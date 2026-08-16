import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HireDepartment as HireDepartmentSchema } from '../../modules/hire-departments/models/HireDepartment'

const mocks = vi.hoisted(() => ({
  connectDB: vi.fn(),
  departmentCreateIndex: vi.fn(),
  departmentIndexes: vi.fn(),
  departmentAggregate: vi.fn(),
  departmentDuplicateRows: vi.fn(),
  jobCreateIndex: vi.fn(),
  jobIndexes: vi.fn(),
}))

vi.mock('../../shared/db/connection', () => ({ connectDB: mocks.connectDB }))
vi.mock('../../modules/hire-departments/models', () => ({
  HireDepartment: {
    collection: {
      createIndex: mocks.departmentCreateIndex,
      indexes: mocks.departmentIndexes,
      aggregate: mocks.departmentAggregate,
    },
  },
}))
vi.mock('../../modules/hire/models', () => ({
  HireJob: {
    collection: {
      createIndex: mocks.jobCreateIndex,
      indexes: mocks.jobIndexes,
    },
  },
}))

import {
  HIRE_PHASE6_DEPARTMENT_INDEX_DEFINITIONS,
  hirePhase6DepartmentIndexPreparationModeOf,
  isExactHirePhase6DepartmentIndex,
  prepareHirePhase6DepartmentIndexes,
} from '../prepare-hire-phase6-department-indexes'

const targetMocks = {
  departments: {
    createIndex: mocks.departmentCreateIndex,
    indexes: mocks.departmentIndexes,
  },
  jobs: {
    createIndex: mocks.jobCreateIndex,
    indexes: mocks.jobIndexes,
  },
} as const

type Target = keyof typeof targetMocks

function exactIndexes(target: Target) {
  return HIRE_PHASE6_DEPARTMENT_INDEX_DEFINITIONS.filter(
    (definition) => definition.target === target,
  ).map((definition) => ({
    name: definition.name,
    key: definition.key,
    ...(definition.unique ? { unique: true } : {}),
    ...(definition.sparse ? { sparse: true } : {}),
    ...(definition.partialFilterExpression
      ? { partialFilterExpression: definition.partialFilterExpression }
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
  for (const definition of HIRE_PHASE6_DEPARTMENT_INDEX_DEFINITIONS) {
    targetMocks[definition.target].createIndex.mockResolvedValue(definition.name)
  }
}

describe('Hire Phase 6 department index preparation', () => {
  const originalSurface = process.env.IPG_SURFACE
  const originalDatabase = process.env.HIRE_CONTROL_DATABASE_NAME

  beforeEach(() => {
    vi.resetAllMocks()
    process.env.IPG_SURFACE = 'hire-control'
    process.env.HIRE_CONTROL_DATABASE_NAME = 'hire-control'
    mocks.connectDB.mockResolvedValue({ connection: { name: 'hire-control' } })
    mocks.departmentAggregate.mockReturnValue({ toArray: mocks.departmentDuplicateRows })
    mocks.departmentDuplicateRows.mockResolvedValue([])
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

  it('defaults to a disconnected plan and rejects unsafe or ambiguous flags', async () => {
    expect(hirePhase6DepartmentIndexPreparationModeOf([])).toBe('plan')
    expect(hirePhase6DepartmentIndexPreparationModeOf(['--check'])).toBe('check')
    expect(hirePhase6DepartmentIndexPreparationModeOf(['--apply'])).toBe('apply')
    expect(() => hirePhase6DepartmentIndexPreparationModeOf(['--apply', '--check']))
      .toThrow('mutually exclusive')
    expect(() => hirePhase6DepartmentIndexPreparationModeOf(['--drop']))
      .toThrow('unknown argument')

    await prepareHirePhase6DepartmentIndexes([])

    expect(mocks.connectDB).not.toHaveBeenCalled()
    expect(mocks.departmentIndexes).not.toHaveBeenCalled()
    expect(mocks.departmentCreateIndex).not.toHaveBeenCalled()
    expect(mocks.departmentAggregate).not.toHaveBeenCalled()
    expect(mocks.jobIndexes).not.toHaveBeenCalled()
    expect(mocks.jobCreateIndex).not.toHaveBeenCalled()
  })

  it('keeps check mode read-only and requires all exact collection indexes', async () => {
    setAllExactIndexes()

    await prepareHirePhase6DepartmentIndexes(['--check'])

    expect(mocks.connectDB).toHaveBeenCalledWith({ schemaInitialization: 'disabled' })
    expect(mocks.departmentIndexes).toHaveBeenCalledTimes(1)
    expect(mocks.jobIndexes).toHaveBeenCalledTimes(1)
    expect(mocks.departmentCreateIndex).not.toHaveBeenCalled()
    expect(mocks.jobCreateIndex).not.toHaveBeenCalled()
    expect(mocks.departmentAggregate).not.toHaveBeenCalled()
    expect(console.log).toHaveBeenCalledWith(
      `\nCHECK PASSED — all ${HIRE_PHASE6_DEPARTMENT_INDEX_DEFINITIONS.length} exact Phase 6 Hire-control department indexes exist.`,
    )
  })

  it('creates only missing exact indexes after the catalogue uniqueness preflight', async () => {
    setAllMissingThenExact()

    await prepareHirePhase6DepartmentIndexes(['--apply'])

    expect(mocks.departmentAggregate).toHaveBeenCalledTimes(2)
    expect(mocks.departmentCreateIndex).toHaveBeenCalledTimes(3)
    expect(mocks.jobCreateIndex).toHaveBeenCalledTimes(1)
    expect(mocks.departmentCreateIndex).toHaveBeenCalledWith(
      { workspaceId: 1, normalizedName: 1 },
      { name: 'workspaceId_1_normalizedName_1', unique: true },
    )
    expect(mocks.departmentCreateIndex).toHaveBeenCalledWith(
      { workspaceId: 1, systemKey: 1 },
      {
        name: 'workspaceId_1_systemKey_1',
        unique: true,
        partialFilterExpression: { systemKey: { $exists: true } },
      },
    )
    expect(mocks.departmentAggregate).toHaveBeenLastCalledWith([
      { $match: { systemKey: { $exists: true } } },
      {
        $group: {
          _id: { workspaceId: '$workspaceId', systemKey: '$systemKey' },
          count: { $sum: 1 },
        },
      },
      { $match: { count: { $gt: 1 } } },
      { $limit: 1 },
    ])
    expect(mocks.jobCreateIndex).toHaveBeenCalledWith(
      { workspaceId: 1, departmentId: 1, status: 1, createdAt: -1 },
      { name: 'workspaceId_1_departmentId_1_status_1_createdAt_-1' },
    )
    expect(console.log).toHaveBeenCalledWith(
      `\nAPPLY PASSED — all ${HIRE_PHASE6_DEPARTMENT_INDEX_DEFINITIONS.length} exact indexes exist; no index was removed.`,
    )
  })

  it('fails closed on an incompatible same-key index before any write', async () => {
    mocks.departmentIndexes.mockResolvedValue([
      {
        name: 'wrong-department-name-index',
        key: { workspaceId: 1, normalizedName: 1 },
        unique: false,
      },
    ])
    mocks.jobIndexes.mockResolvedValue(exactIndexes('jobs'))

    await expect(prepareHirePhase6DepartmentIndexes(['--apply']))
      .rejects.toThrow('incompatible same-key Phase 6 department index')

    expect(mocks.departmentAggregate).not.toHaveBeenCalled()
    expect(mocks.departmentCreateIndex).not.toHaveBeenCalled()
    expect(mocks.jobCreateIndex).not.toHaveBeenCalled()
  })

  it('treats a legacy sparse system-key index as incompatible and refuses writes', async () => {
    mocks.departmentIndexes.mockResolvedValue([
      ...exactIndexes('departments').filter(
        (index) => index.name !== 'workspaceId_1_systemKey_1',
      ),
      {
        name: 'workspaceId_1_systemKey_1',
        key: { workspaceId: 1, systemKey: 1 },
        unique: true,
        sparse: true,
      },
    ])
    mocks.jobIndexes.mockResolvedValue(exactIndexes('jobs'))

    await expect(prepareHirePhase6DepartmentIndexes(['--apply']))
      .rejects.toThrow('incompatible same-key Phase 6 department index')

    expect(mocks.departmentAggregate).not.toHaveBeenCalled()
    expect(mocks.departmentCreateIndex).not.toHaveBeenCalled()
    expect(mocks.jobCreateIndex).not.toHaveBeenCalled()
  })

  it('fails before writes when duplicate normalized department names would violate the unique invariant', async () => {
    mocks.departmentIndexes.mockResolvedValue([])
    mocks.jobIndexes.mockResolvedValue([])
    mocks.departmentDuplicateRows.mockResolvedValue([{ _id: { workspaceId: 'w1', normalizedName: 'sales' }, count: 2 }])

    await expect(prepareHirePhase6DepartmentIndexes(['--apply']))
      .rejects.toThrow('duplicate Department rows')

    expect(mocks.departmentCreateIndex).not.toHaveBeenCalled()
    expect(mocks.jobCreateIndex).not.toHaveBeenCalled()
  })

  it('preflights exactly the partial unique-index population for system keys', async () => {
    mocks.departmentIndexes.mockResolvedValue([])
    mocks.jobIndexes.mockResolvedValue([])
    mocks.departmentDuplicateRows
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ _id: { workspaceId: 'w1', systemKey: 'legacy' }, count: 2 }])

    await expect(prepareHirePhase6DepartmentIndexes(['--apply']))
      .rejects.toThrow('duplicate Department rows')

    expect(mocks.departmentAggregate).toHaveBeenLastCalledWith(expect.arrayContaining([
      { $match: { systemKey: { $exists: true } } },
    ]))
    expect(mocks.departmentCreateIndex).not.toHaveBeenCalled()
    expect(mocks.jobCreateIndex).not.toHaveBeenCalled()
  })

  it('treats an unmaterialized collection as missing indexes rather than a database failure', async () => {
    const namespaceMissing = Object.assign(new Error('namespace missing'), { code: 26 })
    mocks.departmentIndexes
      .mockRejectedValueOnce(namespaceMissing)
      .mockResolvedValueOnce(exactIndexes('departments'))
    mocks.jobIndexes
      .mockRejectedValueOnce(namespaceMissing)
      .mockResolvedValueOnce(exactIndexes('jobs'))

    await expect(prepareHirePhase6DepartmentIndexes(['--apply'])).resolves.toBeUndefined()

    expect(mocks.departmentCreateIndex).toHaveBeenCalledTimes(3)
    expect(mocks.jobCreateIndex).toHaveBeenCalledTimes(1)
  })

  it('covers each Department schema index plus the one HireJob read index', () => {
    const schemaIndexes = HireDepartmentSchema.schema.indexes() as Array<[
      Record<string, unknown>,
      {
        unique?: boolean
        sparse?: boolean
        partialFilterExpression?: Record<string, unknown>
      },
    ]>
    const departmentDefinitions = HIRE_PHASE6_DEPARTMENT_INDEX_DEFINITIONS.filter(
      (definition) => definition.target === 'departments',
    )

    expect(schemaIndexes).toHaveLength(3)
    expect(departmentDefinitions).toHaveLength(schemaIndexes.length)
    expect(HIRE_PHASE6_DEPARTMENT_INDEX_DEFINITIONS).toHaveLength(4)
    expect(HIRE_PHASE6_DEPARTMENT_INDEX_DEFINITIONS.filter(
      (definition) => definition.target === 'jobs',
    )).toHaveLength(1)

    for (const [key, options] of schemaIndexes) {
      const definition = departmentDefinitions.find(
        (candidate) => JSON.stringify(candidate.key) === JSON.stringify(key),
      )
      expect(definition).toBeDefined()
      expect(definition?.unique).toBe(Boolean(options.unique))
      expect(definition?.sparse).toBe(Boolean(options.sparse))
      expect(definition?.partialFilterExpression).toEqual(
        options.partialFilterExpression,
      )
    }
  })

  it('requires every option to match exactly, including partial versus sparse', () => {
    const definition = HIRE_PHASE6_DEPARTMENT_INDEX_DEFINITIONS.find(
      (candidate) => candidate.name === 'workspaceId_1_systemKey_1',
    )
    expect(definition).toBeDefined()
    expect(isExactHirePhase6DepartmentIndex(
      {
        name: definition!.name,
        key: definition!.key,
        unique: true,
        partialFilterExpression: { systemKey: { $exists: true } },
      },
      definition!,
    )).toBe(true)
    expect(isExactHirePhase6DepartmentIndex(
      {
        name: definition!.name,
        key: definition!.key,
        unique: true,
        sparse: true,
      },
      definition!,
    )).toBe(false)
  })
})
