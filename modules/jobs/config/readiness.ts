/**
 * Readiness band computation (READINESS.md §2) — pure, zero LLM,
 * deterministic, client-safe (deep-importable). Called by the attribution
 * worker at evidence-write time; consumers read the denormalized snapshot,
 * never recompute per-request.
 *
 * Vocabulary rules (rulings #3/#4 + panel findings): bands never
 * percentages; "ready" vocabulary banned; copy verb is "practiced
 * against"; zero counted evidence = NO claims.
 */

export interface EvidenceRowLike {
  requirementId: string
  xrayHash: string
  strength: 'strong' | 'partial'
  answerScore: number
  scoringEpoch: string
  sessionId: string
}

export interface CurrentParseLike {
  xrayHash: string
  /** Ids of MUST-HAVE requirements only — the counting universe equals the
   *  denominator's universe (Codex #537). */
  mustHaveIds: string[]
}

export type ReadinessBand = 'none' | 'building' | 'practiced' | 'strong-evidence'

export interface ReadinessSnapshot {
  band: ReadinessBand
  sessions: number
  practicedCount: number
  mustHaveTotal: number
  /** 0–100; strength MULTIPLIES (partial 72 → 36) — panel R1. */
  quality: number
  /** Fraction of must-haves with ≥1 STRONG row (0–1). */
  strongCoverage: number
  xrayHash: string
  scoringEpoch: string
  at: Date
}

/** Row-level quality floor (R0): a row below this never counts at all. */
export const ANSWER_SCORE_FLOOR = 40
/** Small-N guard (R4): below this many must-haves the coverage prong is
 *  unreliable — bands cap at Practiced. */
export const SMALL_N_MUST_HAVES = 4

/** Exported so the attribution worker's best-row-per-requirement collapse
 *  (pre-insert dedup, Codex #538) uses the SAME rule as band math. */
export const STRENGTH_WEIGHT: Record<'strong' | 'partial', number> = { strong: 1.0, partial: 0.5 }

export function computeReadiness(
  rows: EvidenceRowLike[],
  parse: CurrentParseLike,
  currentEpoch: string,
  totalSessions: number,
  now = new Date()
): ReadinessSnapshot {
  const mustHaves = new Set(parse.mustHaveIds)
  // Counting predicate (§2): current hash, current epoch, above the row
  // floor, and inside the MUST-HAVE universe.
  const counted = rows.filter(
    (r) =>
      r.xrayHash === parse.xrayHash &&
      r.scoringEpoch === currentEpoch &&
      r.answerScore >= ANSWER_SCORE_FLOOR &&
      mustHaves.has(r.requirementId)
  )

  // Best row per requirement (repeat coverage never multi-counts — R28):
  // best = highest strengthWeight × answerScore.
  const bestByReq = new Map<string, EvidenceRowLike>()
  for (const r of counted) {
    const prev = bestByReq.get(r.requirementId)
    const score = STRENGTH_WEIGHT[r.strength] * r.answerScore
    if (!prev || score > STRENGTH_WEIGHT[prev.strength] * prev.answerScore) {
      bestByReq.set(r.requirementId, r)
    }
  }

  const practicedCount = bestByReq.size
  const mustHaveTotal = parse.mustHaveIds.length
  const quality =
    practicedCount === 0
      ? 0
      : Math.round(
          Array.from(bestByReq.values()).reduce(
            (sum, r) => sum + STRENGTH_WEIGHT[r.strength] * r.answerScore,
            0
          ) / practicedCount
        )
  const strongCount = Array.from(bestByReq.values()).filter((r) => r.strength === 'strong').length
  const strongCoverage = mustHaveTotal === 0 ? 0 : strongCount / mustHaveTotal
  const coverage = mustHaveTotal === 0 ? 0 : practicedCount / mustHaveTotal

  let band: ReadinessBand = counted.length === 0 ? 'none' : 'building'
  if (counted.length > 0 && totalSessions >= 3 && coverage >= 0.4 && quality >= 50) {
    band = 'practiced'
    if (coverage >= 0.7 && quality >= 70 && strongCoverage >= 0.4 && mustHaveTotal >= SMALL_N_MUST_HAVES) {
      band = 'strong-evidence'
    }
  }
  // Small-N guard: the cap applies to the TOP band only (Practiced stays
  // reachable — its criteria are session/quality-weighted enough).
  if (band === 'strong-evidence' && mustHaveTotal < SMALL_N_MUST_HAVES) band = 'practiced'

  return {
    band,
    sessions: totalSessions,
    practicedCount,
    mustHaveTotal,
    quality,
    strongCoverage: Math.round(strongCoverage * 100) / 100,
    xrayHash: parse.xrayHash,
    scoringEpoch: currentEpoch,
    at: now,
  }
}
