import { describe, it, expect, vi, beforeEach } from 'vitest'

// ─── Mocks ──────────────────────────────────────────────────────────────────

vi.mock('@shared/db/connection', () => ({
  connectDB: vi.fn(),
}))

vi.mock('@shared/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const mockDeleteFromR2 = vi.fn()
vi.mock('@shared/storage/r2', () => ({
  deleteFromR2: (...args: unknown[]) => mockDeleteFromR2(...args),
}))

const mockSessionFindById = vi.fn()
const mockSessionDeleteOne = vi.fn()
vi.mock('@shared/db/models/InterviewSession', () => ({
  InterviewSession: {
    findById: (...args: unknown[]) => mockSessionFindById(...args),
    deleteOne: (...args: unknown[]) => mockSessionDeleteOne(...args),
  },
}))

vi.mock('@shared/db/models/MultimodalAnalysis', () => ({
  MultimodalAnalysis: {
    deleteOne: vi.fn().mockResolvedValue({ deletedCount: 1 }),
  },
}))

// SessionSummary lives in the barrel — mock just the model
vi.mock('@shared/db/models', () => {
  const actual = {
    User: { findById: vi.fn(), deleteOne: vi.fn() },
    InterviewSession: {
      findById: (...args: unknown[]) => mockSessionFindById(...args),
      find: vi.fn(),
      deleteMany: vi.fn().mockResolvedValue({ deletedCount: 0 }),
      deleteOne: (...args: unknown[]) => mockSessionDeleteOne(...args),
    },
    MultimodalAnalysis: {
      deleteOne: vi.fn().mockResolvedValue({ deletedCount: 1 }),
      deleteMany: vi.fn().mockResolvedValue({ deletedCount: 0 }),
    },
    UsageRecord: { deleteMany: vi.fn().mockResolvedValue({ deletedCount: 0 }) },
    WaitlistEntry: { deleteMany: vi.fn().mockResolvedValue({ deletedCount: 0 }) },
    WeaknessCluster: { deleteMany: vi.fn().mockResolvedValue({ deletedCount: 0 }) },
    UserBadge: { deleteMany: vi.fn().mockResolvedValue({ deletedCount: 0 }) },
    PathwayPlan: { deleteMany: vi.fn().mockResolvedValue({ deletedCount: 0 }) },
    WizardSession: { deleteMany: vi.fn().mockResolvedValue({ deletedCount: 0 }) },
    StreakDay: { deleteMany: vi.fn().mockResolvedValue({ deletedCount: 0 }) },
    SessionSummary: {
      deleteOne: vi.fn().mockResolvedValue({ deletedCount: 1 }),
      deleteMany: vi.fn().mockResolvedValue({ deletedCount: 0 }),
    },
    XpEvent: { deleteMany: vi.fn().mockResolvedValue({ deletedCount: 0 }) },
    SavedJobDescription: { deleteMany: vi.fn().mockResolvedValue({ deletedCount: 0 }) },
    DailyChallengeAttempt: { deleteMany: vi.fn().mockResolvedValue({ deletedCount: 0 }) },
    DrillAttempt: { deleteMany: vi.fn().mockResolvedValue({ deletedCount: 0 }) },
    UserCompetencyState: { deleteMany: vi.fn().mockResolvedValue({ deletedCount: 0 }) },
  }
  return actual
})

vi.mock('@shared/db/mongoClient', () => ({
  default: Promise.resolve({
    db: () => ({
      collection: () => ({
        deleteMany: vi.fn().mockResolvedValue({ deletedCount: 0 }),
      }),
    }),
  }),
}))

import { deleteInterviewSession } from '@shared/services/accountDeletion'

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('accountDeletion – R2 key coverage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockDeleteFromR2.mockResolvedValue(undefined)
    mockSessionDeleteOne.mockResolvedValue({ deletedCount: 1 })
  })

  it('deletes audioRecordingR2Key and screenRecordingR2Key when present', async () => {
    mockSessionFindById.mockResolvedValue({
      _id: 'sess-1',
      userId: { toString: () => 'user-1' },
      recordingR2Key: 'video.webm',
      audioRecordingR2Key: 'audio.opus',
      screenRecordingR2Key: 'screen.webm',
      facialLandmarksR2Key: 'facial.json',
      resumeR2Key: undefined,
      jdR2Key: undefined,
    })

    const result = await deleteInterviewSession('507f1f77bcf86cd799439011', 'user-1')

    // All 4 keys should have been passed to deleteFromR2
    expect(mockDeleteFromR2).toHaveBeenCalledWith('video.webm')
    expect(mockDeleteFromR2).toHaveBeenCalledWith('audio.opus')
    expect(mockDeleteFromR2).toHaveBeenCalledWith('screen.webm')
    expect(mockDeleteFromR2).toHaveBeenCalledWith('facial.json')
    expect(mockDeleteFromR2).toHaveBeenCalledTimes(4)
    expect(result.r2KeysDeleted).toBe(4)
  })

  it('skips missing R2 keys without error', async () => {
    mockSessionFindById.mockResolvedValue({
      _id: 'sess-2',
      userId: { toString: () => 'user-1' },
      recordingR2Key: 'video.webm',
      audioRecordingR2Key: undefined,
      screenRecordingR2Key: undefined,
      facialLandmarksR2Key: undefined,
      resumeR2Key: undefined,
      jdR2Key: undefined,
    })

    const result = await deleteInterviewSession('507f1f77bcf86cd799439011', 'user-1')

    expect(mockDeleteFromR2).toHaveBeenCalledTimes(1)
    expect(mockDeleteFromR2).toHaveBeenCalledWith('video.webm')
    expect(result.r2KeysDeleted).toBe(1)
  })
})
