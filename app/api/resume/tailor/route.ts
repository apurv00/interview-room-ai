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

// composeApiRoute performs its own session lookup. Preserve the authenticated
// identity observed by the outer pre-quota guard so a deletion/session removal
// between those two reads cannot silently downgrade this same request to the
// anonymous Tailor contract.
const authenticatedRequestUsers = new WeakMap<NextRequest, string>()

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
    const outerAuthenticatedUserId = authenticatedRequestUsers.get(req)
    const innerAuthenticatedUserId = user.id === 'anonymous' ? null : user.id
    if (
      outerAuthenticatedUserId &&
      innerAuthenticatedUserId !== outerAuthenticatedUserId
    ) {
      // Session disappearance can be the direct result of account deletion.
      // Prefer the exact terminal deletion signal over a generic identity
      // change when the original account fence is now inactive.
      if (!(await isJobsAccountActive(outerAuthenticatedUserId))) {
        return accountUnavailableResponse()
      }
      return NextResponse.json(
        { error: 'sign-in session changed', code: 'SESSION_CHANGED' },
        { status: 409 },
      )
    }
    const accountBoundUserId = outerAuthenticatedUserId ?? innerAuthenticatedUserId
    // Defense in depth for clients that send body provenance. The Tailor page
    // also sends x-origin-user-id so its account-switch rejection happens in
    // the wrapper below, before composeApiRoute consumes quota.
    const headerOriginUserId = req.headers.get('x-origin-user-id')
    if (
      (body.originUserId !== undefined &&
        (!accountBoundUserId || body.originUserId !== accountBoundUserId)) ||
      (headerOriginUserId !== null &&
        (!accountBoundUserId || headerOriginUserId !== accountBoundUserId))
    ) {
      return NextResponse.json(
        { error: 'sign-in session changed', code: 'SESSION_CHANGED' },
        { status: 409 },
      )
    }
    try {
      if (accountBoundUserId) {
        await connectDB()
        if (!(await isJobsAccountActive(accountBoundUserId))) return accountUnavailableResponse()
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
      if (accountBoundUserId && !(await isJobsAccountActive(accountBoundUserId))) {
        return accountUnavailableResponse()
      }
      return NextResponse.json(result)
    } catch {
      if (accountBoundUserId) {
        try {
          if (!(await isJobsAccountActive(accountBoundUserId))) {
            return accountUnavailableResponse()
          }
        } catch {
          // Preserve the provider failure if the diagnostic recheck also fails.
        }
      }
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
  const session = await getServerSession(authOptions)
  const currentUserId = (session?.user as { id?: string } | undefined)?.id
  if (originUserId !== null && (!currentUserId || originUserId !== currentUserId)) {
    return NextResponse.json(
      { error: 'sign-in session changed', code: 'SESSION_CHANGED' },
      { status: 409 },
    )
  }
  // Every authenticated Tailor request is account-bound, including legacy
  // clients that omit provenance. Keep this check outside composeApiRoute so
  // inactive accounts consume neither quota nor a potentially large JSON parse.
  if (currentUserId) {
    await connectDB()
    if (!(await isJobsAccountActive(currentUserId))) {
      return accountUnavailableResponse()
    }
    authenticatedRequestUsers.set(req, currentUserId)
  }
  try {
    return await composedPOST(req, context)
  } finally {
    authenticatedRequestUsers.delete(req)
  }
}
