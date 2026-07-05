/**
 * Scoring-guide block for the evaluate-answer prompt.
 *
 * The DEFAULT guide is STAR / behavioral-anchored — the correct calibration for
 * behavioral, technical, case-study, system-design, and coding depths. The `academics`
 * depth is a SUBJECT VIVA, where STAR framing mis-anchors scoring (an academic answer is
 * an explanation / derivation, not a STAR story), so it gets a conceptual-understanding
 * guide instead. Kept as a pure, unit-tested helper so the hot-path evaluate-answer
 * route change stays a one-line swap.
 *
 * DEFAULT_SCORING_GUIDE is byte-for-byte the legacy inline string (G.11) — do not edit
 * it without re-checking the evaluate-answer calibration tests.
 */

export const DEFAULT_SCORING_GUIDE = `SCORING GUIDE — calibrate to the answer in front of you; do not anchor to the middle.
- 0–20  : Off-topic, fabricated, or a non-answer.
- 21–40 : Weak. Missing key elements, no specifics, no ownership.
- 41–60 : Adequate but generic. Lacks depth, structure, or concrete detail.
- 61–80 : Good. Clear structure, specific examples, visible personal contribution.
- 81–100: Excellent. STAR-structured, quantified outcomes, clear ownership, strong relevance.

Score distribution is expected to SPREAD across all five bands across a session — do not cluster answers in 55–75. 81–100 is reachable when 3 of 4 dimensions are excellent AND no dimension is below 60. An answer with STAR structure, quantified outcomes, clear ownership, and strong relevance should score 85–92 even if specificity is only "good." Reserve 0–20 for off-topic, fabricated, or non-answers.`

export const ACADEMIC_SCORING_GUIDE = `SCORING GUIDE — calibrate to the answer in front of you; do not anchor to the middle. This is an ACADEMIC SUBJECT VIVA: score conceptual understanding and first-principles reasoning, NOT STAR / behavioral structure.
- 0–20  : Off-topic, fabricated, or a fundamentally wrong concept stated confidently.
- 21–40 : Weak. Recites a definition with no understanding, or makes a major conceptual error.
- 41–60 : Adequate. Correct definition but thin reasoning — cannot derive or explain "why".
- 61–80 : Good. Correct fundamentals with sound first-principles reasoning and stated assumptions.
- 81–100: Excellent. Derives or explains the mechanism cleanly, handles the "why" and edge cases, connects an adjacent subject, and is honest about the limits of their knowledge.

Score distribution is expected to SPREAD across all five bands across a session — do not cluster answers in 55–75. 81–100 is reachable when the candidate reasons correctly from first principles AND no dimension is below 60. Reward intellectual honesty ("I'm not sure, but reasoning from first principles…") over confident wrong recall. Accept "I'd look up that exact constant or value" — test understanding, not memorization. Do NOT penalize a minor arithmetic slip if the method is sound. Reserve 0–20 for fabricated or fundamentally wrong concepts.`

/** Returns the scoring-guide block appropriate to the interview depth. */
export function buildScoringGuide(depthSlug: string): string {
  return depthSlug === 'academics' ? ACADEMIC_SCORING_GUIDE : DEFAULT_SCORING_GUIDE
}

/**
 * `resolveEvalDepthSlug` — the depth an answer should be EVALUATED as (academics
 * warm-ups Q0/Q1 are scored behavioral). The canonical implementation lives in
 * `shared/lib/answerSuggestion` so the client feedback UI can resolve the SAME
 * rule without importing this server-adjacent module (which would drag the
 * @interview barrel's server deps into the client bundle). Re-exported here so
 * the evaluate-answer + turn-router routes keep their existing import path.
 */
export { resolveEvalDepthSlug } from '@shared/lib/answerSuggestion'
