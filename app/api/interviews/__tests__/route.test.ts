import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const {
  mockGetServerSession,
  mockCreateSession,
  mockListSessions,
  mockResolvePracticeHandoff,
  mockFencePracticeSessionWrite,
  mockConnectDB,
  mockIsJobsAccountActive,
  mockActiveJobsAccountIds,
} = vi.hoisted(() => ({
  mockGetServerSession: vi.fn(),
  mockCreateSession: vi.fn(),
  mockListSessions: vi.fn(),
  mockResolvePracticeHandoff: vi.fn(),
  mockFencePracticeSessionWrite: vi.fn(),
  mockConnectDB: vi.fn(),
  mockIsJobsAccountActive: vi.fn(),
  mockActiveJobsAccountIds: vi.fn(),
}))

vi.mock('next-auth', () => ({ getServerSession: mockGetServerSession }))
vi.mock('@shared/auth/authOptions', () => ({ authOptions: {} }))
vi.mock('@interview/services/core/interviewService', () => ({
  createSession: mockCreateSession,
  listSessions: mockListSessions,
}))
vi.mock('@shared/db/connection', () => ({ connectDB: mockConnectDB }))
vi.mock('@shared/services/jobsAccountFence', () => ({
  isJobsAccountActive: (...args: unknown[]) => mockIsJobsAccountActive(...args),
  activeJobsAccountIds: (...args: unknown[]) => mockActiveJobsAccountIds(...args),
}))
vi.mock('@jobs/services/practiceHandoff', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@jobs/services/practiceHandoff')>()),
  resolvePracticeHandoff: mockResolvePracticeHandoff,
  fencePracticeSessionWrite: mockFencePracticeSessionWrite,
}))
vi.mock('@shared/logger', () => ({ logger: { error: vi.fn() } }))

import { GET, POST } from '../route'
import { practiceHandoffHashOf } from '@jobs/services/practiceHandoff'

const USER_ID = '507f1f77bcf86cd799439010'
const JOB_ID = '507f1f77bcf86cd799439011'
const OTHER_JOB_ID = '507f1f77bcf86cd799439012'
const JD = 'Backend role requiring Node.js and MongoDB. '.repeat(3)
const SERVER_JD = JD.replace(/\. /g, '.\n\n').trim()
const SERVER_PARSED_JD = {
  rawText: SERVER_JD,
  company: 'PhonePe',
  role: 'Backend Engineer',
  inferredDomain: 'backend',
  requirements: [{
    id: 'req-1',
    category: 'technical' as const,
    requirement: 'Build Node.js services',
    importance: 'must-have' as const,
    targetCompetencies: ['backend'],
  }],
  keyThemes: ['services'],
  modelParsingSuppressed: true as const,
}

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
  mockListSessions.mockResolvedValue({ sessions: [], total: 0, page: 1, limit: 20 })
  mockConnectDB.mockResolvedValue(undefined)
  mockIsJobsAccountActive.mockResolvedValue(true)
  mockActiveJobsAccountIds.mockImplementation(
    (userIds: string[]) => Promise.resolve(new Set(userIds)),
  )
  mockResolvePracticeHandoff.mockResolvedValue({
    jobId: JOB_ID,
    jobDescription: SERVER_JD,
    jdHash: practiceHandoffHashOf(JD),
    company: 'PhonePe',
    experience: '3-6',
    parsedJobDescription: SERVER_PARSED_JD,
    role: 'backend',
    applicationId: 'canonical-app',
  })
  mockFencePracticeSessionWrite.mockResolvedValue(true)
})

describe('GET /api/interviews account lifecycle', () => {
  it('returns exact account-unavailable semantics before listing sessions', async () => {
    mockIsJobsAccountActive.mockResolvedValue(false)

    const response = await GET(new NextRequest('http://localhost/api/interviews'))

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toEqual({
      error: 'account unavailable',
      code: 'ACCOUNT_UNAVAILABLE',
    })
    expect(mockListSessions).not.toHaveBeenCalled()
  })

  it('withholds a captured session list when deletion wins before response', async () => {
    mockIsJobsAccountActive.mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    mockListSessions.mockResolvedValue({
      sessions: [{ _id: 'private-session', recordingR2Key: 'private-key' }],
      total: 1,
      page: 1,
      limit: 20,
    })

    const response = await GET(new NextRequest('http://localhost/api/interviews'))

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toMatchObject({ code: 'ACCOUNT_UNAVAILABLE' })
    expect(mockActiveJobsAccountIds).not.toHaveBeenCalled()
  })

  it('withholds a sanitized list when requester deletion wins at the final disclosure check', async () => {
    mockListSessions.mockResolvedValue({
      sessions: [{ _id: 'captured-private-row', userId: USER_ID, feedback: { overall_score: 80 } }],
      pagination: { page: 1, limit: 20, total: 1, totalPages: 1 },
    })
    mockActiveJobsAccountIds.mockResolvedValueOnce(new Set())

    const response = await GET(new NextRequest('http://localhost/api/interviews'))

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toMatchObject({ code: 'ACCOUNT_UNAVAILABLE' })
    expect(mockActiveJobsAccountIds).toHaveBeenCalledWith([USER_ID])
  })

  it('prefers account-unavailable when the list query fails during deletion', async () => {
    mockListSessions.mockRejectedValue(new Error('session sweep interrupted query'))
    mockIsJobsAccountActive.mockResolvedValueOnce(true).mockResolvedValueOnce(false)

    const response = await GET(new NextRequest('http://localhost/api/interviews'))

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toMatchObject({ code: 'ACCOUNT_UNAVAILABLE' })
  })

  it('preserves owner setup fields while stripping foreign-owner private context', async () => {
    const foreignOwnerId = '507f1f77bcf86cd799439099'
    mockGetServerSession.mockResolvedValue({
      user: {
        id: USER_ID,
        role: 'recruiter',
        organizationId: '507f1f77bcf86cd799439020',
      },
    })
    mockListSessions.mockResolvedValue({
      sessions: [
        {
          _id: 'owner-session',
          userId: USER_ID,
          resumeText: 'OWNER RESUME',
          jobDescription: 'OWNER JD',
          candidateEmail: 'owner@example.com',
          userAgent: 'owner-agent',
          recordingR2Key: 'recordings/owner.webm',
          screenRecordingR2Key: 'recordings/owner-screen.webm',
          audioRecordingR2Key: 'recordings/owner-audio.webm',
          facialLandmarksR2Key: 'landmarks/owner.json',
          resumeR2Key: 'documents/owner-resume.pdf',
          jdR2Key: 'documents/owner-jd.pdf',
          inviteTokenHash: 'owner-invite-secret',
          inviteTokenExpiry: '2099-01-01T00:00:00.000Z',
        },
        {
          _id: 'foreign-session',
          userId: foreignOwnerId,
          resumeText: 'FOREIGN RESUME',
          jobDescription: 'FOREIGN JD',
          candidateEmail: 'foreign@example.com',
          userAgent: 'foreign-agent',
          parsedResume: { name: 'Foreign Candidate' },
          parsedJobDescription: { title: 'Foreign Role' },
          resumeFileName: 'foreign-resume.pdf',
          jdFileName: 'foreign-jd.pdf',
          recordingUrl: 'https://private.example/recording',
          shareToken: 'foreign-share-secret',
          recordingR2Key: 'recordings/foreign.webm',
          screenRecordingR2Key: 'recordings/foreign-screen.webm',
          audioRecordingR2Key: 'recordings/foreign-audio.webm',
          facialLandmarksR2Key: 'landmarks/foreign.json',
          resumeR2Key: 'documents/foreign-resume.pdf',
          jdR2Key: 'documents/foreign-jd.pdf',
          inviteTokenHash: 'foreign-invite-secret',
          inviteTokenExpiry: '2099-01-01T00:00:00.000Z',
          feedback: { overall_score: 80 },
        },
      ],
      pagination: { page: 1, limit: 20, total: 2, totalPages: 1 },
    })

    const response = await GET(new NextRequest('http://localhost/api/interviews'))
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.pagination.total).toBe(2)
    expect(body.sessions[0]).toMatchObject({
      resumeText: 'OWNER RESUME',
      jobDescription: 'OWNER JD',
      candidateEmail: 'owner@example.com',
      userAgent: 'owner-agent',
      hasRecording: true,
      hasScreenRecording: true,
    })
    for (const privateField of [
      'recordingR2Key',
      'screenRecordingR2Key',
      'audioRecordingR2Key',
      'facialLandmarksR2Key',
      'resumeR2Key',
      'jdR2Key',
      'inviteTokenHash',
      'inviteTokenExpiry',
    ]) {
      expect(body.sessions[0]).not.toHaveProperty(privateField)
      expect(body.sessions[1]).not.toHaveProperty(privateField)
    }
    expect(body.sessions[1]).toMatchObject({
      _id: 'foreign-session',
      feedback: { overall_score: 80 },
    })
    for (const privateField of [
      'resumeText',
      'jobDescription',
      'candidateEmail',
      'userAgent',
      'parsedResume',
      'parsedJobDescription',
      'resumeFileName',
      'jdFileName',
      'recordingUrl',
      'shareToken',
    ]) {
      expect(body.sessions[1]).not.toHaveProperty(privateField)
    }
    expect(mockActiveJobsAccountIds).toHaveBeenCalledWith([USER_ID, foreignOwnerId])
  })

  it('prunes a foreign row instead of failing the page when its owner starts deleting in flight', async () => {
    const foreignOwnerId = '507f1f77bcf86cd799439099'
    mockGetServerSession.mockResolvedValue({
      user: {
        id: USER_ID,
        role: 'recruiter',
        organizationId: '507f1f77bcf86cd799439020',
      },
    })
    mockListSessions.mockResolvedValue({
      sessions: [{ _id: 'captured-private-row', userId: foreignOwnerId, feedback: { overall_score: 80 } }],
      pagination: { page: 1, limit: 20, total: 1, totalPages: 1 },
    })
    mockActiveJobsAccountIds.mockResolvedValueOnce(new Set([USER_ID]))

    const response = await GET(new NextRequest('http://localhost/api/interviews'))
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.sessions).toEqual([])
    expect(body.pagination).toEqual({ page: 1, limit: 20, total: 1, totalPages: 1 })
    expect(mockActiveJobsAccountIds).toHaveBeenCalledWith([USER_ID, foreignOwnerId])
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
        experience: '3-6',
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
      verifiedJobsParsedJobDescription: SERVER_PARSED_JD,
      beforeVerifiedJobsSessionWrite: expect.any(Function),
    }))
  })

  it('returns 409 when source revocation wins the transactional session fence', async () => {
    mockFencePracticeSessionWrite.mockResolvedValueOnce(false)
    mockCreateSession.mockImplementationOnce(async (input: {
      beforeVerifiedJobsSessionWrite?: (session: unknown) => Promise<boolean>
    }) => {
      if (!(await input.beforeVerifiedJobsSessionWrite?.({ id: 'db-session' }))) {
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
    expect(mockResolvePracticeHandoff).toHaveBeenCalledOnce()
    expect(mockFencePracticeSessionWrite).toHaveBeenCalledWith(
      {
        userId: USER_ID,
        jobId: JOB_ID,
        jdHash: practiceHandoffHashOf(JD),
        role: 'backend',
        applicationId: 'canonical-app',
      },
      { id: 'db-session' },
    )
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

  it('rejects a browser experience that differs from the server profile', async () => {
    const response = await POST(request({
      config: {
        ...baseConfig,
        experience: '7+',
        attribution: { source: 'jobs', jobId: JOB_ID },
      },
      jobsHandoffToken: 'signed-token',
    }))

    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ code: 'JOBS_HANDOFF_INVALID' })
    expect(mockCreateSession).not.toHaveBeenCalled()
  })

  it.each(['0-2', '7+'] as const)(
    'canonicalizes a valid Jobs session to server experience %s',
    async (experience) => {
      mockResolvePracticeHandoff.mockResolvedValue({
        jobId: JOB_ID,
        jobDescription: SERVER_JD,
        jdHash: practiceHandoffHashOf(JD),
        company: 'PhonePe',
        experience,
        parsedJobDescription: SERVER_PARSED_JD,
        role: 'backend',
        applicationId: 'canonical-app',
      })

      const response = await POST(request({
        config: {
          ...baseConfig,
          experience,
          attribution: { source: 'jobs', jobId: JOB_ID },
        },
        jobsHandoffToken: 'signed-token',
      }))

      expect(response.status).toBe(201)
      expect(mockCreateSession).toHaveBeenCalledWith(expect.objectContaining({
        config: expect.objectContaining({ experience }),
      }))
    },
  )

  it('fails the transactional fence when profile authority changes mid-flight', async () => {
    mockFencePracticeSessionWrite.mockResolvedValueOnce(false)
    mockCreateSession.mockImplementationOnce(async (input: {
      beforeVerifiedJobsSessionWrite?: (session: unknown) => Promise<boolean>
    }) => {
      if (!(await input.beforeVerifiedJobsSessionWrite?.({ id: 'db-session' }))) {
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
      experience: '3-6',
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
