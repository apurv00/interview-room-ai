import { NextResponse } from 'next/server'
import { composeApiRoute } from '@shared/middleware/composeApiRoute'
import { connectDB } from '@shared/db/connection'
import { ProductEvent } from '@shared/db/models'
import {
  ProductEventInputSchema,
  ANON_COOKIE,
  ANON_COOKIE_MAX_AGE,
  anonIdFromCookieHeader,
  mintAnonCookie,
  stitchAnonEventsToUser,
} from '@jobs'
import { logger } from '@shared/logger'
import { recordJobsUserEvent } from '@jobs/services/userEventService'

export const dynamic = 'force-dynamic'

/**
 * POST /api/events — first-party product-event capture (PRODUCT_FLOW §2).
 * Accepts only the closed browser-owned keepalive vocabulary. Server/worker
 * events are written at their authoritative mutation point and cannot cross
 * this public boundary. Identity: session user when authed, else the signed
 * anon cookie (minted here on first contact).
 * Telemetry never breaks a user flow — DB failures log and return 204.
 */
export const POST = composeApiRoute({
  schema: ProductEventInputSchema,
  authOptional: true,
  rateLimit: {
    keyPrefix: 'rl:events',
    windowMs: 60_000,
    maxRequests: 30,
    anonDailyLimit: 300,
  },
  handler: async (req, { body, user }) => {
    const authedUserId = user && user.id !== 'anonymous' ? user.id : null

    // Keep the signed anon link on authenticated browser events as the
    // correlation bridge without accepting a browser-authored identity
    // mutation.
    let anonId = anonIdFromCookieHeader(req.headers.get('cookie'))
    let mintedCookie: string | null = null
    if (!authedUserId && !anonId) {
      const minted = mintAnonCookie()
      anonId = minted.anonId
      mintedCookie = minted.cookieValue
    }
    try {
      await connectDB()
      if (authedUserId && anonId) {
        // The browser supplies neither identity. Both values come from
        // authenticated/signed server state, and the fenced helper is
        // idempotent after the first successful stitch.
        await stitchAnonEventsToUser(anonId, authedUserId)
      }
      const event = {
        name: body.name,
        anonId: anonId ?? undefined,
        jobPostingId: body.jobPostingId,
        props: body.props,
        ts: new Date(),
      }
      if (authedUserId) {
        await recordJobsUserEvent({ ...event, userId: authedUserId })
      } else {
        await ProductEvent.create(event)
      }
    } catch (err) {
      logger.warn({ err, name: body.name }, 'ProductEvent write failed')
    }

    const res = new NextResponse(null, { status: 204 })
    if (mintedCookie) {
      res.cookies.set(ANON_COOKIE, mintedCookie, {
        httpOnly: true,
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production',
        maxAge: ANON_COOKIE_MAX_AGE,
        path: '/',
        // Cross-subdomain funnel identity (Codex #508): the app serves
        // resume./learn./cms. subdomains and the NextAuth session cookie is
        // scoped to .interviewprep.guru (authOptions precedent) — a
        // host-only anon cookie minted on a subdomain would never reach the
        // apex-host authed stitch call. Host-only in dev.
        ...(process.env.NODE_ENV === 'production' ? { domain: '.interviewprep.guru' } : {}),
      })
    }
    return res
  },
})
