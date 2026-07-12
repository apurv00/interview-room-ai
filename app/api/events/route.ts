import { NextResponse } from 'next/server'
import { composeApiRoute } from '@shared/middleware/composeApiRoute'
import { connectDB } from '@shared/db/connection'
import { ProductEvent } from '@shared/db/models'
import { ProductEventInputSchema, ANON_COOKIE, ANON_COOKIE_MAX_AGE, anonIdFromCookieHeader, mintAnonCookie, stitchAnonEventsToUser } from '@jobs'
import { logger } from '@shared/logger'

export const dynamic = 'force-dynamic'

/**
 * POST /api/events — first-party product-event capture (PRODUCT_FLOW §2).
 * Client keepalive writes for ANON surfaces; authed surfaces should write
 * server-side in their own routes where possible. Identity: session user
 * when authed, else the signed anon cookie (minted here on first contact).
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

    // The anon cookie is read for AUTHED requests too (Codex #508): it is
    // httpOnly, so this server path is the only place the pre-signup
    // identity can ever be linked to the user.
    let anonId = anonIdFromCookieHeader(req.headers.get('cookie'))
    let mintedCookie: string | null = null
    if (!authedUserId && !anonId) {
      const minted = mintAnonCookie()
      anonId = minted.anonId
      mintedCookie = minted.cookieValue
    }
    try {
      await connectDB()
      // Stitch AFTER connect (bufferCommands:false — a pre-connection
      // updateMany throws on cold serverless starts).
      if (authedUserId && anonId && body.name === 'identity_aliased') {
        // Backfill pre-signup rows to the user — idempotent, never throws.
        await stitchAnonEventsToUser(anonId, authedUserId)
      }
      await ProductEvent.create({
        name: body.name,
        userId: authedUserId ?? undefined,
        // Authed events KEEP the anon link when the cookie is present —
        // dropping it orphans the pre-signup history (Codex #508).
        anonId: anonId ?? undefined,
        jobPostingId: body.jobPostingId,
        applicationId: body.applicationId,
        sessionId: body.sessionId,
        props: body.props,
        ts: new Date(),
      })
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
      })
    }
    return res
  },
})
