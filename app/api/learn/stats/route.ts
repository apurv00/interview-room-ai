import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@shared/auth/authOptions'
import { connectDB } from '@shared/db/connection'
import { User } from '@shared/db/models'
import { updatePracticeStats } from '@learn'
import { isFeatureEnabled } from '@shared/featureFlags'
import { z } from 'zod'

export const dynamic = 'force-dynamic'

const UpdateStatsSchema = z.object({
  domain: z.string().min(1).max(50),
  interviewType: z.string().min(1).max(50),
  score: z.number().min(0).max(100),
  strongDimensions: z.array(z.string().max(50)).max(5).optional(),
  weakDimensions: z.array(z.string().max(50)).max(5).optional(),
})

export async function POST(req: Request) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // G.14: when xp_from_feedback is ON, this endpoint no-ops and
  // generate-feedback becomes the authoritative writer of practiceStats
  // (using the deterministic feedback.overall_score rather than the
  // client's pre-feedback ad-hoc mean). The client's fire-and-forget
  // call at useInterview.ts:862 stays in place — it just hits a
  // no-op endpoint when the flag is on; the 200 response keeps the
  // `.catch(() => {})` at the call site from logging an error.
  if (isFeatureEnabled('xp_from_feedback')) {
    return NextResponse.json({
      success: true,
      skipped: 'xp_from_feedback',
      message: 'practiceStats written server-side by generate-feedback',
    })
  }

  const body = await req.json()
  const parsed = UpdateStatsSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid data' }, { status: 400 })
  }

  const { domain, interviewType, score, strongDimensions, weakDimensions } = parsed.data
  const result = await updatePracticeStats({
    userId: session.user.id,
    domain,
    interviewType,
    score,
    strongDimensions,
    weakDimensions,
  })
  if (!result.updated) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 })
  }
  return NextResponse.json({ success: true })
}

export async function GET() {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  await connectDB()
  const user = await User.findById(session.user.id).select('practiceStats').lean()
  if (!user) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 })
  }

  return NextResponse.json({ practiceStats: user.practiceStats || {} })
}
