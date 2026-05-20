import mongoose from 'mongoose'
import { inngest } from '@shared/services/inngest'
import { aiLogger } from '@shared/logger'
import { connectDB } from '@shared/db/connection'
import { InterviewSession } from '@shared/db/models'
import { isFeatureEnabled } from '@shared/featureFlags'
import { evaluateSession, type SessionEvaluationSummary } from '@interview'
import { generatePathwayPlan } from '@learn/services/pathwayPlanner'
import { synthesizeFeedbackForPathway } from '@learn/services/pathwayRegeneration'
import type { FeedbackData, AnswerEvaluation, SpeechMetrics } from '@shared/types'

/**
 * Pathway regeneration background job.
 *
 * Triggered by `/api/generate-feedback` via
 * `inngest.send({ name: 'pathway/regenerate', ... })` once the feedback
 * has been computed for a session. Replaces the previous fire-and-forget
 * `.then(generatePathwayPlan)` chain that was wrapped inside a tracked
 * side effect in the API route.
 *
 * Why the move:
 * The old chain ran inside the API request lifecycle as fire-and-forget.
 * When the LLM call inside `generatePathwayPlan` timed out, or
 * `evaluateSession()` rejected upstream, the chain died silently — no
 * retry, no surfaced error. The pathway page's `?fromFeedback=<sessionId>`
 * banner watched `PathwayPlan.generatedFromSessionId` for a match that
 * never came, and the "Your pathway update is catching up" banner hung
 * for days.
 *
 * Inngest gives us:
 *   - 3 attempts (retries: 2) with exponential backoff
 *   - explicit onFailure → write `pathwayGenerationStatus: 'failed'`
 *     so the UI has a recoverable state to render a retry CTA against
 *   - per-step checkpointing — if `generatePathwayPlan` succeeds but
 *     `evaluateSession` had to be retried twice, we don't redo the LLM
 *     call wastefully on the third attempt
 *
 * Mirrors the structure of `modules/interview/jobs/analysisJob.ts` so
 * the two background-job modules stay consistent.
 */

interface PathwayJobStepRunner {
  run: <T>(name: string, fn: () => Promise<T> | T) => Promise<T>
}

/**
 * Event payload — intentionally minimal (Codex P2 on PR #379 — flagged
 * by the user as effectively P0 because the failure mode is unrecoverable).
 *
 * The previous shape carried `domain`, `interviewType`, `experience`,
 * `feedback`, and `typedEvaluations` inline. For a long interview those
 * objects can run into tens of kilobytes (full question/answer text +
 * 4-dimension evaluations × N questions + the full FeedbackData with
 * its red flags + dimension breakdowns + ideal answers). Inngest events
 * have a hard size limit (512KB at the time of writing); if a session
 * exceeds it, every `inngest.send()` for that session fails forever,
 * the retry endpoint resends the SAME oversized payload, and
 * regeneration is permanently bricked for that user.
 *
 * Fix: send only the identifiers. The job re-fetches the heavy data
 * from Mongo as its first real step. Mirrors `analysisJob`'s shape
 * (`{sessionId, userId, startTime}`) so the two background-job
 * modules stay consistent.
 */
export interface PathwayJobEventData {
  sessionId: string
  userId: string
}

/** Field names on InterviewSession that track pathway-generation lifecycle. */
const STATUS_FIELDS = {
  status: 'pathwayGenerationStatus',
  error: 'pathwayGenerationError',
  startedAt: 'pathwayGenerationStartedAt',
  completedAt: 'pathwayGenerationCompletedAt',
  attempts: 'pathwayGenerationAttempts',
} as const

/**
 * Pure handler — exported separately from the Inngest wrapper so tests can
 * invoke it with a mocked step object.
 */
export async function runPathwayJobHandler(
  event: { data: PathwayJobEventData },
  step: PathwayJobStepRunner,
): Promise<{ sessionId: string; status: 'completed' | 'skipped'; pathwayId?: string }> {
  const { sessionId, userId } = event.data

  // Step 1: mark the session running + increment attempt counter. Inngest
  // retries call this handler from the top, so each attempt bumps the
  // counter — gives the operator a visible signal of "this session has
  // failed twice already" without having to read logs.
  await step.run('mark-running', async () => {
    await connectDB()
    await InterviewSession.findByIdAndUpdate(sessionId, {
      $set: {
        [STATUS_FIELDS.status]: 'running',
        [STATUS_FIELDS.startedAt]: new Date(),
      },
      $inc: { [STATUS_FIELDS.attempts]: 1 },
    })
  })

  // Step 2: fetch the heavy session data from Mongo.
  //
  // Previously the event payload carried `config`, `feedback`, and
  // `typedEvaluations` inline; we now read them from the session
  // document here so the event stays small (Codex P2 on PR #379).
  //
  // Race note: generate-feedback's persist + pathway-enqueue side-
  // effects fire in parallel. By the time the Inngest worker picks
  // up the event (typically <2s), persist has completed (it's
  // awaited before the API returns — see route.ts:1230 comment).
  // If feedback is genuinely missing here (degenerate case: session
  // deleted, retake flow racing, etc.), throw so Inngest retries —
  // by the 2nd attempt persist will definitely have landed.
  const sessionData = await step.run('fetch-session', async () => {
    await connectDB()
    const doc = await InterviewSession.findOne({
      _id: sessionId,
      userId: new mongoose.Types.ObjectId(userId),
    })
      .select('config feedback evaluations speechMetrics')
      .lean<{
        config?: { role?: string; interviewType?: string; experience?: string }
        feedback?: FeedbackData
        evaluations?: AnswerEvaluation[]
        speechMetrics?: SpeechMetrics[]
      }>()
    if (!doc) {
      throw new Error(`pathwayJob: session ${sessionId} not found for user ${userId}`)
    }
    if (!doc.config?.role || !doc.config?.experience) {
      throw new Error(`pathwayJob: session ${sessionId} missing config.role/experience`)
    }
    if (!Array.isArray(doc.evaluations) || doc.evaluations.length === 0) {
      throw new Error(`pathwayJob: session ${sessionId} has no evaluations`)
    }
    // Upstream fix (2026-05-20): generate-feedback's outer-catch and inner-
    // degraded paths intentionally skip persisting `session.feedback` (P0
    // contract — synthetic scores must not leak to dashboard/history).
    // Evaluations ARE persisted at interview end, so synthesize an in-memory
    // feedback snapshot for the planner when the real one is absent.
    let feedback = doc.feedback
    if (!feedback || feedback.degraded) {
      const synthesized = synthesizeFeedbackForPathway(
        doc.evaluations,
        doc.speechMetrics,
      )
      if (!synthesized) {
        throw new Error(`pathwayJob: session ${sessionId} has no feedback yet — generate-feedback persist race`)
      }
      feedback = synthesized
    }
    return {
      domain: doc.config.role,
      // Match the primary feedback flow's default
      // (app/api/generate-feedback/route.ts:243) so the regenerated
      // plan uses the same evaluation assumptions as the original.
      interviewType: doc.config.interviewType || 'screening',
      experience: doc.config.experience,
      feedback,
      typedEvaluations: doc.evaluations,
    }
  })
  const { domain, interviewType, experience, feedback, typedEvaluations } = sessionData

  // Step 3: evaluate session (pure, no LLM call). Independently retryable.
  const sessionEval: SessionEvaluationSummary = await step.run('evaluate-session', async () =>
    evaluateSession({
      domain,
      interviewType,
      seniorityBand: experience,
      evaluations: typedEvaluations,
    }),
  )

  // Codex P1 on PR #379 — `generatePathwayPlan()` returns null for TWO
  // distinct reasons:
  //   (a) `isFeatureEnabled('pathway_planner') === false` — legitimate skip
  //   (b) an internal exception caught by its outer try/catch — REAL failure
  //
  // The previous code treated both as 'skipped', so a real failure (LLM
  // timeout, Mongo blip, schema validation drift) was silently turned into
  // a terminal success state. Inngest's onFailure never fired, the session
  // never reached 'failed', and the retry CTA never appeared.
  //
  // Fix: branch on the flag explicitly. When the flag is off → mark
  // 'skipped' and return. When the flag is on → a null return value can
  // only mean an internal failure, so throw and let Inngest retry +
  // onFailure write 'failed'.
  if (!isFeatureEnabled('pathway_planner')) {
    await step.run('mark-skipped', async () => {
      await connectDB()
      await InterviewSession.findByIdAndUpdate(sessionId, {
        $set: {
          [STATUS_FIELDS.status]: 'skipped',
          [STATUS_FIELDS.completedAt]: new Date(),
        },
        $unset: { [STATUS_FIELDS.error]: 1 },
      })
    })
    return { sessionId, status: 'skipped' }
  }

  // Step 3: generate the actual plan. This is the LLM-heavy step;
  // wrapping it independently means a retry won't redo `evaluate-session`.
  const plan = await step.run('generate-plan', async () => {
    const result = await generatePathwayPlan({
      userId,
      sessionId,
      domain,
      interviewType,
      experience,
      feedback,
      sessionEvaluation: sessionEval,
    })
    // Feature flag is ON (checked above) — null here means the planner's
    // internal try/catch swallowed an error. Re-raise so Inngest retries
    // and onFailure marks the session 'failed' for the retry CTA.
    if (!result) {
      throw new Error(
        'generatePathwayPlan returned null with pathway_planner flag enabled — internal planner failure',
      )
    }
    return result
  })

  // Step 4: persist final status. We're guaranteed `plan` is truthy here
  // because the flag-off case returned early above and the null-with-flag-
  // on case threw.
  //
  // Vercel review on PR #379 — `$set: { error: undefined }` is a no-op in
  // MongoDB (Mongo treats `undefined` as "field not specified"); only the
  // `$unset` actually clears the field. Drop the dead `$set` entry to
  // avoid misleading any future reader.
  await step.run('mark-completed', async () => {
    await connectDB()
    await InterviewSession.findByIdAndUpdate(sessionId, {
      $set: {
        [STATUS_FIELDS.status]: 'succeeded',
        [STATUS_FIELDS.completedAt]: new Date(),
      },
      $unset: { [STATUS_FIELDS.error]: 1 },
    })
  })

  return {
    sessionId,
    status: 'completed',
    pathwayId: plan._id ? String(plan._id) : undefined,
  }
}

/**
 * Defensive helper for the onFailure path — Inngest invokes it as a
 * separate function, so it can't rely on closures or step semantics.
 * Best-effort: if the DB write itself fails, we log and move on rather
 * than throw, because throwing here would trigger onFailure recursively
 * and obscure the original error in the logs.
 */
async function markFailed(sessionId: string, errorMessage: string): Promise<void> {
  try {
    await connectDB()
    await InterviewSession.findByIdAndUpdate(sessionId, {
      $set: {
        [STATUS_FIELDS.status]: 'failed',
        [STATUS_FIELDS.error]: errorMessage.slice(0, 500),
        [STATUS_FIELDS.completedAt]: new Date(),
      },
    })
  } catch (dbErr) {
    aiLogger.error(
      { err: dbErr, sessionId },
      'pathwayJob.markFailed: failed to write failure status to session — operator will need to inspect logs',
    )
  }
}

export const pathwayJob = inngest.createFunction(
  {
    id: 'pathway-regenerate',
    name: 'Regenerate pathway plan from feedback',
    retries: 2, // total attempts: 3
    triggers: [{ event: 'pathway/regenerate' }],
    onFailure: async ({ event, error }) => {
      // `event` here is the internal failure event; the original trigger
      // event lives at event.data.event.
      const originalEvent = (event.data as { event?: { data?: PathwayJobEventData } }).event
      const sessionId = originalEvent?.data?.sessionId
      if (!sessionId) {
        aiLogger.error({ err: error }, 'pathwayJob onFailure: missing sessionId in event payload')
        return
      }
      aiLogger.error(
        { err: error, sessionId },
        'pathwayJob failed after retries — marking session pathwayGenerationStatus=failed',
      )
      await markFailed(sessionId, error.message || 'Pathway generation failed after 3 attempts')
    },
  },
  async ({ event, step }) =>
    runPathwayJobHandler(
      event as unknown as { data: PathwayJobEventData },
      step as unknown as PathwayJobStepRunner,
    ),
)

// Re-export the field names so the API route + UI layers query the same
// names without each restating the string literals.
export const PATHWAY_STATUS_FIELDS = STATUS_FIELDS

// Eslint silence: mongoose import is used by the schema reference; keeping
// the import explicit so the file is self-contained when reading.
void mongoose
