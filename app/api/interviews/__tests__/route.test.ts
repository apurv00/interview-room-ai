import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const { mockGetServerSession, mockCreateSession, mockResolvePracticeHandoff } = vi.hoisted(() => ({
  mockGetServerSession: vi.fn(),
  mockCreateSession: vi.fn(),
  mockResolvePracticeHandoff: vi.fn(),
}))

vi.mock('next-auth', () => ({ getServerSession: mockGetServerSession }))
vi.mock('@shared/auth/authOptions', () => ({ authOptions: {} }))
vi.mock('@interview/services/core/interviewService', () => ({
  createSession: mockCreateSession,
  listSessions: vi.fn(),
}))
vi.mock('@jobs/services/practiceHandoff', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@jobs/services/practiceHandoff')>()),
  resolvePracticeHandoff: mockResolvePracticeHandoff,
}))
vi.mock('@shared/logger', () => ({ logger: { error: vi.fn() } }))

import { POST } from '../route'
import { practiceHandoffHashOf } from '@jobs/services/practiceHandoff'

const USER_ID = '507f1f77bcf86cd799439010'
const JOB_ID = '507f1f77bcf86cd799439011'
const OTHER_JOB_ID = '507f1f77bcf86cd799439012'
const JD = 'Backend role requiring Node.js and MongoDB. '.repeat(3)
const SERVER_JD = JD.replace(/\. /g, '.\n\n').trim()

const baseConfig = {
  role: 'backend',
  interviewType: 'behavioral',
  experience: '3-6' as const,
  duration: 20,
  jobDescription: JD,
}

function request(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/interviews', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mockGetServerSession.mockResolvedValue({
    user: { id: USER_ID, organizationId: '507f1f77bcf86cd799439020' },
  })
  mockCreateSession.mockResolvedValue({ _id: { toString: () => 'session-1' } })
  mockResolvePracticeHandoff.mockResolvedValue({
    jobId: JOB_ID,
    jobDescription: SERVER_JD,
    jdHash: practiceHandoffHashOf(JD),
    company: 'PhonePe',
    role: 'backend',
    applicationId: 'canonical-app',
  })
})

describe('POST /api/interviews Jobs handoff', () => {
  it('leaves ordinary non-Jobs session creation unchanged', async () => {
    const response = await POST(request({ config: baseConfig }))

    expect(response.status).toBe(201)
    expect(await response.json()).toEqual({ sessionId: 'session-1' })
    expect(mockResolvePracticeHandoff).not.toHaveBeenCalled()
    expect(mockCreateSession).toHaveBeenCalledWith(expect.objectContaining({
      config: baseConfig,
      jobDescription: JD,
      verifiedJobsAttribution: undefined,
    }))
  })

  it('rejects Jobs attribution without its transport token before quota/session creation', async () => {
    const response = await POST(request({
      config: {
        ...baseConfig,
        attribution: { source: 'jobs', jobId: JOB_ID, applicationId: 'browser-app' },
      },
    }))

    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ code: 'JOBS_HANDOFF_INVALID' })
    expect(mockResolvePracticeHandoff).not.toHaveBeenCalled()
    expect(mockCreateSession).not.toHaveBeenCalled()
  })

  it('server-resolves and persists only canonical Jobs identity and JD', async () => {
    const response = await POST(request({
      config: {
        ...baseConfig,
        targetCompany: 'Tampered Co',
        attribution: { source: 'jobs', jobId: JOB_ID, applicationId: 'browser-app' },
      },
      jobsHandoffToken: 'signed-token',
    }))

    expect(response.status).toBe(201)
    expect(mockResolvePracticeHandoff).toHaveBeenCalledWith('signed-token', USER_ID)
    expect(mockCreateSession).toHaveBeenCalledWith(expect.objectContaining({
      config: expect.objectContaining({
        role: 'backend',
        jobDescription: SERVER_JD,
        targetCompany: 'PhonePe',
        attribution: {
          source: 'jobs',
          jobId: JOB_ID,
          applicationId: 'canonical-app',
        },
      }),
      jobDescription: SERVER_JD,
      verifiedJobsAttribution: expect.objectContaining({
        source: 'jobs',
        jobId: JOB_ID,
        applicationId: 'canonical-app',
        handoffVersion: 1,
        jdHash: practiceHandoffHashOf(JD),
        verifiedAt: expect.any(Date),
      }),
      beforeJobDescriptionProviderCall: expect.any(Function),
    }))
  })

  it('returns 409 when source revocation wins after handoff but before JD model egress', async () => {
    mockResolvePracticeHandoff
      .mockResolvedValueOnce({
        jobId: JOB_ID,
        jobDescription: SERVER_JD,
        jdHash: practiceHandoffHashOf(JD),
        company: 'PhonePe',
        role: 'backend',
        applicationId: 'canonical-app',
      })
      // Source revocation wins after the request handoff but before the
      // parser's first provider attempt.
      .mockResolvedValueOnce(null)
    mockCreateSession.mockImplementationOnce(async (input: {
      beforeJobDescriptionProviderCall?: () => Promise<boolean>
    }) => {
      if (!(await input.beforeJobDescriptionProviderCall?.())) {
        throw Object.assign(new Error('model provider precondition failed'), {
          name: 'ModelProviderPreconditionError',
        })
      }
      return { _id: { toString: () => 'session-must-not-exist' } }
    })

    const response = await POST(request({
      config: {
        ...baseConfig,
        attribution: { source: 'jobs', jobId: JOB_ID },
      },
      jobsHandoffToken: 'signed-token',
    }))

    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ code: 'JOBS_HANDOFF_INVALID' })
    expect(mockResolvePracticeHandoff).toHaveBeenNthCalledWith(2, 'signed-token', USER_ID)
  })

  it('rejects a browser role that differs from the re-resolved server role', async () => {
    const response = await POST(request({
      config: {
        ...baseConfig,
        role: 'browser-stale-role',
        attribution: { source: 'jobs', jobId: JOB_ID },
      },
      jobsHandoffToken: 'signed-token',
    }))

    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ code: 'JOBS_HANDOFF_INVALID' })
    expect(mockCreateSession).not.toHaveBeenCalled()
  })

  it.each([
    ['cross-job claim', { jobId: OTHER_JOB_ID, jobDescription: JD }],
    ['cross-JD claim', { jobId: JOB_ID, jobDescription: 'A different public JD' }],
  ])('fails closed for a %s even when the browser coordinates its own fields', async (_label, claim) => {
    const response = await POST(request({
      config: {
        ...baseConfig,
        jobDescription: claim.jobDescription,
        attribution: { source: 'jobs', jobId: claim.jobId },
      },
      jobsHandoffToken: 'signed-token',
    }))

    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ code: 'JOBS_HANDOFF_INVALID' })
    expect(mockCreateSession).not.toHaveBeenCalled()
  })

  it('rejects a token whose signature/user/posting resolution fails', async () => {
    mockResolvePracticeHandoff.mockResolvedValue(null)

    const response = await POST(request({
      config: { ...baseConfig, attribution: { source: 'jobs', jobId: JOB_ID } },
      jobsHandoffToken: 'wrong-user-or-expired-token',
    }))

    expect(response.status).toBe(409)
    expect(mockCreateSession).not.toHaveBeenCalled()
  })

  it('returns a validation 400 rather than a generic 500 for an oversized transport token', async () => {
    const response = await POST(request({
      config: { ...baseConfig, attribution: { source: 'jobs', jobId: JOB_ID } },
      jobsHandoffToken: 'x'.repeat(2049),
    }))

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      error: 'Invalid session configuration',
      code: 'VALIDATION_ERROR',
    })
    expect(mockResolvePracticeHandoff).not.toHaveBeenCalled()
    expect(mockCreateSession).not.toHaveBeenCalled()
  })

  it('fails closed when the posting has no server-resolvable interview role', async () => {
    mockResolvePracticeHandoff.mockResolvedValue({
      jobId: JOB_ID,
      jobDescription: SERVER_JD,
      jdHash: practiceHandoffHashOf(JD),
      company: 'PhonePe',
    })

    const response = await POST(request({
      config: { ...baseConfig, attribution: { source: 'jobs', jobId: JOB_ID } },
      jobsHandoffToken: 'signed-token',
    }))

    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ code: 'JOBS_HANDOFF_INVALID' })
    expect(mockCreateSession).not.toHaveBeenCalled()
  })
})
