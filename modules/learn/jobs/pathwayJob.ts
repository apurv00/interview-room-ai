import mongoose from 'mongoose'
import { inngest } from '@shared/services/inngest'
import { aiLogger } from '@shared/logger'
import { connectDB } from '@shared/db/connection'
import { InterviewSession } from '@shared/db/models'
import { evaluateSession, type SessionEvaluationSummary } from '@interview'
import { generatePathwayPlan } from '@learn/services/pathwayPlanner'
import type { FeedbackData, AnswerEvaluation } from '@shared/types'

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

export interface PathwayJobEventData {
  sessionId: string
  userId: string
  domain: string
  interviewType: string
  experience: string
  feedback: FeedbackData
  typedEvaluations: AnswerEvaluation[]
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
  const { sessionId, userId, domain, interviewType, experience, feedback, typedEvaluations } = event.data

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

  // Step 2: evaluate session (pure, no LLM call; uses the per-question
  // evaluations passed in the event payload). Independently retryable.
  const sessionEval: SessionEvaluationSummary = await step.run('evaluate-session', async () =>
    evaluateSession({
      domain,
      interviewType,
      seniorityBand: experience,
      evaluations: typedEvaluations,
    }),
  )

  // Step 3: generate the actual plan. This is the LLM-heavy step;
  // wrapping it independently means a retry won't redo `evaluate-session`.
  const plan = await step.run('generate-plan', async () => {
    return await generatePathwayPlan({
      userId,
      sessionId,
      domain,
      interviewType,
      experience,
      feedback,
      sessionEvaluation: sessionEval,
    })
  })

  // Step 4: persist final status. If the planner returned null (feature
  // flag off, silent skip), mark 'skipped' instead of 'succeeded' so the
  // UI can distinguish "we tried and got nothing" from "we tried and
  // produced a plan".
  await step.run('mark-completed', async () => {
    await connectDB()
    await InterviewSession.findByIdAndUpdate(sessionId, {
      $set: {
        [STATUS_FIELDS.status]: plan ? 'succeeded' : 'skipped',
        [STATUS_FIELDS.completedAt]: new Date(),
        [STATUS_FIELDS.error]: undefined,
      },
      $unset: { [STATUS_FIELDS.error]: 1 },
    })
  })

  return {
    sessionId,
    status: plan ? 'completed' : 'skipped',
    pathwayId: plan?._id ? String(plan._id) : undefined,
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
