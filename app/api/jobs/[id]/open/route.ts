import mongoose from 'mongoose'
import { getServerSession } from 'next-auth'
import { NextResponse } from 'next/server'
import { authOptions } from '@shared/auth/authOptions'
import { connectDB } from '@shared/db/connection'
import { JobsAccountInactiveError } from '@shared/services/jobsAccountFence'
import { isApplyOptionId } from '@jobs/services/applyOptionIdentity'
import { resolveLiveApplyRedirect } from '@jobs/services/applyRedirectService'
import { checkJobsRateLimit } from '@jobs/services/rateLimit'
import { logger } from '@shared/logger'

export const dynamic = 'force-dynamic'

const PRIVATE_NO_STORE_HEADERS = {
  'Cache-Control': 'private, no-store',
  Pragma: 'no-cache',
  'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': 'noindex, nofollow',
}

function unavailable(status = 404) {
  return NextResponse.json(
    { error: 'destination unavailable' },
    { status, headers: PRIVATE_NO_STORE_HEADERS },
  )
}

function withPrivateHeaders(response: NextResponse): NextResponse {
  for (const [name, value] of Object.entries(PRIVATE_NO_STORE_HEADERS)) {
    response.headers.set(name, value)
  }
  return response
}

/**
 * GET /api/jobs/[id]/open?optionId=… — authenticated navigation boundary.
 * The destination is resolved from the current live posting immediately
 * before redirect; no rejected or exceptional response contains the URL.
 */
export async function GET(req: Request, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions)
  const userId = (session?.user as { id?: string } | undefined)?.id
  if (!userId) return unavailable(401)
  const rateLimitBlock = await checkJobsRateLimit(userId)
  if (rateLimitBlock) return withPrivateHeaders(rateLimitBlock)

  const optionId = new URL(req.url).searchParams.get('optionId')
  if (!mongoose.Types.ObjectId.isValid(params.id) || !isApplyOptionId(optionId)) {
    return unavailable()
  }

  try {
    await connectDB()
    const destination = await resolveLiveApplyRedirect(userId, params.id, optionId)
    if (!destination) return unavailable()

    return withPrivateHeaders(NextResponse.redirect(destination, 307))
  } catch (error) {
    if (error instanceof JobsAccountInactiveError) {
      return NextResponse.json(
        { error: 'account unavailable', code: 'ACCOUNT_UNAVAILABLE' },
        { status: 401, headers: PRIVATE_NO_STORE_HEADERS },
      )
    }
    logger.error(
      {
        errorName: error instanceof Error ? error.name : typeof error,
        postingId: params.id,
      },
      'jobs apply redirect resolution failed',
    )
    return unavailable(503)
  }
}
