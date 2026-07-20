import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import mongoose from 'mongoose'

const {
  mockGetServerSession,
  mockGetSession,
  mockJobPostingFindById,
  mockJobApplicationExists,
  mockPreparePractice,
} = vi.hoisted(() => ({
  mockGetServerSession: vi.fn(),
  mockGetSession: vi.fn(),
  mockJobPostingFindById: vi.fn(),
  mockJobApplicationExists: vi.fn(),
  mockPreparePractice: vi.fn(),
}))

vi.mock('next-auth', () => ({
  getServerSession: (...args: unknown[]) => mockGetServerSession(...args),
}))
vi.mock('@shared/auth/authOptions', () => ({ authOptions: {} }))
vi.mock('@interview/services/core/interviewService', () => ({
  getSession: (...args: unknown[]) => mockGetSession(...args),
}))
vi.mock('@shared/db/models', () => ({
  JobPosting: { findById: (...args: unknown[]) => mockJobPostingFindById(...args) },
  JobApplication: { exists: (...args: unknown[]) => mockJobApplicationExists(...args) },
}))
vi.mock('@jobs/services/practiceHandoff', () => ({
  preparePracticeHandoffPosting: (...args: unknown[]) => mockPreparePractice(...args),
}))
vi.mock('@shared/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import { POST } from '../route'

const USER_ID = new mongoose.Types.ObjectId().toString()
const VIEWER_ID = new mongoose.Types.ObjectId().toString()
const SESSION_ID = new mongoose.Types.ObjectId().toString()
const ROOT_ID = new mongoose.Types.ObjectId().toString()
const JOB_ID = new mongoose.Types.ObjectId().toString()
const JD_HASH = 'a'.repeat(64)

function postingResult(posting: { status: string; closedReason?: string } | null) {
  return {
    select: vi.fn().mockReturnValue({
      lean: vi.fn().mockResolvedValue(posting),
    }),
  }
}

function parent(overrides: Record<string, unknown> = {}) {
  return {
    _id: SESSION_ID,
    userId: { toString: () => USER_ID },
    config: {
      role: 'backend',
      interviewType: 'behavioral',
      experience: '3-6',
      duration: 20,
    },
    jobDescription: 'Canonical JD',
    resumeText: 'Candidate resume',
    ...overrides,
  }
}

function callRoute(id = SESSION_ID) {
  return POST(
    new NextRequest(`http://localhost/api/interviews/${id}/retake`, { method: 'POST' }),
    { params: { id } }
  )
}

describe('POST /api/interviews/[id]/retake', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetServerSession.mockResolvedValue({
      user: { id: USER_ID, role: 'user', organizationId: undefined },
    })
    mockGetSession.mockResolvedValue(parent())
    mockJobPostingFindById.mockReturnValue(postingResult({ status: 'open' }))
    mockJobApplicationExists.mockResolvedValue(null)
    mockPreparePractice.mockResolvedValue({ jobDescription: 'JD', role: 'backend', jdHash: JD_HASH })
  })

  it('returns a verified Jobs practice intent and the root of a retake chain', async () => {
    mockGetSession.mockResolvedValue(parent({
      parentSessionId: { toString: () => ROOT_ID },
      attribution: {
        source: 'jobs',
        jobId: JOB_ID,
        handoffVersion: 1,
        jdHash: JD_HASH,
      },
    }))

    const response = await callRoute()
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.parentSessionId).toBe(ROOT_ID)
    expect(body.jobsOrigin).toBe(true)
    expect(body.jobsPractice).toEqual({ jobId: JOB_ID })
    expect(mockJobPostingFindById).toHaveBeenCalledWith(JOB_ID)
    expect(mockJobApplicationExists).not.toHaveBeenCalled()
  })

  it('keeps a normally archived posting exact for its authenticated tracker owner', async () => {
    mockGetSession.mockResolvedValue(parent({
      attribution: {
        source: 'jobs',
        jobId: JOB_ID,
        handoffVersion: 1,
        jdHash: JD_HASH,
      },
    }))
    mockJobPostingFindById.mockReturnValue(postingResult({
      status: 'closed',
      closedReason: 'valid-through-expired',
    }))
    mockJobApplicationExists.mockResolvedValue({ _id: new mongoose.Types.ObjectId().toString() })

    const response = await callRoute()
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.parentSessionId).toBe(SESSION_ID)
    expect(body.jobsPractice).toEqual({ jobId: JOB_ID })
    expect(mockJobApplicationExists).toHaveBeenCalledWith({
      userId: USER_ID,
      jobPostingId: JOB_ID,
    })
  })

  it.each([
    ['a normally archived posting owned by another user', { status: 'closed', closedReason: 'aged-out' }, false],
    ['a restricted posting', { status: 'closed', closedReason: 'source-revoked' }, true],
    ['an unknown legacy closure', { status: 'closed' }, true],
    ['a deleted posting', null, true],
  ])('falls back to generic retake for %s', async (_label, posting, applicationExistsShouldStayUnused) => {
    mockGetSession.mockResolvedValue(parent({
      attribution: {
        source: 'jobs',
        jobId: JOB_ID,
        handoffVersion: 1,
        jdHash: JD_HASH,
      },
    }))
    mockJobPostingFindById.mockReturnValue(postingResult(posting))
    mockJobApplicationExists.mockResolvedValue(null)

    const response = await callRoute()
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.jobsOrigin).toBe(true)
    expect(body.jobsPractice).toBeUndefined()
    if (applicationExistsShouldStayUnused) {
      expect(mockJobApplicationExists).not.toHaveBeenCalled()
    } else {
      expect(mockJobApplicationExists).toHaveBeenCalledWith({
        userId: USER_ID,
        jobPostingId: JOB_ID,
      })
    }
    expect(mockPreparePractice).not.toHaveBeenCalled()
  })

  it.each([
    ['the current JD hash changed', { jobDescription: 'Changed JD', role: 'backend', jdHash: 'b'.repeat(64) }],
    ['the CMS role is no longer active', { jobDescription: 'JD', jdHash: JD_HASH }],
  ])('falls back to generic retake when %s', async (_label, prepared) => {
    mockGetSession.mockResolvedValue(parent({
      attribution: {
        source: 'jobs',
        jobId: JOB_ID,
        handoffVersion: 1,
        jdHash: JD_HASH,
      },
    }))
    mockPreparePractice.mockResolvedValue(prepared)

    const response = await callRoute()
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.jobsOrigin).toBe(true)
    expect(body.jobsPractice).toBeUndefined()
  })

  it('degrades a Practice preparation outage to generic retake', async () => {
    mockGetSession.mockResolvedValue(parent({
      attribution: {
        source: 'jobs',
        jobId: JOB_ID,
        handoffVersion: 1,
        jdHash: JD_HASH,
      },
    }))
    mockPreparePractice.mockRejectedValue(new Error('CMS unavailable'))

    const response = await callRoute()

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ jobsOrigin: true })
  })

  it.each([
    ['legacy Jobs attribution', { source: 'jobs', jobId: JOB_ID }],
    ['missing JD identity', { source: 'jobs', jobId: JOB_ID, handoffVersion: 1 }],
    ['non-Jobs attribution', undefined],
  ])('does not promote %s into verified Jobs practice', async (_label, attribution) => {
    mockGetSession.mockResolvedValue(parent({ attribution }))

    const response = await callRoute()
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.parentSessionId).toBe(SESSION_ID)
    expect(body.jobsPractice).toBeUndefined()
    expect(mockJobPostingFindById).not.toHaveBeenCalled()
  })

  it('is owner-only even when getSession permits an organization viewer', async () => {
    mockGetServerSession.mockResolvedValue({
      user: { id: VIEWER_ID, role: 'recruiter', organizationId: new mongoose.Types.ObjectId().toString() },
    })

    const response = await callRoute()

    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ code: 'FORBIDDEN' })
  })

  it('rejects malformed ids before loading the session', async () => {
    const response = await callRoute('not-an-object-id')

    expect(response.status).toBe(400)
    expect(mockGetSession).not.toHaveBeenCalled()
  })
})
