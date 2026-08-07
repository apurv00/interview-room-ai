import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@shared/db/connection', () => ({
  connectDB: vi.fn().mockResolvedValue(undefined),
}))

const mockFindById = vi.fn()
const mockFindByIdAndUpdate = vi.fn()
const mockSessionCreate = vi.fn()
const mockUserUpdateOne = vi.fn()
const mockUserFindOneAndUpdate = vi.fn()
const mockUserExists = vi.fn()
const mockUserExistsSession = vi.fn()
const mockUserFindByIdAndUpdate = vi.fn()
const mockDepthFindOne = vi.fn()
const mockParseJobDescription = vi.fn()
const {
  mockWithActiveJobsAccountWrite,
  mockDbSession,
  MockJobsAccountInactiveError,
} = vi.hoisted(() => {
  class MockJobsAccountInactiveError extends Error {}
  return {
    mockWithActiveJobsAccountWrite: vi.fn(),
    mockDbSession: { id: 'jobs-account-session' },
    MockJobsAccountInactiveError,
  }
})

vi.mock('@shared/db/models', () => ({
  InterviewSession: {
    findById: (...args: unknown[]) => mockFindById(...args),
    findByIdAndUpdate: (...args: unknown[]) => mockFindByIdAndUpdate(...args),
    create: (...args: unknown[]) => mockSessionCreate(...args),
  },
  User: {
    updateOne: (...args: unknown[]) => mockUserUpdateOne(...args),
    findOneAndUpdate: (...args: unknown[]) => mockUserFindOneAndUpdate(...args),
    exists: (...args: unknown[]) => mockUserExists(...args),
    findByIdAndUpdate: (...args: unknown[]) => mockUserFindByIdAndUpdate(...args),
  },
}))

vi.mock('@shared/db/models/InterviewDepth', () => ({
  InterviewDepth: { findOne: (...args: unknown[]) => mockDepthFindOne(...args) },
}))

vi.mock('@shared/services/jobsAccountFence', () => ({
  activeJobsAccountFilter: (userId: string) => ({
    _id: userId,
    $or: [{ accountState: 'active' }, { accountState: { $exists: false } }],
  }),
  JobsAccountInactiveError: MockJobsAccountInactiveError,
  withActiveJobsAccountWrite: mockWithActiveJobsAccountWrite,
}))

vi.mock('@shared/auth/permissions', () => ({
  canEditSession: vi.fn().mockReturnValue(true),
  canViewSession: vi.fn().mockReturnValue(true),
}))

vi.mock('@shared/db/seed', () => ({ FALLBACK_DEPTHS: [] }))
vi.mock('@shared/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

vi.mock('@interview/services/persona/jdParserService', () => ({
  parseJobDescription: (...args: unknown[]) => mockParseJobDescription(...args),
  buildParsedJDContext: vi.fn(),
}))

vi.mock('@interview/services/persona/resumeContextService', () => ({
  parseAndCacheResume: vi.fn(),
  buildParsedResumeContext: vi.fn(),
}))

vi.mock('@interview/services/persona/documentContextCache', () => ({
  setCachedJDContext: vi.fn(),
  setCachedResumeContext: vi.fn(),
}))

vi.mock('@interview/services/core/sessionConfigCache', () => ({
  warmSessionConfigCache: vi.fn(),
}))

import { createSession, updateSession } from '@interview/services/core/interviewService'

const JOBS_JD = 'A server-resolved backend role requiring reliable Node.js services.'
const JOBS_PARSED_JD = {
  rawText: JOBS_JD,
  company: 'Acme',
  role: 'Backend Engineer',
  inferredDomain: 'backend',
  requirements: [{
    id: 'req-1',
    category: 'technical' as const,
    requirement: 'Build reliable Node.js services',
    importance: 'must-have' as const,
    targetCompetencies: ['backend'],
  }],
  keyThemes: ['reliability'],
  modelParsingSuppressed: true as const,
}

describe('createSession — Jobs JD provider authority', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockWithActiveJobsAccountWrite.mockImplementation(
      async (_userId: string, work: (session: unknown) => Promise<unknown>) => work(mockDbSession),
    )
    mockUserExistsSession.mockResolvedValue({ _id: '507f1f77bcf86cd799439010' })
    mockUserExists.mockReturnValue({ session: mockUserExistsSession })
  })

  it('forwards the optional authority callback to structured JD parsing', async () => {
    const beforeProviderCall = vi.fn().mockResolvedValue(true)
    mockUserUpdateOne.mockResolvedValue({ matchedCount: 1 })
    mockUserFindOneAndUpdate.mockResolvedValue({ _id: '507f1f77bcf86cd799439010' })
    mockUserExists.mockResolvedValue({ _id: '507f1f77bcf86cd799439010' })
    mockDepthFindOne.mockReturnValue({ lean: () => Promise.resolve(null) })
    mockSessionCreate.mockResolvedValue({ _id: { toString: () => 'session-1' } })
    mockParseJobDescription.mockResolvedValue({
      rawText: 'A sufficiently detailed backend job description',
      company: '',
      role: '',
      inferredDomain: '',
      requirements: [],
      keyThemes: [],
    })

    await createSession({
      userId: '507f1f77bcf86cd799439010',
      config: {
        role: 'backend',
        interviewType: 'behavioral',
        experience: '3-6',
        duration: 20,
      },
      jobDescription: 'A sufficiently detailed backend job description',
      beforeJobDescriptionProviderCall: beforeProviderCall,
    })

    expect(mockParseJobDescription).toHaveBeenCalledWith(
      'A sufficiently detailed backend job description',
      undefined,
      beforeProviderCall
    )
  })

  it('enforces Basic and exact paid limits without calendar-resetting subscriptions', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-05T12:00:00.000Z'))
    try {
      mockUserUpdateOne.mockResolvedValue({ matchedCount: 1 })
      mockUserFindOneAndUpdate.mockResolvedValue({
        _id: '507f1f77bcf86cd799439010',
      })
      mockDepthFindOne.mockReturnValue({
        lean: () => Promise.resolve(null),
      })
      mockSessionCreate.mockResolvedValue({
        _id: { toString: () => 'session-quota-1' },
      })

      await createSession({
        userId: '507f1f77bcf86cd799439010',
        config: {
          role: 'backend',
          interviewType: 'behavioral',
          experience: '3-6',
          duration: 20,
        },
      })

      const reset = mockUserUpdateOne.mock.calls[0]
      expect(reset[0]).toEqual(expect.objectContaining({
        entitlementSource: { $ne: 'subscription' },
        $or: expect.arrayContaining([
          { legacyMonthlyInterviewResetAt: { $exists: false } },
        ]),
      }))
      expect(reset[1]).toEqual({
        $set: expect.objectContaining({
          monthlyInterviewsUsed: 0,
          legacyMonthlyInterviewResetAt: new Date(
            '2026-08-05T12:00:00.000Z',
          ),
        }),
      })
      expect(reset[1].$set).not.toHaveProperty('usageResetAt')

      expect(mockUserUpdateOne.mock.calls[1]).toEqual([
        expect.objectContaining({
          organizationId: null,
          plan: { $nin: ['plus', 'pro', 'enterprise'] },
          entitlementSource: { $nin: ['subscription', 'admin_grant'] },
        }),
        { $set: { monthlyInterviewLimit: 1 } },
      ])
      expect(mockUserUpdateOne.mock.calls[2]).toEqual([
        expect.objectContaining({
          entitlementSource: 'subscription',
          planVocabularyVersion: 2,
          plan: 'plus',
          planExpiresAt: {
            $gt: new Date('2026-08-05T12:00:00.000Z'),
          },
          interviewLimit: 10,
        }),
        { $set: { monthlyInterviewLimit: 10 } },
      ])
      expect(mockUserUpdateOne.mock.calls[3]).toEqual([
        expect.objectContaining({
          entitlementSource: 'subscription',
          planVocabularyVersion: 2,
          plan: 'pro',
          planExpiresAt: {
            $gt: new Date('2026-08-05T12:00:00.000Z'),
          },
          interviewLimit: 15,
        }),
        { $set: { monthlyInterviewLimit: 15 } },
      ])

      const admission = mockUserFindOneAndUpdate.mock.calls[0][0]
      expect(admission.$and[0]).toEqual({
        $expr: {
          $lt: ['$monthlyInterviewsUsed', '$monthlyInterviewLimit'],
        },
      })
      expect(admission.$and[1].$or).toEqual(expect.arrayContaining([
        expect.objectContaining({ monthlyInterviewLimit: 1 }),
        expect.objectContaining({
          entitlementSource: 'subscription',
          plan: 'plus',
          interviewLimit: 10,
          monthlyInterviewLimit: 10,
        }),
        expect.objectContaining({
          entitlementSource: 'subscription',
          plan: 'pro',
          interviewLimit: 15,
          monthlyInterviewLimit: 15,
        }),
        { plan: 'enterprise' },
        { entitlementSource: 'admin_grant' },
      ]))
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects a Basic request above 10 minutes before consuming quota', async () => {
    mockUserUpdateOne.mockResolvedValue({ matchedCount: 1 })
    mockUserFindOneAndUpdate.mockResolvedValue(null)
    mockUserExists.mockResolvedValue({
      _id: '507f1f77bcf86cd799439010',
    })

    await expect(createSession({
      userId: '507f1f77bcf86cd799439010',
      config: {
        role: 'backend',
        interviewType: 'behavioral',
        experience: '3-6',
        duration: 20,
      },
    })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      statusCode: 403,
      message: 'Basic interviews are limited to 10 minutes.',
    })

    const admission = mockUserFindOneAndUpdate.mock.calls[0][0]
    expect(admission.$and[2]).toEqual({
      $nor: [expect.objectContaining({
        organizationId: null,
        monthlyInterviewLimit: 1,
      })],
    })
    expect(mockSessionCreate).not.toHaveBeenCalled()
    expect(mockUserFindByIdAndUpdate).not.toHaveBeenCalled()
  })

  it('admits a 10-minute Basic request and persists the authoritative duration', async () => {
    mockUserUpdateOne.mockResolvedValue({ matchedCount: 1 })
    mockUserFindOneAndUpdate.mockResolvedValue({
      _id: '507f1f77bcf86cd799439010',
    })
    mockDepthFindOne.mockReturnValue({ lean: () => Promise.resolve(null) })
    mockSessionCreate.mockResolvedValue({
      _id: { toString: () => 'session-basic-duration' },
    })

    await createSession({
      userId: '507f1f77bcf86cd799439010',
      config: {
        role: 'backend',
        interviewType: 'behavioral',
        experience: '3-6',
        duration: 10,
      },
    })

    const admission = mockUserFindOneAndUpdate.mock.calls[0][0]
    expect(admission.$and).toHaveLength(2)
    expect(mockSessionCreate).toHaveBeenCalledWith(expect.objectContaining({
      config: expect.objectContaining({ duration: 10 }),
    }))
  })

  it('admits 30 minutes only through a non-Basic authority branch', async () => {
    mockUserUpdateOne.mockResolvedValue({ matchedCount: 1 })
    mockUserFindOneAndUpdate.mockResolvedValue({
      _id: '507f1f77bcf86cd799439010',
    })
    mockDepthFindOne.mockReturnValue({ lean: () => Promise.resolve(null) })
    mockSessionCreate.mockResolvedValue({
      _id: { toString: () => 'session-paid-duration' },
    })

    await createSession({
      userId: '507f1f77bcf86cd799439010',
      config: {
        role: 'backend',
        interviewType: 'behavioral',
        experience: '3-6',
        duration: 30,
      },
    })

    const admission = mockUserFindOneAndUpdate.mock.calls[0][0]
    expect(admission.$and[2]).toEqual({
      $nor: [expect.objectContaining({ monthlyInterviewLimit: 1 })],
    })
    expect(mockSessionCreate).toHaveBeenCalledWith(expect.objectContaining({
      config: expect.objectContaining({ duration: 30 }),
    }))
  })

  it('rejects every account above the 30-minute product maximum before writes', async () => {
    await expect(createSession({
      userId: '507f1f77bcf86cd799439010',
      config: {
        role: 'backend',
        interviewType: 'behavioral',
        experience: '3-6',
        duration: 31,
      },
    })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      statusCode: 403,
      message: 'Interview duration must be between 5 and 30 minutes.',
    })

    expect(mockUserUpdateOne).not.toHaveBeenCalled()
    expect(mockUserFindOneAndUpdate).not.toHaveBeenCalled()
    expect(mockSessionCreate).not.toHaveBeenCalled()
  })

  it('rolls back quota and creates no session when the provider gate is revoked', async () => {
    const denied = Object.assign(new Error('model provider precondition failed'), {
      name: 'ModelProviderPreconditionError',
    })
    mockUserUpdateOne.mockResolvedValue({ matchedCount: 1 })
    mockUserFindOneAndUpdate.mockResolvedValue({ _id: '507f1f77bcf86cd799439010' })
    mockUserFindByIdAndUpdate.mockResolvedValue({ _id: '507f1f77bcf86cd799439010' })
    mockDepthFindOne.mockReturnValue({ lean: () => Promise.resolve(null) })
    mockParseJobDescription.mockRejectedValueOnce(denied)

    await expect(createSession({
      userId: '507f1f77bcf86cd799439010',
      config: {
        role: 'backend',
        interviewType: 'behavioral',
        experience: '3-6',
        duration: 20,
      },
      jobDescription: 'A source-controlled backend job description',
      beforeJobDescriptionProviderCall: vi.fn().mockResolvedValue(false),
    })).rejects.toBe(denied)

    expect(mockSessionCreate).not.toHaveBeenCalled()
    expect(mockUserFindByIdAndUpdate).toHaveBeenCalledWith(
      '507f1f77bcf86cd799439010',
      { $inc: { monthlyInterviewsUsed: -1, interviewCount: -1 } }
    )
  })

  it('creates a Jobs-attributed session inside the active-account transaction', async () => {
    const beforeVerifiedJobsSessionWrite = vi.fn().mockResolvedValue(true)
    mockUserUpdateOne.mockResolvedValue({ matchedCount: 1 })
    mockUserFindOneAndUpdate.mockResolvedValue({ _id: '507f1f77bcf86cd799439010' })
    mockDepthFindOne.mockReturnValue({ lean: () => Promise.resolve(null) })
    mockSessionCreate.mockResolvedValue([{ _id: { toString: () => 'session-1' } }])

    await createSession({
      userId: '507f1f77bcf86cd799439010',
      config: {
        role: 'backend',
        interviewType: 'behavioral',
        experience: '3-6',
        duration: 20,
      },
      verifiedJobsAttribution: {
        source: 'jobs',
        jobId: '507f1f77bcf86cd799439011',
        applicationId: '507f1f77bcf86cd799439012',
        handoffVersion: 1,
        jdHash: 'a'.repeat(64),
        verifiedAt: new Date('2026-07-21T00:00:00Z'),
      },
      verifiedJobsParsedJobDescription: JOBS_PARSED_JD,
      beforeVerifiedJobsSessionWrite,
      jobDescription: JOBS_JD,
    })

    expect(mockWithActiveJobsAccountWrite).toHaveBeenCalledWith(
      '507f1f77bcf86cd799439010',
      expect.any(Function),
    )
    expect(mockUserExists).toHaveBeenCalledWith(expect.objectContaining({
      _id: expect.anything(),
      experienceLevel: '3-6',
    }))
    expect(mockUserExistsSession).toHaveBeenCalledWith(mockDbSession)
    expect(mockSessionCreate).toHaveBeenCalledWith(
      [expect.objectContaining({
        attribution: expect.objectContaining({ source: 'jobs' }),
        parsedJobDescription: JOBS_PARSED_JD,
      })],
      { session: mockDbSession },
    )
    expect(beforeVerifiedJobsSessionWrite).toHaveBeenCalledWith(mockDbSession)
    expect(beforeVerifiedJobsSessionWrite.mock.invocationCallOrder[0])
      .toBeLessThan(mockSessionCreate.mock.invocationCallOrder[0])
    expect(mockParseJobDescription).not.toHaveBeenCalled()
  })

  it('rolls quota back and creates nothing when source revoke wins before the posting fence', async () => {
    const beforeVerifiedJobsSessionWrite = vi.fn().mockResolvedValue(false)
    mockUserUpdateOne.mockResolvedValue({ matchedCount: 1 })
    mockUserFindOneAndUpdate.mockResolvedValue({ _id: '507f1f77bcf86cd799439010' })
    mockUserFindByIdAndUpdate.mockResolvedValue({ _id: '507f1f77bcf86cd799439010' })
    mockDepthFindOne.mockReturnValue({ lean: () => Promise.resolve(null) })

    await expect(createSession({
      userId: '507f1f77bcf86cd799439010',
      config: {
        role: 'backend',
        interviewType: 'behavioral',
        experience: '3-6',
        duration: 20,
      },
      verifiedJobsAttribution: {
        source: 'jobs',
        jobId: '507f1f77bcf86cd799439011',
        handoffVersion: 1,
        jdHash: 'a'.repeat(64),
        verifiedAt: new Date('2026-07-21T00:00:00Z'),
      },
      verifiedJobsParsedJobDescription: JOBS_PARSED_JD,
      beforeVerifiedJobsSessionWrite,
      jobDescription: JOBS_JD,
    })).rejects.toMatchObject({ name: 'ModelProviderPreconditionError' })

    expect(beforeVerifiedJobsSessionWrite).toHaveBeenCalledWith(mockDbSession)
    expect(mockUserExists).not.toHaveBeenCalled()
    expect(mockSessionCreate).not.toHaveBeenCalled()
    expect(mockUserFindByIdAndUpdate).toHaveBeenCalledWith(
      '507f1f77bcf86cd799439010',
      { $inc: { monthlyInterviewsUsed: -1, interviewCount: -1 } },
    )
  })

  it('preserves a transient posting write conflict so Mongo can retry the transaction', async () => {
    const transientConflict = Object.assign(new Error('write conflict'), {
      errorLabels: ['TransientTransactionError'],
      hasErrorLabel: (label: string) => label === 'TransientTransactionError',
    })
    const beforeVerifiedJobsSessionWrite = vi.fn().mockRejectedValue(transientConflict)
    mockUserUpdateOne.mockResolvedValue({ matchedCount: 1 })
    mockUserFindOneAndUpdate.mockResolvedValue({ _id: '507f1f77bcf86cd799439010' })
    mockUserFindByIdAndUpdate.mockResolvedValue({ _id: '507f1f77bcf86cd799439010' })
    mockDepthFindOne.mockReturnValue({ lean: () => Promise.resolve(null) })

    await expect(createSession({
      userId: '507f1f77bcf86cd799439010',
      config: {
        role: 'backend',
        interviewType: 'behavioral',
        experience: '3-6',
        duration: 20,
      },
      verifiedJobsAttribution: {
        source: 'jobs',
        jobId: '507f1f77bcf86cd799439011',
        handoffVersion: 1,
        jdHash: 'a'.repeat(64),
        verifiedAt: new Date('2026-07-21T00:00:00Z'),
      },
      verifiedJobsParsedJobDescription: JOBS_PARSED_JD,
      beforeVerifiedJobsSessionWrite,
      jobDescription: JOBS_JD,
    })).rejects.toBe(transientConflict)

    expect(transientConflict.hasErrorLabel('TransientTransactionError')).toBe(true)
    expect(mockSessionCreate).not.toHaveBeenCalled()
    expect(mockUserFindByIdAndUpdate).toHaveBeenCalledWith(
      '507f1f77bcf86cd799439010',
      { $inc: { monthlyInterviewsUsed: -1, interviewCount: -1 } },
    )
  })

  it('rejects Jobs attribution without the server-carried exact parse before quota', async () => {
    await expect(createSession({
      userId: '507f1f77bcf86cd799439010',
      config: {
        role: 'backend',
        interviewType: 'behavioral',
        experience: '3-6',
        duration: 20,
      },
      verifiedJobsAttribution: {
        source: 'jobs',
        jobId: '507f1f77bcf86cd799439011',
        handoffVersion: 1,
        jdHash: 'a'.repeat(64),
        verifiedAt: new Date('2026-07-21T00:00:00Z'),
      },
      beforeVerifiedJobsSessionWrite: vi.fn().mockResolvedValue(true),
      jobDescription: JOBS_JD,
    })).rejects.toMatchObject({ name: 'ModelProviderPreconditionError' })

    expect(mockUserUpdateOne).not.toHaveBeenCalled()
    expect(mockUserFindOneAndUpdate).not.toHaveBeenCalled()
    expect(mockSessionCreate).not.toHaveBeenCalled()
    expect(mockParseJobDescription).not.toHaveBeenCalled()
  })

  it('rolls quota back and creates nothing when profile experience changes before the final transaction write', async () => {
    mockUserUpdateOne.mockResolvedValue({ matchedCount: 1 })
    mockUserFindOneAndUpdate.mockResolvedValue({ _id: '507f1f77bcf86cd799439010' })
    mockDepthFindOne.mockReturnValue({ lean: () => Promise.resolve(null) })
    mockUserExistsSession.mockResolvedValueOnce(null)

    await expect(createSession({
      userId: '507f1f77bcf86cd799439010',
      config: {
        role: 'backend',
        interviewType: 'behavioral',
        experience: '3-6',
        duration: 20,
      },
      verifiedJobsAttribution: {
        source: 'jobs',
        jobId: '507f1f77bcf86cd799439011',
        handoffVersion: 1,
        jdHash: 'a'.repeat(64),
        verifiedAt: new Date('2026-07-21T00:00:00Z'),
      },
      verifiedJobsParsedJobDescription: JOBS_PARSED_JD,
      beforeVerifiedJobsSessionWrite: vi.fn().mockResolvedValue(true),
      jobDescription: JOBS_JD,
    })).rejects.toMatchObject({ name: 'ModelProviderPreconditionError' })

    expect(mockUserExistsSession).toHaveBeenCalledWith(mockDbSession)
    expect(mockSessionCreate).not.toHaveBeenCalled()
    expect(mockUserFindByIdAndUpdate).toHaveBeenCalledWith(
      '507f1f77bcf86cd799439010',
      { $inc: { monthlyInterviewsUsed: -1, interviewCount: -1 } },
    )
  })

  it('rolls quota back and creates nothing when account deletion wins the Jobs session fence', async () => {
    mockUserUpdateOne.mockResolvedValue({ matchedCount: 1 })
    mockUserFindOneAndUpdate.mockResolvedValue({ _id: '507f1f77bcf86cd799439010' })
    mockDepthFindOne.mockReturnValue({ lean: () => Promise.resolve(null) })
    mockWithActiveJobsAccountWrite.mockRejectedValueOnce(
      new MockJobsAccountInactiveError('account deleting'),
    )

    await expect(createSession({
      userId: '507f1f77bcf86cd799439010',
      config: {
        role: 'backend',
        interviewType: 'behavioral',
        experience: '3-6',
        duration: 20,
      },
      verifiedJobsAttribution: {
        source: 'jobs',
        jobId: '507f1f77bcf86cd799439011',
        handoffVersion: 1,
        jdHash: 'a'.repeat(64),
        verifiedAt: new Date('2026-07-21T00:00:00Z'),
      },
      verifiedJobsParsedJobDescription: JOBS_PARSED_JD,
      beforeVerifiedJobsSessionWrite: vi.fn().mockResolvedValue(true),
      jobDescription: JOBS_JD,
    })).rejects.toThrow('User not found')

    expect(mockSessionCreate).not.toHaveBeenCalled()
    expect(mockUserFindByIdAndUpdate).toHaveBeenCalledWith(
      '507f1f77bcf86cd799439010',
      { $inc: { monthlyInterviewsUsed: -1, interviewCount: -1 } },
    )
  })
})

describe('updateSession — generic session persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockFindById.mockResolvedValue({
      userId: { toString: () => 'user-1' },
      organizationId: undefined,
      status: 'in_progress',
    })
    mockFindByIdAndUpdate.mockResolvedValue({ _id: { toString: () => 'session-1' } })
  })

  it('ignores raw artifact keys while persisting transcript, completion, and latency telemetry', async () => {
    const interviewLatencyTelemetry = {
      wrapUpListenMs: 15004,
      wrapUpSafeQaMs: 812,
      closingTtsMs: 2300,
      persistMs: 940,
      finalTopicFastPath: true,
    }

    await updateSession('session-1', 'user-1', 'candidate', undefined, {
      audioRecordingR2Key: 'recordings/user-1/session-1-audio.webm',
      audioRecordingSizeBytes: 12345,
      screenRecordingR2Key: 'recordings/user-1/session-1-screen.webm',
      screenRecordingSizeBytes: 67890,
      liveTranscriptWords: [{ word: 'hello', start: 0, end: 0.4, confidence: 0.99 }],
      answeredCount: 3,
      endReason: 'normal',
      interviewLatencyTelemetry,
    })

    expect(mockFindByIdAndUpdate).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({
        liveTranscriptWords: [{ word: 'hello', start: 0, end: 0.4, confidence: 0.99 }],
        answeredCount: 3,
        endReason: 'normal',
        interviewLatencyTelemetry,
      }),
      { returnDocument: 'after' }
    )
    const persisted = mockFindByIdAndUpdate.mock.calls[0]?.[1]
    expect(persisted).not.toHaveProperty('audioRecordingR2Key')
    expect(persisted).not.toHaveProperty('audioRecordingSizeBytes')
    expect(persisted).not.toHaveProperty('screenRecordingR2Key')
    expect(persisted).not.toHaveProperty('screenRecordingSizeBytes')
  })
})
