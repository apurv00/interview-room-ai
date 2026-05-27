import mongoose from 'mongoose'
import { connectDB } from '@shared/db/connection'
import { InterviewSession } from '@shared/db/models'
import { inngest } from '@shared/services/inngest'
import { isFeatureEnabled } from '@shared/featureFlags'
import { aiLogger } from '@shared/logger'
import type { AnswerEvaluation, FeedbackData, SpeechMetrics } from '@shared/types'
import { aggregateMetrics, communicationScore } from '@interview/config/speechMetrics'
import { computePerQAverage } from '@interview/services/eval/perQAggregation'
import { SHORT_FORM_MIN_ANSWERS } from '@interview/services/eval/completionAdjustment'

/**
 * Mongo filter matching pathway statuses where a fresh enqueue is safe.
 * Mirrors `RETRYABLE_STATUS_FILTER` in `app/api/learn/pathway/retry/route.ts`
 * so both entry points use the same CAS contract:
 *   - `failed` — previous job blew up; re-enqueue is the recovery path
 *   - missing / null — never attempted
 *
 * Explicitly excluded: `pending` / `running` (already in flight; second
 * enqueue would duplicate the Inngest event), `succeeded` (plan already
 * exists; re-enqueue burns LLM cost for no gain), `skipped` (feature was
 * off — won't be honored anyway).
 *
 * Codex P1 on PR #398: without this gate, the outer-catch in
 * `/api/generate-feedback` re-emitted `pathway/regenerate` on every
 * feedback retry during an upstream LLM outage, racing terminal status
 * writes between concurrent jobs and multiplying planner cost.
 */
const ENQUEUE_STATUS_FILTER = {
  $or: [
    { pathwayGenerationStatus: 'failed' },
    { pathwayGenerationStatus: { $exists: false } },
    { pathwayGenerationStatus: null },
  ],
}

/**
 * Build an in-memory FeedbackData snapshot for the pathway Inngest job
 * when `InterviewSession.feedback` was never persisted (outer-catch or
 * inner-degraded paths). NEVER write this object to `session.feedback` —
 * downstream dashboard/history readers must not see synthetic scores.
 */
export function synthesizeFeedbackForPathway(
  evaluations: AnswerEvaluation[],
  speechMetrics?: SpeechMetrics[] | null,
): FeedbackData | null {
  if (!Array.isArray(evaluations) || evaluations.length === 0) return null

  const aggMetrics = aggregateMetrics(speechMetrics ?? [])
  const commScore = communicationScore(aggMetrics)
  const roughScore = computePerQAverage(evaluations).average
  const fallbackEngScore = Math.round(roughScore * 0.9)
  const fallbackOverall = Math.round(roughScore * 0.4 + commScore * 0.3 + fallbackEngScore * 0.3)

  return {
    overall_score: fallbackOverall,
    pass_probability: fallbackOverall >= 75 ? 'High' : fallbackOverall >= 50 ? 'Medium' : 'Low',
    confidence_level: 'Low',
    dimensions: {
      answer_quality: {
        score: roughScore,
        strengths: [],
        weaknesses: ['Pathway synthesized from per-question scores — full feedback was not available'],
      },
      communication: {
        score: commScore,
        wpm: aggMetrics.wpm,
        filler_rate: aggMetrics.fillerRate,
        pause_score: aggMetrics.pauseScore,
        rambling_index: aggMetrics.ramblingIndex,
      },
      engagement_signals: {
        score: fallbackEngScore,
        engagement_score: fallbackEngScore,
        confidence_trend: 'stable',
        energy_consistency: 0.5,
        composure_under_pressure: Math.round(roughScore * 0.85),
      },
    },
    red_flags: ['Pathway plan built from approximate session scores — retry feedback for a full report'],
    top_3_improvements: [
      'Use the STAR framework explicitly for every behavioral question',
      'Include specific metrics and outcomes to strengthen specificity',
      'Reduce filler words — pause instead of using "um" or "like"',
    ],
  }
}

export function canEnqueuePathwayRegeneration(
  sessionId: string | undefined,
  evaluations: unknown[] | undefined,
  answeredCount?: number,
): sessionId is string {
  const count =
    typeof answeredCount === 'number' && answeredCount >= 0
      ? answeredCount
      : Array.isArray(evaluations)
        ? evaluations.length
        : 0
  return Boolean(
    sessionId &&
      isFeatureEnabled('pathway_planner') &&
      Array.isArray(evaluations) &&
      evaluations.length > 0 &&
      count >= SHORT_FORM_MIN_ANSWERS,
  )
}

/**
 * Enqueue background pathway regeneration for a completed session.
 * Shared by the healthy generate-feedback side-effect block and the
 * degraded/outer-catch recovery paths (2026-05-20 upstream fix).
 */
export async function enqueuePathwayRegeneration(
  sessionId: string,
  userId: string,
  opts?: { source?: string; useSynthesizedFeedback?: boolean },
): Promise<void> {
  await connectDB()
  const $set: Record<string, unknown> = {
    pathwayGenerationStatus: 'pending',
    pathwayGenerationUseSynthesizedFeedback: opts?.useSynthesizedFeedback === true,
  }

  // Atomic claim — combine the retryability check and the status flip into
  // a single findOneAndUpdate so concurrent callers can't both pass a
  // separate check and then both enqueue. If the doc isn't in a claimable
  // status (`pending` / `running` / `succeeded` / `skipped`), `claimed`
  // is null and we skip the Inngest send entirely.
  //
  // `userId` is in the filter as defense-in-depth (Vercel security review
  // on PR #400). Callers in /api/generate-feedback already validate
  // session ownership upstream, but enforcing it here too means a future
  // caller that forgets to validate can't accidentally enable cross-user
  // pathway writes. Matches the filter shape in /api/learn/pathway/retry.
  let claimed: unknown
  try {
    claimed = await InterviewSession.findOneAndUpdate(
      {
        _id: new mongoose.Types.ObjectId(sessionId),
        userId: new mongoose.Types.ObjectId(userId),
        ...ENQUEUE_STATUS_FILTER,
      },
      { $set, $unset: { pathwayGenerationError: 1 } },
      { returnDocument: 'after' },
    )
  } catch (err) {
    aiLogger.warn(
      { err, sessionId, userId, source: opts?.source ?? 'unknown' },
      'pathway/regenerate enqueue: status claim DB write failed',
    )
    throw err
  }

  if (!claimed) {
    aiLogger.info(
      { sessionId, userId, source: opts?.source ?? 'unknown' },
      'pathway/regenerate enqueue skipped — session already pending/running/succeeded/skipped',
    )
    return
  }

  try {
    await inngest.send({
      name: 'pathway/regenerate',
      data: { sessionId, userId },
    })
    aiLogger.info(
      { sessionId, userId, source: opts?.source ?? 'unknown' },
      'pathway/regenerate enqueued',
    )
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to enqueue pathway regeneration.'
    await InterviewSession.findByIdAndUpdate(sessionId, {
      $set: {
        pathwayGenerationStatus: 'failed',
        pathwayGenerationError: message.slice(0, 500),
      },
    }).catch(() => {})
    throw err
  }
}
