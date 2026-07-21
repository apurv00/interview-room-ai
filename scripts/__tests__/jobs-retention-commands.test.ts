import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  runJobsRetentionSweep: vi.fn(),
  assertRetentionTtlIndex: vi.fn(),
  prepareRetentionTtlIndex: vi.fn(),
  connectDB: vi.fn(),
}))

vi.mock('../../modules/jobs/services/retentionService', () => ({
  runJobsRetentionSweep: mocks.runJobsRetentionSweep,
}))
vi.mock('../../modules/jobs/services/retentionIndex', () => ({
  assertRetentionTtlIndex: mocks.assertRetentionTtlIndex,
  prepareRetentionTtlIndex: mocks.prepareRetentionTtlIndex,
}))
vi.mock('../../shared/db/connection', () => ({ connectDB: mocks.connectDB }))

import {
  assertRetentionSweepConverged,
  retentionSweepModeOf,
  runRetentionSweepCli,
} from '../sweep-jobs-retention'
import {
  retentionIndexModeOf,
  runRetentionIndexPreparation,
} from '../prepare-jobs-retention-index'
import type { JobsRetentionSweepReport } from '../../modules/jobs/services/retentionService'

function convergedReport(): JobsRetentionSweepReport {
  return {
    dryRun: true,
    at: '2026-07-21T12:00:00.000Z',
    ownerPins: { applicationOwned: 3, contradictions: 0, repaired: 0 },
    freshness: { missingCanonicalFreshness: 0, backfilled: 0 },
    closures: {
      validThroughEligible: 0,
      validThroughClosed: 0,
      agedOutEligible: 0,
      agedOutClosed: 0,
    },
    tombstones: { eligibleToSlim: 0, slimmed: 0 },
    ttl: {
      indexReady: true,
      indexName: 'purgeAt_1',
      staleNonPurgeable: 0,
      staleCleared: 0,
      normalArchivesEligible: 0,
      normalArchivesScheduled: 0,
    },
    corpus: {
      retained: 25_000,
      ownerPinned: 3,
      purgeScheduled: 0,
      restrictedTombstones: 1,
      warnAt: 20_000,
      hardStopAt: 25_000,
      state: 'hard-stop',
    },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, 'log').mockImplementation(() => undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('Jobs retention operator command modes', () => {
  it('keeps destructive operations explicit', () => {
    expect(retentionSweepModeOf([])).toBe('dry-run')
    expect(retentionSweepModeOf(['--apply'])).toBe('apply')
    expect(retentionSweepModeOf(['--check'])).toBe('check')
    expect(retentionIndexModeOf([])).toBe('dry-run')
    expect(retentionIndexModeOf(['--apply'])).toBe('apply')
    expect(retentionIndexModeOf(['--check'])).toBe('check')
  })

  it('rejects typos and mutually exclusive modes', () => {
    expect(() => retentionSweepModeOf(['--aply'])).toThrow('unknown argument')
    expect(() => retentionSweepModeOf(['--apply', '--check'])).toThrow(/either --apply or --check/)
    expect(() => retentionIndexModeOf(['--apply', '--check'])).toThrow(/either --apply or --check/)
  })

  it.each([
    { argv: [] as string[], dryRun: true },
    { argv: ['--apply'], dryRun: false },
    { argv: ['--check'], dryRun: true },
  ])('wires $argv to dryRun=$dryRun with schema writes disabled', async ({ argv, dryRun }) => {
    mocks.runJobsRetentionSweep.mockResolvedValue(convergedReport())

    await expect(runRetentionSweepCli(argv)).resolves.toBeUndefined()

    expect(mocks.runJobsRetentionSweep).toHaveBeenCalledWith({
      dryRun,
      schemaInitialization: 'disabled',
    })
  })

  it.each([
    ['owner contradictions', (report: JobsRetentionSweepReport) => { report.ownerPins.contradictions = 1 }],
    ['freshness backfills', (report: JobsRetentionSweepReport) => { report.freshness.missingCanonicalFreshness = 2 }],
    ['valid-through closures', (report: JobsRetentionSweepReport) => { report.closures.validThroughEligible = 3 }],
    ['aged-out closures', (report: JobsRetentionSweepReport) => { report.closures.agedOutEligible = 4 }],
    ['tombstones to slim', (report: JobsRetentionSweepReport) => { report.tombstones.eligibleToSlim = 5 }],
    ['stale TTL rows to clear', (report: JobsRetentionSweepReport) => { report.ttl.staleNonPurgeable = 6 }],
    ['normal archives to schedule', (report: JobsRetentionSweepReport) => { report.ttl.normalArchivesEligible = 7 }],
  ])('fails convergence when %s remain', (label, makePending) => {
    const report = convergedReport()
    makePending(report)

    expect(() => assertRetentionSweepConverged(report)).toThrow(`${label}=`)
  })

  it('treats corpus capacity as reporting, not a pending lifecycle mutation', () => {
    expect(() => assertRetentionSweepConverged(convergedReport())).not.toThrow()
  })

  it('runs --check read-only and rejects a non-converged report', async () => {
    const report = convergedReport()
    report.ownerPins.contradictions = 2
    report.ttl.normalArchivesEligible = 3
    mocks.runJobsRetentionSweep.mockResolvedValue(report)

    await expect(runRetentionSweepCli(['--check'])).rejects.toThrow(
      'owner contradictions=2, normal archives to schedule=3',
    )
    expect(mocks.runJobsRetentionSweep).toHaveBeenCalledWith({
      dryRun: true,
      schemaInitialization: 'disabled',
    })
  })

  it.each([
    { label: 'check', argv: ['--check'], apply: false, assertsReady: true },
    { label: 'apply', argv: ['--apply'], apply: true, assertsReady: false },
  ])('wires retention-index $label mode with schema writes disabled', async ({
    argv,
    apply,
    assertsReady,
  }) => {
    const keyIdentical = [{
      name: 'purgeAt_1',
      key: { purgeAt: 1 },
      expireAfterSeconds: 0,
    }]
    mocks.prepareRetentionTtlIndex.mockResolvedValue({
      ready: true,
      matchingName: 'purgeAt_1',
      keyIdentical,
      purgeAtRows: 0,
    })

    await expect(runRetentionIndexPreparation(argv)).resolves.toBeUndefined()

    expect(mocks.connectDB).toHaveBeenCalledWith({ schemaInitialization: 'disabled' })
    expect(mocks.prepareRetentionTtlIndex).toHaveBeenCalledWith(apply)
    if (assertsReady) {
      expect(mocks.assertRetentionTtlIndex).toHaveBeenCalledWith(keyIdentical)
    } else {
      expect(mocks.assertRetentionTtlIndex).not.toHaveBeenCalled()
    }
  })
})
