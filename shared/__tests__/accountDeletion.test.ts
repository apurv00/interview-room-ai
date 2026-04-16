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
const mockSessionFind = vi.fn()
const mockUserDeleteOne = vi.fn().mockResolvedValue({ deletedCount: 1 })
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

vi.mock('@shared/db/models/User', () => ({
  User: { deleteOne: (...args: unknown[]) => mockUserDeleteOne(...args) },
}))

// SessionSummary lives in the barrel — mock just the model
vi.mock('@shared/db/models', () => {
  const actual = {
    User: { findById: vi.fn(), deleteOne: (...args: unknown[]) => mockUserDeleteOne(...args) },
    InterviewSession: {
      findById: (...args: unknown[]) => mockSessionFindById(...args),
      find: (...args: unknown[]) => mockSessionFind(...args),
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

import { deleteInterviewSession, deleteUserAccount } from '@shared/services/accountDeletion'

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

describe('deleteUserAccount – R2 key coverage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockDeleteFromR2.mockResolvedValue(undefined)
    mockUserDeleteOne.mockResolvedValue({ deletedCount: 1 })
  })

  it('collects audioRecordingR2Key and screenRecordingR2Key from every session and deletes them', async () => {
    // Two sessions, each with all 6 R2 key types — verifies the projection
    // includes the previously-missing audio/screen keys AND the loop pushes
    // them onto the delete list.
    mockSessionFind.mockReturnValue({
      lean: () => Promise.resolve([
        {
          recordingR2Key: 'sess1-video.webm',
          audioRecordingR2Key: 'sess1-audio.opus',
          screenRecordingR2Key: 'sess1-screen.webm',
          facialLandmarksR2Key: 'sess1-facial.json',
          resumeR2Key: 'sess1-resume.pdf',
          jdR2Key: 'sess1-jd.txt',
        },
        {
          recordingR2Key: 'sess2-video.webm',
          audioRecordingR2Key: 'sess2-audio.opus',
          screenRecordingR2Key: 'sess2-screen.webm',
          facialLandmarksR2Key: undefined,
          resumeR2Key: undefined,
          jdR2Key: undefined,
        },
      ]),
    })

    const result = await deleteUserAccount('507f1f77bcf86cd799439011', 'user@example.com')

    // Session 1: 6 keys, Session 2: 3 keys = 9 total deleteFromR2 calls
    expect(mockDeleteFromR2).toHaveBeenCalledWith('sess1-audio.opus')
    expect(mockDeleteFromR2).toHaveBeenCalledWith('sess1-screen.webm')
    expect(mockDeleteFromR2).toHaveBeenCalledWith('sess2-audio.opus')
    expect(mockDeleteFromR2).toHaveBeenCalledWith('sess2-screen.webm')
    expect(mockDeleteFromR2).toHaveBeenCalledTimes(9)
    expect(result.r2KeysDeleted).toBe(9)
  })

  it('handles users with no sessions — no R2 calls, account still deleted', async () => {
    mockSessionFind.mockReturnValue({ lean: () => Promise.resolve([]) })

    const result = await deleteUserAccount('507f1f77bcf86cd799439011', 'user@example.com')

    expect(mockDeleteFromR2).not.toHaveBeenCalled()
    expect(result.r2KeysDeleted).toBe(0)
    expect(result.collectionsCleared['User']).toBe(1)
  })

  it('projection requested by InterviewSession.find includes audio and screen keys', async () => {
    mockSessionFind.mockReturnValue({ lean: () => Promise.resolve([]) })

    await deleteUserAccount('507f1f77bcf86cd799439011', 'user@example.com')

    // Verify the projection sent to MongoDB includes the previously-missing
    // fields. Without this, even if the loop checked them, Mongoose would
    // strip them from the lean docs and they'd be undefined → never deleted.
    expect(mockSessionFind).toHaveBeenCalledTimes(1)
    const projection = mockSessionFind.mock.calls[0][1]
    expect(projection).toMatchObject({
      recordingR2Key: 1,
      audioRecordingR2Key: 1,
      screenRecordingR2Key: 1,
      facialLandmarksR2Key: 1,
      resumeR2Key: 1,
      jdR2Key: 1,
    })
  })
})
