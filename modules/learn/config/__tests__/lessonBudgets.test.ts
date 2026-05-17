import { describe, it, expect } from 'vitest'
import {
  COMPETENCY_LESSON_BUDGETS,
  DEFAULT_LESSON_BUDGET,
  getLessonBudget,
} from '../lessonBudgets'

describe('lessonBudgets config', () => {
  it('all budgets have valid complexity and positive maxTokens', () => {
    const validComplexities = ['simple', 'medium', 'complex']
    for (const [key, budget] of Object.entries(COMPETENCY_LESSON_BUDGETS)) {
      expect(validComplexities, `${key} has invalid complexity`).toContain(budget.complexity)
      expect(budget.maxTokens, `${key} has non-positive maxTokens`).toBeGreaterThan(0)
    }
  })

  it('complex competencies have higher budgets than simple ones', () => {
    const complex = COMPETENCY_LESSON_BUDGETS['star_structure']
    const simple = COMPETENCY_LESSON_BUDGETS['conciseness']
    expect(complex.maxTokens).toBeGreaterThan(simple.maxTokens)
  })

  it('default budget is medium complexity', () => {
    expect(DEFAULT_LESSON_BUDGET.complexity).toBe('medium')
    // Budgets bumped 2026-05-17 because the lesson schema (title +
    // summary + deep dive + worked example + takeaways) needs
    // ~500-700 tokens of output — the previous 350 ceiling was
    // truncating mid-output and 502ing every lesson on /pathway.
    expect(DEFAULT_LESSON_BUDGET.maxTokens).toBe(700)
  })

  it('getLessonBudget returns correct budget for known competency', () => {
    const budget = getLessonBudget('star_structure')
    expect(budget.complexity).toBe('complex')
    expect(budget.maxTokens).toBe(800)
  })

  it('covers all UNIVERSAL_FALLBACK_COMPETENCIES so they do not hit DEFAULT', () => {
    // Production diagnosis 2026-05-17 — the fallback competencies
    // (relevance, structure, specificity) are what every legacy plan
    // self-heals to via getUniversalPlan's backfill. Each MUST have
    // an explicit budget entry so token-sizing decisions stay local
    // to this file when behaviour needs tuning.
    expect(COMPETENCY_LESSON_BUDGETS['relevance']).toBeDefined()
    expect(COMPETENCY_LESSON_BUDGETS['structure']).toBeDefined()
    expect(COMPETENCY_LESSON_BUDGETS['specificity']).toBeDefined()
  })

  it('getLessonBudget returns default for unknown competency', () => {
    const budget = getLessonBudget('nonexistent_skill')
    expect(budget).toEqual(DEFAULT_LESSON_BUDGET)
  })

  it('no budget exceeds 900 tokens (hard model limit)', () => {
    for (const [key, budget] of Object.entries(COMPETENCY_LESSON_BUDGETS)) {
      expect(budget.maxTokens, `${key} exceeds hard limit`).toBeLessThanOrEqual(900)
    }
  })
})
