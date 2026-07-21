import { beforeEach, describe, expect, it, vi } from 'vitest'
import { gzipSync } from 'zlib'
import { NextRequest } from 'next/server'

const {
  mockConnectDB,
  mockPostingFindById,
  mockPostingExists,
  mockApplicationFindOne,
  mockApplicationExists,
  mockGetServerSession,
  mockCreateSession,
  mockGetActiveCatalog,
  mockIsJobsAccountActive,
} = vi.hoisted(() => ({
  mockConnectDB: vi.fn(),
  mockPostingFindById: vi.fn(),
  mockPostingExists: vi.fn().mockResolvedValue({ _id: 'posting-authoritative' }),
  mockApplicationFindOne: vi.fn(),
  mockApplicationExists: vi.fn().mockResolvedValue({ _id: 'application-authoritative' }),
  mockGetServerSession: vi.fn(),
  mockCreateSession: vi.fn(),
  mockGetActiveCatalog: vi.fn(),
  mockIsJobsAccountActive: vi.fn(),
}))

vi.mock('@shared/db/connection', () => ({ connectDB: mockConnectDB }))
vi.mock('@shared/db/models', () => ({
  JobPosting: { findById: mockPostingFindById, exists: mockPostingExists },
  JobApplication: { findOne: mockApplicationFindOne, exists: mockApplicationExists },
}))
vi.mock('../services/baseResumeService', () => ({ getBaseResume: vi.fn() }))
vi.mock('@resume', () => ({ getResume: vi.fn() }))
vi.mock('next-auth', () => ({ getServerSession: mockGetServerSession }))
vi.mock('@shared/auth/authOptions', () => ({ authOptions: {} }))
vi.mock('@interview/services/core/interviewService', () => ({
  createSession: mockCreateSession,
  listSessions: vi.fn(),
}))
vi.mock('@shared/logger', () => ({ logger: { error: vi.fn() } }))
vi.mock('@interview/services/persona/domainCatalogService', () => ({
  getActiveInterviewDomainCatalog: mockGetActiveCatalog,
}))
vi.mock('@shared/services/jobsAccountFence', () => ({
  isJobsAccountActive: mockIsJobsAccountActive,
}))

import { getJobDetail } from '../services/feedService'
import { xrayHashOf } from '../services/xrayService'
import { POST as createInterview } from '@/app/api/interviews/route'
import { INTERVIEW_ROLE_SLUG_MAX_CHARS } from '@shared/interviewContract'

const USER_ID = '507f1f77bcf86cd799439010'
const JOB_ID = '507f1f77bcf86cd799439011'
const SESSION_ID = '507f1f77bcf86cd799439012'
const CANONICAL_JD = 'Build reliable Android applications with Kotlin at production scale.'
const DISPLAY_JD = 'Build reliable Android applications\n\nwith Kotlin at production scale.'
const ACTIVE_CATALOG = {
  slugs: ['general', 'mobile'],
  slugSet: new Set(['general', 'mobile']),
  inferenceSlugSet: new Set(['general', 'mobile']),
  revision: 'jd-role-v2:test',
  authoritative: true,
  source: 'cms' as const,
}

function query(value: unknown) {
  return {
    lean: () => Promise.resolve(value),
    select: () => ({ lean: () => Promise.resolve(value) }),
  }
}

describe('authenticated Job detail → verified interview session', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv('NEXTAUTH_SECRET', 'test-secret-longer-than-sixteen-characters')
    mockConnectDB.mockResolvedValue(undefined)
    mockGetServerSession.mockResolvedValue({ user: { id: USER_ID } })
    mockCreateSession.mockResolvedValue({ _id: { toString: () => SESSION_ID } })
    mockGetActiveCatalog.mockResolvedValue(ACTIVE_CATALOG)
    mockIsJobsAccountActive.mockResolvedValue(true)

    const posting = {
      _id: JOB_ID,
      title: 'Mobile Engineer',
      company: 'Acme',
      locations: ['Remote'],
      isRemote: true,
      status: 'open',
      provenance: [],
      flags: {},
      // The source omitted a top-level domain. Practice becomes eligible
      // only through the current persisted X-ray and closed mapper.
      parsedJD: { inferredDomain: 'mobile' },
      parsedJDHash: xrayHashOf(CANONICAL_JD),
      parsedJDRoleVersion: ACTIVE_CATALOG.revision,
      jdCompressed: gzipSync(Buffer.from(CANONICAL_JD)),
      jdDisplayCompressed: gzipSync(Buffer.from(DISPLAY_JD)),
    }
    const application = {
      _id: '507f1f77bcf86cd799439013',
      status: 'saved',
      verifiedPracticeSessionIds: [],
    }
    mockPostingFindById.mockImplementation(() => query(posting))
    mockApplicationFindOne.mockImplementation(() => query(application))
  })

  it('uses one server snapshot for displayed JD, token, resolved role, and persisted session config', async () => {
    const detail = await getJobDetail(JOB_ID, USER_ID)
    expect(detail?.gated).toBe(false)
    if (!detail || detail.gated) throw new Error('expected authenticated detail')

    expect(detail).toMatchObject({
      jd: DISPLAY_JD,
      practiceRole: 'mobile',
      practiceHandoffToken: expect.any(String),
    })

    const response = await createInterview(new NextRequest('http://localhost/api/interviews', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        config: {
          role: detail.practiceRole,
          experience: '3-6',
          duration: 20,
          jobDescription: detail.jd,
          targetCompany: detail.company,
          attribution: {
            source: 'jobs',
            jobId: detail.id,
            applicationId: detail.application?.applicationId,
          },
        },
        jobsHandoffToken: detail.practiceHandoffToken,
      }),
    }))

    expect(response.status).toBe(201)
    expect(await response.json()).toEqual({ sessionId: SESSION_ID })
    expect(mockCreateSession).toHaveBeenCalledWith(expect.objectContaining({
      userId: USER_ID,
      config: expect.objectContaining({
        role: 'mobile',
        jobDescription: DISPLAY_JD,
        targetCompany: 'Acme',
        attribution: {
          source: 'jobs',
          jobId: JOB_ID,
          applicationId: '507f1f77bcf86cd799439013',
        },
      }),
      verifiedJobsAttribution: expect.objectContaining({
        source: 'jobs',
        jobId: JOB_ID,
        applicationId: '507f1f77bcf86cd799439013',
        handoffVersion: 1,
      }),
    }))
  })

  it('carries an exact-boundary direct CMS role outside the inference subset through the full handoff', async () => {
    const customRole = 'r'.repeat(INTERVIEW_ROLE_SLUG_MAX_CHARS)
    const inferenceSlugs = Array.from({ length: 100 }, (_, index) => `role-${index}`)
    const customCatalog = {
      slugs: inferenceSlugs,
      slugSet: new Set([...inferenceSlugs, customRole]),
      inferenceSlugSet: new Set(inferenceSlugs),
      revision: 'jd-role-v2:long-custom-role',
      authoritative: true,
      source: 'cms' as const,
    }
    mockGetActiveCatalog.mockResolvedValue(customCatalog)
    const posting = {
      _id: JOB_ID,
      title: 'Custom Specialist',
      company: 'Acme',
      locations: ['Remote'],
      isRemote: true,
      domain: customRole,
      status: 'open',
      provenance: [],
      flags: {},
      jdCompressed: gzipSync(Buffer.from(CANONICAL_JD)),
    }
    const application = {
      _id: '507f1f77bcf86cd799439013',
      status: 'saved',
      verifiedPracticeSessionIds: [],
    }
    mockPostingFindById.mockImplementation(() => query(posting))
    mockApplicationFindOne.mockImplementation(() => query(application))

    const detail = await getJobDetail(JOB_ID, USER_ID)
    if (!detail || detail.gated) throw new Error('expected authenticated detail')
    expect(detail.practiceRole).toBe(customRole)

    const response = await createInterview(new NextRequest('http://localhost/api/interviews', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        config: {
          role: detail.practiceRole,
          experience: '3-6',
          duration: 20,
          jobDescription: detail.jd,
          targetCompany: detail.company,
          attribution: { source: 'jobs', jobId: detail.id },
        },
        jobsHandoffToken: detail.practiceHandoffToken,
      }),
    }))

    expect(response.status).toBe(201)
    expect(mockCreateSession).toHaveBeenCalledWith(expect.objectContaining({
      config: expect.objectContaining({ role: customRole }),
    }))
  })
})
