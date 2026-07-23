import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  connectDB: vi.fn(),
  decisionCreateIndex: vi.fn(),
  decisionIndexes: vi.fn(),
  auditCreateIndex: vi.fn(),
  auditIndexes: vi.fn(),
}))

vi.mock('../../shared/db/connection', () => ({ connectDB: mocks.connectDB }))
vi.mock('../../shared/db/models/JobQualityDecision', () => ({
  JobQualityDecision: { collection: { createIndex: mocks.decisionCreateIndex, indexes: mocks.decisionIndexes } },
}))
vi.mock('../../shared/db/models', () => ({
  JobsVerdictConfigAudit: { collection: { createIndex: mocks.auditCreateIndex, indexes: mocks.auditIndexes } },
}))

import {
  prepareJobsVerdictGovernanceIndexes,
  verdictGovernanceIndexModeOf,
} from '../prepare-jobs-verdict-governance-indexes'

const decisionIndexes = [
  { name: 'job_quality_decision_key_uq', key: { decisionKey: 1 }, unique: true, partialFilterExpression: { recordType: 'automatic' } },
  { name: 'job_quality_review_operation_uq', key: { operationId: 1 }, unique: true, partialFilterExpression: { recordType: 'review' } },
  { name: 'job_quality_review_queue', key: { recordType: 1, reviewStatus: 1, occurredAt: -1, _id: -1 } },
  { name: 'job_quality_review_history', key: { rootDecisionId: 1, occurredAt: 1, _id: 1 } },
]

describe('Jobs verdict-governance index preparation', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mocks.connectDB.mockResolvedValue(undefined)
    mocks.decisionCreateIndex.mockResolvedValue('ok')
    mocks.auditCreateIndex.mockResolvedValue('jobs_verdict_config_revision_uq')
    mocks.decisionIndexes.mockResolvedValue(decisionIndexes)
    mocks.auditIndexes.mockResolvedValue([
      { name: 'jobs_verdict_config_revision_uq', key: { revision: 1 }, unique: true },
    ])
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
  })

  it('defaults to dry-run and rejects ambiguous flags', () => {
    expect(verdictGovernanceIndexModeOf([])).toBe('dry-run')
    expect(verdictGovernanceIndexModeOf(['--apply'])).toBe('apply')
    expect(verdictGovernanceIndexModeOf(['--check'])).toBe('check')
    expect(() => verdictGovernanceIndexModeOf(['--apply', '--check'])).toThrow('mutually exclusive')
    expect(() => verdictGovernanceIndexModeOf(['--drop'])).toThrow('unknown argument')
  })

  it('does not connect or mutate in dry-run mode', async () => {
    await prepareJobsVerdictGovernanceIndexes([])
    expect(mocks.connectDB).not.toHaveBeenCalled()
    expect(mocks.decisionCreateIndex).not.toHaveBeenCalled()
  })

  it('creates only the enumerated indexes and verifies permanent evidence', async () => {
    await prepareJobsVerdictGovernanceIndexes(['--apply'])
    expect(mocks.connectDB).toHaveBeenCalledWith({ schemaInitialization: 'disabled' })
    expect(mocks.decisionCreateIndex).toHaveBeenCalledTimes(4)
    expect(mocks.auditCreateIndex).toHaveBeenCalledExactlyOnceWith(
      { revision: 1 },
      { name: 'jobs_verdict_config_revision_uq', unique: true },
    )
  })

  it('check mode is read-only and fails on a missing or unsafe index', async () => {
    mocks.decisionIndexes.mockResolvedValue([
      ...decisionIndexes.slice(0, 3),
      { ...decisionIndexes[3], expireAfterSeconds: 60 },
    ])
    await expect(prepareJobsVerdictGovernanceIndexes(['--check'])).rejects.toThrow('index verification failed')
    expect(mocks.decisionCreateIndex).not.toHaveBeenCalled()
  })
})
