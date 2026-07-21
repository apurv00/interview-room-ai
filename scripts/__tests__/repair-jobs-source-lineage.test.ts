import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  connectDB: vi.fn(),
  countDocuments: vi.fn(),
  aggregate: vi.fn(),
  updateMany: vi.fn(),
  metaExists: vi.fn(),
  metaFindOneAndUpdate: vi.fn(),
  metaUpdateOne: vi.fn(),
}))

vi.mock('../../shared/db/connection', () => ({ connectDB: mocks.connectDB }))
vi.mock('../../shared/db/models', () => ({
  JOB_SOURCE_CONTROL_META_ID: 'jobs-source-control',
  JOB_SOURCE_ID_PATTERN: /^(?:__legacy_unknown__|[a-z0-9][a-z0-9:_-]{0,99})$/,
  JOB_SOURCE_LINEAGE_UNKNOWN: '__legacy_unknown__',
  JobPosting: {
    countDocuments: mocks.countDocuments,
    aggregate: mocks.aggregate,
    updateMany: mocks.updateMany,
  },
  JobSourceControlMeta: {
    exists: mocks.metaExists,
    findOneAndUpdate: mocks.metaFindOneAndUpdate,
    updateOne: mocks.metaUpdateOne,
  },
}))

import {
  assertSourceLineageInvariant,
  runSourceLineageRepair,
  sourceLineageRepairModeOf,
} from '../repair-jobs-source-lineage'

describe('Jobs source-lineage repair deploy gate', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.connectDB.mockResolvedValue(undefined)
    mocks.metaExists.mockResolvedValue(null)
    mocks.metaFindOneAndUpdate.mockResolvedValue({ controlWriteSeq: 0, ingestWriteSeq: 0 })
    mocks.metaUpdateOne.mockResolvedValue({ matchedCount: 1 })
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it.each([
    [[], 'dry-run'],
    [['--apply'], 'apply'],
    [['--check'], 'check'],
  ] as const)('parses %j as %s mode', (argv, mode) => {
    expect(sourceLineageRepairModeOf([...argv])).toBe(mode)
  })

  it('rejects ambiguous or unknown arguments', () => {
    expect(() => sourceLineageRepairModeOf(['--apply', '--check'])).toThrow(/either --apply or --check/)
    expect(() => sourceLineageRepairModeOf(['--aply'])).toThrow('unknown argument: --aply')
  })

  it('fails promotion for missing lineage or uncovered provenance', () => {
    expect(() => assertSourceLineageInvariant({
      missingOrEmptySourceIds: 2,
      invalidProvenanceSourceIds: 4,
      provenanceCoverageGaps: 3,
      globalMarkerMissing: 1,
    })).toThrow('invalid sourceIds=2, invalid provenance=4, provenance gaps=3, global marker missing=1')
  })

  it('keeps --check read-only and fails on lineage drift', async () => {
    mocks.countDocuments
      .mockResolvedValueOnce(2) // invalid sourceIds
      .mockResolvedValueOnce(1) // invalid provenance
      .mockResolvedValueOnce(0) // ambiguous report
    mocks.aggregate.mockResolvedValueOnce([{ count: 1 }])

    await expect(runSourceLineageRepair(['--check'])).rejects.toThrow(
      'invalid sourceIds=2, invalid provenance=1, provenance gaps=1',
    )

    expect(mocks.connectDB).toHaveBeenCalledWith({ schemaInitialization: 'disabled' })
    expect(mocks.updateMany).not.toHaveBeenCalled()
  })

  it('backfills known IDs, marks ambiguous history, and verifies the result', async () => {
    mocks.countDocuments
      .mockResolvedValueOnce(3) // before: missing/empty
      .mockResolvedValueOnce(1) // before: invalid provenance
      .mockResolvedValueOnce(2) // ambiguous legacy
      .mockResolvedValueOnce(0) // posting verification: missing/empty
      .mockResolvedValueOnce(0) // posting verification: invalid provenance
      .mockResolvedValueOnce(3) // total postings
      .mockResolvedValueOnce(2) // unknown postings for marker
      .mockResolvedValueOnce(0) // final verification: missing/empty
      .mockResolvedValueOnce(0) // final verification: invalid provenance
      .mockResolvedValueOnce(2) // final sentinel count
    mocks.aggregate
      .mockResolvedValueOnce([{ count: 3 }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
    mocks.metaExists
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ _id: 'jobs-source-control' })
    mocks.updateMany.mockResolvedValue({ matchedCount: 3, modifiedCount: 3 })

    await expect(runSourceLineageRepair(['--apply'])).resolves.toBeUndefined()

    expect(mocks.updateMany).toHaveBeenCalledOnce()
    const [, pipeline] = mocks.updateMany.mock.calls[0]
    expect(JSON.stringify(pipeline)).toContain('__legacy_unknown__')
    expect(JSON.stringify(pipeline)).toContain('$setUnion')
    expect(JSON.stringify(pipeline)).toContain('$filter')
    const repairFilter = JSON.stringify(mocks.updateMany.mock.calls[0][0])
    expect(repairFilter).toContain('$expr')
    expect(repairFilter).toContain('$isArray')
    expect(repairFilter).toContain('$regexMatch')
    expect(repairFilter).toContain('$allElementsTrue')
    expect(JSON.stringify(pipeline).match(/\$anyElementTrue/g)?.length).toBeGreaterThanOrEqual(2)
    expect(JSON.stringify(pipeline)).toContain('provenance')
    expect(mocks.metaFindOneAndUpdate).toHaveBeenCalledWith(
      { _id: 'jobs-source-control' },
      expect.objectContaining({
        $set: expect.objectContaining({
          sourceLineageVersion: 1,
          repairedPostings: 3,
          retainedPostings: 3,
          unknownLineagePostings: 2,
        }),
        $max: { controlWriteSeq: 0, ingestWriteSeq: 0 },
      }),
      { upsert: true, new: true },
    )
  })

  it('invalidates global readiness without deleting generations when a late gap appears', async () => {
    mocks.countDocuments
      .mockResolvedValueOnce(1) // before missing
      .mockResolvedValueOnce(0) // before invalid provenance
      .mockResolvedValueOnce(0) // ambiguous
      .mockResolvedValueOnce(0) // posting verification missing
      .mockResolvedValueOnce(0) // posting verification invalid provenance
      .mockResolvedValueOnce(1) // total
      .mockResolvedValueOnce(0) // unknown for marker
      .mockResolvedValueOnce(1) // final late gap
      .mockResolvedValueOnce(0) // final invalid provenance
    mocks.aggregate
      .mockResolvedValueOnce([{ count: 1 }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
    mocks.metaExists
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ _id: 'jobs-source-control' })
    mocks.updateMany.mockResolvedValue({ matchedCount: 1, modifiedCount: 1 })

    await expect(runSourceLineageRepair(['--apply'])).rejects.toThrow('invalid sourceIds=1')

    const repairedAt = mocks.metaFindOneAndUpdate.mock.calls[0][1].$set.repairedAt
    expect(repairedAt).toBeInstanceOf(Date)
    expect(mocks.metaUpdateOne).toHaveBeenCalledWith(
      {
        _id: 'jobs-source-control',
        sourceLineageVersion: 1,
        controlWriteSeq: 0,
        ingestWriteSeq: 0,
        repairedAt,
      },
      { $unset: { sourceLineageVersion: 1 } },
    )
  })

  it('never invalidates a newer generation while compensating a late repair gap', async () => {
    mocks.countDocuments
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(0)
    mocks.aggregate
      .mockResolvedValueOnce([{ count: 1 }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
    mocks.metaExists
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ _id: 'jobs-source-control' })
    mocks.updateMany.mockResolvedValue({ matchedCount: 1, modifiedCount: 1 })
    mocks.metaFindOneAndUpdate.mockResolvedValue({ controlWriteSeq: 8, ingestWriteSeq: 13 })
    // A concurrent fenced operation advances either generation after this
    // returned snapshot, so the exact cleanup CAS cannot match.
    mocks.metaUpdateOne.mockResolvedValue({ matchedCount: 0 })

    await expect(runSourceLineageRepair(['--apply'])).rejects.toThrow('invalid sourceIds=1')

    expect(mocks.metaUpdateOne).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceLineageVersion: 1,
        controlWriteSeq: 8,
        ingestWriteSeq: 13,
        repairedAt: expect.any(Date),
      }),
      { $unset: { sourceLineageVersion: 1 } },
    )
  })
})
