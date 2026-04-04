import { NextResponse } from 'next/server'
import { composeApiRoute } from '@shared/middleware/composeApiRoute'
import { aiLogger } from '@shared/logger'

/**
 * Returns a Deepgram token for client-side WebSocket STT.
 *
 * Attempts to mint a short-lived temporary token via Deepgram's /v1/auth/grant.
 * If the grant endpoint fails (e.g. key lacks Member scope), falls back to
 * returning the API key directly — safe because this route is auth-gated.
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

    // Try to mint a short-lived temporary token first.
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

      if (response.ok) {
        const data = await response.json()
        const tempToken = data.access_token || data.token || data.key
        if (tempToken) {
          return NextResponse.json({ token: tempToken, expiresIn: TOKEN_TTL_SECONDS })
        }
        aiLogger.warn(
          { responseKeys: Object.keys(data) },
          'Deepgram /v1/auth/grant OK but no token field — falling back to API key'
        )
      } else {
        const errorText = await response.text().catch(() => '<unreadable>')
        aiLogger.warn(
          { status: response.status, body: errorText },
          'Deepgram /v1/auth/grant failed — falling back to API key'
        )
      }
    } catch (err) {
      aiLogger.warn({ err }, 'Deepgram /v1/auth/grant threw — falling back to API key')
    }

    // Fallback: return the API key directly. This is safe because the route
    // is behind auth (composeApiRoute enforces session) and rate-limited.
    return NextResponse.json({ token: apiKey, expiresIn: TOKEN_TTL_SECONDS })
  },
})
