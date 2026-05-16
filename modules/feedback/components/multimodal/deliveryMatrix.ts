/**
 * Delivery × Content matrix — pure data derivation.
 *
 * Round 5d feature #1. The headline insight of the Multimodal tab: a
 * per-question scatter of *what was said* (content score) against *how
 * it was delivered* (composite delivery score). Four quadrants name the
 * behavior pattern so the user can immediately tell knowing-and-showing
 * apart from bluffing-confidently — different remedies for different
 * problems.
 *
 * Why this lives in Multimodal: it's the only view in the page that
 * fuses the two signal families. Feedback talks about content scores
 * in isolation; Scores breaks them down further; this matrix is the
 * cross-axis. (Festinger's cognitive dissonance principle: humans
 * learn fastest from contradictions between expected vs. actual.)
 */

import type { AnswerEvaluation } from '@shared/types'
import type { ProsodySegment, FacialSegment } from '@shared/types/multimodal'

/** Facial aggregator's "no usable frames" sentinel. */
const FACIAL_SENTINEL = -1

/** Mid-line split — same threshold for both axes. */
const QUADRANT_THRESHOLD = 50

export type Quadrant =
  | 'nailed-it'           // HC + HD — knew it AND showed it
  | 'bluffed-confidently' // LC + HD — strong delivery, weak substance
  | 'knew-but-mumbled'    // HC + LD — strong substance, weak delivery
  | 'off-on-both'         // LC + LD — needs work on both

export interface MatrixPoint {
  questionIndex: number   // 0-based
  questionLabel: string   // "Q1", "Q2", …
  contentScore: number    // 0–100
  deliveryScore: number   // 0–100
  quadrant: Quadrant
}

export type ExclusionReason = 'no-facial-data' | 'no-content-score' | 'no-audio-data'

export interface ExcludedQuestion {
  questionIndex: number
  questionLabel: string
  reason: ExclusionReason
}

/** Display copy per exclusion reason. Single source of truth so the
 *  footnote and any future surface stay in sync. */
export const REASON_LABEL: Record<ExclusionReason, string> = {
  'no-facial-data': 'no facial signal',
  'no-content-score': 'no content score',
  'no-audio-data': 'no audio signal',
}

export interface MatrixData {
  points: MatrixPoint[]
  excluded: ExcludedQuestion[]
}

/**
 * Content score for one question. Mean of the four AnswerEvaluation
 * dimensions, matching what `OverviewTab.currentScores` already does
 * for the dimension radar. Returns null when the evaluation is missing
 * or any required field is non-finite (caller drops the dot).
 *
 * NOTE: failed evals carry status='failed' and 50/50/50/50 placeholder
 * scores from the client fallback. The caller is expected to have
 * filtered those out already (see how OverviewTab.evalData does it).
 * We don't double-filter here because the eval shape doesn't carry the
 * status field — the calling layer is the source of truth.
 */
export function contentScoreFromEvaluation(e: AnswerEvaluation | undefined): number | null {
  if (!e) return null
  const vals = [e.relevance, e.structure, e.specificity, e.ownership]
  if (!vals.every((v) => Number.isFinite(v))) return null
  return (vals[0] + vals[1] + vals[2] + vals[3]) / 4
}

/**
 * Audio confidence band → 0–100 component. Mirrors composureScore.ts.
 *  high → 100, medium → 50, low → 0. Returns null on missing.
 */
function audioComponent(marker: ProsodySegment['confidenceMarker'] | undefined): number | null {
  if (marker === 'high') return 100
  if (marker === 'medium') return 50
  if (marker === 'low') return 0
  return null
}

function validFacialComponent(value: number | undefined | null): number | null {
  if (value == null) return null
  if (!Number.isFinite(value)) return null
  if (value === FACIAL_SENTINEL) return null
  return Math.max(0, Math.min(100, value * 100)) // facial 0–1 → 0–100, clamped
}

/**
 * Mean of the valid facial signals in 0–100. Returns null when neither
 * eye contact nor head stability is usable (both sentinel/missing).
 * Extracted from `deliveryScoreForQuestion` so `buildMatrixData` can
 * separately detect missing-facial vs missing-audio for the exclusion
 * reason (Codex P2 review on Round 5d — previously the reason was
 * hardcoded to 'no-facial-data' even when the actual cause was missing
 * audio).
 */
function facialFraction(facial: FacialSegment | undefined): number | null {
  const eye = validFacialComponent(facial?.avgEyeContact)
  const stab = validFacialComponent(facial?.headStability)
  if (eye == null && stab == null) return null
  const parts: number[] = []
  if (eye != null) parts.push(eye)
  if (stab != null) parts.push(stab)
  return parts.reduce((s, v) => s + v, 0) / parts.length
}

/**
 * Composite delivery score for one question.
 *
 *   delivery = mean of (audio confidence, eye contact, head stability)
 *
 * Audio is the heaviest single contributor because it's the only signal
 * the candidate can fully control without a camera; if audio is missing
 * we return null (audio-less prosody segments are exceedingly rare —
 * essentially silence-only Qs, which won't have a meaningful matrix
 * position anyway).
 *
 * Returns null when facial data is missing (any sentinel/missing
 * eye-contact AND any sentinel/missing head-stability). Per the user's
 * Round 5d sign-off: drop the dot rather than fabricate a position from
 * audio alone — the matrix is supposed to fuse both channels, so
 * showing audio-only dots in the same view would erode the visual
 * contract.
 */
export function deliveryScoreForQuestion(
  prosody: ProsodySegment | undefined,
  facial: FacialSegment | undefined,
): number | null {
  const a = audioComponent(prosody?.confidenceMarker)
  if (a == null) return null
  const f = facialFraction(facial)
  if (f == null) return null
  // Weight audio + facial equally (1 + 1) so a strong audio signal can
  // still drag delivery up when facial is mid-range, and vice versa.
  return (a + f) / 2
}

export function quadrantOf(contentScore: number, deliveryScore: number): Quadrant {
  const highContent = contentScore >= QUADRANT_THRESHOLD
  const highDelivery = deliveryScore >= QUADRANT_THRESHOLD
  if (highContent && highDelivery) return 'nailed-it'
  if (!highContent && highDelivery) return 'bluffed-confidently'
  if (highContent && !highDelivery) return 'knew-but-mumbled'
  return 'off-on-both'
}

export interface QuestionMarker {
  label: string
  offsetSeconds: number
}

/**
 * Build the full matrix dataset from per-Q inputs. Aligns evaluations,
 * prosody and facial by `questionIndex` (preferred) or positional index
 * (fallback for older pipeline output). Excluded Qs are tagged with the
 * specific reason — Codex P2 review on Round 5d caught that the previous
 * pass hardcoded 'no-facial-data' even when the actual cause was missing
 * audio or content, so the footnote lied to the user when prosody data
 * was sparse (silence-only Qs, extraction failures, etc).
 *
 * Diagnosis order:
 *   1. no content score    → 'no-content-score'
 *   2. no audio confidence → 'no-audio-data'
 *   3. no facial signal    → 'no-facial-data'
 *   4. otherwise            → plot the point.
 */
/**
 * Index lookup that's strict when the data uses `questionIndex` and
 * positional only when it doesn't. Without this guard, a sparse array
 * like `[facial(Q0), facial(Q2)]` would return facial(Q2) for the i=1
 * lookup via positional fallback, silently mis-attributing Q2's
 * delivery score to Q1. Caught in the buildMatrixData test suite.
 */
function pickByQIndex<T extends { questionIndex?: number }>(
  arr: ReadonlyArray<T> | undefined,
  i: number,
): T | undefined {
  if (!arr || arr.length === 0) return undefined
  const usesIndex = arr.some((e) => e.questionIndex != null)
  if (usesIndex) return arr.find((e) => e.questionIndex === i)
  return arr[i]
}

export function buildMatrixData(args: {
  evaluations: ReadonlyArray<AnswerEvaluation> | undefined
  prosodySegments: ReadonlyArray<ProsodySegment> | undefined
  facialSegments: ReadonlyArray<FacialSegment> | undefined
  questions: ReadonlyArray<QuestionMarker>
}): MatrixData {
  const { evaluations, prosodySegments, facialSegments, questions } = args
  const points: MatrixPoint[] = []
  const excluded: ExcludedQuestion[] = []

  for (let i = 0; i < questions.length; i++) {
    const q = questions[i]

    // Resolve per-Q data — strict-by-questionIndex when the field is
    // used, positional only when it isn't (older pipeline output).
    const evalForQ = pickByQIndex(evaluations, i)
    const prosodyForQ = pickByQIndex(prosodySegments, i)
    const facialForQ = pickByQIndex(facialSegments, i)

    const content = contentScoreFromEvaluation(evalForQ)
    if (content == null) {
      excluded.push({ questionIndex: i, questionLabel: q.label, reason: 'no-content-score' })
      continue
    }
    // Diagnose audio + facial separately so the exclusion reason matches
    // the actual cause. Without this split, prosody-missing Qs would be
    // labeled 'no-facial-data' and the footnote would lie to the user.
    const audio = audioComponent(prosodyForQ?.confidenceMarker)
    if (audio == null) {
      excluded.push({ questionIndex: i, questionLabel: q.label, reason: 'no-audio-data' })
      continue
    }
    const facial = facialFraction(facialForQ)
    if (facial == null) {
      excluded.push({ questionIndex: i, questionLabel: q.label, reason: 'no-facial-data' })
      continue
    }
    const delivery = (audio + facial) / 2
    points.push({
      questionIndex: i,
      questionLabel: q.label,
      contentScore: content,
      deliveryScore: delivery,
      quadrant: quadrantOf(content, delivery),
    })
  }

  return { points, excluded }
}

/** Display-ready label per quadrant. User-confirmed copy in Round 5d. */
export const QUADRANT_LABEL: Record<Quadrant, string> = {
  'nailed-it': 'Nailed it',
  'bluffed-confidently': 'Bluffed confidently',
  'knew-but-mumbled': 'Knew but mumbled',
  'off-on-both': 'Off on both',
}

/**
 * Compose the per-Q exclusion footnote.
 *
 * Codex P3 review on Round 5d — the previous footnote called the bucket
 * "no facial signal" any time at least one excluded Q had that reason,
 * silently mis-labeling the others. New behavior:
 *
 *   single reason across all excluded Qs
 *     → "Q2 was excluded — no facial signal."
 *     → "Q1, Q3 were excluded — no audio signal."
 *
 *   mixed reasons → annotate each Q with its own reason
 *     → "Q1 (no facial signal), Q3 (no audio signal) were excluded."
 *
 * Returns '' when nothing was excluded so the caller can skip rendering.
 */
export function buildExclusionFootnote(excluded: ReadonlyArray<ExcludedQuestion>): string {
  if (excluded.length === 0) return ''

  // Stable order: keep insertion order (which matches questionIndex)
  // so the labels read left-to-right in the same order the matrix
  // would have shown the Qs.
  const reasons = new Set(excluded.map((e) => e.reason))
  const wasOrWere = excluded.length === 1 ? 'was' : 'were'

  if (reasons.size === 1) {
    const reason = excluded[0].reason
    const qs = excluded.map((e) => e.questionLabel).join(', ')
    return `${qs} ${wasOrWere} excluded — ${REASON_LABEL[reason]}.`
  }

  // Mixed reasons — annotate each Q so the user can see what each one lacks.
  const parts = excluded.map((e) => `${e.questionLabel} (${REASON_LABEL[e.reason]})`)
  return `${parts.join(', ')} ${wasOrWere} excluded.`
}
