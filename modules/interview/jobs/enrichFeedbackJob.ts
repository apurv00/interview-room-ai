import { inngest } from '@shared/services/inngest'
import { connectDB } from '@shared/db/connection'
import { InterviewSession } from '@shared/db/models'
import { aiLogger } from '@shared/logger'
import { trackUsage } from '@shared/services/usageTracking'
import { flushUsageBuffer } from '@shared/services/usageBuffer'
import type { AuthUser } from '@shared/middleware/withAuth'
import { getDomainLabel } from '@interview/config/interviewConfig'
import {
  runFeedbackEnrichment,
  type EnrichmentEvaluation,
} from '@interview/services/eval/feedbackEnrichment'

/**
 * Async feedback enrichment — ideal_answers + drill_recommendations at FULL
 * quality (reasoningEffort 'high'), off the request path.
 *
 * Founder ruling 2026-07-17: enrichment is authored teaching content the
 * user reads in the learning/drills experience — its generation time is
 * free, so it never again trades quality against request latency. This job
 * replaces BOTH prior generators:
 *   - the inline batch call in /api/generate-feedback (was raced against a
 *     caller timeout — the 2026-07-11→17 outage class), and
 *   - the drill-page JIT backfill (6s user-blocking call, same outage).
 * New interviews enqueue with reason 'post-feedback'; historical sessions
 * with missing/partial coverage enqueue on drill-page demand with reason
 * 'drill-backfill'. One engine, one quality bar.
 *
 * Long-interview envelope (explicit requirement: 20/30-minute interviews
 * must not break): the LLM budget and prompt caps are sized for the
 * 10-weak-question worst case in feedbackEnrichment.ts, and there is no
 * caller-side race anywhere in this path — each step runs in its own
 * Inngest invocation with retries, so a 90s generation on a 30-minute
 * session is normal operation, not a timeout.
 *
 * Shape mirrors pathwayJob (pure handler + step runner for tests, minimal
 * event payload per Codex P2 #379, explicit onFailure status write).
 */

interface EnrichJobStepRunner {
  run: <T>(name: string, fn: () => Promise<T> | T) => Promise<T>
}

export interface EnrichFeedbackJobEventData {
  sessionId: string
  userId: string
  reason: 'post-feedback' | 'drill-backfill'
  /** drill-backfill: guarantee this question is in the generated set. */
  questionIndex?: number
}

/** Field names on InterviewSession tracking enrichment lifecycle. */
const STATUS_FIELDS = {
  status: 'enrichmentStatus',
  error: 'enrichmentError',
  completedAt: 'enrichmentCompletedAt',
} as const

export async function runEnrichFeedbackJobHandler(
  event: { data: EnrichFeedbackJobEventData },
  step: EnrichJobStepRunner,
): Promise<{ sessionId: string; status: 'completed' | 'skipped'; idealAnswers?: number }> {
  const { sessionId, userId, reason, questionIndex } = event.data

  await step.run('mark-running', async () => {
    await connectDB()
    await InterviewSession.findByIdAndUpdate(sessionId, {
      $set: { [STATUS_FIELDS.status]: 'running' },
    })
  })

  // Minimal event payload discipline: re-read the heavy data here. By the
  // time Inngest delivers (typically <2s), generate-feedback's awaited
  // persist has landed; if evaluations are genuinely absent, throw so
  // Inngest retries (mirrors pathwayJob's race note).
  const sessionData = await step.run('fetch-session', async () => {
    await connectDB()
    const doc = await InterviewSession.findOne({ _id: sessionId })
      .select('config evaluations userId feedback.ideal_answers')
      .lean<{
        config?: { role?: string; interviewType?: string }
        evaluations?: EnrichmentEvaluation[]
        userId?: unknown
        feedback?: { ideal_answers?: Array<Record<string, unknown>> }
      }>()
    if (!doc) {
      throw new Error(`enrichFeedbackJob: session ${sessionId} not found`)
    }
    if (String(doc.userId) !== String(userId)) {
      throw new Error(`enrichFeedbackJob: session ${sessionId} user mismatch`)
    }
    if (!Array.isArray(doc.evaluations) || doc.evaluations.length === 0) {
      throw new Error(`enrichFeedbackJob: session ${sessionId} has no evaluations`)
    }
    return {
      evaluations: doc.evaluations,
      role: doc.config?.role ?? 'general',
      interviewType: doc.config?.interviewType ?? 'screening',
      existingIdealAnswers: doc.feedback?.ideal_answers ?? [],
    }
  })

  const { enrichment, durationMs } = await step.run('run-enrichment', async () => {
    const startedAt = Date.now()
    const result = await runFeedbackEnrichment({
      evaluations: sessionData.evaluations,
      domainLabel: getDomainLabel(sessionData.role),
      interviewType: sessionData.interviewType,
      // Codex P2 (#552): the drilled question must be in the set even when
      // it ranks outside the weakest-10 cap on long sessions.
      mustIncludeQuestionIndex: questionIndex,
    })
    const elapsed = Date.now() - startedAt
    aiLogger.info(
      {
        sessionId,
        reason,
        durationMs: elapsed,
        idealAnswers: result?.ideal_answers.length ?? 0,
        drills: result?.drill_recommendations.length ?? 0,
        outputTokens: result?.usage.outputTokens ?? 0,
      },
      'enrichFeedbackJob: enrichment generation complete',
    )
    return { enrichment: result, durationMs: elapsed }
  })

  await step.run('persist-enrichment', async () => {
    await connectDB()
    const setFields: Record<string, unknown> = {
      [STATUS_FIELDS.status]: 'succeeded',
      [STATUS_FIELDS.completedAt]: new Date(),
    }
    if (enrichment) {
      // Union-merge by questionIndex (new entries win): a wholesale $set
      // would let a later drill-backfill run DROP entries a previous run
      // generated for other questions (latent under Codex P2 on #552).
      const newByIndex = new Map(
        enrichment.ideal_answers.map((a) => [Number(a.questionIndex ?? -1), a]),
      )
      const preserved = sessionData.existingIdealAnswers.filter(
        (a) => !newByIndex.has(Number(a.questionIndex ?? -1)),
      )
      const merged = [...preserved, ...enrichment.ideal_answers].sort(
        (a, b) => Number(a.questionIndex ?? 0) - Number(b.questionIndex ?? 0),
      )
      setFields['feedback.ideal_answers'] = merged
      if (enrichment.drill_recommendations.length > 0) {
        setFields['feedback.drill_recommendations'] = enrichment.drill_recommendations
      }
    }
    await InterviewSession.findByIdAndUpdate(sessionId, { $set: setFields })
  })

  if (enrichment) {
    // Usage accounting moved here from the route's api_call_feedback fold-in
    // (Codex P2 #349): enrichment still bills under 'api_call_feedback' (same
    // analytics bucket as always) but as its own record now.
    // buildUsageRecordData reads only user.id + user.organizationId — the
    // narrow cast is deliberate; the job has no AuthUser session context.
    await step.run('track-usage', async () => {
      await trackUsage({
        user: { id: userId } as AuthUser,
        type: 'api_call_feedback',
        sessionId,
        inputTokens: enrichment.usage.inputTokens,
        outputTokens: enrichment.usage.outputTokens,
        modelUsed: enrichment.model,
        durationMs,
        success: true,
      }).catch(() => {})
      // Codex P2 (#552): with a sessionId, trackUsage takes the Redis
      // usage-buffer path, whose only other flusher (the completion PATCH)
      // has already fired before this job runs — without this flush the
      // record would sit in Redis until TTL and vanish from analytics.
      await flushUsageBuffer(sessionId).catch(() => {})
    })
  }

  return {
    sessionId,
    status: enrichment ? 'completed' : 'skipped',
    ...(enrichment ? { idealAnswers: enrichment.ideal_answers.length } : {}),
  }
}

/** Defensive onFailure writer — mirrors pathwayJob.markFailed. */
async function markFailed(sessionId: string, message: string): Promise<void> {
  try {
    await connectDB()
    await InterviewSession.findByIdAndUpdate(sessionId, {
      $set: {
        [STATUS_FIELDS.status]: 'failed',
        [STATUS_FIELDS.error]: message.slice(0, 500),
      },
    })
  } catch (dbErr) {
    aiLogger.error(
      { err: dbErr, sessionId },
      'enrichFeedbackJob.markFailed: failed to write failure status to session',
    )
  }
}

export const enrichFeedbackJob = inngest.createFunction(
  {
    id: 'feedback-enrich',
    name: 'Generate feedback enrichment (ideal answers + drills)',
    retries: 2, // total attempts: 3
    triggers: [{ event: 'feedback/enrich.requested' }],
    onFailure: async ({ event, error }) => {
      const originalEvent = (event.data as { event?: { data?: EnrichFeedbackJobEventData } }).event
      const sessionId = originalEvent?.data?.sessionId
      if (!sessionId) {
        aiLogger.error({ err: error }, 'enrichFeedbackJob onFailure: missing sessionId in event payload')
        return
      }
      aiLogger.error(
        { err: error, sessionId },
        'enrichFeedbackJob failed after retries — marking enrichmentStatus=failed',
      )
      await markFailed(sessionId, error.message || 'Feedback enrichment failed after 3 attempts')
    },
  },
  async ({ event, step }) =>
    runEnrichFeedbackJobHandler(
      event as unknown as { data: EnrichFeedbackJobEventData },
      step as unknown as EnrichJobStepRunner,
    ),
)

export const ENRICHMENT_STATUS_FIELDS = STATUS_FIELDS
