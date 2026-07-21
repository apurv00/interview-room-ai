import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@shared/auth/authOptions'
import { connectDB } from '@shared/db/connection'
import mongoose from 'mongoose'
import { getJobDetail } from '@jobs'
import { isJobsAccountActive } from '@shared/services/jobsAccountFence'

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
    return NextResponse.json(
      { error: 'not found' },
      { status: 404, headers: { 'Cache-Control': 'no-store' } },
    )
  }
  const session = await getServerSession(authOptions)
  const userId = (session?.user as { id?: string } | undefined)?.id ?? null
  const privateResponse = userId
    ? { headers: { 'Cache-Control': 'private, no-store' } }
    : undefined
  await connectDB()
  if (userId && !(await isJobsAccountActive(userId))) {
    return NextResponse.json(
      { error: 'account unavailable', code: 'ACCOUNT_UNAVAILABLE' },
      { status: 401, headers: { 'Cache-Control': 'private, no-store' } },
    )
  }
  const detail = await getJobDetail(params.id, userId)
  // Detail preparation crosses CMS and resume reads and can mint a fresh
  // Practice token. Never let a stale JWT carry personalized data across a
  // deletion that committed while those reads were in flight.
  if (userId && !(await isJobsAccountActive(userId))) {
    return NextResponse.json(
      { error: 'account unavailable', code: 'ACCOUNT_UNAVAILABLE' },
      { status: 401, headers: { 'Cache-Control': 'private, no-store' } },
    )
  }
  if (!detail) {
    return NextResponse.json(
      { error: 'not found' },
      {
        status: 404,
        headers: { 'Cache-Control': userId ? 'private, no-store' : 'no-store' },
      }
    )
  }
  return NextResponse.json(detail, privateResponse)
}
