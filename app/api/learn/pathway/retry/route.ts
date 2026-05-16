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
 *
 * The set is used post-CAS to format helpful error messages. The CAS
 * itself uses `RETRYABLE_STATUS_FILTER` below (Codex P2 on PR #379 —
 * atomic claim, prevents two concurrent retries both passing the check).
 */
const RETRYABLE_STATUSES: ReadonlySet<string | undefined> = new Set([
  'failed',
  undefined,
])

/**
 * Mongo filter that matches the same set of statuses as
 * `RETRYABLE_STATUSES`. Used inside the atomic `findOneAndUpdate` so
 * the read+write happen as a single operation. Without this, two
 * concurrent /api/learn/pathway/retry calls could both pass a separate
 * status check and then both flip 'pending' + both enqueue — duplicate
 * background jobs, conflicting terminal status writes (one writes
 * 'succeeded', the other 'failed' over it), and 2× LLM cost.
 */
const RETRYABLE_STATUS_FILTER = {
  $or: [
    { pathwayGenerationStatus: 'failed' },
    { pathwayGenerationStatus: { $exists: false } },
    { pathwayGenerationStatus: null },
  ],
}

/**
 * Default `interviewType` when the session's config doesn't specify one.
 * Must match the primary feedback flow's default (currently
 * `'screening'`, set at app/api/generate-feedback/route.ts:243) so a
 * retry doesn't silently regenerate a plan under different evaluation
 * assumptions than the original generation. Codex P2 on PR #379.
 *
 * If you change the primary default, change this too — they're
 * intentionally coupled.
 */
const DEFAULT_INTERVIEW_TYPE = 'screening'

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

    // Codex P2 on PR #379 — atomic retry claim.
    //
    // Combine the retryability check and the status flip into a single
    // findOneAndUpdate so two concurrent retry calls cannot both pass
    // the guard. If two requests race here:
    //   - the first findOneAndUpdate matches the retryable filter and
    //     flips status to 'pending', returning the updated doc
    //   - the second findOneAndUpdate now sees status='pending' (which
    //     is NOT in RETRYABLE_STATUS_FILTER) and returns null
    //   - we return 409 instead of enqueueing a duplicate job
    //
    // This replaces the previous read-check-write pattern that had a
    // race window between the status check and the flip.
    const claimed = await InterviewSession.findOneAndUpdate(
      {
        _id: new mongoose.Types.ObjectId(sessionId),
        userId: new mongoose.Types.ObjectId(user.id),
        ...RETRYABLE_STATUS_FILTER,
      },
      {
        $set: { pathwayGenerationStatus: 'pending' },
        $unset: { pathwayGenerationError: 1 },
      },
      { returnDocument: 'after' }
    )

    if (!claimed) {
      // Either the session moved out of a retryable state between our
      // validation read and the CAS, or another concurrent retry just
      // won. Disambiguate via a quick re-read so the user gets a useful
      // error rather than a generic "could not claim".
      const reason =
        session.pathwayGenerationStatus === 'running' ||
        session.pathwayGenerationStatus === 'pending'
          ? 'A pathway regeneration is already in flight for this session.'
          : RETRYABLE_STATUSES.has(session.pathwayGenerationStatus)
            ? 'Another retry just claimed this session — refresh and try again if needed.'
            : `Pathway regeneration is not retryable from status '${session.pathwayGenerationStatus}'. ` +
              'Retries are reserved for failed or never-attempted sessions.'
      return NextResponse.json({ error: reason }, { status: 409 })
    }

    // Codex P1 + Vercel P1 on PR #379 — deadlock-on-enqueue-failure.
    //
    // After the atomic claim above, the status is 'pending'. If the
    // inngest.send below fails, we must roll back to 'failed' so the
    // retry guard doesn't block all future attempts permanently.
    try {
      await inngest.send({
        name: 'pathway/regenerate',
        data: {
          sessionId,
          userId: user.id,
          domain: session.config.role,
          // Codex P2 on PR #379 — match the primary flow's default in
          // app/api/generate-feedback/route.ts:243 ('screening'). A
          // retry must regenerate under the SAME assumptions as the
          // original generation; using a different default here would
          // silently shift evaluation weighting + pathway picks for
          // any session that lacks an explicit interviewType.
          interviewType: session.config.interviewType || DEFAULT_INTERVIEW_TYPE,
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
