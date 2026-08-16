import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  requireMembership: vi.fn(),
  listHireDepartments: vi.fn(),
  createHireDepartment: vi.fn(),
}))

vi.mock('../../_lib/composeHireApiRoute', () => ({
  composeHireApiRoute: (options: any) => async (req: Request) => {
    const body = options.schema ? options.schema.parse(await req.json()) : {}
    return options.handler(req, {
      user: { id: 'hire-member:workspace.member', email: 'admin@acme.com' },
      body,
      params: {},
    })
  },
}))

vi.mock('@hire', () => ({
  requireMembership: mocks.requireMembership,
}))

vi.mock('@hire-departments', () => ({
  listHireDepartments: mocks.listHireDepartments,
  createHireDepartment: mocks.createHireDepartment,
  CreateHireDepartmentSchema: {
    parse: (value: unknown) => {
      if (
        !value ||
        typeof value !== 'object' ||
        Object.keys(value).length !== 1 ||
        typeof (value as { name?: unknown }).name !== 'string'
      ) {
        const error = new Error('Invalid department payload')
        error.name = 'ZodError'
        throw error
      }
      return { name: (value as { name: string }).name.trim() }
    },
  },
}))

import { GET, POST } from '../route'

const ctx = {
  workspace: { _id: '111111111111111111111111', name: 'Acme' },
  membership: { _id: '222222222222222222222222', role: 'admin' },
}

describe('/api/workspace/departments', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.requireMembership.mockResolvedValue(ctx)
    mocks.listHireDepartments.mockResolvedValue([
      {
        id: '333333333333333333333333',
        name: 'Engineering',
        status: 'active',
        kind: 'standard',
        archivedAt: null,
        assignable: true,
      },
    ])
    mocks.createHireDepartment.mockResolvedValue({
      _id: { toString: () => '444444444444444444444444' },
      name: 'Product',
      status: 'active',
      kind: 'standard',
    })
  })

  it('returns the member-safe catalog through the workspace membership boundary', async () => {
    const response = await GET(
      new Request('https://hire.interviewprep.guru/api/workspace/departments') as never,
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    await expect(response.json()).resolves.toEqual({
      departments: [
        {
          id: '333333333333333333333333',
          name: 'Engineering',
          status: 'active',
          kind: 'standard',
        },
      ],
    })
    expect(mocks.requireMembership).toHaveBeenCalledWith({
      userId: 'hire-member:workspace.member',
      email: 'admin@acme.com',
    })
    expect(mocks.listHireDepartments).toHaveBeenCalledWith(ctx)
  })

  it('passes only a bounded immutable name to the admin-backed create service', async () => {
    const response = await POST(
      new Request('https://hire.interviewprep.guru/api/workspace/departments', {
        method: 'POST',
        body: JSON.stringify({ name: ' Product ' }),
      }) as never,
    )

    expect(response.status).toBe(201)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    await expect(response.json()).resolves.toEqual({
      department: {
        id: '444444444444444444444444',
        name: 'Product',
        status: 'active',
        kind: 'standard',
      },
    })
    expect(mocks.createHireDepartment).toHaveBeenCalledWith(ctx, { name: 'Product' })
  })

  it('does not accept a client-supplied system kind', async () => {
    await expect(
      POST(
        new Request('https://hire.interviewprep.guru/api/workspace/departments', {
          method: 'POST',
          body: JSON.stringify({ name: 'Practice', kind: 'onboarding' }),
        }) as never,
      ),
    ).rejects.toMatchObject({ name: 'ZodError' })
    expect(mocks.createHireDepartment).not.toHaveBeenCalled()
  })
})
