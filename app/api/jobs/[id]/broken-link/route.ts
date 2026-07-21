import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@shared/auth/authOptions'
import { connectDB } from '@shared/db/connection'
import mongoose from 'mongoose'
import { ProductEvent } from '@shared/db/models'
import { parseApplyOptionMutation, reportBrokenLink } from '@jobs'
import { logger } from '@shared/logger'
import { checkJobsRateLimit } from '@jobs/services/rateLimit'

export const dynamic = 'force-dynamic'

/**
 * POST /api/jobs/[id]/broken-link — dead-click report (§4b). Records on the
 * caller's application AND increments the posting-level rung counter: one
 * user's dead click demotes that rung for everyone (the ladder sort sinks
 * reported rungs; never hides them).
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
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid apply option' }, { status: 400 })
  }
  const mutation = parseApplyOptionMutation(body)
  if (!mutation) return NextResponse.json({ error: 'invalid apply option' }, { status: 400 })

  await connectDB()
  const result = await reportBrokenLink(userId, params.id, mutation.optionId)
  if (!result.ok) return NextResponse.json({ error: 'apply option not found' }, { status: 404 })
  if (result.recorded) {
    try {
      await ProductEvent.create({
        name: 'jobs.broken_link',
        userId,
        jobPostingId: params.id,
        props: { tier: result.tier, hadFailover: result.hadFailover },
        ts: new Date(),
      })
    } catch (err) {
      logger.warn({ err }, 'broken-link telemetry write failed')
    }
  }
  return NextResponse.json({ ok: true, alreadyReported: !result.recorded })
}
