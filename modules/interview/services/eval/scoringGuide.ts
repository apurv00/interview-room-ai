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
 * The depth an answer should be EVALUATED as — usually the interview's own depth, but the
 * academics viva has TWO warm-up turns that only name/scope the subject, not probe a concept,
 * and so must not be scored on conceptual correctness / derivation (they would be marked
 * off-topic and drag the aggregate down):
 *   - questionIndex 0: the spoken intro, which asks "which subject are you strongest in?".
 *   - questionIndex 1: the ease-in warm-up slot, where the candidate maps the topics in that
 *     subject ("a roadmap") before any real probing.
 * Both are evaluated as `behavioral` (its dimensions, criteria, skill, and guide) — while still
 * producing an evaluation so the answered-question count stays accurate. The first real viva
 * probe (index ≥ 2, fundamentals) keeps the academics depth.
 */
export function resolveEvalDepthSlug(interviewType: string, questionIndex?: number): string {
  if (interviewType === 'academics' && (questionIndex === 0 || questionIndex === 1)) return 'behavioral'
  return interviewType
}
