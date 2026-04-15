/**
 * Per-question answer-quality aggregation (Work Items G.4 + G.5).
 *
 * Extracted from app/api/generate-feedback/route.ts because Next.js
 * App Router rejects non-route exports from `route.ts` files (must be
 * GET/POST/PUT/DELETE/etc. only). This module is the single source of
 * truth for how eval rows are averaged into `answer_quality.score`.
 *
 * G.4 policy:
 *   - `status: 'failed'` rows are EXCLUDED from the average. Those
 *     rows carry the 60/55/55/60 placeholder from
 *     evaluate-answer/route.ts so legacy clients don't crash, but the
 *     numbers are fabricated — averaging them in drags real scores
 *     toward a fake mid-range.
 *   - `status: 'truncated'` rows are INCLUDED (partial LLM output is
 *     best-effort real data, not a fabricated placeholder). G.3's
 *     confidence-level downgrade is the appropriate signal for
 *     truncation.
 *   - `status: 'ok'` / absent → counted as today.
 */

export interface PerQAverageResult {
  /** Rounded integer 0..100, or 0 when no rows were usable. */
  average: number
  /** Count of rows that actually contributed to the average. */
  usedCount: number
  /** Count of rows excluded because status === 'failed'. */
  skippedFailedCount: number
}

/**
 * Compute the per-question answer-quality average over `relevance`,
 * `structure`, `specificity`, and `ownership`. Missing dimensions are
 * treated as 0 (consistent with pre-G.5 behavior — a real zero score
 * is distinct from a missing dim only at the row-status level).
 *
 * Pure and deterministic. Safe to call from any context.
 */
export function computePerQAverage(
  evaluations: Array<Record<string, unknown>>,
): PerQAverageResult {
  const dims = ['relevance', 'structure', 'specificity', 'ownership'] as const
  let sum = 0
  let count = 0
  let skippedFailed = 0
  for (const e of evaluations) {
    const status = (e as { status?: string }).status
    if (status === 'failed') {
      skippedFailed++
      continue
    }
    const avg =
      dims.reduce((acc, d) => acc + (Number((e as Record<string, unknown>)[d]) || 0), 0) /
      dims.length
    sum += avg
    count++
  }
  return {
    average: count > 0 ? Math.round(sum / count) : 0,
    usedCount: count,
    skippedFailedCount: skippedFailed,
  }
}
