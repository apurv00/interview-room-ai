import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  connectDB: vi.fn(),
  roundCreateIndex: vi.fn(),
  roundIndexes: vi.fn(),
  roundAggregate: vi.fn(),
  roundDuplicateRows: vi.fn(),
  kitCreateIndex: vi.fn(),
  kitIndexes: vi.fn(),
  kitAggregate: vi.fn(),
  kitDuplicateRows: vi.fn(),
  scorecardCreateIndex: vi.fn(),
  scorecardIndexes: vi.fn(),
  scorecardAggregate: vi.fn(),
  scorecardDuplicateRows: vi.fn(),
  deliveryCreateIndex: vi.fn(),
  deliveryIndexes: vi.fn(),
  deliveryAggregate: vi.fn(),
  deliveryDuplicateRows: vi.fn(),
}))

vi.mock('../../shared/db/connection', () => ({ connectDB: mocks.connectDB }))
vi.mock('../../modules/hire/models', () => ({
  HireHumanRound: {
    collection: {
      createIndex: mocks.roundCreateIndex,
      indexes: mocks.roundIndexes,
      aggregate: mocks.roundAggregate,
    },
  },
  HireInterviewKit: {
    collection: {
      createIndex: mocks.kitCreateIndex,
      indexes: mocks.kitIndexes,
      aggregate: mocks.kitAggregate,
    },
  },
  HireHumanScorecard: {
    collection: {
      createIndex: mocks.scorecardCreateIndex,
      indexes: mocks.scorecardIndexes,
      aggregate: mocks.scorecardAggregate,
    },
  },
  HireHumanKitDelivery: {
    collection: {
      createIndex: mocks.deliveryCreateIndex,
      indexes: mocks.deliveryIndexes,
      aggregate: mocks.deliveryAggregate,
    },
  },
}))

import {
  HIRE_PHASE3_INDEX_DEFINITIONS,
  hirePhase3IndexPreparationModeOf,
  isExactHirePhase3Index,
  prepareHirePhase3Indexes,
} from '../prepare-hire-phase3-indexes'

const targetMocks = {
  'human-rounds': {
    createIndex: mocks.roundCreateIndex,
    indexes: mocks.roundIndexes,
    aggregate: mocks.roundAggregate,
  },
  'interview-kits': {
    createIndex: mocks.kitCreateIndex,
    indexes: mocks.kitIndexes,
    aggregate: mocks.kitAggregate,
  },
  'human-scorecards': {
    createIndex: mocks.scorecardCreateIndex,
    indexes: mocks.scorecardIndexes,
    aggregate: mocks.scorecardAggregate,
  },
  'human-kit-deliveries': {
    createIndex: mocks.deliveryCreateIndex,
    indexes: mocks.deliveryIndexes,
    aggregate: mocks.deliveryAggregate,
  },
} as const

type Target = keyof typeof targetMocks

function exactIndexes(target: Target) {
  return HIRE_PHASE3_INDEX_DEFINITIONS
    .filter((definition) => definition.target === target)
    .map((definition) => ({
      name: definition.name,
      key: definition.key,
      ...(definition.unique ? { unique: true } : {}),
      ...(definition.partialFilterExpression
        ? { partialFilterExpression: definition.partialFilterExpression }
        : {}),
      ...(definition.expireAfterSeconds !== undefined
        ? { expireAfterSeconds: definition.expireAfterSeconds }
        : {}),
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
  for (const definition of HIRE_PHASE3_INDEX_DEFINITIONS) {
    targetMocks[definition.target].createIndex.mockResolvedValue(definition.name)
  }
}

describe('Hire Phase 3 control index preparation', () => {
  const originalSurface = process.env.IPG_SURFACE
  const originalDatabase = process.env.HIRE_CONTROL_DATABASE_NAME

  beforeEach(() => {
    vi.resetAllMocks()
    process.env.IPG_SURFACE = 'hire-control'
    process.env.HIRE_CONTROL_DATABASE_NAME = 'hire-control'
    mocks.connectDB.mockResolvedValue({ connection: { name: 'hire-control' } })
    mocks.roundAggregate.mockReturnValue({ toArray: mocks.roundDuplicateRows })
    mocks.kitAggregate.mockReturnValue({ toArray: mocks.kitDuplicateRows })
    mocks.scorecardAggregate.mockReturnValue({ toArray: mocks.scorecardDuplicateRows })
    mocks.deliveryAggregate.mockReturnValue({ toArray: mocks.deliveryDuplicateRows })
    mocks.roundDuplicateRows.mockResolvedValue([])
    mocks.kitDuplicateRows.mockResolvedValue([])
    mocks.scorecardDuplicateRows.mockResolvedValue([])
    mocks.deliveryDuplicateRows.mockResolvedValue([])
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
    expect(hirePhase3IndexPreparationModeOf([])).toBe('plan')
    expect(hirePhase3IndexPreparationModeOf(['--check'])).toBe('check')
    expect(hirePhase3IndexPreparationModeOf(['--apply'])).toBe('apply')
    expect(hirePhase3IndexPreparationModeOf(['--help'])).toBe('help')
    expect(() => hirePhase3IndexPreparationModeOf(['--apply', '--check'])).toThrow('mutually exclusive')
    expect(() => hirePhase3IndexPreparationModeOf(['--help', '--check'])).toThrow('cannot be combined')
    expect(() => hirePhase3IndexPreparationModeOf(['--drop'])).toThrow('unknown argument')

    await prepareHirePhase3Indexes([])

    expect(mocks.connectDB).not.toHaveBeenCalled()
    for (const target of Object.keys(targetMocks) as Target[]) {
      expect(targetMocks[target].indexes).not.toHaveBeenCalled()
      expect(targetMocks[target].createIndex).not.toHaveBeenCalled()
      expect(targetMocks[target].aggregate).not.toHaveBeenCalled()
    }
  })

  it('keeps --check read-only and verifies all 12 exact indexes', async () => {
    setAllExactIndexes()

    await prepareHirePhase3Indexes(['--check'])

    expect(mocks.connectDB).toHaveBeenCalledWith({ schemaInitialization: 'disabled' })
    for (const target of Object.keys(targetMocks) as Target[]) {
      expect(targetMocks[target].indexes).toHaveBeenCalledTimes(1)
      expect(targetMocks[target].createIndex).not.toHaveBeenCalled()
      expect(targetMocks[target].aggregate).not.toHaveBeenCalled()
    }
    expect(console.log).toHaveBeenCalledWith(
      `\nCHECK PASSED — all ${HIRE_PHASE3_INDEX_DEFINITIONS.length} exact Phase 3 Hire-control indexes exist.`,
    )
  })

  it('creates only missing exact indexes after all same-key and unique-data preflight checks', async () => {
    setAllMissingThenExact()

    await prepareHirePhase3Indexes(['--apply'])

    expect(mocks.connectDB).toHaveBeenCalledWith({ schemaInitialization: 'disabled' })
    expect(mocks.roundAggregate).toHaveBeenCalledTimes(1)
    expect(mocks.kitAggregate).toHaveBeenCalledTimes(1)
    expect(mocks.scorecardAggregate).toHaveBeenCalledTimes(1)
    expect(mocks.deliveryAggregate).toHaveBeenCalledTimes(1)
    expect(mocks.roundCreateIndex).toHaveBeenCalledTimes(3)
    expect(mocks.kitCreateIndex).toHaveBeenCalledTimes(3)
    expect(mocks.scorecardCreateIndex).toHaveBeenCalledTimes(2)
    expect(mocks.deliveryCreateIndex).toHaveBeenCalledTimes(4)
    expect(mocks.kitCreateIndex).toHaveBeenCalledWith(
      { workspaceId: 1, humanRoundId: 1, active: 1 },
      {
        name: 'workspaceId_1_humanRoundId_1_active_1',
        unique: true,
        partialFilterExpression: { active: true },
      },
    )
    expect(mocks.deliveryCreateIndex).toHaveBeenCalledWith(
      { expiresAt: 1 },
      { name: 'expiresAt_1', expireAfterSeconds: 0 },
    )
    expect(console.log).toHaveBeenCalledWith(
      `\nAPPLY PASSED — all ${HIRE_PHASE3_INDEX_DEFINITIONS.length} exact indexes exist; no index was removed.`,
    )
  })

  it('treats a first-rollout absent collection as missing indexes rather than a database error', async () => {
    setAllMissingThenExact()
    mocks.scorecardIndexes
      .mockReset()
      .mockRejectedValueOnce({ code: 26, codeName: 'NamespaceNotFound' })
      .mockResolvedValueOnce(exactIndexes('human-scorecards'))

    await prepareHirePhase3Indexes(['--apply'])

    expect(mocks.scorecardCreateIndex).toHaveBeenCalledTimes(2)
  })

  it('fails closed on an incompatible same-key index before any write', async () => {
    setAllExactIndexes()
    mocks.kitIndexes.mockResolvedValue([
      ...exactIndexes('interview-kits').filter(
        (index) => index.name !== 'workspaceId_1_humanRoundId_1_active_1',
      ),
      {
        name: 'wrong_non_partial_active_kit_index',
        key: { workspaceId: 1, humanRoundId: 1, active: 1 },
        unique: true,
      },
    ])

    await expect(prepareHirePhase3Indexes(['--apply'])).rejects.toThrow(
      'incompatible same-key Phase 3 index',
    )

    for (const target of Object.keys(targetMocks) as Target[]) {
      expect(targetMocks[target].createIndex).not.toHaveBeenCalled()
      expect(targetMocks[target].aggregate).not.toHaveBeenCalled()
    }
  })

  it('fails closed before any write when an active-kit unique coordinate is duplicated', async () => {
    setAllMissingThenExact()
    mocks.kitDuplicateRows.mockResolvedValue([
      { _id: { workspaceId: 'w', humanRoundId: 'r', active: true }, count: 2 },
    ])

    await expect(prepareHirePhase3Indexes(['--apply'])).rejects.toThrow(
      'duplicate live workspace/human-round interview kits',
    )

    for (const target of Object.keys(targetMocks) as Target[]) {
      expect(targetMocks[target].createIndex).not.toHaveBeenCalled()
    }
  })

  it('requires exact TTL and partial options rather than merely matching index keys', () => {
    const ttlDefinition = HIRE_PHASE3_INDEX_DEFINITIONS.find(
      (definition) => definition.name === 'expiresAt_1',
    )
    const activeKitDefinition = HIRE_PHASE3_INDEX_DEFINITIONS.find(
      (definition) => definition.name === 'workspaceId_1_humanRoundId_1_active_1',
    )
    expect(ttlDefinition).toBeDefined()
    expect(activeKitDefinition).toBeDefined()
    expect(isExactHirePhase3Index({
      name: 'expiresAt_1',
      key: { expiresAt: 1 },
    }, ttlDefinition!)).toBe(false)
    expect(isExactHirePhase3Index({
      name: 'workspaceId_1_humanRoundId_1_active_1',
      key: { workspaceId: 1, humanRoundId: 1, active: 1 },
      unique: true,
    }, activeKitDefinition!)).toBe(false)
  })
})
