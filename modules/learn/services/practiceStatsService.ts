/**
 * Practice-stats update service (Work Item G.14).
 *
 * Pulled out of app/api/learn/stats/route.ts so the same logic can
 * run from two places:
 *   1. POST /api/learn/stats — the legacy fire-and-forget call from
 *      useInterview.ts:862 that awards XP based on the ad-hoc mean
 *      of evaluationsRef BEFORE feedback generation. When the
 *      xp_from_feedback flag is ON, the endpoint no-ops and defers
 *      to path (2).
 *   2. POST /api/generate-feedback — awards XP server-side from the
 *      canonical feedback.overall_score after G.8 blend / G.9 AQ
 *      aggregation / G.10 completion multiplier have all been
 *      applied. When the flag is ON, this is the authoritative
 *      write and the numbers users see on their feedback page
 *      match the numbers they see on the /learn dashboard.
 *
 * Pure-enough: touches Mongo, never throws (errors are logged and
 * swallowed), no network I/O, no side effects outside the User
 * document.
 */

import mongoose from 'mongoose'
import { connectDB } from '@shared/db/connection'
import { User } from '@shared/db/models'
import { logger } from '@shared/logger'
import type { AnswerEvaluation } from '@shared/types'

export interface UpdatePracticeStatsInput {
  userId: string
  domain: string
  interviewType: string
  /** Clamped integer 0-100. Typically feedback.overall_score when
   *  called from generate-feedback (flag ON), or the ad-hoc
   *  evaluationsRef mean when called from /api/learn/stats (flag OFF). */
  score: number
  strongDimensions?: string[]
  weakDimensions?: string[]
}

export interface UpdatePracticeStatsResult {
  /** True when the User doc was updated. False on any failure or
   *  if the user wasn't found. */
  updated: boolean
  /** The resolved key used on user.practiceStats (`${domain}:${type}`). */
  key: string
  /** Post-write totalSessions for this key. Undefined on failure. */
  totalSessions?: number
  /** Post-write running avgScore for this key. Undefined on failure. */
  avgScore?: number
}

/**
 * Update user.practiceStats[`${domain}:${interviewType}`] with a new
 * score. Running avg recomputed incrementally. Writes `lastScore`
 * and `lastPracticedAt` to the same record.
 *
 * Never throws — errors are logged via @shared/logger and a
 * `{updated: false}` result is returned. Callers are expected to
 * fire-and-forget (both call sites ignore the promise today).
 */
export async function updatePracticeStats(
  input: UpdatePracticeStatsInput,
): Promise<UpdatePracticeStatsResult> {
  const {
    userId, domain, interviewType,
    score, strongDimensions, weakDimensions,
  } = input
  const key = `${domain}:${interviewType}`

  // Clamp score into the valid 0-100 range so a bad upstream value
  // doesn't poison the running average.
  const clamped = Math.max(0, Math.min(100, Math.round(Number(score) || 0)))

  try {
    await connectDB()
    const user = await User.findById(userId).select('practiceStats').lean()
    if (!user) {
      logger.warn({ userId }, 'updatePracticeStats: user not found')
      return { updated: false, key }
    }

    const existing = user.practiceStats?.get?.(key)
      || (user.practiceStats as unknown as Record<string, unknown>)?.[key]
    const prev = existing as { totalSessions?: number; avgScore?: number } | undefined

    const totalSessions = (prev?.totalSessions || 0) + 1
    const avgScore = prev?.avgScore
      ? Math.round(((prev.avgScore * (totalSessions - 1)) + clamped) / totalSessions)
      : clamped

    await User.findByIdAndUpdate(userId, {
      $set: {
        [`practiceStats.${key}`]: {
          totalSessions,
          avgScore,
          lastScore: clamped,
          lastPracticedAt: new Date(),
          strongDimensions: strongDimensions || [],
          weakDimensions: weakDimensions || [],
        },
      },
    })

    return { updated: true, key, totalSessions, avgScore }
  } catch (err) {
    logger.error({ err, userId, domain, interviewType }, 'updatePracticeStats failed')
    return { updated: false, key }
  }
}

// Dimension helpers — used when the caller wants to derive strong/weak
// from a per-question evaluation array rather than computing in-place.
// Keeps both call sites (legacy /api/learn/stats and new
// /api/generate-feedback) consistent in how they slice dimensions.

const RUBRIC_DIMS = ['relevance', 'structure', 'specificity', 'ownership'] as const

export function deriveStrongWeakDimensions(
  evaluations: AnswerEvaluation[],
): { strongDimensions: string[]; weakDimensions: string[] } {
  const realEvals = evaluations.filter((e) => e.status !== 'failed')
  if (!realEvals.length) {
    return { strongDimensions: [], weakDimensions: [] }
  }
  const dimAvgs = RUBRIC_DIMS.map((d) => ({
    name: d,
    avg: realEvals.reduce((s, e) => s + (Number(e[d]) || 0), 0) / realEvals.length,
  }))
  const sorted = [...dimAvgs].sort((a, b) => b.avg - a.avg)
  return {
    strongDimensions: sorted.slice(0, 2).map((d) => d.name),
    weakDimensions: sorted.slice(-2).map((d) => d.name),
  }
}
