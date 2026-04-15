/**
 * Overall-score blending (Work Item G.8).
 *
 * Problem: `app/api/generate-feedback/route.ts:505` computes
 * `overall_score = aq*0.4 + comm*0.3 + eng*0.3` — a fixed linear
 * formula over dimension means — and discards Claude's holistic
 * `overall_score`. Since `aq` itself is a mean-of-means (over 4
 * dimensions × N questions), most sessions compress into a 55–75
 * band. Users consistently complain that "scores all feel the same";
 * this is the single largest mechanical cause.
 *
 * Fix: BLEND Claude's value back in. Claude can see the transcript,
 * the speech patterns, the resume, the JD — signal the formula
 * doesn't reach. But Claude's holistic judgement is also noisy, so
 * we defend against hallucinated extremes by:
 *
 *   1. Clamping Claude's value to [0, 100].
 *   2. Computing a weighted average — default 0.6 Claude / 0.4
 *      formula. Tunable via env vars / CMS.
 *   3. If Claude disagrees with the formula by more than
 *      `disagreementThreshold` (default 20 points), flip the weights
 *      to favour the formula (0.3 Claude / 0.7 formula). This is the
 *      "safety clamp" — it lets Claude spread the distribution back
 *      out while preventing a wildly-wrong single LLM response from
 *      awarding 92 when the formula says 58.
 *
 * The helper is pure and never throws. Tests cover agreement-zone,
 * disagreement-zone, missing-Claude-value, and edge cases.
 *
 * Flag-gated: production consumers call this only when
 * `FEATURE_FLAG_SCORING_V2_OVERALL` is enabled. OFF reproduces the
 * pre-G.8 deterministic-only behavior byte-for-byte.
 */

/** Default weights for Phase 3 ramp. Tunable via CMS once G.8 lands. */
export const DEFAULT_BLEND_WEIGHTS: BlendWeights = {
  claudeWeight: 0.6,
  formulaWeight: 0.4,
  disagreementThreshold: 20,
  disagreementClaudeWeight: 0.3,
  disagreementFormulaWeight: 0.7,
}

export interface BlendWeights {
  /** Weight applied to Claude's value in the agreement zone. */
  claudeWeight: number
  /** Weight applied to the formula value in the agreement zone. */
  formulaWeight: number
  /** Points delta above which the safety clamp engages. */
  disagreementThreshold: number
  /** Weight applied to Claude's value in the disagreement zone. */
  disagreementClaudeWeight: number
  /** Weight applied to the formula value in the disagreement zone. */
  disagreementFormulaWeight: number
}

export interface BlendResult {
  /** Final user-facing overall_score, integer 0–100. */
  blended: number
  /**
   * 'agreement' | 'disagreement' | 'formula-only'
   *   - agreement: |Δ| ≤ threshold → default weights used.
   *   - disagreement: |Δ| > threshold → safety-clamp weights used.
   *   - formula-only: Claude value absent → formula returned as-is.
   */
  mode: 'agreement' | 'disagreement' | 'formula-only'
  /** Clamped Claude value used in the computation (undefined if absent). */
  claudeClamped?: number
  /** Integer delta (Claude − formula) when both present. */
  delta?: number
}

/** Clamp x into [lo, hi]. Returns NaN → undefined semantics handled by caller. */
function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x))
}

/**
 * Compute the blended overall_score. Deterministic and pure.
 *
 * When `claudeOverall` is null/undefined/non-finite, returns the
 * formula value unchanged (mode='formula-only'). This is the
 * fallback path for rows where Claude didn't emit a numeric
 * overall_score.
 */
export function computeBlendedOverallScore(
  claudeOverall: number | null | undefined,
  formulaOverall: number,
  weights: BlendWeights = DEFAULT_BLEND_WEIGHTS,
): BlendResult {
  // Formula is authoritative — never let it go out of range.
  const formula = Math.round(clamp(formulaOverall, 0, 100))

  // Missing or non-numeric Claude value → fall back to formula.
  if (claudeOverall == null || !Number.isFinite(claudeOverall)) {
    return { blended: formula, mode: 'formula-only' }
  }

  const claude = Math.round(clamp(claudeOverall, 0, 100))
  const delta = claude - formula
  const absDelta = Math.abs(delta)

  const { disagreementThreshold } = weights
  const inDisagreementZone = absDelta > disagreementThreshold

  const { claudeWeight, formulaWeight } = inDisagreementZone
    ? {
        claudeWeight: weights.disagreementClaudeWeight,
        formulaWeight: weights.disagreementFormulaWeight,
      }
    : {
        claudeWeight: weights.claudeWeight,
        formulaWeight: weights.formulaWeight,
      }

  const blended = Math.round(
    clamp(claudeWeight * claude + formulaWeight * formula, 0, 100),
  )

  return {
    blended,
    mode: inDisagreementZone ? 'disagreement' : 'agreement',
    claudeClamped: claude,
    delta,
  }
}

/**
 * Resolve blend weights from env-var overrides, falling back to
 * DEFAULT_BLEND_WEIGHTS. Env overrides let ops tune the blend
 * without a redeploy — useful during the Phase 3 ramp. Invalid
 * values fall back to defaults silently.
 *
 *   SCORING_V2_CLAUDE_WEIGHT            → claudeWeight
 *   SCORING_V2_FORMULA_WEIGHT           → formulaWeight
 *   SCORING_V2_DISAGREEMENT_THRESHOLD   → disagreementThreshold
 *   SCORING_V2_DISAGREE_CLAUDE_WEIGHT   → disagreementClaudeWeight
 *   SCORING_V2_DISAGREE_FORMULA_WEIGHT  → disagreementFormulaWeight
 */
export function resolveBlendWeights(): BlendWeights {
  const out: BlendWeights = { ...DEFAULT_BLEND_WEIGHTS }
  const envMap: Array<[keyof BlendWeights, string]> = [
    ['claudeWeight', 'SCORING_V2_CLAUDE_WEIGHT'],
    ['formulaWeight', 'SCORING_V2_FORMULA_WEIGHT'],
    ['disagreementThreshold', 'SCORING_V2_DISAGREEMENT_THRESHOLD'],
    ['disagreementClaudeWeight', 'SCORING_V2_DISAGREE_CLAUDE_WEIGHT'],
    ['disagreementFormulaWeight', 'SCORING_V2_DISAGREE_FORMULA_WEIGHT'],
  ]
  for (const [key, envKey] of envMap) {
    const raw = process.env[envKey]
    if (raw == null || raw === '') continue
    const num = Number(raw)
    if (Number.isFinite(num) && num >= 0) {
      out[key] = num
    }
  }
  return out
}
