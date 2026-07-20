import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import mongoose from 'mongoose'

const { mockGetServerSession, mockGetSession, mockJobPostingExists } = vi.hoisted(() => ({
  mockGetServerSession: vi.fn(),
  mockGetSession: vi.fn(),
  mockJobPostingExists: vi.fn(),
}))

vi.mock('next-auth', () => ({
  getServerSession: (...args: unknown[]) => mockGetServerSession(...args),
}))
vi.mock('@shared/auth/authOptions', () => ({ authOptions: {} }))
vi.mock('@interview/services/core/interviewService', () => ({
  getSession: (...args: unknown[]) => mockGetSession(...args),
}))
vi.mock('@shared/db/models', () => ({
  JobPosting: { exists: (...args: unknown[]) => mockJobPostingExists(...args) },
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
    mockJobPostingExists.mockResolvedValue({ _id: JOB_ID })
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
    expect(body.jobsPractice).toEqual({ jobId: JOB_ID })
    expect(mockJobPostingExists).toHaveBeenCalledWith({ _id: JOB_ID, status: 'open' })
  })

  it('falls back to generic retake when the attributed posting is no longer open', async () => {
    mockGetSession.mockResolvedValue(parent({
      attribution: {
        source: 'jobs',
        jobId: JOB_ID,
        handoffVersion: 1,
        jdHash: JD_HASH,
      },
    }))
    mockJobPostingExists.mockResolvedValue(null)

    const response = await callRoute()
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.parentSessionId).toBe(SESSION_ID)
    expect(body.jobsPractice).toBeUndefined()
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
    expect(mockJobPostingExists).not.toHaveBeenCalled()
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
