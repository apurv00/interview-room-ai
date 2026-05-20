import { connectDB } from '@shared/db/connection'
import { InterviewSession } from '@shared/db/models'
import { inngest } from '@shared/services/inngest'
import { isFeatureEnabled } from '@shared/featureFlags'
import { aiLogger } from '@shared/logger'
import type { AnswerEvaluation, FeedbackData, SpeechMetricsEntry } from '@shared/types'
import { aggregateMetrics, communicationScore } from '@interview/config/speechMetrics'
import { computePerQAverage } from '@interview/services/eval/perQAggregation'

/**
 * Build an in-memory FeedbackData snapshot for the pathway Inngest job
 * when `InterviewSession.feedback` was never persisted (outer-catch or
 * inner-degraded paths). NEVER write this object to `session.feedback` —
 * downstream dashboard/history readers must not see synthetic scores.
 */
export function synthesizeFeedbackForPathway(
  evaluations: AnswerEvaluation[],
  speechMetrics?: SpeechMetricsEntry[] | null,
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
): sessionId is string {
  return Boolean(
    sessionId &&
      isFeatureEnabled('pathway_planner') &&
      Array.isArray(evaluations) &&
      evaluations.length > 0,
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
  opts?: { source?: string },
): Promise<void> {
  await connectDB()
  await InterviewSession.findByIdAndUpdate(sessionId, {
    $set: { pathwayGenerationStatus: 'pending' },
  })
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
