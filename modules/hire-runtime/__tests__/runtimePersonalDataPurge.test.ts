import mongoose from 'mongoose'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const MODEL_NAMES = [
  'MultimodalAnalysis',
  'UsageRecord',
  'ScoreTelemetry',
  'WeaknessCluster',
  'UserBadge',
  'PathwayPlan',
  'WizardSession',
  'StreakDay',
  'SessionSummary',
  'XpEvent',
  'DailyChallengeAttempt',
  'DrillAttempt',
  'UserCompetencyState',
  'ServedProblem',
  'SavedResume',
  'LessonEngagement',
  'ProductEvent',
  'JobsEmailSend',
  'JobPracticeEvidence',
  'JobApplication',
] as const

const mocks = vi.hoisted(() => {
  const names = [
    'MultimodalAnalysis', 'UsageRecord', 'ScoreTelemetry', 'WeaknessCluster',
    'UserBadge', 'PathwayPlan', 'WizardSession', 'StreakDay', 'SessionSummary',
    'XpEvent', 'DailyChallengeAttempt', 'DrillAttempt', 'UserCompetencyState',
    'ServedProblem', 'SavedResume', 'LessonEngagement', 'ProductEvent',
    'JobsEmailSend', 'JobPracticeEvidence', 'JobApplication',
  ]
  return {
    events: [] as string[],
    models: Object.fromEntries(names.map((name) => [name, {
      modelName: name,
      deleteMany: vi.fn(),
    }])) as Record<string, { modelName: string; deleteMany: ReturnType<typeof vi.fn> }>,
    sessionFind: vi.fn(),
    sessionDelete: vi.fn(),
    userUpdate: vi.fn(),
    userFind: vi.fn(),
    userDelete: vi.fn(),
    userExists: vi.fn(),
    usageFence: vi.fn(),
    redisDelete: vi.fn(),
    abortMultipart: vi.fn(),
    deleteObjects: vi.fn(),
    assertDrained: vi.fn(),
    bindingExists: vi.fn(),
    rawDelete: vi.fn(),
  }
})

vi.mock('@shared/db/models', () => ({
  ...mocks.models,
  InterviewSession: {
    find: mocks.sessionFind,
    deleteMany: mocks.sessionDelete,
  },
  User: {
    updateOne: mocks.userUpdate,
    findOne: mocks.userFind,
    deleteOne: mocks.userDelete,
    exists: mocks.userExists,
  },
}))
vi.mock('@shared/db/models/SavedResume', () => ({
  SavedResume: mocks.models.SavedResume,
}))
vi.mock('@shared/services/usageBuffer', () => ({
  tombstoneAccountUsageBuffers: mocks.usageFence,
}))
vi.mock('@shared/redis', () => ({
  redis: { del: mocks.redisDelete },
}))
vi.mock('../services/runtimeMediaManifest', () => ({
  abortRuntimeMultipartUploads: mocks.abortMultipart,
  deleteRuntimePersonalObjects: mocks.deleteObjects,
}))
vi.mock('../services/runtimeWriteFence', () => ({
  assertRuntimeWritesDrained: mocks.assertDrained,
}))
vi.mock('../models/HireRuntimeBinding', () => ({
  HireRuntimeBinding: { exists: mocks.bindingExists },
}))

import {
  __runtimePersonalDataPurge,
  purgeRuntimePrincipalData,
} from '../services/runtimePersonalDataPurge'

const originalDbDescriptor = Object.getOwnPropertyDescriptor(mongoose.connection, 'db')
const PRINCIPAL_ID = new mongoose.Types.ObjectId('a'.repeat(24))
const SESSION_ID = new mongoose.Types.ObjectId('b'.repeat(24))
const ROUND_ID = 'c'.repeat(24)
const WORKSPACE_ID = new mongoose.Types.ObjectId('f'.repeat(24))
const APPLICATION_ID = new mongoose.Types.ObjectId('1'.repeat(24))
const CAMERA_KEY = `recordings/${PRINCIPAL_ID}/${SESSION_ID}-1723248000000.webm`
const AUDIO_KEY = `recordings/${PRINCIPAL_ID}/${SESSION_ID}-audio-1723248000001.webm`

function selected(value: unknown) {
  return { select: () => ({ lean: async () => value }) }
}

function binding(overrides: Record<string, unknown> = {}) {
  return {
    _id: new mongoose.Types.ObjectId('d'.repeat(24)),
    workspaceId: WORKSPACE_ID,
    applicationId: APPLICATION_ID,
    roundId: new mongoose.Types.ObjectId(ROUND_ID),
    principalId: PRINCIPAL_ID,
    status: 'revoked',
    purgePersonalData: true,
    runtimeSessionId: SESSION_ID,
    issuedObjectCapabilities: [{
      key: AUDIO_KEY,
      runtimeSessionId: SESSION_ID,
      expiresAt: new Date('2026-08-10T00:00:00.000Z'),
    }],
    issuedMultipartCapabilities: [{
      key: AUDIO_KEY,
      runtimeSessionId: SESSION_ID,
      uploadId: 'upload-1',
      expiresAt: new Date('2026-08-10T00:00:00.000Z'),
    }],
    pendingMediaManifest: [{
      kind: 'recording',
      sourceKey: CAMERA_KEY,
      contentType: 'video/webm',
      sizeBytes: 100,
      sha256: 'e'.repeat(64),
    }],
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.events.length = 0
  mocks.bindingExists.mockImplementation(async (filter) =>
    filter.workspaceId?.toString() === WORKSPACE_ID.toString()
      ? { _id: filter._id }
      : null,
  )
  mocks.assertDrained.mockImplementation(() => mocks.events.push('drained'))
  mocks.userUpdate.mockImplementation(async () => {
    mocks.events.push('user-fence')
    return { acknowledged: true, matchedCount: 1 }
  })
  mocks.sessionFind.mockReturnValue(selected([{
    _id: SESSION_ID,
    recordingR2Key: CAMERA_KEY,
  }]))
  mocks.userFind.mockReturnValue(selected(null))
  mocks.usageFence.mockImplementation(async () => mocks.events.push('usage-fence'))
  mocks.redisDelete.mockImplementation(async () => {
    mocks.events.push('redis-cache-purge')
    return 0
  })
  mocks.abortMultipart.mockImplementation(async () => mocks.events.push('abort-multipart'))
  mocks.deleteObjects.mockImplementation(async () => mocks.events.push('delete-r2'))
  mocks.sessionDelete.mockImplementation(async () => {
    mocks.events.push('InterviewSession')
    return { acknowledged: true, deletedCount: 1 }
  })
  for (const name of MODEL_NAMES) {
    mocks.models[name].deleteMany.mockImplementation(async () => {
      mocks.events.push(name)
      return { acknowledged: true, deletedCount: 1 }
    })
  }
  mocks.rawDelete.mockImplementation(async (filter) => {
    mocks.events.push(`auth:${Object.keys(filter)[0]}`)
    return { acknowledged: true, deletedCount: 1 }
  })
  Object.defineProperty(mongoose.connection, 'db', {
    configurable: true,
    value: { collection: () => ({ deleteMany: mocks.rawDelete }) },
  })
  mocks.userDelete.mockImplementation(async () => {
    mocks.events.push('User')
    return { acknowledged: true, deletedCount: 1 }
  })
  mocks.userExists.mockResolvedValue(false)
})

afterAll(() => {
  if (originalDbDescriptor) {
    Object.defineProperty(mongoose.connection, 'db', originalDbDescriptor)
  }
})

describe('complete isolated runtime personal-data cascade', () => {
  it('fences writers, inventories storage, deletes every derived collection, and removes User last', async () => {
    const now = new Date('2026-08-10T02:00:00.000Z')
    await expect(
      purgeRuntimePrincipalData({ binding: binding() as never, roundId: ROUND_ID, now }),
    ).resolves.toEqual(now)

    expect(mocks.events.slice(0, 6)).toEqual([
      'drained',
      'user-fence',
      'usage-fence',
      'redis-cache-purge',
      'abort-multipart',
      'delete-r2',
    ])
    expect(mocks.events.at(-1)).toBe('User')
    expect(mocks.abortMultipart).toHaveBeenCalledWith({
      principalId: PRINCIPAL_ID.toString(),
      uploads: [{
        key: AUDIO_KEY,
        runtimeSessionId: SESSION_ID.toString(),
        uploadId: 'upload-1',
      }],
    })
    expect(mocks.deleteObjects).toHaveBeenCalledWith({
      principalId: PRINCIPAL_ID.toString(),
      objects: expect.arrayContaining([
        { key: CAMERA_KEY, runtimeSessionId: SESSION_ID.toString() },
        { key: AUDIO_KEY, runtimeSessionId: SESSION_ID.toString() },
      ]),
    })
    expect(mocks.redisDelete).toHaveBeenCalledWith(
      `jd:ctx:${SESSION_ID}`,
      `resume:ctx:${SESSION_ID}`,
      `session:cfg:${SESSION_ID}`,
      `feedback:lock:${SESSION_ID}`,
    )
    expect(MODEL_NAMES.every((name) =>
      mocks.models[name].deleteMany.mock.calls.length === 1)).toBe(true)
    for (const name of MODEL_NAMES) {
      expect(mocks.models[name].deleteMany).toHaveBeenCalledWith(
        name === 'UsageRecord'
          ? { userId: PRINCIPAL_ID, organizationId: WORKSPACE_ID }
          : { userId: PRINCIPAL_ID },
      )
    }
    expect(mocks.rawDelete).toHaveBeenCalledTimes(5)
    expect(mocks.rawDelete.mock.calls.map(([filter]) => filter)).toEqual([
      { userId: PRINCIPAL_ID },
      { userId: PRINCIPAL_ID },
      { identifier: `round-${ROUND_ID}@guests.interviewprep.internal` },
      { email: `round-${ROUND_ID}@guests.interviewprep.internal` },
      { userId: PRINCIPAL_ID },
    ])
    expect(mocks.bindingExists).toHaveBeenCalledWith({
      _id: new mongoose.Types.ObjectId('d'.repeat(24)),
      workspaceId: WORKSPACE_ID,
      applicationId: APPLICATION_ID,
      roundId: new mongoose.Types.ObjectId(ROUND_ID),
      principalId: PRINCIPAL_ID,
      status: 'revoked',
      purgePersonalData: true,
    })
  })

  it('rejects a foreign-workspace binding before any purge side effect', async () => {
    const foreignWorkspaceId = new mongoose.Types.ObjectId('2'.repeat(24))

    await expect(
      purgeRuntimePrincipalData({
        binding: binding({ workspaceId: foreignWorkspaceId }) as never,
        roundId: ROUND_ID,
      }),
    ).rejects.toThrow(/not authorized/)

    expect(mocks.bindingExists).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: foreignWorkspaceId }),
    )
    expect(mocks.assertDrained).not.toHaveBeenCalled()
    expect(mocks.userUpdate).not.toHaveBeenCalled()
    expect(mocks.sessionDelete).not.toHaveBeenCalled()
    expect(mocks.rawDelete).not.toHaveBeenCalled()
    expect(mocks.userDelete).not.toHaveBeenCalled()
  })

  it('does not begin deletion until the host write-capability horizon drains', async () => {
    mocks.assertDrained.mockImplementationOnce(() => {
      throw new Error('still draining')
    })
    await expect(
      purgeRuntimePrincipalData({ binding: binding() as never, roundId: ROUND_ID }),
    ).rejects.toThrow('still draining')
    expect(mocks.userUpdate).not.toHaveBeenCalled()
    expect(mocks.deleteObjects).not.toHaveBeenCalled()
  })

  it('keeps the deleting User fence when any derived collection sweep fails', async () => {
    mocks.models.ScoreTelemetry.deleteMany.mockResolvedValueOnce({
      acknowledged: false,
      deletedCount: 0,
    })
    await expect(
      purgeRuntimePrincipalData({ binding: binding() as never, roundId: ROUND_ID }),
    ).rejects.toThrow(/ScoreTelemetry purge was not acknowledged/)
    expect(mocks.userDelete).not.toHaveBeenCalled()
  })

  it('retries the complete idempotent sweep after a partial collection failure', async () => {
    mocks.models.ScoreTelemetry.deleteMany.mockResolvedValueOnce({
      acknowledged: false,
      deletedCount: 0,
    })

    await expect(
      purgeRuntimePrincipalData({ binding: binding() as never, roundId: ROUND_ID }),
    ).rejects.toThrow(/ScoreTelemetry purge was not acknowledged/)
    await expect(
      purgeRuntimePrincipalData({ binding: binding() as never, roundId: ROUND_ID }),
    ).resolves.toBeInstanceOf(Date)

    expect(mocks.models.MultimodalAnalysis.deleteMany).toHaveBeenCalledTimes(2)
    expect(mocks.models.ScoreTelemetry.deleteMany).toHaveBeenCalledTimes(2)
    expect(mocks.models.WeaknessCluster.deleteMany).toHaveBeenCalledTimes(1)
    expect(mocks.userDelete).toHaveBeenCalledTimes(1)
  })

  it('does not acknowledge while any raw auth-row deletion is unacknowledged', async () => {
    mocks.rawDelete
      .mockResolvedValueOnce({ acknowledged: true, deletedCount: 1 })
      .mockResolvedValueOnce({ acknowledged: true, deletedCount: 1 })
      .mockResolvedValueOnce({ acknowledged: false, deletedCount: 0 })

    await expect(
      purgeRuntimePrincipalData({ binding: binding() as never, roundId: ROUND_ID }),
    ).rejects.toThrow(/verification_tokens purge was not acknowledged/)

    expect(mocks.rawDelete).toHaveBeenCalledTimes(3)
    expect(mocks.userDelete).not.toHaveBeenCalled()
  })

  it('requires the Redis usage-buffer tombstone before deleting durable data', async () => {
    mocks.usageFence.mockRejectedValueOnce(new Error('Redis unavailable'))
    await expect(
      purgeRuntimePrincipalData({ binding: binding() as never, roundId: ROUND_ID }),
    ).rejects.toThrow('Redis unavailable')
    expect(mocks.abortMultipart).not.toHaveBeenCalled()
    expect(mocks.sessionDelete).not.toHaveBeenCalled()
    expect(mocks.userDelete).not.toHaveBeenCalled()
  })

  it('fails closed with durable inventory intact when exact session-cache deletion fails', async () => {
    mocks.redisDelete.mockRejectedValueOnce(new Error('Redis unavailable'))
    await expect(
      purgeRuntimePrincipalData({ binding: binding() as never, roundId: ROUND_ID }),
    ).rejects.toThrow('Redis unavailable')
    expect(mocks.usageFence).toHaveBeenCalledOnce()
    expect(mocks.abortMultipart).not.toHaveBeenCalled()
    expect(mocks.deleteObjects).not.toHaveBeenCalled()
    expect(mocks.sessionDelete).not.toHaveBeenCalled()
    expect(mocks.userDelete).not.toHaveBeenCalled()
  })

  it('deletes each exact cache key once across a duplicate session snapshot', async () => {
    mocks.sessionFind.mockReturnValue(selected([
      { _id: SESSION_ID, recordingR2Key: CAMERA_KEY },
      { _id: SESSION_ID, recordingR2Key: CAMERA_KEY },
    ]))

    await expect(
      purgeRuntimePrincipalData({ binding: binding() as never, roundId: ROUND_ID }),
    ).resolves.toBeInstanceOf(Date)

    expect(mocks.redisDelete).toHaveBeenCalledWith(
      `jd:ctx:${SESSION_ID}`,
      `resume:ctx:${SESSION_ID}`,
      `session:cfg:${SESSION_ID}`,
      `feedback:lock:${SESSION_ID}`,
    )
  })

  it('uses the binding session inventory when a retry finds Mongo already swept', async () => {
    mocks.sessionFind.mockReturnValue(selected([]))

    await expect(
      purgeRuntimePrincipalData({ binding: binding() as never, roundId: ROUND_ID }),
    ).resolves.toBeInstanceOf(Date)

    expect(mocks.usageFence).toHaveBeenCalledWith(
      PRINCIPAL_ID.toString(),
      [SESSION_ID.toString()],
    )
    expect(mocks.redisDelete).toHaveBeenCalledWith(
      `jd:ctx:${SESSION_ID}`,
      `resume:ctx:${SESSION_ID}`,
      `session:cfg:${SESSION_ID}`,
      `feedback:lock:${SESSION_ID}`,
    )
  })

  it('does not report success while the pseudonymous User still exists', async () => {
    mocks.userDelete.mockResolvedValueOnce({ acknowledged: true, deletedCount: 0 })
    mocks.userExists.mockResolvedValueOnce(true)
    await expect(
      purgeRuntimePrincipalData({ binding: binding() as never, roundId: ROUND_ID }),
    ).rejects.toThrow(/fence survived/)
  })

  it('keeps the cascade list pinned to every user-derived runtime model', () => {
    expect(
      __runtimePersonalDataPurge.RUNTIME_PRINCIPAL_COLLECTIONS.map(
        (collection) => collection.model.modelName,
      ),
    ).toEqual(MODEL_NAMES)
  })
})
