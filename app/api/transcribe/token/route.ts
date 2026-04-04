import { NextResponse } from 'next/server'
import { composeApiRoute } from '@shared/middleware/composeApiRoute'
import { aiLogger } from '@shared/logger'

/**
 * Returns a Deepgram API key for client-side WebSocket STT.
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
      aiLogger.error('DEEPGRAM_API_KEY env var is not set')
      return NextResponse.json({ error: 'Deepgram not configured' }, { status: 503 })
    }

    // Generate a short-lived temporary token.
    try {
      const response = await fetch(
        'https://api.deepgram.com/v1/auth/grant',
        {
          method: 'POST',
          headers: {
            Authorization: `Token ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ ttl_seconds: TOKEN_TTL_SECONDS }),
          signal: AbortSignal.timeout(10_000),
        }
      )

      if (!response.ok) {
        const errorText = await response.text().catch(() => '<unreadable>')
        aiLogger.error(
          { status: response.status, body: errorText },
          'Deepgram /v1/auth/grant returned non-OK status'
        )
        return NextResponse.json(
          { error: 'Failed to mint temporary Deepgram token', deepgramStatus: response.status },
          { status: 502 }
        )
      }

      const data = await response.json()
      const tempToken = data.access_token || data.token || data.key
      if (!tempToken) {
        aiLogger.error(
          { responseKeys: Object.keys(data) },
          'Deepgram /v1/auth/grant OK but no token field found in response'
        )
        return NextResponse.json(
          { error: 'Deepgram response missing token field' },
          { status: 502 }
        )
      }

      return NextResponse.json({ token: tempToken, expiresIn: TOKEN_TTL_SECONDS })
    } catch (err) {
      aiLogger.error({ err }, 'Deepgram token fetch threw an exception')
      return NextResponse.json({ error: 'Deepgram token service unavailable' }, { status: 503 })
    }
  },
})
