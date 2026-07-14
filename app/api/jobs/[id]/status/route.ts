import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@shared/auth/authOptions'
import { connectDB } from '@shared/db/connection'
import mongoose from 'mongoose'
import { ProductEvent } from '@shared/db/models'
import { transitionStatus, USER_SETTABLE_STATUSES, type UserSettableStatus } from '@jobs'
import { logger } from '@shared/logger'

export const dynamic = 'force-dynamic'

/**
 * POST /api/jobs/[id]/status — USER status transitions (PRODUCT_FLOW §2:
 * loose machine — forward jumps and backward corrections both allowed;
 * `applied` here is the user CLAIM the return-sheet captures, distinct from
 * the machine fact `apply_clicked`, which is never settable through this
 * route). Emits jobs.status_changed / jobs.apply_confirmed server-side.
 */
export async function POST(req: Request, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions)
  const userId = (session?.user as { id?: string } | undefined)?.id
  if (!userId) return NextResponse.json({ error: 'sign in required' }, { status: 401 })
  if (!mongoose.Types.ObjectId.isValid(params.id)) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }
  let to: string | undefined
  let latencyMs: number | undefined
  let viaNudge = false
  try {
    const body = await req.json()
    to = body?.status
    if (typeof body?.latencyMs === 'number' && body.latencyMs >= 0) latencyMs = Math.floor(body.latencyMs)
    viaNudge = body?.viaNudge === true
  } catch { /* fallthrough to validation */ }
  if (!to || !(USER_SETTABLE_STATUSES as readonly string[]).includes(to)) {
    return NextResponse.json({ error: `status must be one of ${USER_SETTABLE_STATUSES.join(', ')}` }, { status: 400 })
  }

  await connectDB()
  const result = await transitionStatus(userId, params.id, to as UserSettableStatus)
  if (!result.ok) return NextResponse.json({ error: 'no application for this job' }, { status: 404 })
  try {
    await ProductEvent.create({
      name: to === 'applied' ? 'jobs.apply_confirmed' : 'jobs.status_changed',
      userId,
      jobPostingId: params.id,
      props: to === 'applied' ? { latencyMs, viaNudge } : { to, source: 'user' },
      ts: new Date(),
    })
  } catch (err) {
    logger.warn({ err }, 'status telemetry write failed') // telemetry never breaks the flow
  }
  return NextResponse.json({ ok: true, status: result.status })
}
