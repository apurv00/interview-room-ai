import { describe, expect, it, vi } from 'vitest'

const {
  mockAuditFindOne,
  mockSourceFindOne,
  mockSourceUpdateOne,
  mockIndexes,
  collection,
  mockSourceFind,
  mockMetaFindOne,
  mockPostingCount,
  mockPostingAggregate,
  mockLegalAuditCount,
  mockCycleAggregate,
  mockOperationFind,
  mockRedisPing,
} = vi.hoisted(() => ({
  mockAuditFindOne: vi.fn(),
  mockSourceFindOne: vi.fn(),
  mockSourceUpdateOne: vi.fn(),
  mockIndexes: vi.fn(),
  collection: { indexes: vi.fn(), createIndex: vi.fn() },
  mockSourceFind: vi.fn(),
  mockMetaFindOne: vi.fn(),
  mockPostingCount: vi.fn(),
  mockPostingAggregate: vi.fn(),
  mockLegalAuditCount: vi.fn(),
  mockCycleAggregate: vi.fn(),
  mockOperationFind: vi.fn(),
  mockRedisPing: vi.fn(),
}))
collection.indexes = mockIndexes

vi.mock('mongoose', () => ({
  default: {
    connection: { db: null },
    startSession: vi.fn(),
  },
}))
vi.mock('@shared/db/connection', () => ({ connectDB: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@shared/redis', () => ({ redis: { get: vi.fn(), ping: mockRedisPing, eval: vi.fn() } }))
vi.mock('@shared/services/inngest', () => ({ inngest: { send: vi.fn() } }))
vi.mock('@shared/db/models', () => ({
  JOB_SOURCE_CONTROL_META_ID: 'jobs-source-control',
  JobPosting: { collection, countDocuments: mockPostingCount, aggregate: mockPostingAggregate },
  JobSourceConfig: { collection, findOne: mockSourceFindOne, updateOne: mockSourceUpdateOne, find: mockSourceFind },
  JobSourceControlAudit: { collection, countDocuments: mockLegalAuditCount },
  JobSourceControlMeta: { findOne: mockMetaFindOne },
  JobSourceOperationAudit: {
    collection,
    findOne: mockAuditFindOne,
    find: mockOperationFind,
    updateOne: vi.fn(),
    create: vi.fn(),
  },
  JobIngestCycle: { aggregate: mockCycleAggregate },
}))
vi.mock('../sourceControl', () => ({
  controlRevisionOf: (source: { controlRevision?: number }) => source.controlRevision ?? 0,
  operationalRevisionOf: (source: { operationalRevision?: number }) => source.operationalRevision ?? 0,
  controlRevisionFilter: (revision: number) => ({ controlRevision: revision }),
  operationalRevisionFilter: (revision: number) => ({ operationalRevision: revision }),
}))

import {
  SourceOperationReadinessError,
  getJobSourceControlPlane,
  operateJobSource,
  type SourceOperationCommand,
} from '../sourceOperations'
import { JOB_SOURCE_CONTROL_INDEX_NAMES } from '../../config/sourceControlLimits'
import { JOB_SOURCE_CATALOG, sourceSeed, sourcePolicyHash } from '../../config/sourceCatalog'

const base = {
  operationId: '018f6f08-8c2d-7b2e-9ca1-4ad0e35f8321',
  actorUserId: '507f1f77bcf86cd799439011',
  sourceId: 'jsearch',
  expectedControlRevision: 0,
  expectedOperationalRevision: 0,
} satisfies Omit<SourceOperationCommand, 'action'>

function exactIndexes() {
  return [
    { name: JOB_SOURCE_CONTROL_INDEX_NAMES.sourceConfigSourceId, key: { sourceId: 1 }, unique: true },
    { name: JOB_SOURCE_CONTROL_INDEX_NAMES.auditOperationId, key: { operationId: 1 }, unique: true },
    { name: JOB_SOURCE_CONTROL_INDEX_NAMES.auditSourceRevision, key: { sourceId: 1, revision: 1 }, unique: true },
    { name: JOB_SOURCE_CONTROL_INDEX_NAMES.operationAuditOperationId, key: { operationId: 1 }, unique: true },
    { name: JOB_SOURCE_CONTROL_INDEX_NAMES.operationAuditSourceOccurredAt, key: { sourceId: 1, occurredAt: -1 } },
    { name: JOB_SOURCE_CONTROL_INDEX_NAMES.postingSourceIds, key: { sourceIds: 1 } },
    { name: JOB_SOURCE_CONTROL_INDEX_NAMES.postingProvenanceSourceId, key: { 'provenance.sourceId': 1 } },
  ]
}

describe('operateJobSource index authority', () => {
  it.each([
    { action: 'pause' as const },
    { action: 'update-settings' as const, settings: { cadenceMinutes: 60 } },
  ])('blocks $action before mutation when exact permanent-audit indexes are absent', async (command) => {
    mockAuditFindOne.mockReturnValue({ lean: () => Promise.resolve(null) })
    mockIndexes.mockResolvedValue([])

    await expect(operateJobSource({ ...base, ...command })).rejects.toBeInstanceOf(
      SourceOperationReadinessError,
    )
    expect(mockSourceFindOne).not.toHaveBeenCalled()
    expect(mockSourceUpdateOne).not.toHaveBeenCalled()
  })

  it('rejects a hidden required index before any source mutation', async () => {
    mockAuditFindOne.mockReturnValue({ lean: () => Promise.resolve(null) })
    mockIndexes.mockResolvedValue(exactIndexes().map((index) =>
      index.name === JOB_SOURCE_CONTROL_INDEX_NAMES.sourceConfigSourceId
        ? { ...index, hidden: true }
        : index,
    ))

    await expect(operateJobSource({ ...base, action: 'pause' })).rejects.toBeInstanceOf(
      SourceOperationReadinessError,
    )
    expect(mockSourceUpdateOne).not.toHaveBeenCalled()
  })
})

describe('source-control readiness convergence', () => {
  it('reports bootstrap-required when an enabled row lacks a current policy-bound operational audit', async () => {
    mockIndexes.mockResolvedValue(exactIndexes())
    const sources = JOB_SOURCE_CATALOG.map((definition) => ({
      ...sourceSeed(definition),
      enabled: definition.sourceId === 'jsearch',
    }))
    mockSourceFind.mockReturnValue({ lean: () => Promise.resolve(sources) })
    mockMetaFindOne.mockReturnValue({
      lean: () => Promise.resolve({ sourceLineageVersion: 1, controlWriteSeq: 0, retainedPostings: 0 }),
    })
    mockPostingCount.mockResolvedValue(0)
    mockLegalAuditCount.mockResolvedValue(0)
    mockPostingAggregate.mockResolvedValue([])
    mockCycleAggregate.mockResolvedValue([])
    mockOperationFind.mockReturnValue({
      sort: () => ({
        limit: () => ({
          select: () => ({ lean: () => Promise.resolve([{
            operationId: 'bootstrap-1', action: 'bootstrap', actorUserId: '507f1f77bcf86cd799439011',
            changes: {
              adoptedEnabledSources: 1,
              repairedSources: [{ sourceId: 'jsearch', fields: ['cadenceMinutes', 'not-safe'] }],
            },
            occurredAt: new Date('2026-07-22T01:00:00.000Z'),
          }]) }),
        }),
      }),
    })
    mockAuditFindOne.mockReturnValue({ lean: () => Promise.resolve(null) })
    delete process.env.REDIS_URL

    const plane = await getJobSourceControlPlane()

    expect(sourcePolicyHash(sources[0] as never)).toMatch(/^[a-f0-9]{64}$/)
    expect(plane.readiness.sourceControlReady).toBe(false)
    expect(plane.bootstrap.required).toBe(true)
    expect(plane.bootstrap.blockers.join(' ')).not.toContain('enabled sources')
    expect(plane.bootstrap.repairs).toContain(
      'pause and permanently audit enabled legacy rows without current operational authority',
    )
    expect(plane.audit[0]).toMatchObject({
      changes: {
        adoptedEnabledSources: 1,
        repairedSources: [{ sourceId: 'jsearch', fields: ['cadenceMinutes'] }],
      },
    })
  })

  it('does not report source-control ready for a partial reviewed catalog', async () => {
    mockIndexes.mockResolvedValue(exactIndexes())
    const sources = JOB_SOURCE_CATALOG.slice(1).map((definition) => sourceSeed(definition))
    mockSourceFind.mockReturnValue({ lean: () => Promise.resolve(sources) })
    mockMetaFindOne.mockReturnValue({ lean: () => Promise.resolve({ sourceLineageVersion: 1, controlWriteSeq: 0, retainedPostings: 0 }) })
    mockPostingCount.mockResolvedValue(0)
    mockLegalAuditCount.mockResolvedValue(0)
    mockPostingAggregate.mockResolvedValue([])
    mockCycleAggregate.mockResolvedValue([])
    mockOperationFind.mockReturnValue({ sort: () => ({ limit: () => ({ select: () => ({ lean: () => Promise.resolve([]) }) }) }) })
    mockAuditFindOne.mockReturnValue({ lean: () => Promise.resolve(null) })
    delete process.env.REDIS_URL

    const plane = await getJobSourceControlPlane()

    expect(plane.readiness.sourceControlReady).toBe(false)
    expect(plane.bootstrap.required).toBe(true)
    expect(plane.bootstrap.repairs).toContain('seed missing deploy-reviewed catalog sources in a paused state')
  })
})
