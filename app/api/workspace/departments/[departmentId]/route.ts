/** PATCH — admin archives or restores a department catalog entry. */

import { NextResponse } from 'next/server'
import { requireMembership } from '@hire'
import {
  UpdateHireDepartmentSchema,
  updateHireDepartment,
  type UpdateHireDepartmentPayload,
} from '@hire-departments'
import { composeHireApiRoute } from '../../_lib/composeHireApiRoute'

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

export const PATCH = composeHireApiRoute<UpdateHireDepartmentPayload>({
  schema: UpdateHireDepartmentSchema,
  rateLimit: { windowMs: 60_000, maxRequests: 20, keyPrefix: 'rl:hire-departments-update' },
  async handler(_req, { user, body, params }) {
    const ctx = await requireMembership({ userId: user.id, email: user.email })
    const department = await updateHireDepartment(ctx, params.departmentId, body)
    return NextResponse.json(
      { department: serializeDepartment(department) },
      { headers: { 'Cache-Control': 'private, no-store' } },
    )
  },
})
