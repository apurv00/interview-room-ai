import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@shared/auth/authOptions'
import { connectDB } from '@shared/db/connection'
import mongoose from 'mongoose'
import { ProductEvent } from '@shared/db/models'
import { recordApplyClick } from '@jobs'
import { logger } from '@shared/logger'

export const dynamic = 'force-dynamic'

/**
 * POST /api/jobs/[id]/apply-click — the MACHINE FACT (PRODUCT_FLOW §2:
 * apply_clicked vs applied, never conflated). Called keepalive from the
 * detail page's click handler AFTER the sync window.open. Authed-only by
 * construction (the apply ladder exists only behind the P-2 gate); the
 * telemetry event is written server-side here, replacing the client
 * keepalive event for this surface.
 */
export async function POST(req: Request, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions)
  const userId = (session?.user as { id?: string } | undefined)?.id
  if (!userId) return NextResponse.json({ error: 'sign in required' }, { status: 401 })
  if (!mongoose.Types.ObjectId.isValid(params.id)) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }
  let click: { tier?: string; url?: string } = {}
  try {
    const body = await req.json()
    if (typeof body?.tier === 'string') click.tier = body.tier.slice(0, 40)
    if (typeof body?.url === 'string') click.url = body.url.slice(0, 2000)
  } catch { /* clicks without metadata still count */ }

  await connectDB()
  const result = await recordApplyClick(userId, params.id, click)
  if (!result) return NextResponse.json({ error: 'not found' }, { status: 404 })
  try {
    await ProductEvent.create({
      name: 'jobs.apply_click',
      userId,
      jobPostingId: params.id,
      props: { tier: click.tier, source: 'detail', transitioned: result.transitioned },
      ts: new Date(),
    })
  } catch (err) {
    logger.warn({ err }, 'jobs.apply_click telemetry write failed') // telemetry never breaks the flow
  }
  return NextResponse.json({ ok: true, ...result })
}
