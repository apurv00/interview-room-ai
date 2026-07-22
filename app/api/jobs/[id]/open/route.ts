import mongoose from 'mongoose'
import { getServerSession } from 'next-auth'
import { NextResponse } from 'next/server'
import { authOptions } from '@shared/auth/authOptions'
import { connectDB } from '@shared/db/connection'
import { JobsAccountInactiveError } from '@shared/services/jobsAccountFence'
import { recordApplyOpenAttempt } from '@jobs'
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

type OpenIntent = 'apply' | 'view'

/**
 * Authenticated navigation boundary. Apply is POST-only and the sole
 * server-recorded attempt edge; View is GET-only and resolves the same current
 * destination without creating Apply evidence. Method/intent mismatches fail
 * before auth, rate limiting, or database work, so a cross-site top-level GET
 * cannot pin a victim's posting or manufacture report-governance evidence.
 */
async function openDestination(
  req: Request,
  params: { id: string },
  expectedIntent: OpenIntent,
): Promise<NextResponse> {
  const searchParams = new URL(req.url).searchParams
  const optionId = searchParams.get('optionId')
  const intent = searchParams.get('intent')
  if (
    !mongoose.Types.ObjectId.isValid(params.id) ||
    !isApplyOptionId(optionId) ||
    intent !== expectedIntent
  ) {
    return unavailable()
  }

  const session = await getServerSession(authOptions)
  const userId = (session?.user as { id?: string } | undefined)?.id
  if (!userId) return unavailable(401)
  const rateLimitBlock = await checkJobsRateLimit(userId)
  if (rateLimitBlock) return withPrivateHeaders(rateLimitBlock)

  try {
    await connectDB()
    if (expectedIntent === 'view') {
      const destination = await resolveLiveApplyRedirect(userId, params.id, optionId)
      if (!destination) return unavailable()
      return withPrivateHeaders(NextResponse.redirect(destination, 307))
    }

    // Resolve current authority and record the attempt together inside the
    // account-fenced application transaction. Telemetry remains on the
    // asynchronous legacy status edge so it cannot delay this redirect.
    const attempt = await recordApplyOpenAttempt(userId, params.id, optionId)
    if (!attempt) return unavailable()

    // 303 is mandatory: after our POST mutation succeeds, the user agent must
    // reach the external employer with GET and must never replay the POST.
    return withPrivateHeaders(NextResponse.redirect(attempt.canonicalOption.url, 303))
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
      'jobs navigation redirect resolution failed',
    )
    return unavailable(503)
  }
}

/** GET /open?intent=view — read-only source navigation. */
export async function GET(req: Request, { params }: { params: { id: string } }) {
  return openDestination(req, params, 'view')
}

/** POST /open?intent=apply — trusted Apply-attempt navigation. */
export async function POST(req: Request, { params }: { params: { id: string } }) {
  return openDestination(req, params, 'apply')
}
