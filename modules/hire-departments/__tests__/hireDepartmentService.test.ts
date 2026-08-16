import mongoose from 'mongoose'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AppError } from '@shared/errors'

const {
  mocks,
  session,
} = vi.hoisted(() => {
  const session = { id: 'department-session' }
  return {
    session,
    mocks: {
      connect: vi.fn(),
      fence: vi.fn(),
      findOne: vi.fn(),
      find: vi.fn(),
      findOneAndUpdate: vi.fn(),
      create: vi.fn(),
      countDocuments: vi.fn(),
    },
  }
})

vi.mock('../boundary', () => ({
  connectHireControlDB: (...args: unknown[]) => mocks.connect(...args),
  withActiveHireWorkspaceWriteTransaction: (...args: unknown[]) => mocks.fence(...args),
}))

vi.mock('../models', () => ({
  HIRE_SYSTEM_DEPARTMENT_NAMES: {
    legacy: 'Unclassified legacy jobs',
    onboarding: 'Practice and test drives',
  },
  HireDepartment: {
    findOne: (...args: unknown[]) => mocks.findOne(...args),
    find: (...args: unknown[]) => mocks.find(...args),
    findOneAndUpdate: (...args: unknown[]) => mocks.findOneAndUpdate(...args),
    create: (...args: unknown[]) => mocks.create(...args),
    countDocuments: (...args: unknown[]) => mocks.countDocuments(...args),
  },
}))

import {
  archiveHireDepartment,
  assertAssignableHireDepartment,
  createHireDepartment,
  ensureHireSystemDepartment,
  listHireDepartments,
  normalizeHireDepartmentName,
} from '../services/hireDepartmentService'

const WORKSPACE_ID = new mongoose.Types.ObjectId('111111111111111111111111')
const MEMBER_ID = new mongoose.Types.ObjectId('222222222222222222222222')
const DEPARTMENT_ID = new mongoose.Types.ObjectId('333333333333333333333333')
const OTHER_WORKSPACE_ID = new mongoose.Types.ObjectId('444444444444444444444444')

const ADMIN = {
  workspace: { _id: WORKSPACE_ID },
  membership: {
    _id: MEMBER_ID,
    role: 'admin',
    name: 'HR Admin',
    email: 'admin@example.com',
  },
} as never

const MEMBER = {
  workspace: { _id: WORKSPACE_ID },
  membership: {
    _id: MEMBER_ID,
    role: 'member',
    name: 'HR Member',
    email: 'member@example.com',
  },
} as never

function department(overrides: Record<string, unknown> = {}) {
  return {
    _id: DEPARTMENT_ID,
    workspaceId: WORKSPACE_ID,
    name: 'Engineering',
    normalizedName: 'engineering',
    kind: 'standard',
    status: 'active',
    ...overrides,
  }
}

function sessionQuery(value: unknown) {
  return { session: vi.fn().mockResolvedValue(value) }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.connect.mockResolvedValue(undefined)
  mocks.fence.mockImplementation(
    async (_workspaceId: unknown, _memberId: unknown, work: (transactionSession: unknown) => Promise<unknown>) =>
      work(session),
  )
})

describe('Hire Department catalog service', () => {
  it('normalizes names to the same unique workspace coordinate', () => {
    expect(normalizeHireDepartmentName('  People\tOperations  ')).toBe('people operations')
  })

  it('accepts only an active standard department in the caller workspace', async () => {
    mocks.findOne.mockReturnValue(sessionQuery(department()))

    const result = await assertAssignableHireDepartment({
      workspaceId: WORKSPACE_ID,
      departmentId: DEPARTMENT_ID,
      session: session as never,
    })

    expect(result).toMatchObject({ _id: DEPARTMENT_ID, kind: 'standard', status: 'active' })
    expect(mocks.findOne).toHaveBeenCalledWith({
      _id: DEPARTMENT_ID,
      workspaceId: WORKSPACE_ID,
      kind: 'standard',
      status: 'active',
    })
  })

  it('rejects foreign, archived, and system rows through one assignability fence', async () => {
    mocks.findOne.mockReturnValue(sessionQuery(null))

    await expect(assertAssignableHireDepartment({
      workspaceId: OTHER_WORKSPACE_ID,
      departmentId: DEPARTMENT_ID,
      session: session as never,
    })).rejects.toMatchObject({ code: 'DEPARTMENT_NOT_ASSIGNABLE' })
  })

  it('creates only an admin-owned standard row and maps duplicate names safely', async () => {
    mocks.create.mockResolvedValue([department()])
    const created = await createHireDepartment(ADMIN, { name: ' Engineering ' })

    expect(created).toMatchObject({ name: 'Engineering', kind: 'standard' })
    expect(mocks.create).toHaveBeenCalledWith(
      [expect.objectContaining({
        workspaceId: WORKSPACE_ID,
        name: 'Engineering',
        normalizedName: 'engineering',
        kind: 'standard',
        status: 'active',
      })],
      { session },
    )

    mocks.create.mockRejectedValueOnce({ code: 11000 })
    await expect(createHireDepartment(ADMIN, { name: 'Engineering' })).rejects.toMatchObject({
      code: 'DEPARTMENT_NAME_CONFLICT',
    })
    await expect(createHireDepartment(MEMBER, { name: 'Finance' })).rejects.toBeInstanceOf(AppError)
  })

  it('reserves system labels and keeps system upserts inside the caller session', async () => {
    await expect(createHireDepartment(ADMIN, { name: 'Practice and test drives' })).rejects.toMatchObject({
      code: 'DEPARTMENT_SYSTEM_NAME_RESERVED',
    })

    const systemDepartment = department({
      _id: new mongoose.Types.ObjectId(),
      name: 'Practice and test drives',
      normalizedName: 'practice and test drives',
      kind: 'onboarding',
      systemKey: 'onboarding',
    })
    mocks.findOneAndUpdate.mockResolvedValue(systemDepartment)
    const ensured = await ensureHireSystemDepartment({
      workspaceId: WORKSPACE_ID,
      kind: 'onboarding',
      session: session as never,
    })

    expect(ensured).toBe(systemDepartment)
    expect(mocks.findOneAndUpdate).toHaveBeenCalledWith(
      { workspaceId: WORKSPACE_ID, systemKey: 'onboarding' },
      expect.objectContaining({
        $set: { status: 'active' },
        $setOnInsert: expect.objectContaining({ kind: 'onboarding', systemKey: 'onboarding' }),
      }),
      expect.objectContaining({ session, upsert: true }),
    )
  })

  it('shows historical standard and legacy labels to every member, never onboarding', async () => {
    const catalogRows = [
      department(),
      department({
        _id: new mongoose.Types.ObjectId(),
        name: 'Unclassified legacy jobs',
        normalizedName: 'unclassified legacy jobs',
        kind: 'legacy',
        systemKey: 'legacy',
      }),
    ]
    mocks.find.mockImplementation(() => ({
      sort: vi.fn().mockResolvedValue(catalogRows),
    }))
    await expect(listHireDepartments(ADMIN)).resolves.toEqual([
      expect.objectContaining({ name: 'Engineering', assignable: true }),
      expect.objectContaining({ name: 'Unclassified legacy jobs', assignable: false }),
    ])
    await expect(listHireDepartments(MEMBER)).resolves.toEqual([
      expect.objectContaining({ name: 'Engineering', assignable: true }),
      expect.objectContaining({ name: 'Unclassified legacy jobs', assignable: false }),
    ])
    expect(mocks.find).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      kind: { $in: ['standard', 'legacy'] },
    })
  })

  it('prevents archiving the final active standard department', async () => {
    mocks.countDocuments.mockReturnValue(sessionQuery(1))
    await expect(archiveHireDepartment(ADMIN, DEPARTMENT_ID.toString())).rejects.toMatchObject({
      code: 'DEPARTMENT_LAST_ACTIVE',
    })
    expect(mocks.findOneAndUpdate).not.toHaveBeenCalled()
  })
})
