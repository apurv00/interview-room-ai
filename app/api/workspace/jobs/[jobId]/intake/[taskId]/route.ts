import { NextResponse } from 'next/server'
import { z } from 'zod'
import {
  getHireIntakeTask,
  requireMembership,
  supplyHireIntakeIdentity,
} from '@hire'
import { composeHireApiRoute } from '../../../../_lib/composeHireApiRoute'

export const dynamic = 'force-dynamic'

const PRIVATE_NO_STORE_HEADERS = { 'Cache-Control': 'private, no-store' }

const SupplyIdentitySchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  email: z.string().trim().toLowerCase().email().max(254),
})

type SupplyIdentityPayload = z.infer<typeof SupplyIdentitySchema>

/** Recruiter-only, workspace-scoped status for a durable intake task. */
export const GET = composeHireApiRoute({
  // The panel polls three of at most twenty tasks every three seconds;
  // this leaves member headroom while keeping task state private.
  rateLimit: { windowMs: 60_000, maxRequests: 180, keyPrefix: 'rl:hire-intake-status' },
  async handler(_req, { user, params }) {
    const ctx = await requireMembership({ userId: user.id, email: user.email })
    const task = await getHireIntakeTask(ctx, {
      jobId: params.jobId,
      taskId: params.taskId,
    })
    return NextResponse.json({ task }, { headers: PRIVATE_NO_STORE_HEADERS })
  },
})

/**
 * Supply a recruiter-confirmed identity for a task that is waiting for one.
 * The stored resume is retained on the task, so this requeues work without a
 * second upload or any client-side parsing.
 */
export const PATCH = composeHireApiRoute<SupplyIdentityPayload>({
  schema: SupplyIdentitySchema,
  rateLimit: { windowMs: 60_000, maxRequests: 30, keyPrefix: 'rl:hire-intake-identity' },
  async handler(_req, { user, body, params }) {
    const ctx = await requireMembership({ userId: user.id, email: user.email })
    const task = await supplyHireIntakeIdentity(ctx, {
      jobId: params.jobId,
      taskId: params.taskId,
      name: body.name,
      email: body.email,
    })
    return NextResponse.json({ task }, { headers: PRIVATE_NO_STORE_HEADERS })
  },
})
