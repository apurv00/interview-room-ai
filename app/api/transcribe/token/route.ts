import { NextResponse } from 'next/server'
import { composeApiRoute } from '@shared/middleware/composeApiRoute'

/**
 * Returns a short-lived Deepgram API key for client-side WebSocket STT.
 * Uses Deepgram's /v1/auth/token endpoint to generate a temporary key
 * that expires after a configurable TTL (default 120s).
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

    try {
      // Use Deepgram's temporary auth token endpoint
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

      if (!response.ok) {
        console.error('Deepgram token generation failed:', response.status, await response.text())
        return NextResponse.json({ error: 'Failed to generate STT token' }, { status: 502 })
      }

      const data = await response.json()
      // Deepgram returns { token: "...", ... } for temporary auth tokens
      const tempToken = data.token || data.key
      if (!tempToken) {
        console.error('Deepgram token response missing token field:', data)
        return NextResponse.json({ error: 'Invalid token response' }, { status: 502 })
      }

      return NextResponse.json({
        token: tempToken,
        expiresIn: TOKEN_TTL_SECONDS,
      })
    } catch (err) {
      console.error('Deepgram token request error:', err)
      return NextResponse.json({ error: 'Token generation failed' }, { status: 502 })
    }
  },
})
