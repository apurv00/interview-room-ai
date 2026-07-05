/**
 * Deterministic per-answer coaching suggestion + domain-aware dimension labels.
 *
 * Replaces the old inline ternary (QuestionBreakdown / SourceFeedbackDrawer)
 * that keyed on `structure < 55` FIRST — so it emitted "use the STAR framework"
 * for almost every low-scoring answer, regardless of which dimension was
 * actually weakest and regardless of whether STAR even applies to the round.
 * Coding / system-design / academics rounds re-map the four score slots
 * (structure ← code_quality / architecture / conceptual_depth), so STAR advice
 * there is nonsensical — the academics rubric explicitly forbids rewarding STAR.
 *
 * This helper (1) selects the tip from the ACTUAL weakest dimension and
 * (2) tailors both the copy and the dimension's displayed meaning to the
 * interview family (behavioral / coding / system-design / academics).
 *
 * NOTE: an earlier version also surfaced the model's own `answerSummary` text
 * for coding/design rounds, but that field reuses a "Submitted <lang> solution
 * for <title>." fallback string when the evaluator returns no feedback, and a
 * real critique that opens the same way is structurally indistinguishable from
 * that fallback at this layer (Codex #496). Surfacing was dropped in favor of
 * the always-correct domain dimension copy; restoring it robustly would need a
 * source change (a dedicated feedback field on the evaluation).
 *
 * Pure + dependency-free (no imports) so both @feedback and @learn can share it
 * without a cross-module import — shared/** may not depend on any module.
 */

export type SuggestionFamily = 'behavioral' | 'coding' | 'system-design' | 'academics'

export interface SuggestionInput {
  relevance: number
  structure: number
  specificity: number
  ownership: number
  /** Present only when a JD was provided (behavioral JD-overlay rounds). */
  jdAlignment?: number | null
  /** LLM-declared weakest dimension; used only when it names one of the 4 slots. */
  primaryGap?: string
}

type BaseDim = 'relevance' | 'structure' | 'specificity' | 'ownership'
type Dim = BaseDim | 'jdAlignment'

/** Only nudge when there is real room to improve (matches the prior gate). */
const SUGGESTION_AVG_THRESHOLD = 60

/**
 * Map the dynamic `interviewType` slug to a suggestion family. The three
 * special rounds are identified by their exact slugs in useInterview
 * ('coding' → evaluate-code, 'system-design' → evaluate-design, 'academics' →
 * evaluate-answer with the viva rubric). Everything else (screening,
 * behavioral, technical, case_study, culture_fit, …) is behavioral-family,
 * where the four slots keep their literal meaning and STAR is a valid frame.
 */
/**
 * The depth an answer should be EVALUATED / LABELLED as — usually the interview's
 * own depth, but the academics viva has TWO warm-up turns that only name/scope the
 * subject, not probe a concept, so they are scored with the behavioral rubric:
 *   - questionIndex 0: the spoken intro ("which subject are you strongest in?").
 *   - questionIndex 1: the ease-in "roadmap" warm-up, before any real probing.
 * The first real viva probe (index ≥ 2) keeps the academics depth.
 *
 * Lives here (client-safe, dependency-free) so both the server eval path
 * (re-exported by @interview/services/eval/scoringGuide, consumed by the
 * evaluate-answer + turn-router routes) and the client feedback UI
 * (QuestionBreakdown) resolve the SAME rule with no barrel-drags-server-code
 * bundling problem and no duplication.
 */
export function resolveEvalDepthSlug(interviewType: string, questionIndex?: number): string {
  if (interviewType === 'academics' && (questionIndex === 0 || questionIndex === 1)) return 'behavioral'
  return interviewType
}

export function suggestionFamily(interviewType?: string): SuggestionFamily {
  switch ((interviewType ?? '').toLowerCase()) {
    case 'coding':
      return 'coding'
    case 'system-design':
      return 'system-design'
    case 'academics':
      return 'academics'
    default:
      return 'behavioral'
  }
}

/**
 * Per-family labels for the four score slots. For non-behavioral rounds the
 * generic slots hold re-mapped dimensions, so labelling them "Structure (STAR)"
 * everywhere was misleading. Mirrors the slot mapping in
 * code/designEvaluationToAnswerEvaluation (useInterview.ts) and the academics
 * viva rubric ordering (seed scoringDims).
 */
const DIMENSION_LABELS: Record<SuggestionFamily, Record<BaseDim, string>> = {
  behavioral: {
    relevance: 'Relevance',
    structure: 'Structure (STAR)',
    specificity: 'Specificity',
    ownership: 'Ownership',
  },
  coding: {
    relevance: 'Correctness',
    structure: 'Code Quality',
    specificity: 'Efficiency',
    ownership: 'Edge Cases',
  },
  'system-design': {
    relevance: 'Requirements',
    structure: 'Architecture',
    specificity: 'Scalability',
    ownership: 'Trade-offs',
  },
  academics: {
    relevance: 'Correctness',
    structure: 'Conceptual Depth',
    specificity: 'Derivation',
    ownership: 'Breadth',
  },
}

/** Domain-aware label for a score slot (e.g. "Structure (STAR)" vs "Architecture"). */
export function dimensionLabel(dim: BaseDim, interviewType?: string): string {
  return DIMENSION_LABELS[suggestionFamily(interviewType)][dim]
}

/** All four slot labels for a family, in slot order — for the score-breakdown bars. */
export function dimensionLabels(interviewType?: string): Record<BaseDim, string> {
  return DIMENSION_LABELS[suggestionFamily(interviewType)]
}

function weakestDimension(input: SuggestionInput): Dim {
  const dims: Array<{ key: Dim; score: number }> = [
    { key: 'relevance', score: input.relevance },
    { key: 'structure', score: input.structure },
    { key: 'specificity', score: input.specificity },
    { key: 'ownership', score: input.ownership },
  ]
  if (input.jdAlignment != null) dims.push({ key: 'jdAlignment', score: input.jdAlignment })

  // Trust the model's declared gap only when it names one of our slots (true for
  // behavioral evaluate-answer). For coding/design/academics `primaryGap` is a
  // domain alias ('technical_accuracy', 'system_design', …) that matches no
  // slot, so we fall through to the numeric argmin over the actual scores.
  const gap = input.primaryGap
  if (gap && dims.some((d) => d.key === gap)) return gap as Dim

  return dims.reduce((min, d) => (d.score < min.score ? d : min), dims[0]).key
}

const COPY: Record<SuggestionFamily, Record<Dim, string>> = {
  behavioral: {
    relevance: 'Focus on answering the specific question asked — keep your response targeted and on-topic.',
    structure: 'Try the STAR framework: describe the Situation, your Task, the Action you took, and the Result.',
    specificity: 'Add specific metrics, numbers, or concrete examples to make your answer land.',
    ownership: 'Use "I" instead of "we" and spell out your own contribution.',
    jdAlignment: 'Tie your answer back to the role — name the skills and outcomes the job description emphasizes.',
  },
  coding: {
    relevance: 'Make sure the solution fully satisfies the problem — walk through the required cases before finalizing.',
    structure: 'Tighten code quality: clearer names, smaller functions, and consistent structure make it easier to follow.',
    specificity: 'Consider time and space complexity — look for a more efficient algorithm or data structure.',
    ownership: 'Call out the edge cases (empty input, boundaries, overflow) and handle them explicitly.',
    jdAlignment: 'Connect your approach to the technical expectations in the role.',
  },
  'system-design': {
    relevance: 'Clarify the requirements and constraints first — scope the problem before you start designing.',
    structure: 'Strengthen the core architecture: define the components and how they interact end to end.',
    specificity: 'Address scalability — show how the design handles growth, load, and failure.',
    ownership: 'Make the trade-offs explicit — justify each choice against its alternatives.',
    jdAlignment: 'Connect the design to the scale and reliability the role expects.',
  },
  academics: {
    relevance: 'Recheck the core facts and definitions — accuracy is the foundation of a strong viva answer.',
    structure: 'Go deeper on the concept — explain the mechanism and the "why", not just the "what".',
    specificity: 'Show your working — derive the result step by step instead of stating the conclusion.',
    ownership: 'Connect the idea to related topics to show the breadth of your understanding.',
    jdAlignment: 'Relate the concept to its practical applications.',
  },
}

/**
 * Returns the coaching suggestion for a low-scoring answer, or null when the
 * answer scores well enough (rounded avg ≥ 60) that no nudge is warranted.
 *
 * @param input          the four dimension scores (+ optional jdAlignment / primaryGap)
 * @param interviewType  the session's interview-type slug (config.interviewType)
 */
export function answerSuggestion(input: SuggestionInput, interviewType?: string): string | null {
  const avg = Math.round((input.relevance + input.structure + input.specificity + input.ownership) / 4)
  if (avg >= SUGGESTION_AVG_THRESHOLD) return null

  return COPY[suggestionFamily(interviewType)][weakestDimension(input)]
}
