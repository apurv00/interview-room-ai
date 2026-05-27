import mongoose from 'mongoose'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { composeApiRoute } from '@shared/middleware/composeApiRoute'
import { connectDB } from '@shared/db/connection'
import { InterviewSession } from '@shared/db/models'
import { inngest } from '@shared/services/inngest'
import { aiLogger } from '@shared/logger'
import { getShortFormMinAnswers } from '@interview/services/eval/sessionScoringPolicy'
import {
  buildRetryablePathwayStatusFilter,
  getPathwayUpdateEligibility,
  isStalePathwayGeneration,
} from '@learn/services/pathwayUpdateEligibility'
import { isFeatureEnabled } from '@shared/featureFlags'

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
 * Retries are allowed for: 'failed' (the recovery case this endpoint
 * exists for), undefined (never attempted — typically a session that
 * pre-dates Bug B's status tracking), and stale in-flight statuses
 * where the worker never picked up the job.
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
 * `RETRYABLE_STATUSES`, plus stale pending/running states. Used inside
 * the atomic `findOneAndUpdate` so
 * the read+write happen as a single operation. Without this, two
 * concurrent /api/learn/pathway/retry calls could both pass a separate
 * status check and then both flip 'pending' + both enqueue — duplicate
 * background jobs, conflicting terminal status writes (one writes
 * 'succeeded', the other 'failed' over it), and 2× LLM cost.
 */
// NOTE: the previous `DEFAULT_INTERVIEW_TYPE = 'screening'` constant
// is no longer needed at this site — the event payload no longer
// carries `interviewType` (Codex P2 on PR #379 — payload slim-down).
// The Inngest job (modules/learn/jobs/pathwayJob.ts) now owns the
// default and reads it from the session.config when it fetches the
// session itself. If you change the default, change it there.

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
      .select(
        'config feedback evaluations pathwayGenerationStatus pathwayGenerationStartedAt pathwayGenerationUseSynthesizedFeedback completedAt answeredCount',
      )
      .lean<{
        config?: { role?: string; interviewType?: string; experience?: string }
        feedback?: {
          overall_score?: number | null
          degraded?: boolean
          red_flags?: string[] | null
        } | null
        evaluations?: unknown[]
        pathwayGenerationStatus?: string
        pathwayGenerationStartedAt?: Date
        completedAt?: Date
        pathwayGenerationUseSynthesizedFeedback?: boolean
        answeredCount?: number
      }>()

    if (!session) {
      return NextResponse.json({ error: 'Session not found' }, { status: 404 })
    }

    const answeredCount =
      typeof session.answeredCount === 'number'
        ? session.answeredCount
        : session.evaluations?.length ?? 0
    const interviewType = session.config?.interviewType
    const minAnswers = getShortFormMinAnswers(interviewType)
    if (answeredCount < minAnswers) {
      return NextResponse.json(
        {
          error: `At least ${minAnswers} answered question${minAnswers === 1 ? '' : 's'} are required before pathway regeneration can run.`,
        },
        { status: 409 },
      )
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
    if (!Array.isArray(session.evaluations) || session.evaluations.length === 0) {
      return NextResponse.json(
        { error: 'Session has no evaluations to base a plan on.' },
        { status: 409 }
      )
    }
    // Outer-catch / inner-degraded generate-feedback paths intentionally skip
    // persisting session.feedback (P0 contract). Retry must still work when
    // evaluations exist — pathwayJob synthesizes in-memory when
    // pathwayGenerationUseSynthesizedFeedback is set at claim time (Codex P2
    // on PR #398).
    const useSynthesizedFeedback = !session.feedback
    if (useSynthesizedFeedback) {
      aiLogger.info(
        { sessionId, userId: user.id },
        'pathway/retry: no persisted feedback — will enqueue with synthesized-feedback flag',
      )
    } else {
      const eligibility = getPathwayUpdateEligibility({
        answeredCount,
        interviewType,
        pathwayPlannerEnabled: isFeatureEnabled('pathway_planner'),
        feedback: session.feedback ?? null,
        pathwayGenerationStatus: session.pathwayGenerationStatus ?? null,
        evaluationCount: session.evaluations?.length ?? 0,
      })
      if (eligibility.reason === 'insufficient_answers' || eligibility.reason === 'no_scored_feedback') {
        return NextResponse.json(
          {
            error:
              eligibility.reason === 'insufficient_answers'
                ? 'This interview did not have enough answers to update your pathway.'
                : 'Scored feedback is required before pathway regeneration can run.',
          },
          { status: 409 },
        )
      }
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
        ...buildRetryablePathwayStatusFilter(),
      },
      {
        $set: {
          pathwayGenerationStatus: 'pending',
          pathwayGenerationUseSynthesizedFeedback: useSynthesizedFeedback,
          pathwayGenerationStartedAt: new Date(),
        },
        $inc: { pathwayGenerationAttempts: 1 },
        $unset: { pathwayGenerationError: 1 },
      },
      { returnDocument: 'after' }
    )

    if (!claimed) {
      // Either the session moved out of a retryable state between our
      // validation read and the CAS, or another concurrent retry just
      // won. Disambiguate via a quick re-read so the user gets a useful
      // error rather than a generic "could not claim".
      const isStaleInFlight = isStalePathwayGeneration(
        session.pathwayGenerationStatus,
        session.completedAt,
        session.pathwayGenerationStartedAt,
      )
      const reason =
        (session.pathwayGenerationStatus === 'running' ||
          session.pathwayGenerationStatus === 'pending') &&
        !isStaleInFlight
          ? 'A pathway regeneration is already in flight for this session.'
          : RETRYABLE_STATUSES.has(session.pathwayGenerationStatus) || isStaleInFlight
            ? 'Another retry just claimed this session — refresh and try again if needed.'
            : `Pathway regeneration is not retryable from status '${session.pathwayGenerationStatus}'. ` +
              'Retries are reserved for failed, stale in-flight, or never-attempted sessions.'
      return NextResponse.json({ error: reason }, { status: 409 })
    }

    // Codex P1 + Vercel P1 on PR #379 — deadlock-on-enqueue-failure.
    //
    // After the atomic claim above, the status is 'pending'. If the
    // inngest.send below fails, we must roll back to 'failed' so the
    // retry guard doesn't block all future attempts permanently.
    try {
      // Codex P2 on PR #379 (effectively P0) — event payload contains
      // ONLY identifiers. The Inngest job re-fetches config / feedback /
      // evaluations from Mongo and applies its own 'screening' default
      // for missing interviewType (same value DEFAULT_INTERVIEW_TYPE
      // documented above). Previously the event carried the full
      // feedback + evaluations inline; on a long interview that could
      // exceed Inngest's 512KB event-size limit and brick this
      // session's regeneration forever — every retry resent the same
      // oversized payload. The validation reads above (config /
      // feedback / evaluations existence) stay in place so we don't
      // claim + enqueue a job that will just fail in its fetch-session
      // step.
      await inngest.send({
        name: 'pathway/regenerate',
        data: {
          sessionId,
          userId: user.id,
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
