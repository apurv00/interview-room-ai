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
  /** Named trigger the client recorded right before calling ws.close
   *  (e.g. 'graceTimer', 'earlyQuestion', 'reconnectExhausted',
   *  'stopListeningExternal'). Null when the close was initiated by the
   *  remote (Deepgram or network) rather than our own code — the onclose
   *  handler reads the ref unconditionally, so remote-initiated closes
   *  arrive here with trigger:null, which is itself diagnostic. We use
   *  a free-form string (not an enum) so the server accepts triggers
   *  added client-side without requiring a matching server deploy. */
  trigger: z.string().max(50).nullable().optional(),
  /** Per-turn count of PCM frames the client successfully sent to
   *  Deepgram before this close. Optional so older client builds keep
   *  validating without a coordinated deploy. Cap = 1e7: a single
   *  4-minute answer at 4096-sample / 256ms cadence emits ~937 frames,
   *  so any value over 1e6 indicates a bug worth seeing in raw form. */
  audioFrameCount: z.number().int().nonnegative().max(10_000_000).optional(),
  /** Per-turn count of PCM frames the worklet had to drop because the
   *  active ws was CLOSING/CLOSED at frame-arrival time. Non-zero is
   *  the smoking-gun for "user spoke into a dead pipe" — directly
   *  attributable to the audio loss the user reports as "I was
   *  speaking the whole time but transcript was empty". */
  droppedFrameCount: z.number().int().nonnegative().max(10_000_000).optional(),
  /** ws.readyState (CLOSING=2, CLOSED=3) at the most recent dropped
   *  frame. `null` when no drop occurred this turn. Distinguishes
   *  "closed before user started speaking" (=3 throughout) from
   *  "closed mid-speech" (=2 transitioning to =3). */
  lastDropReadyState: z.number().int().min(0).max(3).nullable().optional(),
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
        trigger: body.trigger ?? null,
        audioFrameCount: body.audioFrameCount ?? null,
        droppedFrameCount: body.droppedFrameCount ?? null,
        lastDropReadyState: body.lastDropReadyState ?? null,
      },
      // Inline the counters in the message string too so they show up
      // in plain-text Vercel log views (default `level:error` search
      // displays the message, not the structured fields).
      `Deepgram WS close — code=${body.code} context=${body.context} trigger=${body.trigger ?? 'remote'} wasClean=${body.wasClean} audioFrames=${body.audioFrameCount ?? 'n/a'} droppedFrames=${body.droppedFrameCount ?? 'n/a'} lastDropReadyState=${body.lastDropReadyState ?? 'n/a'}`
    )

    return NextResponse.json({ received: true })
  },
})
