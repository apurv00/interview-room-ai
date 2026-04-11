import mongoose from 'mongoose'
import { connectDB } from '@shared/db/connection'
import { SessionSummary } from '@shared/db/models'
import { isFeatureEnabled } from '@shared/featureFlags'
import { aiLogger as logger } from '@shared/logger'

export interface DimensionDelta {
  dimension: string
  label: string
  current: number
  previous: number | null
  rollingAvg: number | null
  delta: number | null        // vs previous session
  deltaAvg: number | null     // vs 5-session rolling average
  direction: 'up' | 'down' | 'same' | 'new'
}

export interface ComparisonResult {
  dimensions: DimensionDelta[]
  overallDelta: number | null
  overallDirection: 'up' | 'down' | 'same' | 'new'
  sessionsCompared: number
  sinceFirstDelta: number | null  // vs first-ever session
  /**
   * 'parent' — the `previous` column is the parent of a retake (first
   *            attempt at this specific mock). Shown when the current
   *            session has a `parentSessionId` set.
   * 'history' — the `previous` column is whichever session happened
   *             chronologically before this one, regardless of config.
   */
  comparisonMode: 'parent' | 'history'
}

const DIMENSION_MAP: { key: string; label: string }[] = [
  { key: 'relevance', label: 'Relevance' },
  { key: 'structure', label: 'Structure' },
  { key: 'specificity', label: 'Specificity' },
  { key: 'ownership', label: 'Ownership' },
]

function direction(delta: number | null): 'up' | 'down' | 'same' | 'new' {
  if (delta === null) return 'new'
  if (delta > 2) return 'up'
  if (delta < -2) return 'down'
  return 'same'
}

/**
 * Compute comparative feedback: diff current session scores against
 * previous session, 5-session rolling average, and first-ever session.
 *
 * When `parentSessionId` is provided, the `previous` column is populated
 * from exactly that session's summary instead of the chronologically
 * previous one — this powers "vs your first attempt" messaging on the
 * retake feedback page. The rolling-average view is preserved as a
 * secondary signal.
 */
export async function computeComparison(
  userId: string,
  currentScores: Record<string, number>,
  currentOverall: number,
  domain?: string,
  parentSessionId?: string,
): Promise<ComparisonResult> {
  if (!isFeatureEnabled('session_summaries')) {
    return { dimensions: [], overallDelta: null, overallDirection: 'new', sessionsCompared: 0, sinceFirstDelta: null, comparisonMode: 'history' }
  }

  try {
    await connectDB()

    const filter: Record<string, unknown> = { userId: new mongoose.Types.ObjectId(userId) }
    if (domain) filter.domain = domain

    // Fetch last 6 sessions (current is not yet saved, so these are all previous)
    const summaries = await SessionSummary.find(filter)
      .sort({ sessionDate: -1 })
      .limit(6)
      .select('overallScore competencyScores sessionDate')
      .lean()

    // Resolve the "previous" anchor. Retake mode prefers the explicit parent
    // summary so the delta compares against the exact first attempt rather
    // than whichever session ran most recently.
    let parentSummary: Pick<NonNullable<typeof summaries[number]>, 'overallScore' | 'competencyScores'> | null = null
    if (parentSessionId && mongoose.Types.ObjectId.isValid(parentSessionId)) {
      parentSummary = await SessionSummary.findOne({
        userId: new mongoose.Types.ObjectId(userId),
        sessionId: new mongoose.Types.ObjectId(parentSessionId),
      })
        .select('overallScore competencyScores')
        .lean() as typeof parentSummary
    }
    const comparisonMode: 'parent' | 'history' = parentSummary ? 'parent' : 'history'

    if (summaries.length === 0 && !parentSummary) {
      return {
        dimensions: DIMENSION_MAP.map(d => ({
          dimension: d.key,
          label: d.label,
          current: currentScores[d.key] ?? 0,
          previous: null,
          rollingAvg: null,
          delta: null,
          deltaAvg: null,
          direction: 'new' as const,
        })),
        overallDelta: null,
        overallDirection: 'new',
        sessionsCompared: 0,
        sinceFirstDelta: null,
        comparisonMode,
      }
    }

    // In parent mode the `previous` column comes from the parent row;
    // otherwise it's the chronologically previous session summary.
    const previousSession = parentSummary || summaries[0]
    const last5 = summaries.slice(0, 5)

    // Get first-ever session
    const firstSession = await SessionSummary.findOne(filter)
      .sort({ sessionDate: 1 })
      .select('overallScore competencyScores')
      .lean()

    const dimensions: DimensionDelta[] = DIMENSION_MAP.map(d => {
      const current = currentScores[d.key] ?? 0
      const prev = (previousSession.competencyScores as Record<string, number>)?.[d.key] ?? null
      const avgValues = last5
        .map(s => (s.competencyScores as Record<string, number>)?.[d.key])
        .filter((v): v is number => v != null)
      const rollingAvg = avgValues.length > 0
        ? Math.round(avgValues.reduce((a, b) => a + b, 0) / avgValues.length)
        : null

      const delta = prev !== null ? current - prev : null
      const deltaAvg = rollingAvg !== null ? current - rollingAvg : null

      return {
        dimension: d.key,
        label: d.label,
        current,
        previous: prev,
        rollingAvg,
        delta,
        deltaAvg,
        direction: direction(delta),
      }
    })

    const overallDelta = previousSession.overallScore != null
      ? currentOverall - previousSession.overallScore
      : null

    const sinceFirstDelta = firstSession?.overallScore != null && summaries.length >= 2
      ? currentOverall - firstSession.overallScore
      : null

    return {
      dimensions,
      overallDelta,
      overallDirection: direction(overallDelta),
      sessionsCompared: summaries.length,
      sinceFirstDelta,
      comparisonMode,
    }
  } catch (err) {
    logger.error({ err }, 'Failed to compute comparison')
    return { dimensions: [], overallDelta: null, overallDirection: 'new', sessionsCompared: 0, sinceFirstDelta: null, comparisonMode: 'history' }
  }
}
