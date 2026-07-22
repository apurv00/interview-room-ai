import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  connectDB: vi.fn(),
  evidenceFind: vi.fn(),
  evidenceUpdateMany: vi.fn(),
  applicationFind: vi.fn(),
  applicationBulkWrite: vi.fn(),
  currentEvidenceProvenance: vi.fn(),
  writeOrder: [] as string[],
}))

vi.mock('../../shared/db/connection', () => ({ connectDB: mocks.connectDB }))
vi.mock('../../shared/db/models', () => ({
  InterviewSession: { updateOne: vi.fn() },
  JobPracticeEvidence: {
    find: mocks.evidenceFind,
    updateMany: mocks.evidenceUpdateMany,
  },
  JobApplication: {
    find: mocks.applicationFind,
    bulkWrite: mocks.applicationBulkWrite,
  },
}))
vi.mock('../../shared/services/modelRouter', () => ({ resolveModel: vi.fn() }))
vi.mock('../../modules/jobs/services/evidenceProvenance', () => ({
  currentEvidenceProvenance: mocks.currentEvidenceProvenance,
}))

import {
  assertEvidenceProvenanceInvariant,
  evidenceProvenanceRepairModeOf,
  evidenceProvenanceStateOf,
  readinessHasValidProvenance,
  readinessProvenanceStateOf,
  readinessRemovalUpdate,
  runEvidenceProvenanceRepair,
} from '../repair-jobs-evidence-provenance'
import {
  modelConfigSnapshotOf,
  primaryModelExecutionProvenanceOf,
} from '../../shared/services/scoringProvenance'
import type { ResolvedModel } from '../../shared/services/modelRouter'

const RESOLVED: ResolvedModel = {
  model: 'gpt-5.6-luna',
  provider: 'openai',
  maxTokens: 500,
  reasoningEffort: 'low',
  useToonInput: false,
}
const SCORING = primaryModelExecutionProvenanceOf({
  snapshot: modelConfigSnapshotOf('interview.evaluate-answer', RESOLVED),
  contractVersion: 'answer-evaluation.v1',
})
const ATTRIBUTION = primaryModelExecutionProvenanceOf({
  snapshot: modelConfigSnapshotOf('jobs.evidence-attribution', { ...RESOLVED, maxTokens: 1400 }),
  contractVersion: 'evidence-attribution.v1',
})
const CURRENT = {
  epoch: 'e'.repeat(64),
  scoring: [SCORING],
  attribution: [ATTRIBUTION],
}
const ATTESTED = {
  _id: 'e1',
  scoringEpoch: SCORING.fingerprint,
  provenance: {
    schemaVersion: 1,
    status: 'attested',
    scoring: SCORING,
    attribution: ATTRIBUTION,
  },
}
const QUARANTINED = {
  _id: 'e-old',
  scoringEpoch: 'historical-model',
  provenance: {
    schemaVersion: 1,
    status: 'legacy-unverifiable',
    quarantineReason: 'pre-provenance-contract',
    quarantinedAt: new Date('2026-07-22T00:00:00.000Z'),
  },
}
const VALID_READINESS = {
  handoffVersion: 1,
  band: 'building',
  sessions: 1,
  practicedCount: 1,
  scoringEpoch: CURRENT.epoch,
  provenance: { schemaVersion: 1, scoring: [SCORING], attribution: [ATTRIBUTION] },
}

function query(rows: unknown[]) {
  const value = {
    select: vi.fn(),
    sort: vi.fn(),
    limit: vi.fn(),
    lean: vi.fn().mockResolvedValue(rows),
  }
  value.select.mockReturnValue(value)
  value.sort.mockReturnValue(value)
  value.limit.mockReturnValue(value)
  return value
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.writeOrder.length = 0
  mocks.connectDB.mockResolvedValue(undefined)
  mocks.currentEvidenceProvenance.mockResolvedValue(CURRENT)
  mocks.evidenceFind.mockReturnValue(query([]))
  mocks.applicationFind.mockReturnValue(query([]))
  mocks.evidenceUpdateMany.mockImplementation(async () => {
    mocks.writeOrder.push('evidence')
    return { modifiedCount: 1 }
  })
  mocks.applicationBulkWrite.mockImplementation(async () => {
    mocks.writeOrder.push('readiness')
    return { modifiedCount: 1 }
  })
})

describe('Jobs evidence provenance repair', () => {
  it('parses only the three strict modes', () => {
    expect(evidenceProvenanceRepairModeOf([])).toBe('dry-run')
    expect(evidenceProvenanceRepairModeOf(['--apply'])).toBe('apply')
    expect(evidenceProvenanceRepairModeOf(['--check'])).toBe('check')
    expect(() => evidenceProvenanceRepairModeOf(['--apply', '--check'])).toThrow('either')
    expect(() => evidenceProvenanceRepairModeOf(['--aply'])).toThrow('unknown argument')
  })

  it('distinguishes exact attestation, explicit quarantine, missing legacy, and malformed declarations', () => {
    expect(evidenceProvenanceStateOf(ATTESTED)).toBe('attested')
    expect(evidenceProvenanceStateOf(QUARANTINED)).toBe('quarantined')
    expect(evidenceProvenanceStateOf({ _id: 'legacy', scoringEpoch: 'model' })).toBe('legacy')
    expect(evidenceProvenanceStateOf({ ...ATTESTED, scoringEpoch: 'guessed-current-model' })).toBe('malformed')
    expect(evidenceProvenanceStateOf({ ...ATTESTED, provenance: { schemaVersion: 2, status: 'attested' } })).toBe('malformed')
  })

  it('accepts only complete positive readiness provenance', () => {
    expect(readinessHasValidProvenance(VALID_READINESS, CURRENT)).toBe(true)
    expect(readinessProvenanceStateOf({ ...VALID_READINESS, provenance: undefined }, CURRENT)).toBe('malformed')
    expect(readinessProvenanceStateOf({
      ...VALID_READINESS,
      provenance: { schemaVersion: 2, scoring: [], attribution: [] },
    }, CURRENT)).toBe('malformed')
    expect(readinessProvenanceStateOf({
      ...VALID_READINESS,
      scoringEpoch: 'f'.repeat(64),
    }, CURRENT)).toBe('stale')
    expect(readinessHasValidProvenance({
      ...VALID_READINESS,
      provenance: { schemaVersion: 1, scoring: [], attribution: [] },
    }, CURRENT)).toBe(false)
    expect(readinessHasValidProvenance({
      ...VALID_READINESS,
      provenance: {
        schemaVersion: 1,
        scoring: [{ ...SCORING, usedFallback: true }],
        attribution: [ATTRIBUTION],
      },
    }, CURRENT)).toBe(false)
    expect(readinessProvenanceStateOf({ band: 'building' }, CURRENT)).toBe('legacy')
  })

  it('uses a normal Mongoose update document rather than an unsupported pipeline', () => {
    const update = readinessRemovalUpdate()
    expect(Array.isArray(update)).toBe(false)
    expect(update).toEqual({
      $unset: { readiness: 1 },
      $inc: { readinessRevision: 1 },
    })
  })

  it('keeps check physically read-only when the invariant is converged', async () => {
    mocks.evidenceFind.mockReturnValueOnce(query([ATTESTED, QUARANTINED]))
    mocks.applicationFind.mockReturnValueOnce(query([{ _id: 'app1', readiness: VALID_READINESS }]))

    await runEvidenceProvenanceRepair(['--check'])

    expect(mocks.connectDB).toHaveBeenCalledWith({ schemaInitialization: 'disabled' })
    expect(mocks.applicationBulkWrite).not.toHaveBeenCalled()
    expect(mocks.evidenceUpdateMany).not.toHaveBeenCalled()
  })

  it('refuses apply before writes when declared provenance is malformed or future-versioned', async () => {
    mocks.evidenceFind.mockReturnValueOnce(query([{
      ...ATTESTED,
      provenance: { schemaVersion: 99, status: 'attested' },
    }]))
    mocks.applicationFind.mockReturnValueOnce(query([]))

    await expect(runEvidenceProvenanceRepair(['--apply'])).rejects.toThrow('apply refused')
    expect(mocks.applicationBulkWrite).not.toHaveBeenCalled()
    expect(mocks.evidenceUpdateMany).not.toHaveBeenCalled()
  })

  it('refuses future readiness provenance before any write', async () => {
    mocks.evidenceFind.mockReturnValueOnce(query([]))
    mocks.applicationFind.mockReturnValueOnce(query([{
      _id: 'future-app',
      readinessRevision: 2,
      readiness: { ...VALID_READINESS, provenance: { schemaVersion: 99 } },
    }]))

    await expect(runEvidenceProvenanceRepair(['--apply'])).rejects.toThrow('apply refused')
    expect(mocks.applicationBulkWrite).not.toHaveBeenCalled()
    expect(mocks.evidenceUpdateMany).not.toHaveBeenCalled()
  })

  it.each(['bad', -1, 1.5, Number.MAX_SAFE_INTEGER])(
    'refuses unsafe readiness revision %s before any write',
    async (readinessRevision) => {
      mocks.evidenceFind.mockReturnValueOnce(query([]))
      mocks.applicationFind.mockReturnValueOnce(query([{
        _id: 'bad-revision-app',
        readinessRevision,
        readiness: { band: 'building' },
      }]))

      await expect(runEvidenceProvenanceRepair(['--apply'])).rejects.toThrow('unsafe readiness revision')
      expect(mocks.applicationBulkWrite).not.toHaveBeenCalled()
      expect(mocks.evidenceUpdateMany).not.toHaveBeenCalled()
    },
  )

  it('removes legacy snapshots before quarantining rows and verifies physical convergence', async () => {
    const legacy = { _id: 'legacy-evidence', scoringEpoch: 'old-model' }
    const invalidApp = { _id: 'app-old', readinessRevision: 7, readiness: { band: 'building' } }
    mocks.evidenceFind
      .mockReturnValueOnce(query([legacy]))
      .mockReturnValueOnce(query([legacy]))
      .mockReturnValueOnce(query([QUARANTINED]))
    mocks.applicationFind
      .mockReturnValueOnce(query([invalidApp]))
      .mockReturnValueOnce(query([invalidApp]))
      .mockReturnValueOnce(query([]))

    await runEvidenceProvenanceRepair(['--apply'])

    expect(mocks.writeOrder).toEqual(['readiness', 'evidence'])
    expect(mocks.applicationBulkWrite.mock.calls[0][0]).toEqual([
      {
        updateOne: {
          filter: {
            _id: 'app-old',
            readiness: { $exists: true },
            readinessRevision: 7,
          },
          update: {
            $unset: { readiness: 1 },
            $inc: { readinessRevision: 1 },
          },
        },
      },
    ])
    expect(mocks.evidenceUpdateMany.mock.calls[0][0]).toMatchObject({
      provenance: { $exists: false },
    })
    expect(mocks.evidenceUpdateMany.mock.calls[0][1]).toEqual({
      $set: {
        provenance: expect.objectContaining({
          schemaVersion: 1,
          status: 'legacy-unverifiable',
          quarantineReason: 'pre-provenance-contract',
          quarantinedAt: expect.any(Date),
        }),
      },
    })
  })

  it('is idempotent after the database has converged', async () => {
    mocks.evidenceFind
      .mockReturnValueOnce(query([QUARANTINED, ATTESTED]))
      .mockReturnValueOnce(query([]))
      .mockReturnValueOnce(query([QUARANTINED, ATTESTED]))
    mocks.applicationFind
      .mockReturnValueOnce(query([{ _id: 'app1', readiness: VALID_READINESS }]))
      .mockReturnValueOnce(query([{ _id: 'app1', readiness: VALID_READINESS }]))
      .mockReturnValueOnce(query([{ _id: 'app1', readiness: VALID_READINESS }]))

    await runEvidenceProvenanceRepair(['--apply'])

    expect(mocks.applicationBulkWrite).not.toHaveBeenCalled()
    expect(mocks.evidenceUpdateMany).not.toHaveBeenCalled()
  })

  it('quarantines a corpus larger than one page without accumulating all ids', async () => {
    const firstLegacyPage = Array.from({ length: 500 }, (_, index) => ({
      _id: `legacy-${String(index).padStart(4, '0')}`,
      scoringEpoch: 'old-model',
    }))
    const finalLegacyPage = [{ _id: 'legacy-0500', scoringEpoch: 'old-model' }]
    const quarantine = (row: Record<string, unknown>) => ({
      ...row,
      provenance: {
        schemaVersion: 1,
        status: 'legacy-unverifiable',
        quarantineReason: 'pre-provenance-contract',
        quarantinedAt: new Date('2026-07-22T00:00:00.000Z'),
      },
    })
    mocks.evidenceFind
      // Preflight scan.
      .mockReturnValueOnce(query(firstLegacyPage))
      .mockReturnValueOnce(query(finalLegacyPage))
      // Bounded mutation scan.
      .mockReturnValueOnce(query(firstLegacyPage))
      .mockReturnValueOnce(query(finalLegacyPage))
      // Final physical verification.
      .mockReturnValueOnce(query(firstLegacyPage.map(quarantine)))
      .mockReturnValueOnce(query(finalLegacyPage.map(quarantine)))
    mocks.applicationFind
      .mockReturnValueOnce(query([]))
      .mockReturnValueOnce(query([]))
      .mockReturnValueOnce(query([]))

    await runEvidenceProvenanceRepair(['--apply'])

    expect(mocks.evidenceUpdateMany).toHaveBeenCalledTimes(2)
    expect(mocks.evidenceUpdateMany.mock.calls[0][0]._id.$in).toHaveLength(500)
    expect(mocks.evidenceUpdateMany.mock.calls[1][0]._id.$in).toEqual(['legacy-0500'])
  })

  it('fails the deploy invariant when any legacy, malformed, or invalid snapshot remains', () => {
    expect(() => assertEvidenceProvenanceInvariant({
      legacyEvidence: 1,
      malformedEvidence: 0,
      quarantinedEvidence: 10,
      attestedEvidence: 5,
      currentReadiness: 0,
      legacyReadiness: 0,
      staleReadiness: 0,
      malformedReadiness: 0,
      invalidReadinessRevision: 0,
    })).toThrow('invariant failed')
  })
})
