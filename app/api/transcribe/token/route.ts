import { NextResponse } from 'next/server'
import { composeApiRoute } from '@shared/middleware/composeApiRoute'
import { aiLogger } from '@shared/logger'

export const dynamic = 'force-dynamic'

/**
 * Mints a short-lived Deepgram grant for browser WebSocket STT.
 *
 * The server uses the existing DEEPGRAM_API_KEY for the grant request; STT
 * and TTS do not require a second Deepgram credential.
 *
 * The browser must never receive a long-lived provider credential. Deepgram
 * accepts the returned grant as a bearer WebSocket subprotocol during the
 * handshake; the grant is deliberately short-lived and is not cacheable.
 */

const DEEPGRAM_GRANT_TTL_SECONDS = 30
const NO_STORE_HEADERS = {
  'Cache-Control': 'private, no-store',
  Pragma: 'no-cache',
}

function isDeepgramGrant(
  value: unknown,
): value is { access_token: string; expires_in: number } {
  if (!value || typeof value !== 'object') return false
  const grant = value as Record<string, unknown>
  return (
    typeof grant.access_token === 'string' &&
    grant.access_token.length > 0 &&
    typeof grant.expires_in === 'number' &&
    Number.isFinite(grant.expires_in) &&
    grant.expires_in > 0 &&
    grant.expires_in <= DEEPGRAM_GRANT_TTL_SECONDS
  )
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
      aiLogger.error('DEEPGRAM_API_KEY env var is not set')
      return NextResponse.json(
        { error: 'Deepgram not configured' },
        { status: 503, headers: NO_STORE_HEADERS },
      )
    }

    let grantResponse: Response
    try {
      grantResponse = await fetch('https://api.deepgram.com/v1/auth/grant', {
        method: 'POST',
        headers: {
          Authorization: `Token ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ttl_seconds: DEEPGRAM_GRANT_TTL_SECONDS }),
        cache: 'no-store',
      })
    } catch {
      aiLogger.error('Deepgram grant request failed')
      return NextResponse.json(
        { error: 'Deepgram unavailable' },
        { status: 502, headers: NO_STORE_HEADERS },
      )
    }

    if (!grantResponse.ok) {
      aiLogger.error(
        { status: grantResponse.status },
        'Deepgram grant request was rejected',
      )
      return NextResponse.json(
        { error: 'Deepgram unavailable' },
        { status: 502, headers: NO_STORE_HEADERS },
      )
    }

    let grantPayload: unknown
    try {
      grantPayload = await grantResponse.json()
    } catch {
      aiLogger.error('Deepgram grant response was not valid JSON')
      return NextResponse.json(
        { error: 'Deepgram unavailable' },
        { status: 502, headers: NO_STORE_HEADERS },
      )
    }

    if (!isDeepgramGrant(grantPayload)) {
      aiLogger.error('Deepgram grant response was invalid')
      return NextResponse.json(
        { error: 'Deepgram unavailable' },
        { status: 502, headers: NO_STORE_HEADERS },
      )
    }

    return NextResponse.json(
      {
        token: grantPayload.access_token,
        tokenType: 'bearer',
        expiresIn: grantPayload.expires_in,
      },
      { headers: NO_STORE_HEADERS },
    )
  },
})
