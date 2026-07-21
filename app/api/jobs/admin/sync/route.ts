import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@shared/auth/authOptions'
import { inngest } from '@shared/services/inngest'
import { connectDB } from '@shared/db/connection'
import { JobSourceConfig } from '@shared/db/models'
import { controlRevisionOf } from '@jobs/services/sourceControl'
import { checkJobsRateLimit } from '@jobs/services/rateLimit'

export const dynamic = 'force-dynamic'

/**
 * POST /api/jobs/admin/sync — manual ingestion kick (INGESTION §4.4).
 * platform_admin only; body { sourceId? } defaults to jsearch. The sync
 * function itself re-checks flag/enabled/health, so this can never force
 * a run past the guards — it only skips the WAIT for the next cron tick.
 */
export async function POST(req: Request) {
  const session = await getServerSession(authOptions)
  const actor = session?.user as { id?: string; role?: string } | undefined
  if (!actor || actor.role !== 'platform_admin' || !actor.id) {
    return NextResponse.json({ error: 'platform_admin required' }, { status: session?.user ? 403 : 401 })
  }
  const rateLimitBlock = await checkJobsRateLimit(actor.id, 'admin-command')
  if (rateLimitBlock) return rateLimitBlock
  let sourceId = 'jsearch'
  let mode = 'sync'
  let limit: number | undefined
  try {
    const body = await req.json()
    if (typeof body?.sourceId === 'string' && body.sourceId) sourceId = body.sourceId
    if (body?.mode === 'verdict-sweep') mode = 'verdict-sweep'
    if (typeof body?.limit === 'number' && body.limit > 0) limit = Math.floor(body.limit)
  } catch { /* empty body = default source */ }

  // Manual verdict-sweep kick (§4.5) — shares the cron sweeper's handler,
  // which re-checks the JobsVerdictConfig switch + budget; this can never
  // force verdicts past the guards, it only skips the wait for :45.
  if (mode === 'verdict-sweep') {
    await inngest.send({ name: 'jobs/verdict.sweep', data: { limit } })
    return NextResponse.json({ dispatched: 'verdict-sweep' })
  }

  await connectDB()
  const source = await JobSourceConfig.findOne({ sourceId }).select('sourceId enabled health controlRevision').lean()
  if (!source) return NextResponse.json({ error: 'unknown source' }, { status: 404 })
  if (!source.enabled || !['active', 'degraded'].includes(source.health)) {
    return NextResponse.json({ error: 'source is not eligible for sync' }, { status: 409 })
  }
  const controlRevision = controlRevisionOf(source)
  await inngest.send({ name: 'jobs/source.sync', data: { sourceId, controlRevision } })
  return NextResponse.json({ dispatched: sourceId, controlRevision })
}
