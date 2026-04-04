import { NextResponse } from 'next/server'
import { composeApiRoute } from '@shared/middleware/composeApiRoute'

/**
 * Returns a short-lived Deepgram access token for client-side WebSocket STT.
 *
 * Generates a short-lived temporary token via Deepgram's /v1/auth/grant
 * endpoint. We never return the primary API key to clients.
 *
 * Requires DEEPGRAM_API_KEY env var.
 */

const TOKEN_TTL_SECONDS = 120

export const POST = composeApiRoute({
  rateLimit: {
    windowMs: 60_000,
    maxRequests: 10,
    keyPrefix: 'rl:transcribe-token',
  },
  handler: async () => {
    const apiKey = process.env.DEEPGRAM_API_KEY
    if (!apiKey) {
      return NextResponse.json({ error: 'Deepgram not configured' }, { status: 503 })
    }

    // Generate a short-lived temporary token.
    try {
      const response = await fetch('https://api.deepgram.com/v1/auth/grant', {
        method: 'POST',
        headers: {
          Authorization: `Token ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ttl_seconds: TOKEN_TTL_SECONDS }),
      })

      if (response.ok) {
        const data = await response.json()
        const tempToken = data.access_token || data.token || data.key
        if (tempToken) {
          return NextResponse.json({ token: tempToken, expiresIn: TOKEN_TTL_SECONDS })
        }
      }
      return NextResponse.json({ error: `Failed to mint temporary Deepgram token (${response.status})` }, { status: 502 })
    } catch {
      return NextResponse.json({ error: 'Deepgram token service unavailable' }, { status: 503 })
    }
  },
})
