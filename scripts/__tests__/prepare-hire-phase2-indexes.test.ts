import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  connectDB: vi.fn(),
  intakeCreateIndex: vi.fn(),
  intakeIndexes: vi.fn(),
  gateCreateIndex: vi.fn(),
  gateIndexes: vi.fn(),
  batchCreateIndex: vi.fn(),
  batchIndexes: vi.fn(),
  itemCreateIndex: vi.fn(),
  itemIndexes: vi.fn(),
  itemAggregate: vi.fn(),
  itemDuplicateRows: vi.fn(),
}))

vi.mock('../../shared/db/connection', () => ({ connectDB: mocks.connectDB }))
vi.mock('../../modules/hire/models', () => ({
  HireIntakeTask: {
    collection: { createIndex: mocks.intakeCreateIndex, indexes: mocks.intakeIndexes },
  },
  HireScreeningGate: {
    collection: { createIndex: mocks.gateCreateIndex, indexes: mocks.gateIndexes },
  },
  HireInvitationBatch: {
    collection: { createIndex: mocks.batchCreateIndex, indexes: mocks.batchIndexes },
  },
  HireInvitationBatchItem: {
    collection: {
      createIndex: mocks.itemCreateIndex,
      indexes: mocks.itemIndexes,
      aggregate: mocks.itemAggregate,
    },
  },
}))

import {
  HIRE_PHASE2_INDEX_DEFINITIONS,
  hirePhase2IndexPreparationModeOf,
  isExactHirePhase2Index,
  prepareHirePhase2Indexes,
} from '../prepare-hire-phase2-indexes'

const targetMocks = {
  'intake-tasks': {
    createIndex: mocks.intakeCreateIndex,
    indexes: mocks.intakeIndexes,
  },
  'screening-gates': {
    createIndex: mocks.gateCreateIndex,
    indexes: mocks.gateIndexes,
  },
  'invitation-batches': {
    createIndex: mocks.batchCreateIndex,
    indexes: mocks.batchIndexes,
  },
  'invitation-batch-items': {
    createIndex: mocks.itemCreateIndex,
    indexes: mocks.itemIndexes,
  },
} as const

type Target = keyof typeof targetMocks

function exactIndexes(target: Target) {
  return HIRE_PHASE2_INDEX_DEFINITIONS
    .filter((definition) => definition.target === target)
    .map((definition) => ({
      name: definition.name,
      key: definition.key,
      ...(definition.unique ? { unique: true } : {}),
      ...(definition.partialFilterExpression
        ? { partialFilterExpression: definition.partialFilterExpression }
        : {}),
      ...(definition.sparse ? { sparse: true } : {}),
    }))
}

function setAllExactIndexes(): void {
  for (const target of Object.keys(targetMocks) as Target[]) {
    targetMocks[target].indexes.mockResolvedValue(exactIndexes(target))
  }
}

function setAllMissingThenExact(): void {
  for (const target of Object.keys(targetMocks) as Target[]) {
    targetMocks[target].indexes
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(exactIndexes(target))
  }
}

function resetCreateIndexResults(): void {
  for (const definition of HIRE_PHASE2_INDEX_DEFINITIONS) {
    targetMocks[definition.target].createIndex.mockResolvedValue(definition.name)
  }
}

describe('Hire Phase 2 control index preparation', () => {
  const originalSurface = process.env.IPG_SURFACE
  const originalDatabase = process.env.HIRE_CONTROL_DATABASE_NAME

  beforeEach(() => {
    vi.resetAllMocks()
    process.env.IPG_SURFACE = 'hire-control'
    process.env.HIRE_CONTROL_DATABASE_NAME = 'hire-control'
    mocks.connectDB.mockResolvedValue({ connection: { name: 'hire-control' } })
    mocks.itemAggregate.mockReturnValue({ toArray: mocks.itemDuplicateRows })
    mocks.itemDuplicateRows.mockResolvedValue([])
    resetCreateIndexResults()
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
  })

  afterEach(() => {
    if (originalSurface === undefined) delete process.env.IPG_SURFACE
    else process.env.IPG_SURFACE = originalSurface
    if (originalDatabase === undefined) delete process.env.HIRE_CONTROL_DATABASE_NAME
    else process.env.HIRE_CONTROL_DATABASE_NAME = originalDatabase
    vi.restoreAllMocks()
  })

  it('defaults to a disconnected plan and rejects ambiguous flags', async () => {
    expect(hirePhase2IndexPreparationModeOf([])).toBe('plan')
    expect(hirePhase2IndexPreparationModeOf(['--check'])).toBe('check')
    expect(hirePhase2IndexPreparationModeOf(['--apply'])).toBe('apply')
    expect(hirePhase2IndexPreparationModeOf(['--help'])).toBe('help')
    expect(() => hirePhase2IndexPreparationModeOf(['--apply', '--check'])).toThrow('mutually exclusive')
    expect(() => hirePhase2IndexPreparationModeOf(['--help', '--check'])).toThrow('cannot be combined')
    expect(() => hirePhase2IndexPreparationModeOf(['--drop'])).toThrow('unknown argument')

    await prepareHirePhase2Indexes([])
    expect(mocks.connectDB).not.toHaveBeenCalled()
    for (const target of Object.keys(targetMocks) as Target[]) {
      expect(targetMocks[target].indexes).not.toHaveBeenCalled()
      expect(targetMocks[target].createIndex).not.toHaveBeenCalled()
    }
  })

  it('keeps --check read-only and verifies all 11 exact indexes', async () => {
    setAllExactIndexes()

    await prepareHirePhase2Indexes(['--check'])

    expect(mocks.connectDB).toHaveBeenCalledWith({ schemaInitialization: 'disabled' })
    for (const target of Object.keys(targetMocks) as Target[]) {
      expect(targetMocks[target].indexes).toHaveBeenCalledTimes(1)
      expect(targetMocks[target].createIndex).not.toHaveBeenCalled()
    }
    expect(mocks.itemAggregate).not.toHaveBeenCalled()
  })

  it('creates every missing exact index only after whole-rollout preflight', async () => {
    setAllMissingThenExact()

    await prepareHirePhase2Indexes(['--apply'])

    expect(mocks.connectDB).toHaveBeenCalledWith({ schemaInitialization: 'disabled' })
    expect(mocks.itemAggregate).toHaveBeenCalledTimes(1)
    expect(mocks.itemAggregate).toHaveBeenCalledWith([
      { $match: { applicationId: { $exists: true } } },
      {
        $group: {
          _id: { workspaceId: '$workspaceId', applicationId: '$applicationId' },
          count: { $sum: 1 },
        },
      },
      { $match: { count: { $gt: 1 } } },
      { $limit: 1 },
    ])
    expect(mocks.intakeCreateIndex).toHaveBeenCalledTimes(2)
    expect(mocks.gateCreateIndex).toHaveBeenCalledTimes(2)
    expect(mocks.batchCreateIndex).toHaveBeenCalledTimes(3)
    expect(mocks.itemCreateIndex).toHaveBeenCalledTimes(4)
    expect(mocks.itemCreateIndex).toHaveBeenCalledWith(
      { workspaceId: 1, applicationId: 1 },
      {
        name: 'workspaceId_1_applicationId_1',
        unique: true,
        partialFilterExpression: { applicationId: { $exists: true } },
      },
    )
    expect(mocks.itemCreateIndex).toHaveBeenCalledWith(
      { workspaceId: 1, roundId: 1 },
      { name: 'workspaceId_1_roundId_1', sparse: true },
    )
  })

  it('treats a first-rollout absent collection as missing indexes, not as a database error', async () => {
    setAllMissingThenExact()
    mocks.gateIndexes
      .mockReset()
      .mockRejectedValueOnce({ code: 26, codeName: 'NamespaceNotFound' })
      .mockResolvedValueOnce(exactIndexes('screening-gates'))

    await prepareHirePhase2Indexes(['--apply'])

    expect(mocks.gateCreateIndex).toHaveBeenCalledTimes(2)
  })

  it('fails closed on a legacy full application uniqueness index before any write', async () => {
    setAllExactIndexes()
    mocks.itemIndexes.mockResolvedValue([
      ...exactIndexes('invitation-batch-items').filter(
        (index) => index.name !== 'workspaceId_1_applicationId_1',
      ),
      {
        name: 'legacy_workspace_application_unique',
        key: { workspaceId: 1, applicationId: 1 },
        unique: true,
      },
    ])

    await expect(prepareHirePhase2Indexes(['--apply'])).rejects.toThrow(
      'legacy full unique invitation-item index detected',
    )

    for (const target of Object.keys(targetMocks) as Target[]) {
      expect(targetMocks[target].createIndex).not.toHaveBeenCalled()
    }
    expect(mocks.itemAggregate).not.toHaveBeenCalled()
  })

  it('fails closed on any other same-key incompatible index before any write', async () => {
    setAllExactIndexes()
    mocks.gateIndexes.mockResolvedValue([
      ...exactIndexes('screening-gates').filter(
        (index) => index.name !== 'workspaceId_1_jobId_1_confirmedAt_-1__id_-1',
      ),
      {
        name: 'wrong_partial_gate_history',
        key: { workspaceId: 1, jobId: 1, confirmedAt: -1, _id: -1 },
        partialFilterExpression: { status: 'confirmed' },
      },
    ])

    await expect(prepareHirePhase2Indexes(['--apply'])).rejects.toThrow(
      'incompatible same-key Phase 2 index',
    )

    for (const target of Object.keys(targetMocks) as Target[]) {
      expect(targetMocks[target].createIndex).not.toHaveBeenCalled()
    }
    expect(mocks.itemAggregate).not.toHaveBeenCalled()
  })

  it('rejects data that cannot satisfy the live application uniqueness invariant', async () => {
    setAllMissingThenExact()
    mocks.itemDuplicateRows.mockResolvedValue([{ _id: { workspaceId: 'w', applicationId: 'a' }, count: 2 }])

    await expect(prepareHirePhase2Indexes(['--apply'])).rejects.toThrow(
      'duplicate live HireInvitationBatchItem workspace/application rows',
    )

    for (const target of Object.keys(targetMocks) as Target[]) {
      expect(targetMocks[target].createIndex).not.toHaveBeenCalled()
    }
  })

  it('requires the exact sparse/partial options rather than just matching keys', async () => {
    const itemDefinition = HIRE_PHASE2_INDEX_DEFINITIONS.find(
      (definition) => definition.name === 'workspaceId_1_applicationId_1',
    )
    expect(itemDefinition).toBeDefined()
    expect(isExactHirePhase2Index(
      {
        name: 'workspaceId_1_applicationId_1',
        key: { workspaceId: 1, applicationId: 1 },
        unique: true,
      },
      itemDefinition!,
    )).toBe(false)
  })
})
