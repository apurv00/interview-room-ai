import mongoose from 'mongoose'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  connectDB: vi.fn(),
  departmentIndexes: vi.fn(),
  departmentFindOne: vi.fn(),
  departmentUpdateOne: vi.fn(),
  jobAggregate: vi.fn(),
  workspaceRows: vi.fn(),
  jobCountDocuments: vi.fn(),
  jobUpdateMany: vi.fn(),
  withTransaction: vi.fn(),
  endSession: vi.fn(),
}))

vi.mock('../../shared/db/connection', () => ({ connectDB: mocks.connectDB }))
vi.mock('../../modules/hire-departments/models', () => ({
  HireDepartment: {
    collection: {
      indexes: mocks.departmentIndexes,
      findOne: mocks.departmentFindOne,
      updateOne: mocks.departmentUpdateOne,
    },
  },
}))
vi.mock('../../modules/hire/models', () => ({
  HireJob: {
    collection: {
      aggregate: mocks.jobAggregate,
      countDocuments: mocks.jobCountDocuments,
      updateMany: mocks.jobUpdateMany,
    },
  },
}))

import {
  HIRE_LEGACY_DEPARTMENT_NAME,
  HIRE_LEGACY_DEPARTMENT_NORMALIZED_NAME,
  HIRE_LEGACY_DEPARTMENT_SYSTEM_KEY,
  assertNoMissingHireJobDepartments,
  backfillHireJobDepartments,
  hireJobDepartmentBackfillModeOf,
  missingHireJobDepartmentFilter,
  missingHireJobDepartmentWorkspacePipeline,
} from '../backfill-hire-job-departments'
import { HIRE_PHASE6_DEPARTMENT_INDEX_DEFINITIONS } from '../prepare-hire-phase6-department-indexes'

const IDS = {
  workspace: new mongoose.Types.ObjectId('111111111111111111111111'),
  department: new mongoose.Types.ObjectId('222222222222222222222222'),
}
const NOW = new Date('2026-08-16T09:00:00.000Z')

const session = {
  withTransaction: mocks.withTransaction,
  endSession: mocks.endSession,
}

function exactDepartmentUniqueIndexes() {
  return HIRE_PHASE6_DEPARTMENT_INDEX_DEFINITIONS.filter(
    (definition) => definition.target === 'departments' && definition.unique,
  ).map((definition) => ({
    name: definition.name,
    key: definition.key,
    unique: true,
    ...(definition.sparse ? { sparse: true } : {}),
    ...(definition.partialFilterExpression
      ? { partialFilterExpression: definition.partialFilterExpression }
      : {}),
  }))
}

describe('HireJob mandatory department backfill', () => {
  const originalSurface = process.env.IPG_SURFACE
  const originalDatabase = process.env.HIRE_CONTROL_DATABASE_NAME

  beforeEach(() => {
    vi.resetAllMocks()
    process.env.IPG_SURFACE = 'hire-control'
    process.env.HIRE_CONTROL_DATABASE_NAME = 'hire-control'
    mocks.connectDB.mockResolvedValue({ connection: { name: 'hire-control' } })
    mocks.departmentIndexes.mockResolvedValue(exactDepartmentUniqueIndexes())
    mocks.jobAggregate.mockReturnValue({ toArray: mocks.workspaceRows })
    mocks.workspaceRows.mockResolvedValue([])
    mocks.jobCountDocuments.mockResolvedValue(0)
    mocks.departmentFindOne.mockResolvedValue(null)
    mocks.departmentUpdateOne.mockResolvedValue({ upsertedCount: 1 })
    mocks.jobUpdateMany.mockResolvedValue({ matchedCount: 0, modifiedCount: 0 })
    mocks.withTransaction.mockImplementation(async (work: () => Promise<unknown>) => work())
    mocks.endSession.mockResolvedValue(undefined)
    vi.spyOn(mongoose, 'startSession').mockResolvedValue(session as never)
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
  })

  afterEach(() => {
    if (originalSurface === undefined) delete process.env.IPG_SURFACE
    else process.env.IPG_SURFACE = originalSurface
    if (originalDatabase === undefined) delete process.env.HIRE_CONTROL_DATABASE_NAME
    else process.env.HIRE_CONTROL_DATABASE_NAME = originalDatabase
    vi.restoreAllMocks()
  })

  it('defaults to a disconnected plan and exposes only missing/null job filters', async () => {
    expect(hireJobDepartmentBackfillModeOf([])).toBe('plan')
    expect(hireJobDepartmentBackfillModeOf(['--check'])).toBe('check')
    expect(hireJobDepartmentBackfillModeOf(['--apply'])).toBe('apply')
    expect(() => hireJobDepartmentBackfillModeOf(['--apply', '--check']))
      .toThrow('choose either')
    expect(() => hireJobDepartmentBackfillModeOf(['--drop']))
      .toThrow('unknown argument')

    expect(missingHireJobDepartmentFilter()).toEqual({
      $or: [
        { departmentId: { $exists: false } },
        { departmentId: null },
      ],
    })
    expect(missingHireJobDepartmentWorkspacePipeline()).toEqual([
      { $match: missingHireJobDepartmentFilter() },
      { $group: { _id: '$workspaceId', jobCount: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ])

    await backfillHireJobDepartments([], NOW)

    expect(mocks.connectDB).not.toHaveBeenCalled()
    expect(mocks.departmentIndexes).not.toHaveBeenCalled()
    expect(mocks.jobAggregate).not.toHaveBeenCalled()
    expect(mocks.departmentUpdateOne).not.toHaveBeenCalled()
    expect(mocks.jobUpdateMany).not.toHaveBeenCalled()
    expect(mongoose.startSession).not.toHaveBeenCalled()
  })

  it('keeps --check read-only and fails visibly until every job is classified', async () => {
    await backfillHireJobDepartments(['--check'], NOW)

    expect(mocks.connectDB).toHaveBeenCalledWith({ schemaInitialization: 'disabled' })
    expect(mocks.departmentIndexes).toHaveBeenCalledTimes(1)
    expect(mocks.jobCountDocuments).toHaveBeenCalledWith(missingHireJobDepartmentFilter())
    expect(mocks.jobAggregate).not.toHaveBeenCalled()
    expect(mocks.departmentUpdateOne).not.toHaveBeenCalled()
    expect(mocks.jobUpdateMany).not.toHaveBeenCalled()
    expect(mongoose.startSession).not.toHaveBeenCalled()

    mocks.jobCountDocuments.mockResolvedValueOnce(2)
    await expect(backfillHireJobDepartments(['--check'], NOW))
      .rejects.toThrow('2 job(s) still have a null or missing departmentId')
    expect(mocks.departmentUpdateOne).not.toHaveBeenCalled()
  })

  it('requires both Department unique invariants before it can write', async () => {
    mocks.departmentIndexes.mockResolvedValue([
      {
        name: 'workspaceId_1_normalizedName_1',
        key: { workspaceId: 1, normalizedName: 1 },
        unique: true,
      },
    ])

    await expect(backfillHireJobDepartments(['--apply'], NOW))
      .rejects.toThrow('unique indexes must exist')

    expect(mocks.jobAggregate).not.toHaveBeenCalled()
    expect(mocks.departmentUpdateOne).not.toHaveBeenCalled()
    expect(mocks.jobUpdateMany).not.toHaveBeenCalled()
    expect(mongoose.startSession).not.toHaveBeenCalled()
  })

  it('upserts the exact non-assignable system legacy row and updates only missing/null jobs', async () => {
    mocks.workspaceRows.mockResolvedValue([{ _id: IDS.workspace, jobCount: 2 }])
    mocks.departmentFindOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        _id: IDS.department,
        workspaceId: IDS.workspace,
        name: HIRE_LEGACY_DEPARTMENT_NAME,
        normalizedName: HIRE_LEGACY_DEPARTMENT_NORMALIZED_NAME,
        kind: 'legacy',
        systemKey: 'legacy',
        status: 'active',
      })
    mocks.jobUpdateMany.mockResolvedValue({ matchedCount: 2, modifiedCount: 2 })

    await backfillHireJobDepartments(['--apply'], NOW)

    expect(mocks.departmentUpdateOne).toHaveBeenCalledWith(
      { workspaceId: IDS.workspace, kind: 'legacy' },
      {
        $setOnInsert: {
          workspaceId: IDS.workspace,
          name: HIRE_LEGACY_DEPARTMENT_NAME,
          normalizedName: HIRE_LEGACY_DEPARTMENT_NORMALIZED_NAME,
          kind: 'legacy',
          systemKey: HIRE_LEGACY_DEPARTMENT_SYSTEM_KEY,
          status: 'active',
          createdAt: NOW,
          updatedAt: NOW,
        },
      },
      { upsert: true, session },
    )
    expect(mocks.jobUpdateMany).toHaveBeenCalledWith(
      { workspaceId: IDS.workspace, ...missingHireJobDepartmentFilter() },
      { $set: { departmentId: IDS.department, updatedAt: NOW } },
      { session },
    )
    expect(mocks.withTransaction).toHaveBeenCalledTimes(1)
    expect(mocks.endSession).toHaveBeenCalledTimes(1)
    expect(mocks.jobCountDocuments).toHaveBeenCalledWith(missingHireJobDepartmentFilter())
  })

  it('is idempotent after a null-free backfill', async () => {
    await backfillHireJobDepartments(['--apply'], NOW)

    expect(mocks.jobAggregate).toHaveBeenCalledTimes(1)
    expect(mocks.departmentFindOne).not.toHaveBeenCalled()
    expect(mocks.departmentUpdateOne).not.toHaveBeenCalled()
    expect(mocks.jobUpdateMany).not.toHaveBeenCalled()
    expect(mongoose.startSession).not.toHaveBeenCalled()
  })

  it('refuses a pre-existing legacy row without the immutable system key', async () => {
    mocks.workspaceRows.mockResolvedValue([{ _id: IDS.workspace, jobCount: 1 }])
    mocks.departmentFindOne.mockResolvedValueOnce({
      _id: IDS.department,
      workspaceId: IDS.workspace,
      name: HIRE_LEGACY_DEPARTMENT_NAME,
      normalizedName: HIRE_LEGACY_DEPARTMENT_NORMALIZED_NAME,
      kind: 'legacy',
      status: 'active',
    })

    await expect(backfillHireJobDepartments(['--apply'], NOW))
      .rejects.toThrow('incompatible department')

    expect(mocks.departmentUpdateOne).not.toHaveBeenCalled()
    expect(mocks.jobUpdateMany).not.toHaveBeenCalled()
    expect(mocks.endSession).toHaveBeenCalledTimes(1)
  })

  it('fails its final invariant check if an old writer leaves a null department', async () => {
    mocks.workspaceRows.mockResolvedValue([{ _id: IDS.workspace, jobCount: 1 }])
    mocks.departmentFindOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        _id: IDS.department,
        name: HIRE_LEGACY_DEPARTMENT_NAME,
        normalizedName: HIRE_LEGACY_DEPARTMENT_NORMALIZED_NAME,
        kind: 'legacy',
        systemKey: 'legacy',
        status: 'active',
      })
    mocks.jobUpdateMany.mockResolvedValue({ matchedCount: 1, modifiedCount: 1 })
    mocks.jobCountDocuments.mockResolvedValueOnce(1)

    await expect(backfillHireJobDepartments(['--apply'], NOW))
      .rejects.toThrow('1 job(s) still have a null or missing departmentId')
  })

  it('rejects a positive remaining count as a reusable invariant guard', () => {
    expect(() => assertNoMissingHireJobDepartments(1))
      .toThrow('1 job(s) still have a null or missing departmentId')
    expect(() => assertNoMissingHireJobDepartments(0)).not.toThrow()
  })
})
