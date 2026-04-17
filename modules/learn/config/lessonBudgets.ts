export type LessonComplexity = 'simple' | 'medium' | 'complex'

export interface LessonBudget {
  complexity: LessonComplexity
  maxTokens: number
}

export const COMPETENCY_LESSON_BUDGETS: Record<string, LessonBudget> = {
  // Complex — needs worked examples, multi-step frameworks
  star_structure:       { complexity: 'complex', maxTokens: 600 },
  behavioral_stories:   { complexity: 'complex', maxTokens: 600 },
  situation_framing:    { complexity: 'complex', maxTokens: 600 },

  // Medium — one concept + example
  ownership:            { complexity: 'medium', maxTokens: 350 },
  jd_alignment:         { complexity: 'medium', maxTokens: 350 },
  specificity:          { complexity: 'medium', maxTokens: 350 },
  metrics_thinking:     { complexity: 'medium', maxTokens: 350 },
  stakeholder_mgmt:     { complexity: 'medium', maxTokens: 350 },
  problem_solving:      { complexity: 'medium', maxTokens: 350 },
  communication:        { complexity: 'medium', maxTokens: 350 },

  // Simple — quick point + example
  conciseness:          { complexity: 'simple', maxTokens: 200 },
  confidence:           { complexity: 'simple', maxTokens: 200 },
  positivity:           { complexity: 'simple', maxTokens: 200 },
  active_listening:     { complexity: 'simple', maxTokens: 200 },
}

export const DEFAULT_LESSON_BUDGET: LessonBudget = { complexity: 'medium', maxTokens: 350 }

export function getLessonBudget(competency: string): LessonBudget {
  return COMPETENCY_LESSON_BUDGETS[competency] ?? DEFAULT_LESSON_BUDGET
}
