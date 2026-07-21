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

describe('createSession — Jobs JD provider authority', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockWithActiveJobsAccountWrite.mockImplementation(
      async (_userId: string, work: (session: unknown) => Promise<unknown>) => work(mockDbSession),
    )
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
    })

    expect(mockWithActiveJobsAccountWrite).toHaveBeenCalledWith(
      '507f1f77bcf86cd799439010',
      expect.any(Function),
    )
    expect(mockSessionCreate).toHaveBeenCalledWith(
      [expect.objectContaining({
        attribution: expect.objectContaining({ source: 'jobs' }),
      })],
      { session: mockDbSession },
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
    })).rejects.toThrow('User not found')

    expect(mockSessionCreate).not.toHaveBeenCalled()
    expect(mockUserFindByIdAndUpdate).toHaveBeenCalledWith(
      '507f1f77bcf86cd799439010',
      { $inc: { monthlyInterviewsUsed: -1, interviewCount: -1 } },
    )
  })
})

describe('updateSession — recording artifact persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockFindById.mockResolvedValue({
      userId: { toString: () => 'user-1' },
      organizationId: undefined,
      status: 'in_progress',
    })
    mockFindByIdAndUpdate.mockResolvedValue({ _id: { toString: () => 'session-1' } })
  })

  it('persists audio, screen, live transcript, completion, and latency telemetry fields', async () => {
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
        audioRecordingR2Key: 'recordings/user-1/session-1-audio.webm',
        audioRecordingSizeBytes: 12345,
        screenRecordingR2Key: 'recordings/user-1/session-1-screen.webm',
        screenRecordingSizeBytes: 67890,
        liveTranscriptWords: [{ word: 'hello', start: 0, end: 0.4, confidence: 0.99 }],
        answeredCount: 3,
        endReason: 'normal',
        interviewLatencyTelemetry,
      }),
      { returnDocument: 'after' }
    )
  })
})
