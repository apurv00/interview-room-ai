/**
 * GET  /api/workspace/departments — workspace department catalog
 * POST /api/workspace/departments — admin creates a standard department
 */

import { NextResponse } from 'next/server'
import { requireMembership } from '@hire'
import {
  CreateHireDepartmentSchema,
  createHireDepartment,
  listHireDepartments,
  type CreateHireDepartmentPayload,
} from '@hire-departments'
import { composeHireApiRoute } from '../_lib/composeHireApiRoute'

export const dynamic = 'force-dynamic'

type DepartmentSource = {
  id?: string
  _id?: { toString(): string }
  name: string
  status: 'active' | 'archived'
  kind: string
}

function serializeDepartment(department: DepartmentSource) {
  const id = department.id ?? department._id?.toString()
  if (!id) throw new Error('Department response is missing an id')
  return {
    id,
    name: department.name,
    status: department.status,
    kind: department.kind,
  }
}

export const GET = composeHireApiRoute({
  rateLimit: { windowMs: 60_000, maxRequests: 60, keyPrefix: 'rl:hire-departments' },
  async handler(_req, { user }) {
    const ctx = await requireMembership({ userId: user.id, email: user.email })
    const departments = await listHireDepartments(ctx)
    return NextResponse.json(
      { departments: departments.map(serializeDepartment) },
      { headers: { 'Cache-Control': 'private, no-store' } },
    )
  },
})

export const POST = composeHireApiRoute<CreateHireDepartmentPayload>({
  schema: CreateHireDepartmentSchema,
  rateLimit: { windowMs: 60_000, maxRequests: 20, keyPrefix: 'rl:hire-departments-create' },
  async handler(_req, { user, body }) {
    const ctx = await requireMembership({ userId: user.id, email: user.email })
    const department = await createHireDepartment(ctx, body)
    return NextResponse.json(
      { department: serializeDepartment(department) },
      {
        status: 201,
        headers: { 'Cache-Control': 'private, no-store' },
      },
    )
  },
})
