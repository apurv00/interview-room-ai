export type LessonComplexity = 'simple' | 'medium' | 'complex'

export interface LessonBudget {
  complexity: LessonComplexity
  maxTokens: number
}

// Production diagnosis (2026-05-17): every lesson on /learn/pathway
// was returning 502 because the model was generating valid JSON but
// running out of tokens mid-output (Vercel logs showed JSON.parse
// "Unexpected end of JSON input"). The schema asked for ~500-700
// tokens of content but the budget capped at 350 (medium) — every
// "medium" lesson and the default-budget cases were truncating.
//
// Budgets bumped to give the schema honest headroom:
//   - Complex: 800 (was 600) — long worked examples + framework
//   - Medium:  700 (was 350) — single concept + example, but the
//     example.goodAnswer alone is spec'd at 120-200 words ≈ 300 tokens
//   - Simple:  400 (was 200) — same shape, just less prose
//
// Even with these bumps, we still defend against truncation in
// `extractJsonObject` (lessonGenerator.ts) by attempting to repair
// JSON that starts well-formed but never closes — see the regex
// wrapper there. Belt + suspenders.
export const COMPETENCY_LESSON_BUDGETS: Record<string, LessonBudget> = {
  // Complex — needs worked examples, multi-step frameworks
  star_structure:       { complexity: 'complex', maxTokens: 800 },
  behavioral_stories:   { complexity: 'complex', maxTokens: 800 },
  situation_framing:    { complexity: 'complex', maxTokens: 800 },

  // Medium — one concept + example
  ownership:            { complexity: 'medium', maxTokens: 700 },
  jd_alignment:         { complexity: 'medium', maxTokens: 700 },
  specificity:          { complexity: 'medium', maxTokens: 700 },
  metrics_thinking:     { complexity: 'medium', maxTokens: 700 },
  stakeholder_mgmt:     { complexity: 'medium', maxTokens: 700 },
  problem_solving:      { complexity: 'medium', maxTokens: 700 },
  communication:        { complexity: 'medium', maxTokens: 700 },
  // Added in the same bump — these are the UNIVERSAL_FALLBACK_COMPETENCIES
  // (pathwayPlanner.ts) so every legacy/self-healed plan hits one of them.
  // Previously they fell through to DEFAULT_LESSON_BUDGET (350) and
  // hit the same truncation bug.
  relevance:            { complexity: 'medium', maxTokens: 700 },
  structure:            { complexity: 'medium', maxTokens: 700 },

  // Simple — quick point + example
  conciseness:          { complexity: 'simple', maxTokens: 400 },
  confidence:           { complexity: 'simple', maxTokens: 400 },
  positivity:           { complexity: 'simple', maxTokens: 400 },
  active_listening:     { complexity: 'simple', maxTokens: 400 },
}

export const DEFAULT_LESSON_BUDGET: LessonBudget = { complexity: 'medium', maxTokens: 700 }

export function getLessonBudget(competency: string): LessonBudget {
  return COMPETENCY_LESSON_BUDGETS[competency] ?? DEFAULT_LESSON_BUDGET
}
