import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@shared/auth/authOptions'
import { checkJobsRateLimit } from '@jobs/services/rateLimit'
import { connectDB } from '@shared/db/connection'
import { isJobsAccountActive } from '@shared/services/jobsAccountFence'

export const dynamic = 'force-dynamic'

const PRIVATE_NO_STORE_HEADERS = {
  'Cache-Control': 'private, no-store',
  Pragma: 'no-cache',
  'X-Robots-Tag': 'noindex, nofollow',
}

function withPrivateHeaders(response: Response): Response {
  for (const [name, value] of Object.entries(PRIVATE_NO_STORE_HEADERS)) {
    response.headers.set(name, value)
  }
  return response
}

/**
 * POST /api/jobs/[id]/apply-click — retired compatibility signal.
 *
 * The endpoint intentionally performs no parsing, application mutation, or
 * telemetry write. It retains the account-lifecycle read so a stale client
 * can still scrub private state during a rolling deployment.
 */
export async function POST(_req: Request, _context: { params: { id: string } }) {
  const session = await getServerSession(authOptions)
  const userId = (session?.user as { id?: string } | undefined)?.id
  if (!userId) {
    return NextResponse.json(
      { error: 'sign in required' },
      { status: 401, headers: PRIVATE_NO_STORE_HEADERS },
    )
  }
  const rateLimitBlock = await checkJobsRateLimit(userId)
  if (rateLimitBlock) return withPrivateHeaders(rateLimitBlock)
  await connectDB()
  if (!(await isJobsAccountActive(userId))) {
    return NextResponse.json(
      { error: 'account unavailable', code: 'ACCOUNT_UNAVAILABLE' },
      { status: 401, headers: PRIVATE_NO_STORE_HEADERS },
    )
  }

  return NextResponse.json(
    {
      error: 'apply-click endpoint retired',
      code: 'APPLY_CLICK_DEPRECATED',
      replacement: '/api/jobs/[id]/open?intent=apply',
    },
    { status: 410, headers: PRIVATE_NO_STORE_HEADERS },
  )
}
