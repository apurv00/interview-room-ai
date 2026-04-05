import { NextResponse } from 'next/server'
import { composeApiRoute } from '@shared/middleware/composeApiRoute'
import { aiLogger } from '@shared/logger'

export const dynamic = 'force-dynamic'

/**
 * Returns the Deepgram API key for client-side WebSocket STT.
 *
 * Uses the API key directly rather than minting temporary tokens via
 * /v1/auth/grant, which produces JWT tokens that Deepgram's WebSocket
 * endpoint rejects via the subprotocol auth method. This is safe because
 * the route is auth-gated (session required) and rate-limited.
 *
 * Requires DEEPGRAM_API_KEY env var.
 */

export const POST = composeApiRoute({
  rateLimit: {
    windowMs: 60_000,
    maxRequests: 10,
    keyPrefix: 'rl:transcribe-token',
  },
  handler: async () => {
    const apiKey = process.env.DEEPGRAM_API_KEY
    if (!apiKey) {
      aiLogger.error('DEEPGRAM_API_KEY env var is not set')
      return NextResponse.json({ error: 'Deepgram not configured' }, { status: 503 })
    }

    return NextResponse.json({ token: apiKey })
  },
})
