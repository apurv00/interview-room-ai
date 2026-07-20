import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@shared/auth/authOptions'
import { connectDB } from '@shared/db/connection'
import mongoose from 'mongoose'
import { getJobDetail } from '@jobs'
import { mintPracticeHandoffToken, practiceHandoffHashOf } from '@jobs/services/practiceHandoff'

export const dynamic = 'force-dynamic'

/**
 * GET /api/jobs/[id] — public SHELL, authed FULL (founder ruling P-2,
 * 2026-07-14: public feed, auth-gated detail). The projection split lives
 * in feedService server-side: an anonymous response structurally cannot
 * carry the JD or apply URLs, so the enriched corpus is not scrapeable
 * through this route.
 */
export async function GET(_req: Request, { params }: { params: { id: string } }) {
  if (!mongoose.Types.ObjectId.isValid(params.id)) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }
  const session = await getServerSession(authOptions)
  const userId = (session?.user as { id?: string } | undefined)?.id ?? null
  const privateResponse = userId
    ? { headers: { 'Cache-Control': 'private, no-store' } }
    : undefined
  await connectDB()
  const detail = await getJobDetail(params.id, userId)
  if (!detail) {
    return NextResponse.json(
      { error: 'not found' },
      { status: 404, ...(privateResponse ?? {}) }
    )
  }
  if (!detail.gated && userId && detail.jd) {
    return NextResponse.json({
      ...detail,
      practiceHandoffToken: mintPracticeHandoffToken({
        userId,
        jobId: detail.id,
        jdHash: practiceHandoffHashOf(detail.jd),
      }),
    }, privateResponse)
  }
  return NextResponse.json(detail, privateResponse)
}
