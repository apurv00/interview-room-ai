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
const mockSessionDeleteMany = vi.fn().mockResolvedValue({ deletedCount: 0 })
const mockUserDeleteOne = vi.fn().mockResolvedValue({ deletedCount: 1 })
const mockServedProblemUpdateOne = vi.fn().mockResolvedValue({ acknowledged: true })
const mockEvidenceDistinct = vi.fn()
const mockEvidenceDeleteMany = vi.fn().mockResolvedValue({ deletedCount: 0 })
const mockJobAppUpdateMany = vi.fn().mockResolvedValue({ modifiedCount: 0 })
const mockJobAppDeleteMany = vi.fn().mockResolvedValue({ deletedCount: 0 })
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
      deleteMany: (...args: unknown[]) => mockSessionDeleteMany(...args),
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
    JobApplication: {
      deleteMany: (...args: unknown[]) => mockJobAppDeleteMany(...args),
      updateMany: (...args: unknown[]) => mockJobAppUpdateMany(...args),
    },
    ProductEvent: { deleteMany: vi.fn().mockResolvedValue({ deletedCount: 0 }) },
    JobsEmailSend: { deleteMany: vi.fn().mockResolvedValue({ deletedCount: 0 }) },
    JobPracticeEvidence: {
      deleteMany: (...args: unknown[]) => mockEvidenceDeleteMany(...args),
      distinct: (...args: unknown[]) => mockEvidenceDistinct(...args),
    },
    LessonEngagement: { deleteMany: vi.fn().mockResolvedValue({ deletedCount: 0 }) },
    SessionSummary: {
      deleteOne: vi.fn().mockResolvedValue({ deletedCount: 1 }),
      deleteMany: vi.fn().mockResolvedValue({ deletedCount: 0 }),
    },
    XpEvent: { deleteMany: vi.fn().mockResolvedValue({ deletedCount: 0 }) },
    DailyChallengeAttempt: { deleteMany: vi.fn().mockResolvedValue({ deletedCount: 0 }) },
    DrillAttempt: { deleteMany: vi.fn().mockResolvedValue({ deletedCount: 0 }) },
    UserCompetencyState: { deleteMany: vi.fn().mockResolvedValue({ deletedCount: 0 }) },
    ServedProblem: {
      deleteMany: vi.fn().mockResolvedValue({ deletedCount: 2 }),
      updateOne: (...args: unknown[]) => mockServedProblemUpdateOne(...args),
    },
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
    mockEvidenceDistinct.mockResolvedValue([])
    mockEvidenceDeleteMany.mockResolvedValue({ deletedCount: 0 })
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

  it('redacts the served-problem body for a coding session, keeping the no-repeat row (Codex P2 on #485)', async () => {
    mockSessionFindById.mockResolvedValue({
      _id: 'sess-3',
      userId: { toString: () => 'user-1' },
      codingProblemId: 'ai-gen-42',
    })

    await deleteInterviewSession('507f1f77bcf86cd799439011', 'user-1')

    expect(mockServedProblemUpdateOne).toHaveBeenCalledTimes(1)
    const [filter, update] = mockServedProblemUpdateOne.mock.calls[0]
    expect(filter).toMatchObject({ kind: 'coding', problemId: 'ai-gen-42' })
    // Body redacted, row NOT deleted — the id must survive for no-repeat.
    expect(update).toEqual({ $unset: { problemBody: 1 } })
  })

  it('does not touch the ledger for sessions without problem ids', async () => {
    mockSessionFindById.mockResolvedValue({
      _id: 'sess-4',
      userId: { toString: () => 'user-1' },
    })

    await deleteInterviewSession('507f1f77bcf86cd799439011', 'user-1')

    expect(mockServedProblemUpdateOne).not.toHaveBeenCalled()
  })

  it('clears the readiness snapshot on applications fed by the deleted session (Codex #538 r2)', async () => {
    mockSessionFindById.mockResolvedValue({
      _id: 'sess-5',
      userId: { toString: () => 'user-1' },
    })
    // A band derived from deleted answers must not survive the delete —
    // absent snapshot = "no claims"; next attribution write rebuilds it.
    mockEvidenceDistinct.mockResolvedValue([
      '507f1f77bcf86cd799439021',
      '507f1f77bcf86cd799439022',
    ])

    await deleteInterviewSession('507f1f77bcf86cd799439011', 'user-1')

    expect(mockEvidenceDistinct).toHaveBeenCalledWith('applicationId', { sessionId: expect.anything() })
    expect(mockJobAppUpdateMany).toHaveBeenCalledWith(
      {
        _id: { $in: ['507f1f77bcf86cd799439021', '507f1f77bcf86cd799439022'] },
        userId: expect.anything(),
      },
      { $unset: { readiness: 1 }, $inc: { readinessRevision: 1 } }
    )
  })

  it('clears readiness from a late-attached application in the final ticker mutation', async () => {
    const userId = { toString: () => 'user-1' }
    mockSessionFindById.mockResolvedValue({
      _id: 'sess-readiness-race',
      userId,
    })
    mockEvidenceDistinct.mockResolvedValue([])

    await deleteInterviewSession('507f1f77bcf86cd799439011', 'user-1')

    expect(mockJobAppUpdateMany).toHaveBeenCalledWith(
      {
        userId,
        $or: [
          { practiceSessionIds: '507f1f77bcf86cd799439011' },
          { verifiedPracticeSessionIds: '507f1f77bcf86cd799439011' },
        ],
      },
      {
        $unset: { readiness: 1 },
        $inc: { readinessRevision: 1 },
        $pull: {
          practiceSessionIds: '507f1f77bcf86cd799439011',
          verifiedPracticeSessionIds: '507f1f77bcf86cd799439011',
        },
      }
    )
  })

  it('ignores a malformed legacy attribution applicationId and still completes the ticker fence', async () => {
    const userId = { toString: () => 'user-1' }
    mockSessionFindById.mockResolvedValue({
      _id: 'sess-legacy-attribution',
      userId,
      attribution: { source: 'jobs', applicationId: 'browser-not-an-object-id' },
    })
    mockEvidenceDistinct.mockResolvedValue([])

    await expect(
      deleteInterviewSession('507f1f77bcf86cd799439011', 'user-1')
    ).resolves.toMatchObject({ sessionId: '507f1f77bcf86cd799439011' })

    expect(mockJobAppUpdateMany).toHaveBeenCalledWith(
      {
        userId,
        $or: [
          { practiceSessionIds: '507f1f77bcf86cd799439011' },
          { verifiedPracticeSessionIds: '507f1f77bcf86cd799439011' },
        ],
      },
      {
        $unset: { readiness: 1 },
        $inc: { readinessRevision: 1 },
        $pull: {
          practiceSessionIds: '507f1f77bcf86cd799439011',
          verifiedPracticeSessionIds: '507f1f77bcf86cd799439011',
        },
      }
    )
  })

  it('pulls the deleted session from both historical and verified practice arrays', async () => {
    const userId = { toString: () => 'user-1' }
    mockSessionFindById.mockResolvedValue({ _id: 'sess-7', userId })

    await deleteInterviewSession('507f1f77bcf86cd799439011', 'user-1')

    expect(mockJobAppUpdateMany).toHaveBeenCalledWith(
      {
        userId,
        $or: [
          { practiceSessionIds: '507f1f77bcf86cd799439011' },
          { verifiedPracticeSessionIds: '507f1f77bcf86cd799439011' },
        ],
      },
      {
        $unset: { readiness: 1 },
        $inc: { readinessRevision: 1 },
        $pull: {
          practiceSessionIds: '507f1f77bcf86cd799439011',
          verifiedPracticeSessionIds: '507f1f77bcf86cd799439011',
        },
      }
    )
  })

  it('sessions with no initial evidence skip the stale-id update but retain the final ticker fence', async () => {
    mockSessionFindById.mockResolvedValue({
      _id: 'sess-6',
      userId: { toString: () => 'user-1' },
    })

    await deleteInterviewSession('507f1f77bcf86cd799439011', 'user-1')

    expect(mockJobAppUpdateMany.mock.calls.some((c) => '_id' in (c[0] as object))).toBe(false)
    expect(mockJobAppUpdateMany).toHaveBeenCalledWith(
      {
        userId: expect.anything(),
        $or: [
          { practiceSessionIds: '507f1f77bcf86cd799439011' },
          { verifiedPracticeSessionIds: '507f1f77bcf86cd799439011' },
        ],
      },
      expect.objectContaining({
        $unset: { readiness: 1 },
        $inc: { readinessRevision: 1 },
      })
    )
  })

  it('establishes the session-deletion fence before sweeping evidence', async () => {
    const ownerId = { toString: () => 'user-1' }
    mockSessionFindById.mockResolvedValue({
      _id: 'sess-fence',
      userId: ownerId,
    })
    let releaseSessionDelete!: (value: { deletedCount: number }) => void
    mockSessionDeleteOne.mockReturnValueOnce(new Promise((resolve) => {
      releaseSessionDelete = resolve
    }))

    const deletion = deleteInterviewSession('507f1f77bcf86cd799439011', 'user-1')
    await vi.waitFor(() => expect(mockSessionDeleteOne).toHaveBeenCalledTimes(1))
    expect(mockEvidenceDeleteMany).not.toHaveBeenCalled()
    expect(mockJobAppUpdateMany).not.toHaveBeenCalled()

    releaseSessionDelete({ deletedCount: 1 })
    await deletion

    expect(mockEvidenceDeleteMany).toHaveBeenCalledWith({
      sessionId: '507f1f77bcf86cd799439011',
    })
    expect(mockJobAppUpdateMany).toHaveBeenCalledWith(
      {
        userId: ownerId,
        $or: [
          { practiceSessionIds: '507f1f77bcf86cd799439011' },
          { verifiedPracticeSessionIds: '507f1f77bcf86cd799439011' },
        ],
      },
      {
        $unset: { readiness: 1 },
        $inc: { readinessRevision: 1 },
        $pull: {
          practiceSessionIds: '507f1f77bcf86cd799439011',
          verifiedPracticeSessionIds: '507f1f77bcf86cd799439011',
        },
      }
    )
    expect(mockSessionDeleteOne.mock.invocationCallOrder[0]).toBeLessThan(
      mockEvidenceDeleteMany.mock.invocationCallOrder[0]
    )
  })
})

describe('deleteUserAccount – R2 key coverage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockDeleteFromR2.mockResolvedValue(undefined)
    mockUserDeleteOne.mockResolvedValue({ deletedCount: 1 })
    mockSessionDeleteMany.mockResolvedValue({ deletedCount: 0 })
    mockJobAppDeleteMany.mockResolvedValue({ deletedCount: 0 })
    mockEvidenceDeleteMany.mockResolvedValue({ deletedCount: 0 })
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

  it('cascades the ServedProblem ledger (Codex P1 on #485 — GDPR promise covers every user-keyed collection)', async () => {
    mockSessionFind.mockReturnValue({ lean: () => Promise.resolve([]) })

    const result = await deleteUserAccount('507f1f77bcf86cd799439011', 'user@example.com')

    // The ledger stores userId, interview metadata, and (for AI picks) the
    // full problem body — it must not survive DELETE /api/account.
    expect(result.collectionsCleared['ServedProblem']).toBe(2)
    // Legacy SavedJobDescription purge must stay in the cascade until the
    // prod collection is confirmed dropped (Codex on #506) — raw collection
    // path counts 0 here (no live connection in tests), but the KEY existing
    // proves the entry wasn't removed.
    expect(result.collectionsCleared).toHaveProperty('SavedJobDescription (legacy)')
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

  it('completes session deletion and closes the user fence before the final application sweep', async () => {
    mockSessionFind.mockReturnValue({ lean: () => Promise.resolve([]) })
    let releaseSessionDelete!: (value: { deletedCount: number }) => void
    mockSessionDeleteMany.mockReturnValueOnce(new Promise((resolve) => {
      releaseSessionDelete = resolve
    }))

    const deletion = deleteUserAccount('507f1f77bcf86cd799439011', 'user@example.com')
    await vi.waitFor(() => expect(mockSessionDeleteMany).toHaveBeenCalledTimes(1))
    expect(mockEvidenceDeleteMany).not.toHaveBeenCalled()
    expect(mockUserDeleteOne).not.toHaveBeenCalled()
    expect(mockJobAppDeleteMany).not.toHaveBeenCalled()

    releaseSessionDelete({ deletedCount: 1 })
    await deletion

    expect(mockEvidenceDeleteMany).toHaveBeenCalledTimes(1)
    expect(mockUserDeleteOne).toHaveBeenCalledTimes(1)
    expect(mockJobAppDeleteMany).toHaveBeenCalledTimes(1)
    expect(mockUserDeleteOne.mock.invocationCallOrder[0]).toBeLessThan(
      mockJobAppDeleteMany.mock.invocationCallOrder[0]
    )
  })
})
