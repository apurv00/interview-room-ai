/**
 * POST /api/candidate/[roundId]/prepare
 *
 * Session-provisioning seam, guest side. Called by the authenticated guest
 * (post OTP sign-in) right before entering the engine's lobby. Returns the
 * InterviewConfig the engine's own setup flow would have produced — the
 * client writes it to localStorage exactly like InterviewSetupForm does, and
 * the engine self-provisions its session untouched. Also stamps preparedAt,
 * opening the reconciliation window roundLinkService matches against.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@shared/auth/authOptions'
import { prepareRound } from '@hire'
import { AppError } from '@shared/errors'
import { checkRateLimit } from '@shared/middleware/checkRateLimit'

export const dynamic = 'force-dynamic'

export async function POST(
  _req: NextRequest,
  { params }: { params: { roundId: string } }
) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const blocked = await checkRateLimit(session.user.id, {
    windowMs: 60_000,
    maxRequests: 10,
    keyPrefix: 'rl:hire-prepare',
  })
  if (blocked) return blocked

  try {
    const { config } = await prepareRound(params.roundId, session.user.id)
    return NextResponse.json({ config })
  } catch (err) {
    if (err instanceof AppError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: err.statusCode })
    }
    return NextResponse.json({ error: 'Something went wrong' }, { status: 500 })
  }
}
