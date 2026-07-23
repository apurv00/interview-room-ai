import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  mockStartSession,
  mockWithTransaction,
  mockEndSession,
  mockConnectDB,
  mockConfigFindById,
  mockConfigFind,
  mockConfigUpdateOne,
  mockConfigDeleteOne,
  mockAuditFindById,
  mockAuditFindOne,
  mockAuditCreate,
  session,
} = vi.hoisted(() => {
  const mockWithTransaction = vi.fn()
  const mockEndSession = vi.fn()
  return {
    mockStartSession: vi.fn(),
    mockWithTransaction,
    mockEndSession,
    mockConnectDB: vi.fn(),
    mockConfigFindById: vi.fn(),
    mockConfigFind: vi.fn(),
    mockConfigUpdateOne: vi.fn(),
    mockConfigDeleteOne: vi.fn(),
    mockAuditFindById: vi.fn(),
    mockAuditFindOne: vi.fn(),
    mockAuditCreate: vi.fn(),
    session: { withTransaction: mockWithTransaction, endSession: mockEndSession },
  }
})

const DEFAULTS = {
  collectionEnabled: false,
  enforceEnabled: false,
  rankingEnabled: false,
  dailyVerdictCap: 900,
  dailyBudgetUsd: 2.5,
  monthlyBudgetUsd: 75,
  perCompanyDailyCap: 25,
  perSourceDailyCap: 500,
  inputUsdPerMTok: 0.5,
  outputUsdPerMTok: 2,
}

vi.mock('mongoose', () => ({ default: { startSession: mockStartSession } }))
vi.mock('@shared/db/connection', () => ({ connectDB: mockConnectDB }))
vi.mock('@shared/db/models', () => ({
  JOBS_VERDICT_CONFIG_ID: '83ae5b7b13b17e7baf75ce99',
  JobsVerdictConfig: {
    findById: mockConfigFindById,
    find: mockConfigFind,
    updateOne: mockConfigUpdateOne,
    deleteOne: mockConfigDeleteOne,
  },
  JobsVerdictConfigAudit: {
    findById: mockAuditFindById,
    findOne: mockAuditFindOne,
    create: mockAuditCreate,
  },
  jobsVerdictConfigValuesOf: (doc?: Record<string, unknown> | null) => {
    const { revision: _revision, decisionWriteSeq: _sequence, _id: _id, ...values } = doc ?? {}
    return { ...DEFAULTS, ...values }
  },
  jobsVerdictConfigSnapshotOf: (doc?: Record<string, unknown> | null) => {
    const { revision, decisionWriteSeq: _sequence, _id: _id, ...values } = doc ?? {}
    return {
      ...DEFAULTS,
      ...values,
      revision: Number.isSafeInteger(revision) ? revision : 0,
    }
  },
}))

import {
  JobsVerdictConfigConflictError,
  JobsVerdictConfigMigrationRequiredError,
  JobsVerdictConfigRepairRequiredError,
  JobsVerdictConfigTransactionsRequiredError,
  JobsVerdictConfigValidationError,
  fenceJobsVerdictConfigRevision,
  getJobsVerdictConfigSnapshot,
  rollbackJobsVerdictConfig,
  updateJobsVerdictConfig,
  type JobsVerdictConfigUpdateCommand,
} from '../services/verdictConfigControl'

function lean<T>(value: T) {
  return { lean: vi.fn().mockResolvedValue(value) }
}

function rows<T>(value: T[]) {
  return {
    sort: vi.fn().mockReturnValue({
      limit: vi.fn().mockReturnValue(lean(value)),
    }),
  }
}

const OPERATION_ID = '11111111-1111-4111-8111-111111111111'
const ACTOR_ID = '507f1f77bcf86cd799439011'
const CURRENT = { ...DEFAULTS, revision: 0, decisionWriteSeq: 0 }
const NEXT = {
  ...DEFAULTS,
  collectionEnabled: true,
  enforceEnabled: true,
  rankingEnabled: false,
  notes: 'Fraud enforcement cohort',
}
const COMMAND: JobsVerdictConfigUpdateCommand = {
  operationId: OPERATION_ID,
  actorUserId: ACTOR_ID,
  reason: 'Enable the reviewed fraud cohort',
  expectedRevision: 0,
  config: NEXT,
}

beforeEach(() => {
  vi.clearAllMocks()
  mockStartSession.mockResolvedValue(session)
  mockWithTransaction.mockImplementation(async (work: () => Promise<unknown>) => { await work() })
  mockConfigFindById.mockReturnValue(lean(CURRENT))
  mockConfigFind.mockReturnValue(rows([]))
  mockConfigUpdateOne.mockResolvedValue({ matchedCount: 1, upsertedCount: 0 })
  mockConfigDeleteOne.mockResolvedValue({ deletedCount: 1 })
  mockAuditFindById.mockReturnValue(lean(null))
  mockAuditFindOne.mockReturnValue(lean(null))
  mockAuditCreate.mockResolvedValue([])
})

describe('verdict config reads', () => {
  it('reads one legacy row but rejects ambiguous legacy state for governed access', async () => {
    mockConfigFindById.mockReturnValue(lean(null))
    mockConfigFind.mockReturnValueOnce(rows([{ ...DEFAULTS, collectionEnabled: true }]))
    await expect(getJobsVerdictConfigSnapshot()).resolves.toMatchObject({ collectionEnabled: true, revision: 0 })

    mockConfigFind.mockReturnValueOnce(rows([CURRENT, { ...CURRENT, _id: 'other' }]))
    await expect(getJobsVerdictConfigSnapshot()).rejects.toBeInstanceOf(JobsVerdictConfigMigrationRequiredError)
  })

  it('rejects a mixed canonical and legacy singleton state', async () => {
    mockConfigFind.mockReturnValueOnce(rows([{ _id: 'legacy-row' }]))

    await expect(getJobsVerdictConfigSnapshot()).rejects.toBeInstanceOf(JobsVerdictConfigMigrationRequiredError)
  })

  it.each([
    ['non-boolean collection switch', { collectionEnabled: 'yes' }],
    ['enabled parked ranking switch', { rankingEnabled: true }],
    ['enforcement without collection', { collectionEnabled: false, enforceEnabled: true }],
    ['company cap above the global cap', { dailyVerdictCap: 10, perCompanyDailyCap: 11 }],
    ['source cap above the global cap', { dailyVerdictCap: 10, perCompanyDailyCap: 10, perSourceDailyCap: 11 }],
    ['daily budget above the monthly budget', { dailyBudgetUsd: 3, monthlyBudgetUsd: 2 }],
    ['budget above its hard ceiling', { dailyBudgetUsd: 101 }],
    ['missing canonical switch', { collectionEnabled: undefined }],
    ['null canonical budget', { dailyBudgetUsd: null }],
    ['negative config revision', { revision: -1 }],
    ['missing config revision', { revision: undefined }],
    ['fractional config revision', { revision: 0.5 }],
    ['negative decision fence sequence', { decisionWriteSeq: -1 }],
    ['missing decision fence sequence', { decisionWriteSeq: undefined }],
    ['exhausted decision fence sequence', { decisionWriteSeq: Number.MAX_SAFE_INTEGER }],
  ])('requires repair instead of serving a stored %s', async (_label, override) => {
    mockConfigFindById.mockReturnValue(lean({ ...CURRENT, ...override }))

    await expect(getJobsVerdictConfigSnapshot()).rejects.toBeInstanceOf(JobsVerdictConfigRepairRequiredError)
  })
})

describe('fenceJobsVerdictConfigRevision', () => {
  it('physically fences the exact enabled canonical revision in the serving transaction', async () => {
    await expect(fenceJobsVerdictConfigRevision(7, session as never)).resolves.toBe(true)

    expect(mockConfigUpdateOne).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: '83ae5b7b13b17e7baf75ce99',
        collectionEnabled: true,
        enforceEnabled: true,
        revision: 7,
        $and: [{
          $or: [
            { decisionWriteSeq: { $lt: Number.MAX_SAFE_INTEGER } },
            { decisionWriteSeq: { $exists: false } },
          ],
        }],
      }),
      { $inc: { decisionWriteSeq: 1 } },
      { session, timestamps: false },
    )
  })

  it('reports a stale or disabled config without authorizing a serving mutation', async () => {
    mockConfigUpdateOne.mockResolvedValueOnce({ matchedCount: 0 })

    await expect(fenceJobsVerdictConfigRevision(7, session as never)).resolves.toBe(false)
  })
})

describe('updateJobsVerdictConfig', () => {
  it('CAS-writes a full revision and immutable audit in one transaction', async () => {
    const result = await updateJobsVerdictConfig(COMMAND)

    expect(result).toMatchObject({ action: 'update', previousRevision: 0, revision: 1, idempotent: false })
    expect(mockConfigUpdateOne).toHaveBeenCalledWith(
      expect.objectContaining({ _id: '83ae5b7b13b17e7baf75ce99' }),
      expect.objectContaining({ $set: expect.objectContaining({ ...NEXT, revision: 1, updatedBy: ACTOR_ID }) }),
      expect.objectContaining({ session, upsert: true }),
    )
    expect(mockAuditCreate).toHaveBeenCalledWith([
      expect.objectContaining({
        _id: OPERATION_ID,
        action: 'update',
        previousRevision: 0,
        revision: 1,
        from: DEFAULTS,
        to: NEXT,
      }),
    ], { session })
    expect(mockEndSession).toHaveBeenCalledOnce()
  })

  it('atomically removes the exact legacy row after canonical adoption', async () => {
    const legacyId = '507f1f77bcf86cd799439099'
    mockConfigFindById.mockReturnValue(lean(null))
    mockConfigFind.mockReturnValue(rows([{ ...CURRENT, _id: legacyId }]))
    mockConfigUpdateOne.mockResolvedValueOnce({ matchedCount: 0, upsertedCount: 1 })

    await expect(updateJobsVerdictConfig(COMMAND)).resolves.toMatchObject({ revision: 1 })

    expect(mockConfigDeleteOne).toHaveBeenCalledWith({ _id: legacyId }, { session })
    expect(mockAuditCreate).toHaveBeenCalledOnce()
  })

  it('allows fraud enforcement while collection is on and ranking stays disabled', async () => {
    const config = { ...DEFAULTS, collectionEnabled: true, enforceEnabled: true, rankingEnabled: false }
    await expect(updateJobsVerdictConfig({ ...COMMAND, config })).resolves.toMatchObject({
      config: expect.objectContaining(config),
    })
  })

  it('rejects enforcement when decision collection is disabled', async () => {
    const config = { ...DEFAULTS, collectionEnabled: false, enforceEnabled: true, rankingEnabled: false }

    await expect(updateJobsVerdictConfig({ ...COMMAND, config }))
      .rejects.toThrow('collectionEnabled must be true when enforceEnabled is true')
    expect(mockConnectDB).not.toHaveBeenCalled()
  })

  it('keeps the post-GA ranking switch parked', async () => {
    await expect(updateJobsVerdictConfig({
      ...COMMAND,
      config: { ...NEXT, rankingEnabled: true },
    })).rejects.toThrow('rankingEnabled is unavailable until the post-GA ranking gate')
    expect(mockConnectDB).not.toHaveBeenCalled()
  })

  it('rejects stale revisions before either write', async () => {
    mockConfigFindById.mockReturnValue(lean({ ...CURRENT, revision: 4 }))

    const error = await updateJobsVerdictConfig(COMMAND).catch((caught) => caught)
    expect(error).toBeInstanceOf(JobsVerdictConfigConflictError)
    expect(error).toMatchObject({ currentRevision: 4 })
    expect(mockConfigUpdateOne).not.toHaveBeenCalled()
    expect(mockAuditCreate).not.toHaveBeenCalled()
  })

  it('replays the same operation but rejects reuse with a different command', async () => {
    const first = await updateJobsVerdictConfig(COMMAND)
    const audit = mockAuditCreate.mock.calls[0][0][0]
    mockAuditFindById.mockReturnValue(lean(audit))
    mockStartSession.mockClear()

    await expect(updateJobsVerdictConfig(COMMAND)).resolves.toMatchObject({
      revision: first.revision,
      idempotent: true,
    })
    await expect(updateJobsVerdictConfig({ ...COMMAND, reason: 'A different reviewed change' }))
      .rejects.toBeInstanceOf(JobsVerdictConfigConflictError)
    expect(mockStartSession).not.toHaveBeenCalled()
  })

  it.each([
    { ...NEXT, rankingEnabled: undefined },
    { ...NEXT, extra: true },
    { ...NEXT, dailyVerdictCap: 1.5 },
    { ...NEXT, dailyBudgetUsd: Number.NaN },
    { ...NEXT, dailyVerdictCap: 25_001 },
    { ...NEXT, dailyBudgetUsd: 100.01 },
    { ...NEXT, monthlyBudgetUsd: 3_100.01 },
    { ...NEXT, perCompanyDailyCap: 1_001 },
    { ...NEXT, perSourceDailyCap: 25_001 },
    { ...NEXT, inputUsdPerMTok: 0 },
    { ...NEXT, outputUsdPerMTok: 100.01 },
    { ...NEXT, dailyVerdictCap: 10, perCompanyDailyCap: 11 },
    { ...NEXT, dailyVerdictCap: 10, perCompanyDailyCap: 10, perSourceDailyCap: 11 },
    { ...NEXT, dailyBudgetUsd: 3, monthlyBudgetUsd: 2 },
  ])('strictly rejects an invalid full config: %o', async (config) => {
    await expect(updateJobsVerdictConfig({ ...COMMAND, config } as JobsVerdictConfigUpdateCommand))
      .rejects.toBeInstanceOf(JobsVerdictConfigValidationError)
    expect(mockConnectDB).not.toHaveBeenCalled()
  })

  it('accepts every exact numeric boundary', async () => {
    const config = {
      ...NEXT,
      dailyVerdictCap: 25_000,
      dailyBudgetUsd: 100,
      monthlyBudgetUsd: 3_100,
      perCompanyDailyCap: 1_000,
      perSourceDailyCap: 25_000,
      inputUsdPerMTok: 0.01,
      outputUsdPerMTok: 100,
    }

    await expect(updateJobsVerdictConfig({ ...COMMAND, config })).resolves.toMatchObject({
      config: expect.objectContaining(config),
    })
  })

  it('allows dormant global caps without forcing subordinate values to zero', async () => {
    const config = {
      ...NEXT,
      dailyVerdictCap: 0,
      dailyBudgetUsd: 0,
      monthlyBudgetUsd: 0,
      perCompanyDailyCap: 1_000,
      perSourceDailyCap: 25_000,
    }

    await expect(updateJobsVerdictConfig({ ...COMMAND, config })).resolves.toMatchObject({
      config: expect.objectContaining(config),
    })
  })

  it('binds config and audit writes to the same transaction', async () => {
    mockAuditCreate.mockRejectedValueOnce(new Error('audit unavailable'))

    await expect(updateJobsVerdictConfig(COMMAND)).rejects.toThrow('audit unavailable')
    expect(mockConfigUpdateOne.mock.calls[0][2]).toMatchObject({ session })
    expect(mockAuditCreate.mock.calls[0][1]).toEqual({ session })
  })

  it('surfaces standalone MongoDB as an explicit deployment error', async () => {
    mockWithTransaction.mockRejectedValueOnce(Object.assign(new Error('transactions unavailable'), { code: 20 }))
    await expect(updateJobsVerdictConfig(COMMAND)).rejects.toBeInstanceOf(JobsVerdictConfigTransactionsRequiredError)
    expect(mockEndSession).toHaveBeenCalledOnce()
  })
})

describe('rollbackJobsVerdictConfig', () => {
  it('restores a historical state as a new revision', async () => {
    const current = { ...NEXT, revision: 3, decisionWriteSeq: 0 }
    const target = { ...DEFAULTS, collectionEnabled: true, notes: 'Shadow only' }
    mockConfigFindById.mockReturnValue(lean(current))
    mockAuditFindOne.mockReturnValue(lean({ revision: 1, from: DEFAULTS, to: target }))

    const result = await rollbackJobsVerdictConfig({
      operationId: '22222222-2222-4222-8222-222222222222',
      actorUserId: ACTOR_ID,
      reason: 'Restore the stable shadow configuration',
      expectedRevision: 3,
      targetRevision: 1,
    })

    expect(result).toMatchObject({
      action: 'rollback',
      previousRevision: 3,
      revision: 4,
      targetRevision: 1,
      config: { ...target, revision: 4 },
    })
    expect(mockAuditCreate).toHaveBeenCalledWith([
      expect.objectContaining({ action: 'rollback', previousRevision: 3, revision: 4, targetRevision: 1, to: target }),
    ], { session })
  })

  it('uses the first audit from-state when rolling back to revision zero', async () => {
    mockConfigFindById.mockReturnValue(lean({ ...NEXT, revision: 1, decisionWriteSeq: 0 }))
    mockAuditFindOne.mockReturnValue(lean({ revision: 1, from: DEFAULTS, to: NEXT }))

    await expect(rollbackJobsVerdictConfig({
      operationId: '33333333-3333-4333-8333-333333333333',
      actorUserId: ACTOR_ID,
      reason: 'Restore the original safe defaults',
      expectedRevision: 1,
      targetRevision: 0,
    })).resolves.toMatchObject({ config: { ...DEFAULTS, revision: 2 } })
    expect(mockAuditFindOne.mock.calls[0][0]).toEqual({ previousRevision: 0 })
  })

  it.each([
    ['parked ranking enabled', { rankingEnabled: true }],
    ['company cap above the global cap', { dailyVerdictCap: 10, perCompanyDailyCap: 11 }],
    ['source cap above the global cap', { dailyVerdictCap: 10, perCompanyDailyCap: 10, perSourceDailyCap: 11 }],
    ['daily budget above the monthly budget', { dailyBudgetUsd: 3, monthlyBudgetUsd: 2 }],
  ])('rejects an invalid rollback target with %s', async (_label, override) => {
    mockConfigFindById.mockReturnValue(lean({ ...NEXT, revision: 3, decisionWriteSeq: 0 }))
    mockAuditFindOne.mockReturnValue(lean({
      revision: 1,
      from: DEFAULTS,
      to: { ...DEFAULTS, ...override },
    }))

    await expect(rollbackJobsVerdictConfig({
      operationId: '44444444-4444-4444-8444-444444444444',
      actorUserId: ACTOR_ID,
      reason: 'Attempt to restore invalid historical values',
      expectedRevision: 3,
      targetRevision: 1,
    })).rejects.toBeInstanceOf(JobsVerdictConfigValidationError)
    expect(mockConfigUpdateOne).not.toHaveBeenCalled()
    expect(mockAuditCreate).not.toHaveBeenCalled()
  })
})
