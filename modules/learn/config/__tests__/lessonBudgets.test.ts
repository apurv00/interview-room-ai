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
    expect(DEFAULT_LESSON_BUDGET.maxTokens).toBe(350)
  })

  it('getLessonBudget returns correct budget for known competency', () => {
    const budget = getLessonBudget('star_structure')
    expect(budget.complexity).toBe('complex')
    expect(budget.maxTokens).toBe(600)
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
