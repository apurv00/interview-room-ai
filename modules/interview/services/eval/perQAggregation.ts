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
 * Richer aggregate for Work Item G.9 — dimension-aware answer_quality.
 *
 * Pre-G.9, `answer_quality.score` was just the flat mean. That buries
 * the outlier signal: one 90-scoring answer in nine 55-scoring
 * answers reads as 58.5 — indistinguishable from a flat-mediocre
 * session. The weighted formula (0.4 mean + 0.3 top3Mean + 0.2 median
 * + 0.1 bottom3Mean) preserves both "best moment" and "worst moment"
 * signals so candidates can see WHERE their strengths and weaknesses
 * actually live, not just their session-wide average.
 */
export interface AnswerQualityAggregate extends PerQAverageResult {
  /** Median of per-question averages (rounded integer). */
  median: number
  /** Mean of the top-3 per-question scores (or all, if <3 usable rows). */
  top3Mean: number
  /** Mean of the bottom-3 per-question scores. */
  bottom3Mean: number
  /** G.9 weighted aggregate: 0.4*mean + 0.3*top3 + 0.2*median + 0.1*bottom3. */
  weighted: number
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
  const agg = computeAnswerQualityAggregate(evaluations)
  // Backward-compatible subset — pre-G.9 callers that only need the
  // flat mean don't need to know about median / top3 / weighted.
  return {
    average: agg.average,
    usedCount: agg.usedCount,
    skippedFailedCount: agg.skippedFailedCount,
  }
}

/**
 * Compute the full G.9 aggregate. Same row-filtering policy as
 * computePerQAverage (status='failed' excluded; status='truncated'
 * and 'ok' included).
 *
 * Pure and deterministic. Caller is responsible for selecting which
 * field (`average`, `weighted`, etc.) to expose based on feature
 * flag state — this helper never picks for the caller.
 */
export function computeAnswerQualityAggregate(
  evaluations: Array<Record<string, unknown>>,
): AnswerQualityAggregate {
  const dims = ['relevance', 'structure', 'specificity', 'ownership'] as const
  const perQ: number[] = []
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
    perQ.push(avg)
  }

  const count = perQ.length
  if (count === 0) {
    return {
      average: 0,
      usedCount: 0,
      skippedFailedCount: skippedFailed,
      median: 0,
      top3Mean: 0,
      bottom3Mean: 0,
      weighted: 0,
    }
  }

  const sum = perQ.reduce((a, b) => a + b, 0)
  const average = Math.round(sum / count)

  // Median — sort ascending, take middle (or mean of two middles for
  // even-length inputs). Doesn't mutate the caller's input order.
  const sorted = [...perQ].sort((a, b) => a - b)
  const mid = Math.floor(count / 2)
  const medianRaw = count % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2
  const median = Math.round(medianRaw)

  // Top-3 / bottom-3 means. When count < 3 the slice collapses to the
  // full sample, so top3Mean ≈ bottom3Mean ≈ average. That's
  // intentional — with a small sample, the weighted formula degenerates
  // toward the mean, which is the safe conservative default.
  const window = Math.min(3, count)
  const top3MeanRaw = sorted.slice(-window).reduce((a, b) => a + b, 0) / window
  const bottom3MeanRaw = sorted.slice(0, window).reduce((a, b) => a + b, 0) / window
  const top3Mean = Math.round(top3MeanRaw)
  const bottom3Mean = Math.round(bottom3MeanRaw)

  // G.9 weighted aggregate — see AnswerQualityAggregate doc comment.
  // Computed on the raw (pre-rounded) components so rounding error
  // doesn't compound; rounded once at the end.
  const weighted = Math.round(
    0.4 * (sum / count) +
    0.3 * top3MeanRaw +
    0.2 * medianRaw +
    0.1 * bottom3MeanRaw,
  )

  return {
    average,
    usedCount: count,
    skippedFailedCount: skippedFailed,
    median,
    top3Mean,
    bottom3Mean,
    weighted,
  }
}
