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
const DEEPGRAM_GRANT_URL = 'https://api.deepgram.com/v1/auth/grant'
const GRANT_TIMEOUT_MS = 7_000
const GRANT_RETRY_DELAYS_MS = [300, 900]

type DeepgramGrantResponse = {
  access_token?: string
  token?: string
  key?: string
  expires_in?: number
}

async function requestDeepgramGrant(apiKey: string): Promise<Response> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), GRANT_TIMEOUT_MS)
  try {
    return await fetch(DEEPGRAM_GRANT_URL, {
      method: 'POST',
      headers: {
        Authorization: `Token ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ttl_seconds: TOKEN_TTL_SECONDS }),
      signal: controller.signal,
      cache: 'no-store',
    })
  } finally {
    clearTimeout(timeout)
  }
}

async function mintDeepgramTokenWithRetry(apiKey: string): Promise<DeepgramGrantResponse> {
  let lastError: Error | null = null

  for (let attempt = 0; attempt <= GRANT_RETRY_DELAYS_MS.length; attempt++) {
    try {
      const response = await requestDeepgramGrant(apiKey)
      const data = (await response.json().catch(() => ({}))) as DeepgramGrantResponse

      if (response.ok) {
        return data
      }

      const shouldRetry = response.status === 429 || response.status >= 500
      if (!shouldRetry || attempt === GRANT_RETRY_DELAYS_MS.length) {
        throw new Error(`Deepgram grant failed (${response.status})`)
      }
    } catch (error) {
      lastError = error instanceof Error ? error : new Error('Unknown Deepgram grant error')
      if (attempt === GRANT_RETRY_DELAYS_MS.length) {
        break
      }
    }

    await new Promise(resolve => setTimeout(resolve, GRANT_RETRY_DELAYS_MS[attempt]))
  }

  throw lastError ?? new Error('Deepgram grant failed')
}

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
      const data = await mintDeepgramTokenWithRetry(apiKey)
      const tempToken = data.access_token || data.token || data.key
      const expiresIn = typeof data.expires_in === 'number' && data.expires_in > 0
        ? Math.floor(data.expires_in)
        : TOKEN_TTL_SECONDS

      if (!tempToken) {
        return NextResponse.json({ error: 'Deepgram grant returned no token' }, { status: 502 })
      }

      return NextResponse.json({ token: tempToken, expiresIn })
    } catch {
      return NextResponse.json({ error: 'Deepgram token service unavailable' }, { status: 503 })
    }
  },
})
