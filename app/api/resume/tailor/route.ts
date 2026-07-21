import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { composeApiRoute } from '@shared/middleware/composeApiRoute'
import { authOptions } from '@shared/auth/authOptions'
import { connectDB } from '@shared/db/connection'
import { isJobsAccountActive } from '@shared/services/jobsAccountFence'
import { tailorResume } from '@resume/services/resumeAIService'
import { TailorSchema } from '@resume/validators/resume'

export const dynamic = 'force-dynamic'

const accountUnavailableResponse = () => NextResponse.json(
  { error: 'account unavailable', code: 'ACCOUNT_UNAVAILABLE' },
  { status: 401 },
)

// Open to anonymous users so the strongest "wow" tool of the resume funnel
// (job-specific tailoring) is reachable from SEO landings without sign-in.
// Stateless service — no user.id dependency. Anonymous IPs capped at 3
// tailors per day; one full Sonnet call ~$0.05 → bounded ~$0.15/day/IP.
const composedPOST = composeApiRoute({
  schema: TailorSchema,
  authOptional: true,
  rateLimit: {
    keyPrefix: 'rl:resume-tailor',
    windowMs: 60_000,
    maxRequests: 5,
    anonDailyLimit: 3,
  },
  handler: async (req, { body, user }) => {
    // Defense in depth for clients that send body provenance. The Tailor page
    // also sends x-origin-user-id so its account-switch rejection happens in
    // the wrapper below, before composeApiRoute consumes quota.
    if (body.originUserId !== undefined &&
      (user.id === 'anonymous' || body.originUserId !== user.id)) {
      return NextResponse.json(
        { error: 'sign-in session changed', code: 'SESSION_CHANGED' },
        { status: 409 },
      )
    }
    const accountBoundOrigin = user.id !== 'anonymous' && (
      body.originUserId !== undefined || req.headers.get('x-origin-user-id') !== null
    )
    try {
      if (accountBoundOrigin) {
        await connectDB()
        if (!(await isJobsAccountActive(user.id))) return accountUnavailableResponse()
      }
      // Keep provenance out of the AI-service payload. It exists only to bind
      // this HTTP request to the session that originated the client run.
      const result = await tailorResume({
        resumeText: body.resumeText,
        jobDescription: body.jobDescription,
        ...(body.companyName !== undefined ? { companyName: body.companyName } : {}),
      })
      // Provider work cannot be recalled if deletion starts mid-call, but its
      // private result must never be returned to the stale authenticated tab.
      if (accountBoundOrigin && !(await isJobsAccountActive(user.id))) {
        return accountUnavailableResponse()
      }
      return NextResponse.json(result)
    } catch {
      return NextResponse.json({ error: 'Failed to tailor resume' }, { status: 500 })
    }
  },
})

/**
 * Bind authenticated Tailor runs before composeApiRoute consumes any quota.
 * The header is deliberately inspected without parsing/cloning the public
 * endpoint's potentially large JSON body, preserving rate-limit-before-body.
 * Omission remains valid for anonymous and legacy callers.
 */
export async function POST(
  req: NextRequest,
  context?: { params?: Record<string, string> },
): Promise<NextResponse> {
  const originUserId = req.headers.get('x-origin-user-id')
  if (originUserId !== null) {
    const session = await getServerSession(authOptions)
    const currentUserId = (session?.user as { id?: string } | undefined)?.id
    if (!currentUserId || originUserId !== currentUserId) {
      return NextResponse.json(
        { error: 'sign-in session changed', code: 'SESSION_CHANGED' },
        { status: 409 },
      )
    }
    await connectDB()
    if (!(await isJobsAccountActive(currentUserId))) {
      return accountUnavailableResponse()
    }
  }
  return composedPOST(req, context)
}
