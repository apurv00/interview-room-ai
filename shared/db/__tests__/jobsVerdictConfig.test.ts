import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  JOBS_VERDICT_CONFIG_ID,
  JOBS_VERDICT_DEFAULTS,
  JobsVerdictConfig,
  jobsVerdictConfigSnapshotOf,
} from '../models/JobsVerdictConfig'
import { JobsVerdictConfigAudit } from '../models/JobsVerdictConfigAudit'

function lean<T>(value: T) {
  return { lean: vi.fn().mockResolvedValue(value) }
}

function legacyRows(rows: unknown[]) {
  return {
    sort: vi.fn().mockReturnValue({
      limit: vi.fn().mockReturnValue(lean(rows)),
    }),
  }
}

afterEach(() => vi.restoreAllMocks())

describe('JobsVerdictConfig singleton reads', () => {
  it('keeps legacy rows compatible and defaults ranking/revision off', async () => {
    vi.spyOn(JobsVerdictConfig, 'findById').mockReturnValue(lean(null) as never)
    vi.spyOn(JobsVerdictConfig, 'find').mockReturnValue(legacyRows([{
      collectionEnabled: true,
      enforceEnabled: false,
      dailyVerdictCap: 400,
      perSourceDailyCap: 400,
    }]) as never)

    await expect(JobsVerdictConfig.getConfig()).resolves.toMatchObject({
      collectionEnabled: true,
      enforceEnabled: false,
      rankingEnabled: false,
      dailyVerdictCap: 400,
      revision: 0,
    })
  })

  it('returns safe-OFF defaults instead of choosing between legacy duplicates', async () => {
    vi.spyOn(JobsVerdictConfig, 'findById').mockReturnValue(lean(null) as never)
    vi.spyOn(JobsVerdictConfig, 'find').mockReturnValue(legacyRows([
      { collectionEnabled: true, enforceEnabled: true, rankingEnabled: true },
      { collectionEnabled: true, enforceEnabled: false, rankingEnabled: true },
    ]) as never)

    await expect(JobsVerdictConfig.getConfig()).resolves.toEqual({
      ...JOBS_VERDICT_DEFAULTS,
      revision: 0,
    })
  })

  it('always prefers the canonical singleton', async () => {
    const canonical = { ...JOBS_VERDICT_DEFAULTS, collectionEnabled: true, revision: 7, decisionWriteSeq: 2, notes: 'shadow cohort' }
    vi.spyOn(JobsVerdictConfig, 'findById').mockReturnValue(lean(canonical) as never)
    const find = vi.spyOn(JobsVerdictConfig, 'find')

    await expect(JobsVerdictConfig.getConfig()).resolves.toEqual({
      ...JOBS_VERDICT_DEFAULTS,
      collectionEnabled: true,
      revision: 7,
      notes: 'shadow cohort',
    })
    expect(JobsVerdictConfig.findById).toHaveBeenCalledWith(JOBS_VERDICT_CONFIG_ID)
    expect(find).not.toHaveBeenCalled()
  })

  it('fails a structurally incomplete canonical singleton safely off', async () => {
    vi.spyOn(JobsVerdictConfig, 'findById').mockReturnValue(lean({
      ...JOBS_VERDICT_DEFAULTS,
      collectionEnabled: undefined,
      revision: 7,
      decisionWriteSeq: 2,
    }) as never)

    await expect(JobsVerdictConfig.getConfig()).resolves.toEqual({
      ...JOBS_VERDICT_DEFAULTS,
      revision: 0,
    })
  })
})

describe('jobsVerdictConfigSnapshotOf', () => {
  it('normalizes an absent document to safe defaults', () => {
    expect(jobsVerdictConfigSnapshotOf()).toEqual({ ...JOBS_VERDICT_DEFAULTS, revision: 0 })
  })

  it('fails worker switches safely off for an out-of-policy stored value', () => {
    expect(jobsVerdictConfigSnapshotOf({
      ...JOBS_VERDICT_DEFAULTS,
      collectionEnabled: true,
      enforceEnabled: true,
      dailyVerdictCap: 25_001,
      revision: 7,
    })).toEqual({
      ...JOBS_VERDICT_DEFAULTS,
      revision: 7,
    })
  })

  it.each([
    ['non-boolean switch', { collectionEnabled: 'yes' }],
    ['parked ranking switch', { rankingEnabled: true }],
    ['company cap above global cap', { dailyVerdictCap: 10, perCompanyDailyCap: 11 }],
    ['source cap above global cap', { dailyVerdictCap: 10, perCompanyDailyCap: 10, perSourceDailyCap: 11 }],
    ['daily budget above monthly budget', { dailyBudgetUsd: 3, monthlyBudgetUsd: 2 }],
  ])('fails worker switches safely off for a stored %s', (_label, override) => {
    expect(jobsVerdictConfigSnapshotOf({
      ...JOBS_VERDICT_DEFAULTS,
      ...override,
      revision: 8,
    } as never)).toEqual({
      ...JOBS_VERDICT_DEFAULTS,
      revision: 8,
    })
  })
})

describe('Jobs verdict config persistence bounds', () => {
  const maxState = {
    collectionEnabled: true,
    enforceEnabled: true,
    rankingEnabled: false,
    dailyVerdictCap: 25_000,
    dailyBudgetUsd: 100,
    monthlyBudgetUsd: 3_100,
    perCompanyDailyCap: 1_000,
    perSourceDailyCap: 25_000,
    inputUsdPerMTok: 0.01,
    outputUsdPerMTok: 100,
  }

  it('declares the permanent unique config-revision index', () => {
    expect(JobsVerdictConfigAudit.schema.indexes()).toContainEqual([
      { revision: 1 },
      expect.objectContaining({ name: 'jobs_verdict_config_revision_uq', unique: true }),
    ])
  })

  it('accepts the exact bounds in config and immutable audit states', async () => {
    await expect(new JobsVerdictConfig(maxState).validate()).resolves.toBeUndefined()
    await expect(new JobsVerdictConfigAudit({
      _id: '11111111-1111-4111-8111-111111111111',
      action: 'update',
      commandHash: 'a'.repeat(64),
      actorUserId: '507f1f77bcf86cd799439011',
      reason: 'Set the reviewed upper bounds',
      previousRevision: 0,
      revision: 1,
      from: JOBS_VERDICT_DEFAULTS,
      to: maxState,
      occurredAt: new Date(),
    }).validate()).resolves.toBeUndefined()
  })

  it('rejects values outside the contract in both schemas', async () => {
    await expect(new JobsVerdictConfig({
      ...JOBS_VERDICT_DEFAULTS,
      inputUsdPerMTok: 0,
    }).validate()).rejects.toThrow('inputUsdPerMTok')
    await expect(new JobsVerdictConfigAudit({
      _id: '22222222-2222-4222-8222-222222222222',
      action: 'update',
      commandHash: 'b'.repeat(64),
      actorUserId: '507f1f77bcf86cd799439011',
      reason: 'Attempt an unsafe verdict cap',
      previousRevision: 0,
      revision: 1,
      from: JOBS_VERDICT_DEFAULTS,
      to: { ...JOBS_VERDICT_DEFAULTS, dailyVerdictCap: 25_001 },
      occurredAt: new Date(),
    }).validate()).rejects.toThrow('dailyVerdictCap')
  })

  it.each([
    ['rankingEnabled', { rankingEnabled: true }],
    ['perCompanyDailyCap', { dailyVerdictCap: 10, perCompanyDailyCap: 11 }],
    ['perSourceDailyCap', { dailyVerdictCap: 10, perCompanyDailyCap: 10, perSourceDailyCap: 11 }],
    ['dailyBudgetUsd', { dailyBudgetUsd: 3, monthlyBudgetUsd: 2 }],
  ])('rejects an invalid %s relationship in config and audit schemas', async (field, override) => {
    const invalidState = { ...JOBS_VERDICT_DEFAULTS, ...override }
    await expect(new JobsVerdictConfig(invalidState).validate()).rejects.toThrow(field)
    await expect(new JobsVerdictConfigAudit({
      _id: '33333333-3333-4333-8333-333333333333',
      action: 'update',
      commandHash: 'c'.repeat(64),
      actorUserId: '507f1f77bcf86cd799439011',
      reason: 'Attempt an invalid related limit',
      previousRevision: 0,
      revision: 1,
      from: JOBS_VERDICT_DEFAULTS,
      to: invalidState,
      occurredAt: new Date(),
    }).validate()).rejects.toThrow(field)
  })
})
