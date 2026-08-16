import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  requireMembership: vi.fn(),
  updateHireDepartment: vi.fn(),
}))

vi.mock('../../../_lib/composeHireApiRoute', () => ({
  composeHireApiRoute: (options: any) => async (
    req: Request,
    context?: { params?: Record<string, string> },
  ) => {
    const body = options.schema ? options.schema.parse(await req.json()) : {}
    return options.handler(req, {
      user: { id: 'hire-member:workspace.member', email: 'admin@acme.com' },
      body,
      params: context?.params ?? {},
    })
  },
}))

vi.mock('@hire', () => ({
  requireMembership: mocks.requireMembership,
}))

vi.mock('@hire-departments', () => ({
  updateHireDepartment: mocks.updateHireDepartment,
  UpdateHireDepartmentSchema: {
    parse: (value: unknown) => {
      if (
        !value ||
        typeof value !== 'object' ||
        Object.keys(value).length !== 1 ||
        !['archive', 'restore'].includes((value as { action?: string }).action ?? '')
      ) {
        const error = new Error('Invalid department lifecycle command')
        error.name = 'ZodError'
        throw error
      }
      return value
    },
  },
}))

import { PATCH } from '../route'

const DEPARTMENT_ID = '333333333333333333333333'
const ctx = {
  workspace: { _id: '111111111111111111111111', name: 'Acme' },
  membership: { _id: '222222222222222222222222', role: 'admin' },
}

describe('PATCH /api/workspace/departments/[departmentId]', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.requireMembership.mockResolvedValue(ctx)
    mocks.updateHireDepartment.mockResolvedValue({
      _id: { toString: () => DEPARTMENT_ID },
      name: 'Engineering',
      status: 'archived',
      kind: 'standard',
    })
  })

  it('delegates an archive command through the authenticated service boundary', async () => {
    const response = await PATCH(
      new Request(`https://hire.interviewprep.guru/api/workspace/departments/${DEPARTMENT_ID}`, {
        method: 'PATCH',
        body: JSON.stringify({ action: 'archive' }),
      }) as never,
      { params: { departmentId: DEPARTMENT_ID } },
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    await expect(response.json()).resolves.toEqual({
      department: {
        id: DEPARTMENT_ID,
        name: 'Engineering',
        status: 'archived',
        kind: 'standard',
      },
    })
    expect(mocks.updateHireDepartment).toHaveBeenCalledWith(ctx, DEPARTMENT_ID, {
      action: 'archive',
    })
  })

  it('does not expose a rename command in v1', async () => {
    await expect(
      PATCH(
        new Request(`https://hire.interviewprep.guru/api/workspace/departments/${DEPARTMENT_ID}`, {
          method: 'PATCH',
          body: JSON.stringify({ action: 'rename', name: 'Platform' }),
        }) as never,
        { params: { departmentId: DEPARTMENT_ID } },
      ),
    ).rejects.toMatchObject({ name: 'ZodError' })
    expect(mocks.updateHireDepartment).not.toHaveBeenCalled()
  })
})
