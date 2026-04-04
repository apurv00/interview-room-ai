import { NextResponse } from 'next/server'
import { composeApiRoute } from '@shared/middleware/composeApiRoute'

/**
 * Returns a Deepgram API key for client-side WebSocket STT.
 *
 * Attempts to generate a short-lived temporary token via Deepgram's
 * /v1/auth/token endpoint. If that fails (wrong plan, API change, etc.),
 * falls back to returning the main API key so the interview pipeline
 * never breaks.
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

    // Try to generate a short-lived temporary token (preferred for security)
    try {
      const response = await fetch(
        `https://api.deepgram.com/v1/auth/token?expiration_date=${TOKEN_TTL_SECONDS}`,
        {
          method: 'POST',
          headers: {
            Authorization: `Token ${apiKey}`,
            'Content-Type': 'application/json',
          },
        }
      )

      if (response.ok) {
        const data = await response.json()
        const tempToken = data.token || data.key
        if (tempToken) {
          return NextResponse.json({ token: tempToken, expiresIn: TOKEN_TTL_SECONDS })
        }
      }
      // If temp token generation fails, fall through to raw key fallback
    } catch {
      // Temp token generation failed — fall through to raw key
    }

    // Fallback: return the main API key directly.
    // This ensures the interview pipeline never breaks due to temp token issues.
    return NextResponse.json({ token: apiKey })
  },
})
