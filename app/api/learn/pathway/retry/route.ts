import mongoose from 'mongoose'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { composeApiRoute } from '@shared/middleware/composeApiRoute'
import { connectDB } from '@shared/db/connection'
import { InterviewSession } from '@shared/db/models'
import { inngest } from '@shared/services/inngest'
import { aiLogger } from '@shared/logger'

/**
 * POST /api/learn/pathway/retry
 *
 * Re-enqueues pathway regeneration for a session whose previous Inngest
 * `pathway/regenerate` attempt failed. Reads the necessary inputs
 * (config, feedback, evaluations) off the session document so the
 * client doesn't need to re-supply them.
 *
 * Bug B follow-up (2026-05-16) — gives users a recovery path when the
 * Inngest job has terminally failed (`pathwayGenerationStatus: 'failed'`).
 * Without this, the only way to trigger another attempt was to complete
 * another interview, which made transient LLM failures permanently
 * sticky.
 *
 * Rate-limited tightly because:
 *   - each retry triggers another LLM call (cost)
 *   - if the underlying cause is persistent (bad data), unlimited
 *     retries just rack up cost without resolving anything
 */

const RetrySchema = z.object({
  sessionId: z.string().min(1),
})

/**
 * Status values that mean "no retry needed" (Codex P2 on PR #379):
 *   succeeded — the previous attempt produced a plan; retrying just burns LLM
 *   skipped   — feature flag was off; retry won't change that
 *   pending   — a job is already enqueued
 *   running   — a job is already executing
 *
 * Retries are allowed only for: 'failed' (the recovery case this endpoint
 * exists for) and undefined (never attempted — typically a session that
 * pre-dates Bug B's status tracking).
 */
const RETRYABLE_STATUSES: ReadonlySet<string | undefined> = new Set([
  'failed',
  undefined,
])

export const POST = composeApiRoute<z.infer<typeof RetrySchema>>({
  schema: RetrySchema,
  rateLimit: { windowMs: 60_000, maxRequests: 3, keyPrefix: 'rl:pathway-retry' },

  async handler(_req, { user, body }) {
    const { sessionId } = body

    if (!mongoose.isValidObjectId(sessionId)) {
      return NextResponse.json({ error: 'Invalid sessionId' }, { status: 400 })
    }

    await connectDB()
    const session = await InterviewSession.findOne({
      _id: sessionId,
      userId: new mongoose.Types.ObjectId(user.id),
    })
      .select('config feedback evaluations pathwayGenerationStatus')
      .lean<{
        config?: { role?: string; interviewType?: string; experience?: string }
        feedback?: unknown
        evaluations?: unknown[]
        pathwayGenerationStatus?: string
      }>()

    if (!session) {
      return NextResponse.json({ error: 'Session not found' }, { status: 404 })
    }
    // Vercel review on PR #379 — defensive null check. The Mongoose `lean()`
    // strips Mongoose defaults; a session row written by an older migration
    // or by a different code path may legitimately lack `config`.
    if (!session.config || typeof session.config.role !== 'string' || typeof session.config.experience !== 'string') {
      return NextResponse.json(
        { error: 'Session config is missing required fields — cannot regenerate pathway.' },
        { status: 409 }
      )
    }
    if (!session.feedback) {
      return NextResponse.json(
        { error: 'Session has no feedback yet — generate feedback first.' },
        { status: 409 }
      )
    }
    if (!Array.isArray(session.evaluations) || session.evaluations.length === 0) {
      return NextResponse.json(
        { error: 'Session has no evaluations to base a plan on.' },
        { status: 409 }
      )
    }

    // Codex P2 on PR #379 — tighten the retry guard.
    //
    // Previously this only blocked 'running'/'pending' which left 'succeeded'
    // and 'skipped' sessions wide-open for re-enqueue. That meant any
    // authenticated caller could repeatedly trigger pathway regeneration
    // on a working plan, racking up LLM cost AND potentially overwriting
    // a good plan with another generation that wasn't requested by the
    // UI flow. The rate-limit (3/min) is a backstop, not a contract.
    if (!RETRYABLE_STATUSES.has(session.pathwayGenerationStatus)) {
      const reason =
        session.pathwayGenerationStatus === 'running' || session.pathwayGenerationStatus === 'pending'
          ? 'A pathway regeneration is already in flight for this session.'
          : `Pathway regeneration is not retryable from status '${session.pathwayGenerationStatus}'. ` +
            'Retries are reserved for failed or never-attempted sessions.'
      return NextResponse.json({ error: reason }, { status: 409 })
    }

    // Codex P1 + Vercel P1 on PR #379 — deadlock-on-enqueue-failure.
    //
    // Previously this flipped status to 'pending' BEFORE calling
    // inngest.send(). If the send itself failed (Inngest outage, network
    // blip, missing event key in some envs), the session was left
    // permanently in 'pending' state and the retry guard above blocked
    // every future attempt — users stuck forever with no recovery.
    //
    // Fix: wrap the enqueue in try/catch and roll the status back to
    // 'failed' (with the enqueue error captured) so the UI surfaces a
    // retryable error message and the next call passes the guard.
    await InterviewSession.findByIdAndUpdate(sessionId, {
      $set: { pathwayGenerationStatus: 'pending' },
      $unset: { pathwayGenerationError: 1 },
    })

    try {
      await inngest.send({
        name: 'pathway/regenerate',
        data: {
          sessionId,
          userId: user.id,
          domain: session.config.role,
          interviewType: session.config.interviewType ?? 'behavioral',
          experience: session.config.experience,
          feedback: session.feedback,
          typedEvaluations: session.evaluations,
        },
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to enqueue pathway regeneration.'
      aiLogger.error(
        { err, sessionId, userId: user.id },
        'pathway/retry: inngest.send failed — rolling status back to failed',
      )
      // Best-effort rollback. If even this DB write fails, the session
      // stays in 'pending' (degenerate case) but the next call hits the
      // rate-limit / DB-recovers and the user can re-try once the system
      // is back up.
      await InterviewSession.findByIdAndUpdate(sessionId, {
        $set: {
          pathwayGenerationStatus: 'failed',
          pathwayGenerationError: message.slice(0, 500),
        },
      }).catch((dbErr) => {
        aiLogger.error(
          { err: dbErr, sessionId },
          'pathway/retry: failed to roll status back after enqueue failure',
        )
      })
      return NextResponse.json(
        { error: `Could not enqueue retry: ${message}` },
        { status: 503 }
      )
    }

    return NextResponse.json({ success: true, status: 'pending' })
  },
})
