import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  connectDB: vi.fn(),
  shareCreateIndex: vi.fn(),
  shareIndexes: vi.fn(),
  shareAggregate: vi.fn(),
  shareDuplicateRows: vi.fn(),
  verdictCreateIndex: vi.fn(),
  verdictIndexes: vi.fn(),
  verdictAggregate: vi.fn(),
  verdictDuplicateRows: vi.fn(),
  exportCreateIndex: vi.fn(),
  exportIndexes: vi.fn(),
  exportAggregate: vi.fn(),
  exportDuplicateRows: vi.fn(),
  cleanupCreateIndex: vi.fn(),
  cleanupIndexes: vi.fn(),
  cleanupAggregate: vi.fn(),
  cleanupDuplicateRows: vi.fn(),
}))

vi.mock('../../shared/db/connection', () => ({ connectDB: mocks.connectDB }))
vi.mock('../../modules/hire-decisions/models', () => ({
  HireSharePacket: {
    collection: {
      createIndex: mocks.shareCreateIndex,
      indexes: mocks.shareIndexes,
      aggregate: mocks.shareAggregate,
    },
  },
  HireExternalVerdict: {
    collection: {
      createIndex: mocks.verdictCreateIndex,
      indexes: mocks.verdictIndexes,
      aggregate: mocks.verdictAggregate,
    },
  },
  HireAssessmentExport: {
    collection: {
      createIndex: mocks.exportCreateIndex,
      indexes: mocks.exportIndexes,
      aggregate: mocks.exportAggregate,
    },
  },
  HireAssessmentExportCleanup: {
    collection: {
      createIndex: mocks.cleanupCreateIndex,
      indexes: mocks.cleanupIndexes,
      aggregate: mocks.cleanupAggregate,
    },
  },
}))

import {
  HIRE_PHASE4_INDEX_DEFINITIONS,
  hirePhase4IndexPreparationModeOf,
  isExactHirePhase4Index,
  prepareHirePhase4Indexes,
} from '../prepare-hire-phase4-indexes'

const targetMocks = {
  'share-packets': {
    createIndex: mocks.shareCreateIndex,
    indexes: mocks.shareIndexes,
    aggregate: mocks.shareAggregate,
  },
  'external-verdicts': {
    createIndex: mocks.verdictCreateIndex,
    indexes: mocks.verdictIndexes,
    aggregate: mocks.verdictAggregate,
  },
  'assessment-exports': {
    createIndex: mocks.exportCreateIndex,
    indexes: mocks.exportIndexes,
    aggregate: mocks.exportAggregate,
  },
  'assessment-export-cleanups': {
    createIndex: mocks.cleanupCreateIndex,
    indexes: mocks.cleanupIndexes,
    aggregate: mocks.cleanupAggregate,
  },
} as const

type Target = keyof typeof targetMocks

function exactIndexes(target: Target) {
  return HIRE_PHASE4_INDEX_DEFINITIONS
    .filter((definition) => definition.target === target)
    .map((definition) => ({
      name: definition.name,
      key: definition.key,
      ...(definition.unique ? { unique: true } : {}),
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
  for (const definition of HIRE_PHASE4_INDEX_DEFINITIONS) {
    targetMocks[definition.target].createIndex.mockResolvedValue(definition.name)
  }
}

describe('Hire Phase 4 decision-control index preparation', () => {
  const originalSurface = process.env.IPG_SURFACE
  const originalDatabase = process.env.HIRE_CONTROL_DATABASE_NAME

  beforeEach(() => {
    vi.resetAllMocks()
    process.env.IPG_SURFACE = 'hire-control'
    process.env.HIRE_CONTROL_DATABASE_NAME = 'hire-control'
    mocks.connectDB.mockResolvedValue({ connection: { name: 'hire-control' } })
    mocks.shareAggregate.mockReturnValue({ toArray: mocks.shareDuplicateRows })
    mocks.verdictAggregate.mockReturnValue({ toArray: mocks.verdictDuplicateRows })
    mocks.exportAggregate.mockReturnValue({ toArray: mocks.exportDuplicateRows })
    mocks.cleanupAggregate.mockReturnValue({ toArray: mocks.cleanupDuplicateRows })
    mocks.shareDuplicateRows.mockResolvedValue([])
    mocks.verdictDuplicateRows.mockResolvedValue([])
    mocks.exportDuplicateRows.mockResolvedValue([])
    mocks.cleanupDuplicateRows.mockResolvedValue([])
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

  it('defaults to disconnected plan mode and rejects ambiguous flags', async () => {
    expect(hirePhase4IndexPreparationModeOf([])).toBe('plan')
    expect(hirePhase4IndexPreparationModeOf(['--check'])).toBe('check')
    expect(hirePhase4IndexPreparationModeOf(['--apply'])).toBe('apply')
    expect(() => hirePhase4IndexPreparationModeOf(['--apply', '--check'])).toThrow('mutually exclusive')
    expect(() => hirePhase4IndexPreparationModeOf(['--drop'])).toThrow('unknown argument')

    await prepareHirePhase4Indexes([])

    expect(mocks.connectDB).not.toHaveBeenCalled()
    for (const target of Object.keys(targetMocks) as Target[]) {
      expect(targetMocks[target].indexes).not.toHaveBeenCalled()
      expect(targetMocks[target].createIndex).not.toHaveBeenCalled()
    }
  })

  it('keeps --check read-only across every Phase 4 collection', async () => {
    setAllExactIndexes()

    await prepareHirePhase4Indexes(['--check'])

    expect(mocks.connectDB).toHaveBeenCalledWith({ schemaInitialization: 'disabled' })
    for (const target of Object.keys(targetMocks) as Target[]) {
      expect(targetMocks[target].indexes).toHaveBeenCalledTimes(1)
      expect(targetMocks[target].createIndex).not.toHaveBeenCalled()
      expect(targetMocks[target].aggregate).not.toHaveBeenCalled()
    }
    expect(console.log).toHaveBeenCalledWith(
      `\nCHECK PASSED — all ${HIRE_PHASE4_INDEX_DEFINITIONS.length} exact Phase 4 Hire-control indexes exist.`,
    )
  })

  it('creates only missing exact indexes after every collection and unique-data preflight', async () => {
    setAllMissingThenExact()

    await prepareHirePhase4Indexes(['--apply'])

    expect(mocks.shareAggregate).toHaveBeenCalledTimes(1)
    expect(mocks.verdictAggregate).toHaveBeenCalledTimes(1)
    expect(mocks.exportAggregate).toHaveBeenCalledTimes(1)
    expect(mocks.cleanupAggregate).toHaveBeenCalledTimes(1)
    expect(mocks.shareCreateIndex).toHaveBeenCalledTimes(3)
    expect(mocks.verdictCreateIndex).toHaveBeenCalledTimes(3)
    expect(mocks.exportCreateIndex).toHaveBeenCalledTimes(5)
    expect(mocks.cleanupCreateIndex).toHaveBeenCalledTimes(2)
    expect(mocks.verdictCreateIndex).toHaveBeenCalledWith(
      { workspaceId: 1, packetId: 1 },
      { name: 'workspaceId_1_packetId_1', unique: true },
    )
    expect(console.log).toHaveBeenCalledWith(
      `\nAPPLY PASSED — all ${HIRE_PHASE4_INDEX_DEFINITIONS.length} exact indexes exist; no index was removed.`,
    )
  })

  it('fails closed on an incompatible share-packet same-key index before any write', async () => {
    setAllExactIndexes()
    mocks.shareIndexes.mockResolvedValue([
      ...exactIndexes('share-packets').filter((index) => index.name !== 'workspaceId_1_creationOperationId_1'),
      {
        name: 'wrong-share-operation-index',
        key: { workspaceId: 1, creationOperationId: 1 },
        unique: false,
      },
    ])

    await expect(prepareHirePhase4Indexes(['--apply'])).rejects.toThrow('incompatible same-key Phase 4 index')
    for (const target of Object.keys(targetMocks) as Target[]) {
      expect(targetMocks[target].createIndex).not.toHaveBeenCalled()
      expect(targetMocks[target].aggregate).not.toHaveBeenCalled()
    }
  })

  it('fails closed before any write for duplicate external verdict consumption', async () => {
    setAllMissingThenExact()
    mocks.verdictDuplicateRows.mockResolvedValue([{ _id: { workspaceId: 'w', packetId: 'p' }, count: 2 }])

    await expect(prepareHirePhase4Indexes(['--apply'])).rejects.toThrow('duplicate workspace/packet external-verdict rows')
    for (const target of Object.keys(targetMocks) as Target[]) {
      expect(targetMocks[target].createIndex).not.toHaveBeenCalled()
    }
  })

  it('requires exact options rather than merely matching the key pattern', () => {
    const definition = HIRE_PHASE4_INDEX_DEFINITIONS.find(
      (item) => item.target === 'assessment-exports' && item.name === 'workspaceId_1_creationOperationId_1',
    )
    expect(definition).toBeDefined()
    expect(isExactHirePhase4Index({
      name: definition!.name,
      key: definition!.key,
      unique: true,
      expireAfterSeconds: 0,
    }, definition!)).toBe(false)
  })

  it('plans the complete lifecycle and tombstone release gate', () => {
    expect(HIRE_PHASE4_INDEX_DEFINITIONS).toHaveLength(13)
    expect(HIRE_PHASE4_INDEX_DEFINITIONS).toContainEqual(expect.objectContaining({
      target: 'share-packets',
      key: { workspaceId: 1, candidateId: 1 },
    }))
    expect(HIRE_PHASE4_INDEX_DEFINITIONS).toContainEqual(expect.objectContaining({
      target: 'external-verdicts',
      key: { workspaceId: 1, candidateId: 1 },
    }))
    expect(HIRE_PHASE4_INDEX_DEFINITIONS).toContainEqual(expect.objectContaining({
      target: 'assessment-exports',
      key: { workspaceId: 1, jobId: 1, status: 1 },
    }))
    expect(HIRE_PHASE4_INDEX_DEFINITIONS).toContainEqual(expect.objectContaining({
      target: 'assessment-export-cleanups',
      key: { workspaceId: 1, exportId: 1 },
      unique: true,
    }))
    expect(HIRE_PHASE4_INDEX_DEFINITIONS).toContainEqual(expect.objectContaining({
      target: 'assessment-export-cleanups',
      key: { firstSweepAt: 1, nextRetryAt: 1, cleanupNotBeforeAt: 1, leaseExpiresAt: 1, _id: 1 },
    }))
  })
})
