/**
 * Score telemetry — Work Item G.1.
 *
 * Captures scoring decisions (Claude's raw overall_score vs the
 * deterministic formula) for offline analysis. Written from
 * `app/api/generate-feedback/route.ts` (and optionally
 * `app/api/evaluate-answer/route.ts` once G.1b lands).
 *
 * Design contract:
 *   1. Never throws. The call site is inside the happy path of
 *      feedback generation — a telemetry failure must not degrade
 *      the user-visible response.
 *   2. Never blocks. All persistence happens fire-and-forget through
 *      `.catch()` on the returned promise. Callers must not await.
 *   3. Flag-gated. `FEATURE_FLAG_SCORE_TELEMETRY=false` short-circuits
 *      before any work happens.
 *   4. Zero PII beyond foreign keys. Do not log transcript, answer, or
 *      profile content in this collection.
 */

import { connectDB } from '@shared/db/connection'
import { ScoreTelemetry } from '@shared/db/models'
import { isFeatureEnabled } from '@shared/featureFlags'
import { logger } from '@shared/logger'
import mongoose from 'mongoose'

/** Rolling retention window. Keep this aligned with the TTL index on
 *  the `expiresAt` field in `ScoreTelemetry.ts`. */
const TELEMETRY_TTL_DAYS = 30
const TELEMETRY_TTL_MS = TELEMETRY_TTL_DAYS * 24 * 60 * 60 * 1000

export interface ScoreDeltaInput {
  sessionId: string
  userId: string
  source: 'generate-feedback' | 'evaluate-answer'
  taskSlot: string
  modelUsed: string
  /** Raw value parsed from the LLM before any server-side override. */
  claudeOverallScore?: number | null
  /** Current deterministic value (post-override). */
  deterministicOverallScore?: number | null
  claudeDimensions?: Record<string, number>
  deterministicDimensions?: Record<string, number>
  evaluationCount?: number
  promptLength?: number
  inputTokens?: number
  outputTokens?: number
  truncated?: boolean
  recordReason?: 'ok' | 'claude-missing-overall' | 'parse-failed' | 'outer-catch'
}

/**
 * Persist one telemetry row. Returns a promise that resolves to the
 * saved row's _id (useful for tests) or `null` when telemetry is
 * disabled or an error prevented persistence.
 *
 * Call sites MUST NOT await this. Use `.catch(() => {})` so the event
 * loop never sees an unhandled rejection — internally we already
 * swallow errors, but the typing makes the fire-and-forget contract
 * explicit at the call site.
 */
export async function recordScoreDelta(input: ScoreDeltaInput): Promise<mongoose.Types.ObjectId | null> {
  if (!isFeatureEnabled('score_telemetry')) return null

  try {
    const claude = numberOrUndefined(input.claudeOverallScore)
    const det = numberOrUndefined(input.deterministicOverallScore)
    const delta =
      claude !== undefined && det !== undefined ? Math.round(claude - det) : undefined

    await connectDB()

    const doc = await ScoreTelemetry.create({
      sessionId: new mongoose.Types.ObjectId(input.sessionId),
      userId: new mongoose.Types.ObjectId(input.userId),
      source: input.source,
      taskSlot: input.taskSlot,
      modelUsed: input.modelUsed,
      claudeOverallScore: claude,
      deterministicOverallScore: det,
      deltaOverall: delta,
      claudeDimensions: input.claudeDimensions,
      deterministicDimensions: input.deterministicDimensions,
      evaluationCount: input.evaluationCount,
      promptLength: input.promptLength,
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      truncated: input.truncated,
      recordReason: input.recordReason ?? 'ok',
      expiresAt: new Date(Date.now() + TELEMETRY_TTL_MS),
    })

    // Structured ops log — mirrors what the DB now holds so the signal
    // is also available to log-based dashboards.
    logger.info(
      {
        scoreTelemetry: {
          source: input.source,
          taskSlot: input.taskSlot,
          modelUsed: input.modelUsed,
          claudeOverall: claude,
          deterministicOverall: det,
          deltaOverall: delta,
          evaluationCount: input.evaluationCount,
          promptLength: input.promptLength,
          truncated: input.truncated,
          recordReason: input.recordReason ?? 'ok',
        },
      },
      'score-telemetry recorded'
    )

    return doc._id
  } catch (err) {
    // Never throw. A telemetry failure is not a user-visible failure.
    logger.warn({ err, sessionId: input.sessionId }, 'recordScoreDelta failed')
    return null
  }
}

function numberOrUndefined(v: number | null | undefined): number | undefined {
  if (v === null || v === undefined) return undefined
  if (!Number.isFinite(v)) return undefined
  return v
}
