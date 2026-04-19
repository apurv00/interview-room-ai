import { NextResponse } from 'next/server'
import { composeApiRoute } from '@shared/middleware/composeApiRoute'
import { aiLogger } from '@shared/logger'
import { z } from 'zod'

export const dynamic = 'force-dynamic'

/**
 * Client-to-server pipe for Deepgram WebSocket close events. The STT
 * WebSocket runs browser ↔ deepgram.com directly — close codes never
 * touch our server. When users report mid-answer cutoffs they can't
 * always open DevTools to capture console output, so the client fires
 * a fire-and-forget POST here on every `ws.onclose`. We log at
 * `level:error` so the event appears in the user's existing Vercel
 * `level:error` log search alongside other errors.
 *
 * This is purely diagnostic — no side effects on interview flow, no
 * retry logic, no user-visible consequence if the POST fails. The
 * client catches and swallows rejection.
 *
 * Security: route is auth-gated (session required) + rate-limited.
 * 60 requests/min/user is generous enough to cover a single session's
 * worth of legitimate close events even with the 2-attempt reconnect
 * logic (warm + cold paths × 2 reconnects = max ~6 closes per session).
 * Anything beyond that indicates abuse or a bug worth investigating.
 *
 * No PII: we log only WebSocket protocol fields (code, reason,
 * wasClean) and a short `context` label that the client chooses from
 * a small enum (no user content, no transcript).
 */

const DeepgramWsCloseSchema = z.object({
  /** WebSocket close code (1000-4999). */
  code: z.number().int().min(1000).max(4999),
  /** Server-provided reason string. May be empty. Capped at 500 chars
   *  so log lines stay readable. */
  reason: z.string().max(500),
  /** Whether the close was clean (followed protocol). */
  wasClean: z.boolean(),
  /** Which connection path closed — client enum, no user content. */
  context: z.enum(['warmUp', 'connectWebSocket']),
})

type DeepgramWsClosePayload = z.infer<typeof DeepgramWsCloseSchema>

export const POST = composeApiRoute<DeepgramWsClosePayload>({
  schema: DeepgramWsCloseSchema,
  rateLimit: {
    windowMs: 60_000,
    maxRequests: 60,
    keyPrefix: 'rl:dg-ws-close',
  },

  async handler(_req, { body }) {
    // Log at error level so this surfaces in `level:error` Vercel
    // searches alongside the duplicate-index warnings the user already
    // tracks. The actual severity is informational — close events are
    // expected and harmless — but the user's diagnostic workflow keys
    // on error-level lines.
    aiLogger.error(
      {
        module: 'deepgram-ws-close',
        code: body.code,
        reason: body.reason || '(empty)',
        wasClean: body.wasClean,
        context: body.context,
      },
      `Deepgram WS close — code=${body.code} context=${body.context} wasClean=${body.wasClean}`
    )

    return NextResponse.json({ received: true })
  },
})
