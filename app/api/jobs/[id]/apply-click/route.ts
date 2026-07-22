import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@shared/auth/authOptions'
import { connectDB } from '@shared/db/connection'
import mongoose from 'mongoose'
import { parseApplyOptionMutation, recordApplyClick } from '@jobs'
import { logger } from '@shared/logger'
import { checkJobsRateLimit } from '@jobs/services/rateLimit'
import { recordJobsUserEvent } from '@jobs/services/userEventService'
import { JobsAccountInactiveError } from '@shared/services/jobsAccountFence'

export const dynamic = 'force-dynamic'

/**
 * POST /api/jobs/[id]/apply-click — legacy/backward-compatible status edge.
 * It may record apply_clicked (never conflated with the user's applied
 * claim), but deliberately creates no trusted attempt or broken-link
 * governance proof. New detail-page Apply navigation uses /open?intent=apply.
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
  let result: Awaited<ReturnType<typeof recordApplyClick>>
  try {
    result = await recordApplyClick(userId, params.id, parsed.optionId)
  } catch (error) {
    if (error instanceof JobsAccountInactiveError) {
      return NextResponse.json(
        { error: 'account unavailable', code: 'ACCOUNT_UNAVAILABLE' },
        { status: 401 },
      )
    }
    throw error
  }
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
