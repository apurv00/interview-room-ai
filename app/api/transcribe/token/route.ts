import { NextResponse } from 'next/server'
import { composeApiRoute } from '@shared/middleware/composeApiRoute'

/**
 * Returns the Deepgram API key for client-side WebSocket STT.
 * In production, this should generate a short-lived project-scoped key
 * via Deepgram's API. For now, returns the main key with a flag.
 */
export const POST = composeApiRoute({
  rateLimit: {
    windowMs: 60_000,
    maxRequests: 10,
    keyPrefix: 'rl:transcribe-token',
  },
  handler: async () => {
    const key = process.env.DEEPGRAM_API_KEY
    if (!key) {
      return NextResponse.json({ error: 'Deepgram not configured' }, { status: 503 })
    }

    return NextResponse.json({ token: key })
  },
})
