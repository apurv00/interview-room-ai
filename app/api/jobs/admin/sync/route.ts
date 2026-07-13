import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@shared/auth/authOptions'
import { inngest } from '@shared/services/inngest'

export const dynamic = 'force-dynamic'

/**
 * POST /api/jobs/admin/sync — manual ingestion kick (INGESTION §4.4).
 * platform_admin only; body { sourceId? } defaults to jsearch. The sync
 * function itself re-checks flag/enabled/health, so this can never force
 * a run past the guards — it only skips the WAIT for the next cron tick.
 */
export async function POST(req: Request) {
  const session = await getServerSession(authOptions)
  if (!session?.user || (session.user as { role?: string }).role !== 'platform_admin') {
    return NextResponse.json({ error: 'platform_admin required' }, { status: session?.user ? 403 : 401 })
  }
  let sourceId = 'jsearch'
  try {
    const body = await req.json()
    if (typeof body?.sourceId === 'string' && body.sourceId) sourceId = body.sourceId
  } catch { /* empty body = default source */ }

  await inngest.send({ name: 'jobs/source.sync', data: { sourceId } })
  return NextResponse.json({ dispatched: sourceId })
}
