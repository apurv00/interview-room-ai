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

const mockTombstoneAccountUsageBuffers = vi.fn()
vi.mock('@shared/services/usageBuffer', () => ({
  tombstoneAccountUsageBuffers: (...args: unknown[]) =>
    mockTombstoneAccountUsageBuffers(...args),
}))

const mockHireDeletionPreflight = vi.fn()
const mockHireDeletionCommit = vi.fn()
vi.mock('@shared/services/hireMemberDeletionBridgeClient', () => ({
  preflightHireMemberForB2CAccountDeletion: (...args: unknown[]) =>
    mockHireDeletionPreflight(...args),
  commitHireMemberForB2CAccountDeletion: (...args: unknown[]) =>
    mockHireDeletionCommit(...args),
}))

const mockSessionFindById = vi.fn()
const mockSessionFindOneAndDelete = vi.fn()
const mockSessionFind = vi.fn()
const mockSessionDeleteMany = vi.fn().mockResolvedValue({ deletedCount: 0 })
const mockUserFindOneAndUpdate = vi.fn()
const mockUserFindById = vi.fn()
const mockUserExists = vi.fn()
const mockUserDeleteOne = vi.fn().mockResolvedValue({ deletedCount: 1 })
const mockUserUpdateOne = vi.fn().mockResolvedValue({ modifiedCount: 1 })
const mockServedProblemUpdateOne = vi.fn().mockResolvedValue({ acknowledged: true })
const mockEvidenceDistinct = vi.fn()
const mockEvidenceDeleteMany = vi.fn().mockResolvedValue({ deletedCount: 0 })
const mockJobAppUpdateMany = vi.fn().mockResolvedValue({ modifiedCount: 0 })
const mockJobAppDeleteMany = vi.fn().mockResolvedValue({ deletedCount: 0 })
const mockUsageDeleteMany = vi.fn().mockResolvedValue({ deletedCount: 0 })
const mockProductEventDeleteMany = vi.fn().mockResolvedValue({ deletedCount: 0 })
const mockJobsEmailSendDeleteMany = vi.fn().mockResolvedValue({ deletedCount: 0 })
const mockSavedResumeDeleteMany = vi.fn().mockResolvedValue({ deletedCount: 0 })
const mockWeaknessClusterDeleteMany = vi.fn().mockResolvedValue({ deletedCount: 0 })
const mockWaitlistDeleteMany = vi.fn().mockResolvedValue({ deletedCount: 0 })
const mockRawCollectionDeleteMany = vi.fn().mockResolvedValue({ deletedCount: 0 })
const mockUserSelect = vi.fn()
const mockRawCollection = vi.fn((name: string) => ({
  deleteMany: (filter: unknown) => mockRawCollectionDeleteMany(name, filter),
}))

function selectLean(value: unknown) {
  return {
    select: vi.fn().mockImplementation((projection: unknown) => {
      mockUserSelect(projection)
      return {
        lean: vi.fn().mockImplementation(() => Promise.resolve(value)),
      }
    }),
  }
}
vi.mock('@shared/db/models/InterviewSession', () => ({
  InterviewSession: {
    findById: (...args: unknown[]) => mockSessionFindById(...args),
    findOneAndDelete: (...args: unknown[]) => mockSessionFindOneAndDelete(...args),
  },
}))

vi.mock('@shared/db/models/MultimodalAnalysis', () => ({
  MultimodalAnalysis: {
    deleteOne: vi.fn().mockResolvedValue({ deletedCount: 1 }),
  },
}))

vi.mock('@shared/db/models/User', () => ({
  User: {
    findOneAndUpdate: (...args: unknown[]) => mockUserFindOneAndUpdate(...args),
    findById: (...args: unknown[]) => mockUserFindById(...args),
    exists: (...args: unknown[]) => mockUserExists(...args),
    deleteOne: (...args: unknown[]) => mockUserDeleteOne(...args),
    updateOne: (...args: unknown[]) => mockUserUpdateOne(...args),
  },
}))

vi.mock('@shared/db/models/SavedResume', () => ({
  SavedResume: {
    deleteMany: (...args: unknown[]) => mockSavedResumeDeleteMany(...args),
  },
}))

// SessionSummary lives in the barrel — mock just the model
vi.mock('@shared/db/models', () => {
  const actual = {
    User: {
      findOneAndUpdate: (...args: unknown[]) => mockUserFindOneAndUpdate(...args),
      findById: (...args: unknown[]) => mockUserFindById(...args),
      exists: (...args: unknown[]) => mockUserExists(...args),
      deleteOne: (...args: unknown[]) => mockUserDeleteOne(...args),
      updateOne: (...args: unknown[]) => mockUserUpdateOne(...args),
    },
    InterviewSession: {
      findById: (...args: unknown[]) => mockSessionFindById(...args),
      find: (...args: unknown[]) => mockSessionFind(...args),
      deleteMany: (...args: unknown[]) => mockSessionDeleteMany(...args),
      findOneAndDelete: (...args: unknown[]) => mockSessionFindOneAndDelete(...args),
    },
    MultimodalAnalysis: {
      deleteOne: vi.fn().mockResolvedValue({ deletedCount: 1 }),
      deleteMany: vi.fn().mockResolvedValue({ deletedCount: 0 }),
    },
    UsageRecord: { deleteMany: (...args: unknown[]) => mockUsageDeleteMany(...args) },
    WaitlistEntry: { deleteMany: (...args: unknown[]) => mockWaitlistDeleteMany(...args) },
    WeaknessCluster: {
      deleteMany: (...args: unknown[]) => mockWeaknessClusterDeleteMany(...args),
    },
    UserBadge: { deleteMany: vi.fn().mockResolvedValue({ deletedCount: 0 }) },
    PathwayPlan: { deleteMany: vi.fn().mockResolvedValue({ deletedCount: 0 }) },
    WizardSession: { deleteMany: vi.fn().mockResolvedValue({ deletedCount: 0 }) },
    StreakDay: { deleteMany: vi.fn().mockResolvedValue({ deletedCount: 0 }) },
    JobApplication: {
      deleteMany: (...args: unknown[]) => mockJobAppDeleteMany(...args),
      updateMany: (...args: unknown[]) => mockJobAppUpdateMany(...args),
    },
    ProductEvent: { deleteMany: (...args: unknown[]) => mockProductEventDeleteMany(...args) },
    JobsEmailSend: { deleteMany: (...args: unknown[]) => mockJobsEmailSendDeleteMany(...args) },
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

vi.mock('@shared/db/mongoClient', () => {
  const client = {
    db: () => ({
      collection: (name: string) => mockRawCollection(name),
    }),
  }
  return {
    default: Promise.resolve(client),
    getClientPromise: vi.fn().mockResolvedValue(client),
  }
})

import {
  AccountDeletionForbiddenError,
  AccountDeletionIncompleteError,
  deleteInterviewSession,
  deleteUserAccount,
} from '@shared/services/accountDeletion'

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('accountDeletion – R2 key coverage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockDeleteFromR2.mockResolvedValue(undefined)
    mockSessionFindOneAndDelete.mockImplementation(
      () => mockSessionFindById.mock.results[0]?.value ?? null
    )
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
    const authority = {
      ownerUserId: 'user-1',
      sessionId: '507f1f77bcf86cd799439011',
    }
    expect(mockDeleteFromR2).toHaveBeenCalledWith('video.webm', authority)
    expect(mockDeleteFromR2).toHaveBeenCalledWith('audio.opus', authority)
    expect(mockDeleteFromR2).toHaveBeenCalledWith('screen.webm', authority)
    expect(mockDeleteFromR2).toHaveBeenCalledWith('facial.json', authority)
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
    expect(mockDeleteFromR2).toHaveBeenCalledWith('video.webm', {
      ownerUserId: 'user-1',
      sessionId: '507f1f77bcf86cd799439011',
    })
    expect(result.r2KeysDeleted).toBe(1)
  })

  it('deletes an artifact key associated after authorization but before the atomic delete fence', async () => {
    const ownerId = { toString: () => 'user-1' }
    let persistedSession = {
      _id: '507f1f77bcf86cd799439011',
      userId: ownerId,
      audioRecordingR2Key: undefined as string | undefined,
    }
    mockSessionFindById.mockImplementationOnce(async () => ({ ...persistedSession }))
    mockEvidenceDistinct.mockImplementationOnce(async () => {
      persistedSession = {
        ...persistedSession,
        audioRecordingR2Key: 'recordings/late-audio.opus',
      }
      return []
    })
    mockSessionFindOneAndDelete.mockImplementationOnce(async () => ({ ...persistedSession }))

    const result = await deleteInterviewSession('507f1f77bcf86cd799439011', 'user-1')

    expect(mockSessionFindById).toHaveBeenCalledTimes(1)
    expect(mockSessionFindOneAndDelete).toHaveBeenCalledWith({
      _id: '507f1f77bcf86cd799439011',
      userId: 'user-1',
    })
    expect(mockDeleteFromR2).toHaveBeenCalledWith('recordings/late-audio.opus', {
      ownerUserId: 'user-1',
      sessionId: '507f1f77bcf86cd799439011',
    })
    expect(result.r2KeysDeleted).toBe(1)
    expect(mockSessionFindById.mock.invocationCallOrder[0]).toBeLessThan(
      mockEvidenceDistinct.mock.invocationCallOrder[0]
    )
    expect(mockEvidenceDistinct.mock.invocationCallOrder[0]).toBeLessThan(
      mockSessionFindOneAndDelete.mock.invocationCallOrder[0]
    )
    expect(mockSessionFindOneAndDelete.mock.invocationCallOrder[0]).toBeLessThan(
      mockDeleteFromR2.mock.invocationCallOrder[0]
    )
  })

  it('does not delete when ownership changes between authorization and the atomic fence', async () => {
    mockSessionFindById.mockResolvedValue({
      _id: '507f1f77bcf86cd799439011',
      userId: { toString: () => 'user-1' },
      recordingR2Key: 'recordings/original-owner.webm',
    })
    // Models the session being reassigned after the initial authorization
    // read: the owner-constrained atomic delete must miss rather than deleting
    // a row that no longer belongs to the caller.
    mockSessionFindOneAndDelete.mockResolvedValueOnce(null)

    await expect(deleteInterviewSession(
      '507f1f77bcf86cd799439011',
      'user-1',
    )).rejects.toThrow('Session not found')

    expect(mockSessionFindOneAndDelete).toHaveBeenCalledWith({
      _id: '507f1f77bcf86cd799439011',
      userId: 'user-1',
    })
    expect(mockDeleteFromR2).not.toHaveBeenCalled()
    expect(mockEvidenceDeleteMany).not.toHaveBeenCalled()
    expect(mockJobAppUpdateMany).not.toHaveBeenCalled()
  })

  it('reports a cross-session stored key as failed under the exact delete authority', async () => {
    const ownerUserId = '507f1f77bcf86cd799439010'
    const sessionId = '507f1f77bcf86cd799439011'
    const foreignSessionId = '507f1f77bcf86cd799439012'
    const poisonedKey = `recordings/${ownerUserId}/${foreignSessionId}-1721500000000.webm`
    mockSessionFindById.mockResolvedValue({
      _id: sessionId,
      userId: { toString: () => ownerUserId },
      recordingR2Key: poisonedKey,
    })
    mockDeleteFromR2.mockRejectedValueOnce(
      new Error('R2 key is outside the authorized deletion scope'),
    )

    const result = await deleteInterviewSession(sessionId, ownerUserId)

    expect(mockDeleteFromR2).toHaveBeenCalledWith(poisonedKey, {
      ownerUserId,
      sessionId,
    })
    expect(result).toMatchObject({
      r2KeysDeleted: 0,
      r2KeysFailed: 1,
    })
    expect(mockSessionFindOneAndDelete).toHaveBeenCalledWith({
      _id: sessionId,
      userId: ownerUserId,
    })
  })

  it('does not install an account-wide usage tombstone for a single-session deletion', async () => {
    mockSessionFindById.mockResolvedValue({
      _id: 'sess-one',
      userId: { toString: () => 'user-1' },
    })

    await deleteInterviewSession('507f1f77bcf86cd799439011', 'user-1')

    // A user deleting one interview remains active. An account tombstone here
    // would reject usage writes for every other current and future session.
    expect(mockTombstoneAccountUsageBuffers).not.toHaveBeenCalled()
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

  it('redacts a problem id associated after authorization from the document returned by the delete fence', async () => {
    const authorizationOwner = { toString: () => 'user-1' }
    const fencedOwner = { toString: () => 'user-1' }
    let persistedSession = {
      _id: '507f1f77bcf86cd799439011',
      userId: authorizationOwner,
      codingProblemId: undefined as string | undefined,
    }
    mockSessionFindById.mockImplementationOnce(async () => ({ ...persistedSession }))
    mockEvidenceDistinct.mockImplementationOnce(async () => {
      persistedSession = {
        ...persistedSession,
        userId: fencedOwner,
        codingProblemId: 'late-problem-42',
      }
      return []
    })
    mockSessionFindOneAndDelete.mockImplementationOnce(async () => ({ ...persistedSession }))

    await deleteInterviewSession('507f1f77bcf86cd799439011', 'user-1')

    expect(mockServedProblemUpdateOne).toHaveBeenCalledWith(
      {
        userId: fencedOwner,
        kind: 'coding',
        problemId: 'late-problem-42',
      },
      { $unset: { problemBody: 1 } }
    )
    expect(mockSessionFindOneAndDelete.mock.invocationCallOrder[0]).toBeLessThan(
      mockServedProblemUpdateOne.mock.invocationCallOrder[0]
    )
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
    let releaseSessionDelete!: (value: { _id: string; userId: typeof ownerId }) => void
    mockSessionFindOneAndDelete.mockReturnValueOnce(new Promise((resolve) => {
      releaseSessionDelete = resolve
    }))

    const deletion = deleteInterviewSession('507f1f77bcf86cd799439011', 'user-1')
    await vi.waitFor(() => expect(mockSessionFindOneAndDelete).toHaveBeenCalledTimes(1))
    expect(mockEvidenceDeleteMany).not.toHaveBeenCalled()
    expect(mockJobAppUpdateMany).not.toHaveBeenCalled()

    releaseSessionDelete({ _id: 'sess-fence', userId: ownerId })
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
    expect(mockSessionFindOneAndDelete.mock.invocationCallOrder[0]).toBeLessThan(
      mockEvidenceDeleteMany.mock.invocationCallOrder[0]
    )
  })
})

describe('deleteUserAccount – R2 key coverage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockDeleteFromR2.mockResolvedValue(undefined)
    mockUserFindOneAndUpdate.mockReturnValue(selectLean({
      _id: '507f1f77bcf86cd799439011',
      email: 'user@example.com',
      role: 'user',
      accountState: 'deleting',
    }))
    mockUserFindById.mockReturnValue(selectLean(null))
    mockUserExists.mockResolvedValue(null)
    mockUserDeleteOne.mockResolvedValue({ deletedCount: 1 })
    mockSessionDeleteMany.mockResolvedValue({ deletedCount: 0 })
    mockJobAppDeleteMany.mockResolvedValue({ deletedCount: 0 })
    mockEvidenceDeleteMany.mockResolvedValue({ deletedCount: 0 })
    mockUsageDeleteMany.mockResolvedValue({ deletedCount: 0 })
    mockProductEventDeleteMany.mockResolvedValue({ deletedCount: 0 })
    mockJobsEmailSendDeleteMany.mockResolvedValue({ deletedCount: 0 })
    mockSavedResumeDeleteMany.mockResolvedValue({ deletedCount: 0 })
    mockWeaknessClusterDeleteMany.mockResolvedValue({ deletedCount: 0 })
    mockWaitlistDeleteMany.mockResolvedValue({ deletedCount: 0 })
    mockRawCollectionDeleteMany.mockResolvedValue({ deletedCount: 0 })
    mockTombstoneAccountUsageBuffers.mockResolvedValue(undefined)
    mockHireDeletionPreflight.mockResolvedValue({
      operationId: '123e4567-e89b-42d3-a456-426614174000',
      result: { ok: true, action: 'not_linked' },
    })
    mockHireDeletionCommit.mockResolvedValue({ ok: true, action: 'not_linked' })
    mockUserUpdateOne.mockResolvedValue({ modifiedCount: 1 })
  })

  it('preflights Hire before the B2C claim and commits before any personal-data sweep', async () => {
    mockSessionFind.mockReturnValue({ lean: () => Promise.resolve([]) })

    await deleteUserAccount('507f1f77bcf86cd799439011', {
      workspaceConfirmationName: 'Acme',
      acknowledgeWorkspaceDeletion: true,
    })

    expect(mockHireDeletionPreflight).toHaveBeenCalledWith(
      '507f1f77bcf86cd799439011',
      {
        workspaceConfirmationName: 'Acme',
        acknowledgeWorkspaceDeletion: true,
      },
    )
    expect(mockHireDeletionCommit).toHaveBeenCalledWith(
      '507f1f77bcf86cd799439011',
      {
        operationId: '123e4567-e89b-42d3-a456-426614174000',
        workspaceConfirmationName: 'Acme',
        acknowledgeWorkspaceDeletion: true,
      },
    )
    expect(mockHireDeletionPreflight.mock.invocationCallOrder[0]).toBeLessThan(
      mockUserFindOneAndUpdate.mock.invocationCallOrder[0],
    )
    expect(mockUserFindOneAndUpdate.mock.invocationCallOrder[0]).toBeLessThan(
      mockHireDeletionCommit.mock.invocationCallOrder[0],
    )
    expect(mockHireDeletionCommit.mock.invocationCallOrder[0]).toBeLessThan(
      mockSessionFind.mock.invocationCallOrder[0],
    )
  })

  it('does not mutate B2C state when the Hire preflight blocks deletion', async () => {
    const blocked = new Error('transfer first')
    mockHireDeletionPreflight.mockRejectedValueOnce(blocked)

    await expect(
      deleteUserAccount('507f1f77bcf86cd799439011'),
    ).rejects.toBe(blocked)

    expect(mockUserFindOneAndUpdate).not.toHaveBeenCalled()
    expect(mockHireDeletionCommit).not.toHaveBeenCalled()
    expect(mockSessionDeleteMany).not.toHaveBeenCalled()
  })

  it('rolls back a fresh B2C lifecycle claim when the Hire commit loses an authority race', async () => {
    const raced = new Error('member added concurrently')
    mockHireDeletionCommit.mockRejectedValueOnce(raced)

    await expect(
      deleteUserAccount('507f1f77bcf86cd799439011'),
    ).rejects.toBe(raced)

    expect(mockUserUpdateOne).toHaveBeenCalledWith(
      {
        _id: expect.anything(),
        accountState: 'deleting',
        accountDeletionRequestedAt: expect.any(Date),
      },
      {
        $set: { accountState: 'active' },
        $unset: { accountDeletionRequestedAt: 1 },
        $inc: { jobsWriteRevision: 1 },
      },
      { writeConcern: { w: 'majority' } },
    )
    expect(mockSessionFind).not.toHaveBeenCalled()
    expect(mockUserDeleteOne).not.toHaveBeenCalled()
  })

  it('collects the User resume plus every session R2 key and deletes them', async () => {
    mockUserFindOneAndUpdate.mockReturnValueOnce(selectLean({
      _id: '507f1f77bcf86cd799439011',
      email: 'user@example.com',
      role: 'user',
      accountState: 'deleting',
      resumeR2Key: 'user-profile-resume.pdf',
    }))
    // Two sessions, each with all 6 R2 key types — verifies the projection
    // includes the previously-missing audio/screen keys AND the loop pushes
    // them onto the delete list.
    mockSessionFind.mockReturnValue({
      lean: () => Promise.resolve([
        {
          _id: 'sess-1',
          recordingR2Key: 'sess1-video.webm',
          audioRecordingR2Key: 'sess1-audio.opus',
          screenRecordingR2Key: 'sess1-screen.webm',
          facialLandmarksR2Key: 'sess1-facial.json',
          resumeR2Key: 'sess1-resume.pdf',
          jdR2Key: 'sess1-jd.txt',
        },
        {
          _id: 'sess-2',
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

    // User: 1 key, Session 1: 6 keys, Session 2: 3 keys = 10 deletes.
    const authority = { ownerUserId: '507f1f77bcf86cd799439011' }
    expect(mockDeleteFromR2).toHaveBeenCalledWith('user-profile-resume.pdf', authority)
    expect(mockDeleteFromR2).toHaveBeenCalledWith('sess1-audio.opus', authority)
    expect(mockDeleteFromR2).toHaveBeenCalledWith('sess1-screen.webm', authority)
    expect(mockDeleteFromR2).toHaveBeenCalledWith('sess2-audio.opus', authority)
    expect(mockDeleteFromR2).toHaveBeenCalledWith('sess2-screen.webm', authority)
    expect(mockDeleteFromR2).toHaveBeenCalledTimes(10)
    expect(mockTombstoneAccountUsageBuffers).toHaveBeenCalledWith(
      '507f1f77bcf86cd799439011',
      ['sess-1', 'sess-2'],
    )
    expect(result.r2KeysDeleted).toBe(10)
  })

  it('selects resumeR2Key with the durable User lifecycle claim', async () => {
    mockSessionFind.mockReturnValue({ lean: () => Promise.resolve([]) })

    await deleteUserAccount('507f1f77bcf86cd799439011', 'user@example.com')

    expect(mockUserSelect).toHaveBeenCalledWith(
      '_id email role accountState resumeR2Key',
    )
  })

  it('keeps the deleting User and Mongo inventory for a foreign stored R2 key', async () => {
    const ownerUserId = '507f1f77bcf86cd799439011'
    const foreignUserId = '507f1f77bcf86cd799439012'
    const sessionId = '507f1f77bcf86cd799439013'
    const ownResumeKey = `documents/${ownerUserId}/resume/1721500000000-profile.pdf`
    const poisonedKey = `recordings/${foreignUserId}/${sessionId}-1721500000000.webm`
    mockUserFindOneAndUpdate.mockReturnValueOnce(selectLean({
      _id: ownerUserId,
      email: 'user@example.com',
      role: 'user',
      accountState: 'deleting',
      resumeR2Key: ownResumeKey,
    }))
    mockSessionFind.mockReturnValue({
      lean: () => Promise.resolve([
        { _id: sessionId, recordingR2Key: poisonedKey },
      ]),
    })
    mockDeleteFromR2.mockImplementation(async (key: string) => {
      if (key === poisonedKey) {
        throw new Error('R2 key is outside the authorized deletion scope')
      }
    })

    await expect(deleteUserAccount(
      ownerUserId,
      'user@example.com',
    )).rejects.toMatchObject<AccountDeletionIncompleteError>({
      name: 'AccountDeletionIncompleteError',
      failedCollections: ['R2 artifacts'],
    })

    expect(mockDeleteFromR2).toHaveBeenCalledWith(ownResumeKey, { ownerUserId })
    expect(mockDeleteFromR2).toHaveBeenCalledWith(poisonedKey, { ownerUserId })
    expect(mockTombstoneAccountUsageBuffers).toHaveBeenCalledTimes(1)
    expect(mockSessionDeleteMany).not.toHaveBeenCalled()
    expect(mockWeaknessClusterDeleteMany).not.toHaveBeenCalled()
    expect(mockWaitlistDeleteMany).not.toHaveBeenCalled()
    expect(mockRawCollectionDeleteMany).not.toHaveBeenCalled()
    expect(mockJobAppDeleteMany).not.toHaveBeenCalled()
    expect(mockUserDeleteOne).not.toHaveBeenCalled()
  })

  it('handles users with no sessions — no R2 calls, account still deleted', async () => {
    mockSessionFind.mockReturnValue({ lean: () => Promise.resolve([]) })

    const result = await deleteUserAccount('507f1f77bcf86cd799439011', 'user@example.com')

    expect(mockDeleteFromR2).not.toHaveBeenCalled()
    expect(mockTombstoneAccountUsageBuffers).toHaveBeenCalledWith(
      '507f1f77bcf86cd799439011',
      [],
    )
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

  it('deletes collection-backed saved resumes before removing the User fence', async () => {
    const userId = '507f1f77bcf86cd799439011'
    mockSessionFind.mockReturnValue({ lean: () => Promise.resolve([]) })
    mockSavedResumeDeleteMany.mockResolvedValueOnce({ deletedCount: 2 })

    const result = await deleteUserAccount(userId, 'user@example.com')

    const [filter] = mockSavedResumeDeleteMany.mock.calls[0] as [
      { userId: unknown },
    ]
    expect(String(filter.userId)).toBe(userId)
    expect(result.collectionsCleared.SavedResume).toBe(2)
    expect(mockSavedResumeDeleteMany).toHaveBeenCalledTimes(1)
    expect(mockUserDeleteOne).toHaveBeenCalledTimes(1)
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

  it('orders the Redis usage fence after the lifecycle claim and before the Mongo session sweep', async () => {
    mockSessionFind.mockReturnValue({
      lean: () => Promise.resolve([
        { _id: 'sess-before-delete' },
        { _id: 'sess-legacy-buffer' },
      ]),
    })

    await deleteUserAccount('507f1f77bcf86cd799439011', 'user@example.com')

    expect(mockTombstoneAccountUsageBuffers).toHaveBeenCalledWith(
      '507f1f77bcf86cd799439011',
      ['sess-before-delete', 'sess-legacy-buffer'],
    )
    expect(mockUserFindOneAndUpdate.mock.invocationCallOrder[0]).toBeLessThan(
      mockTombstoneAccountUsageBuffers.mock.invocationCallOrder[0],
    )
    expect(mockTombstoneAccountUsageBuffers.mock.invocationCallOrder[0]).toBeLessThan(
      mockSessionDeleteMany.mock.invocationCallOrder[0],
    )
  })

  it('makes the lifecycle marker the first durable mutation', async () => {
    let releaseMarker!: (value: unknown) => void
    const marker = new Promise((resolve) => {
      releaseMarker = resolve
    })
    mockUserFindOneAndUpdate.mockReturnValueOnce(selectLean(marker))
    mockSessionFind.mockReturnValue({ lean: () => Promise.resolve([]) })

    const deletion = deleteUserAccount(
      '507f1f77bcf86cd799439011',
      'stale-session@example.com',
    )
    await vi.waitFor(() => expect(mockUserFindOneAndUpdate).toHaveBeenCalledTimes(1))

    expect(mockSessionFind).not.toHaveBeenCalled()
    expect(mockTombstoneAccountUsageBuffers).not.toHaveBeenCalled()
    expect(mockSessionDeleteMany).not.toHaveBeenCalled()
    expect(mockUsageDeleteMany).not.toHaveBeenCalled()
    expect(mockJobAppDeleteMany).not.toHaveBeenCalled()
    expect(mockUserDeleteOne).not.toHaveBeenCalled()

    releaseMarker({
      _id: '507f1f77bcf86cd799439011',
      email: 'current@example.com',
      role: 'user',
      accountState: 'deleting',
    })
    await deletion

    expect(mockUserFindOneAndUpdate).toHaveBeenCalledWith(
      {
        _id: expect.anything(),
        role: { $ne: 'platform_admin' },
        $or: [
          { accountState: 'active' },
          { accountState: { $exists: false } },
        ],
      },
      {
        $set: {
          accountState: 'deleting',
          accountDeletionRequestedAt: expect.any(Date),
        },
        $inc: { jobsWriteRevision: 1 },
      },
      { new: true, writeConcern: { w: 'majority' } },
    )
    expect(mockUserFindOneAndUpdate.mock.invocationCallOrder[0]).toBeLessThan(
      mockTombstoneAccountUsageBuffers.mock.invocationCallOrder[0],
    )
    expect(mockTombstoneAccountUsageBuffers.mock.invocationCallOrder[0]).toBeLessThan(
      mockSessionDeleteMany.mock.invocationCallOrder[0],
    )
  })

  it('uses current Mongo email authority instead of the stale JWT snapshot', async () => {
    mockUserFindOneAndUpdate.mockReturnValueOnce(selectLean({
      _id: '507f1f77bcf86cd799439011',
      email: 'Current.Email@Example.com ',
      role: 'user',
      accountState: 'deleting',
    }))
    mockSessionFind.mockReturnValue({ lean: () => Promise.resolve([]) })

    const result = await deleteUserAccount(
      '507f1f77bcf86cd799439011',
      'stale-jwt@example.com',
    )

    expect(result.email).toBe('current.email@example.com')
    expect(mockWaitlistDeleteMany).toHaveBeenCalledWith({
      email: 'current.email@example.com',
    })
    expect(mockRawCollectionDeleteMany).toHaveBeenCalledWith(
      'verification_tokens',
      { identifier: 'current.email@example.com' },
    )
    expect(mockRawCollectionDeleteMany).not.toHaveBeenCalledWith(
      'verification_tokens',
      { identifier: 'stale-jwt@example.com' },
    )
  })

  it('uses the current Mongo role and refuses a platform-admin deletion', async () => {
    mockUserFindOneAndUpdate.mockReturnValueOnce(selectLean(null))
    mockUserFindById.mockReturnValueOnce(selectLean({
      _id: '507f1f77bcf86cd799439011',
      email: 'admin@example.com',
      role: 'platform_admin',
      accountState: 'active',
    }))

    await expect(deleteUserAccount(
      '507f1f77bcf86cd799439011',
      'ordinary-user-from-stale-jwt@example.com',
    )).rejects.toBeInstanceOf(AccountDeletionForbiddenError)

    expect(mockSessionFind).not.toHaveBeenCalled()
    expect(mockSessionDeleteMany).not.toHaveBeenCalled()
    expect(mockJobAppDeleteMany).not.toHaveBeenCalled()
    expect(mockUserDeleteOne).not.toHaveBeenCalled()
  })

  it('resumes a prior deletion attempt while the durable marker is deleting', async () => {
    mockUserFindOneAndUpdate.mockReturnValueOnce(selectLean(null))
    mockUserFindById.mockReturnValueOnce(selectLean({
      _id: '507f1f77bcf86cd799439011',
      email: 'retry@example.com',
      role: 'user',
      accountState: 'deleting',
    }))
    mockSessionFind.mockReturnValue({ lean: () => Promise.resolve([]) })

    await expect(deleteUserAccount(
      '507f1f77bcf86cd799439011',
      'stale@example.com',
    )).resolves.toMatchObject({ email: 'retry@example.com' })

    expect(mockUserFindById).toHaveBeenCalledWith(expect.anything())
    expect(mockUserSelect).toHaveBeenCalledTimes(2)
    expect(mockUserSelect).toHaveBeenNthCalledWith(
      1,
      '_id email role accountState resumeR2Key',
    )
    expect(mockUserSelect).toHaveBeenNthCalledWith(
      2,
      '_id email role accountState resumeR2Key',
    )
    expect(mockJobAppDeleteMany).toHaveBeenCalledTimes(1)
    expect(mockUserDeleteOne).toHaveBeenCalledWith({
      _id: expect.anything(),
      accountState: 'deleting',
    })
  })

  it('re-sweeps orphaned user data before treating a missing User as idempotently deleted', async () => {
    mockUserFindOneAndUpdate.mockReturnValueOnce(selectLean(null))
    mockUserFindById.mockReturnValueOnce(selectLean(null))
    mockUserDeleteOne.mockResolvedValueOnce({ deletedCount: 0 })
    mockSessionFind.mockReturnValue({
      lean: () => Promise.resolve([{ _id: 'orphan-session', recordingR2Key: 'orphan-recording.webm' }]),
    })

    const result = await deleteUserAccount('507f1f77bcf86cd799439011')

    expect(result).toMatchObject({
      userId: '507f1f77bcf86cd799439011',
      email: '',
      alreadyDeleted: true,
    })
    expect(mockDeleteFromR2).toHaveBeenCalledWith('orphan-recording.webm', {
      ownerUserId: '507f1f77bcf86cd799439011',
    })
    expect(mockSessionDeleteMany).toHaveBeenCalledTimes(1)
    expect(mockUsageDeleteMany).toHaveBeenCalledTimes(1)
    expect(mockProductEventDeleteMany).toHaveBeenCalledTimes(1)
    expect(mockJobsEmailSendDeleteMany).toHaveBeenCalledTimes(1)
    expect(mockEvidenceDeleteMany).toHaveBeenCalledTimes(1)
    expect(mockJobAppDeleteMany).toHaveBeenCalledTimes(1)
    expect(mockUserExists).toHaveBeenCalledWith({ _id: expect.anything() })
    expect(mockRawCollectionDeleteMany).toHaveBeenCalledWith(
      'accounts',
      { userId: expect.anything() },
    )
    expect(mockRawCollectionDeleteMany).toHaveBeenCalledWith(
      'sessions',
      { userId: expect.anything() },
    )
    expect(mockRawCollectionDeleteMany).not.toHaveBeenCalledWith(
      'verification_tokens',
      { identifier: '' },
    )
  })

  it('does not claim a missing User is deleted when its compensating Jobs sweep fails', async () => {
    mockUserFindOneAndUpdate.mockReturnValueOnce(selectLean(null))
    mockUserFindById.mockReturnValueOnce(selectLean(null))
    mockSessionFind.mockReturnValue({ lean: () => Promise.resolve([]) })
    mockJobAppDeleteMany.mockRejectedValueOnce(new Error('orphan sweep unavailable'))

    await expect(deleteUserAccount('507f1f77bcf86cd799439011')).rejects.toMatchObject({
      name: 'AccountDeletionIncompleteError',
      failedCollections: ['JobApplication'],
    })
    expect(mockUserDeleteOne).not.toHaveBeenCalled()
  })

  it('keeps the deleting user fence when a mandatory Jobs sweep fails', async () => {
    mockSessionFind.mockReturnValue({ lean: () => Promise.resolve([]) })
    mockUsageDeleteMany.mockRejectedValueOnce(new Error('usage sweep unavailable'))

    await expect(deleteUserAccount(
      '507f1f77bcf86cd799439011',
      'user@example.com',
    )).rejects.toMatchObject<AccountDeletionIncompleteError>({
      name: 'AccountDeletionIncompleteError',
      failedCollections: ['UsageRecord'],
    })

    expect(mockJobAppDeleteMany).toHaveBeenCalledTimes(1)
    expect(mockUserDeleteOne).not.toHaveBeenCalled()
  })

  it('keeps the deleting user fence when a non-Jobs cascade fails', async () => {
    mockSessionFind.mockReturnValue({ lean: () => Promise.resolve([]) })
    mockWeaknessClusterDeleteMany.mockRejectedValueOnce(
      new Error('weakness-cluster sweep unavailable'),
    )

    await expect(deleteUserAccount(
      '507f1f77bcf86cd799439011',
      'user@example.com',
    )).rejects.toMatchObject<AccountDeletionIncompleteError>({
      name: 'AccountDeletionIncompleteError',
      failedCollections: ['WeaknessCluster'],
    })

    expect(mockJobAppDeleteMany).toHaveBeenCalledTimes(1)
    expect(mockUserDeleteOne).not.toHaveBeenCalled()
  })

  it('keeps the deleting user fence when the email-keyed Waitlist sweep fails', async () => {
    mockSessionFind.mockReturnValue({ lean: () => Promise.resolve([]) })
    mockWaitlistDeleteMany.mockRejectedValueOnce(new Error('waitlist sweep unavailable'))

    await expect(deleteUserAccount(
      '507f1f77bcf86cd799439011',
      'user@example.com',
    )).rejects.toMatchObject<AccountDeletionIncompleteError>({
      name: 'AccountDeletionIncompleteError',
      failedCollections: ['WaitlistEntry'],
    })

    expect(mockJobAppDeleteMany).toHaveBeenCalledTimes(1)
    expect(mockUserDeleteOne).not.toHaveBeenCalled()
  })

  it('keeps the deleting user fence when NextAuth adapter cleanup fails', async () => {
    mockSessionFind.mockReturnValue({ lean: () => Promise.resolve([]) })
    mockRawCollectionDeleteMany.mockImplementation(async (name: string) => {
      if (name === 'accounts') throw new Error('NextAuth store unavailable')
      return { deletedCount: 0 }
    })

    await expect(deleteUserAccount(
      '507f1f77bcf86cd799439011',
      'user@example.com',
    )).rejects.toMatchObject<AccountDeletionIncompleteError>({
      name: 'AccountDeletionIncompleteError',
      failedCollections: [
        'nextauth.accounts',
        'nextauth.sessions',
        'nextauth.verification_tokens',
      ],
    })

    expect(mockJobAppDeleteMany).toHaveBeenCalledTimes(1)
    expect(mockUserDeleteOne).not.toHaveBeenCalled()
  })

  it('keeps the deleting user fence when the mandatory Redis usage fence fails', async () => {
    mockSessionFind.mockReturnValue({
      lean: () => Promise.resolve([{ _id: 'sess-buffered' }]),
    })
    mockTombstoneAccountUsageBuffers.mockRejectedValueOnce(new Error('redis unavailable'))

    await expect(deleteUserAccount(
      '507f1f77bcf86cd799439011',
      'user@example.com',
    )).rejects.toMatchObject<AccountDeletionIncompleteError>({
      name: 'AccountDeletionIncompleteError',
      failedCollections: ['UsageBuffer'],
    })

    // Mongo sweeps still make progress, while retaining the lifecycle row so
    // a retry can re-establish the Redis tombstone safely.
    expect(mockSessionDeleteMany).toHaveBeenCalledTimes(1)
    expect(mockJobAppDeleteMany).toHaveBeenCalledTimes(1)
    expect(mockUserDeleteOne).not.toHaveBeenCalled()
  })

  it('keeps the deleting user fence when the interview-session sweep fails', async () => {
    mockSessionFind.mockReturnValue({ lean: () => Promise.resolve([]) })
    mockSessionDeleteMany.mockRejectedValueOnce(new Error('session sweep unavailable'))

    await expect(deleteUserAccount(
      '507f1f77bcf86cd799439011',
      'user@example.com',
    )).rejects.toMatchObject<AccountDeletionIncompleteError>({
      name: 'AccountDeletionIncompleteError',
      failedCollections: ['InterviewSession'],
    })

    expect(mockJobAppDeleteMany).toHaveBeenCalledTimes(1)
    expect(mockUserDeleteOne).not.toHaveBeenCalled()
  })

  it('completes session deletion and every mandatory Jobs sweep before deleting the user fence', async () => {
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
    expect(mockUsageDeleteMany).toHaveBeenCalledTimes(1)
    expect(mockProductEventDeleteMany).toHaveBeenCalledTimes(1)
    expect(mockJobsEmailSendDeleteMany).toHaveBeenCalledTimes(1)
    for (const mandatorySweep of [
      mockUsageDeleteMany,
      mockProductEventDeleteMany,
      mockJobsEmailSendDeleteMany,
      mockEvidenceDeleteMany,
      mockJobAppDeleteMany,
    ]) {
      expect(mandatorySweep.mock.invocationCallOrder[0]).toBeLessThan(
        mockUserDeleteOne.mock.invocationCallOrder[0],
      )
    }
    expect(mockUserDeleteOne).toHaveBeenCalledWith({
      _id: expect.anything(),
      accountState: 'deleting',
    })
  })

  it('fails closed when the final conditional delete misses but the lifecycle row still exists', async () => {
    mockSessionFind.mockReturnValue({ lean: () => Promise.resolve([]) })
    mockUserDeleteOne.mockResolvedValueOnce({ deletedCount: 0 })
    mockUserExists.mockResolvedValueOnce({ _id: '507f1f77bcf86cd799439011' })

    await expect(deleteUserAccount(
      '507f1f77bcf86cd799439011',
      'user@example.com',
    )).rejects.toMatchObject<AccountDeletionIncompleteError>({
      name: 'AccountDeletionIncompleteError',
      failedCollections: ['User'],
    })

    expect(mockUserExists).toHaveBeenCalledWith({ _id: expect.anything() })
  })

  it('accepts a final delete miss when a concurrent retry already removed the user', async () => {
    mockSessionFind.mockReturnValue({ lean: () => Promise.resolve([]) })
    mockUserDeleteOne.mockResolvedValueOnce({ deletedCount: 0 })
    mockUserExists.mockResolvedValueOnce(null)

    await expect(deleteUserAccount(
      '507f1f77bcf86cd799439011',
      'user@example.com',
    )).resolves.toMatchObject({
      collectionsCleared: expect.objectContaining({ User: 0 }),
    })

    expect(mockUserExists).toHaveBeenCalledWith({ _id: expect.anything() })
  })
})
