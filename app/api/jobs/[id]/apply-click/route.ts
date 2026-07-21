import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@shared/auth/authOptions'
import { connectDB } from '@shared/db/connection'
import mongoose from 'mongoose'
import { parseApplyOptionMutation, recordApplyClick } from '@jobs'
import { logger } from '@shared/logger'
import { checkJobsRateLimit } from '@jobs/services/rateLimit'
import { recordJobsUserEvent } from '@jobs/services/userEventService'

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
  const rateLimitBlock = await checkJobsRateLimit(userId)
  if (rateLimitBlock) return rateLimitBlock
  if (!mongoose.Types.ObjectId.isValid(params.id)) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }
  let input: unknown
  try {
    input = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 })
  }
  const parsed = parseApplyOptionMutation(input)
  if (!parsed) {
    return NextResponse.json({ error: 'a valid optionId is required' }, { status: 400 })
  }

  await connectDB()
  const result = await recordApplyClick(userId, params.id, parsed.optionId)
  if (!result) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const { canonicalOption, ...publicResult } = result
  try {
    await recordJobsUserEvent({
      name: 'jobs.apply_click',
      userId,
      jobPostingId: params.id,
      props: { tier: canonicalOption.tier, source: 'detail', transitioned: result.transitioned },
      ts: new Date(),
    })
  } catch (err) {
    logger.warn({ err }, 'jobs.apply_click telemetry write failed') // telemetry never breaks the flow
  }
  return NextResponse.json({ ok: true, ...publicResult })
}
