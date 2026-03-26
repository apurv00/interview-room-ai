import { describe, it, expect } from 'vitest'
import { QUESTION_POOL, selectQuestionInspiration } from '../config/questionPool'

const DOMAINS = [
  'frontend', 'backend', 'sdet', 'devops', 'data-science',
  'pm', 'design',
  'business', 'marketing', 'finance', 'sales',
]

const DEPTHS = ['screening', 'behavioral', 'technical', 'case-study']

describe('QUESTION_POOL', () => {
  it('has entries for all 44 domain:depth combinations', () => {
    for (const domain of DOMAINS) {
      for (const depth of DEPTHS) {
        const key = `${domain}:${depth}`
        expect(QUESTION_POOL[key], `Missing pool: ${key}`).toBeDefined()
        expect(QUESTION_POOL[key].length, `${key} should have questions`).toBeGreaterThan(0)
      }
    }
  })

  it('each combination has at least 7 questions', () => {
    for (const domain of DOMAINS) {
      for (const depth of DEPTHS) {
        const key = `${domain}:${depth}`
        expect(QUESTION_POOL[key].length, `${key} needs at least 7`).toBeGreaterThanOrEqual(7)
      }
    }
  })

  it('every question has required fields', () => {
    for (const [key, questions] of Object.entries(QUESTION_POOL)) {
      for (const q of questions) {
        expect(q.question, `${key}: missing question text`).toBeTruthy()
        expect(q.question.length).toBeGreaterThan(10)
        expect(q.experience, `${key}: missing experience`).toBeTruthy()
        expect(['0-2', '3-6', '7+', 'all']).toContain(q.experience)
        expect(q.targetCompetency, `${key}: missing targetCompetency`).toBeTruthy()
      }
    }
  })

  it('each combination covers all experience levels', () => {
    for (const domain of DOMAINS) {
      for (const depth of DEPTHS) {
        const key = `${domain}:${depth}`
        const experiences = new Set(QUESTION_POOL[key].map(q => q.experience))
        expect(experiences.has('0-2') || experiences.has('all'), `${key} missing 0-2 level`).toBe(true)
        expect(experiences.has('3-6') || experiences.has('all'), `${key} missing 3-6 level`).toBe(true)
        expect(experiences.has('7+') || experiences.has('all'), `${key} missing 7+ level`).toBe(true)
      }
    }
  })

  it('total question count is approximately 308', () => {
    const total = Object.values(QUESTION_POOL).reduce((sum, qs) => sum + qs.length, 0)
    expect(total).toBeGreaterThanOrEqual(300)
    expect(total).toBeLessThanOrEqual(350)
  })
})

describe('selectQuestionInspiration', () => {
  it('returns up to 3 questions for a valid combination', () => {
    const result = selectQuestionInspiration('frontend', 'screening', '0-2')
    expect(result.length).toBeLessThanOrEqual(3)
    expect(result.length).toBeGreaterThan(0)
  })

  it('filters by experience level', () => {
    const result = selectQuestionInspiration('backend', 'technical', '7+')
    for (const q of result) {
      expect(['7+', 'all']).toContain(q.experience)
    }
  })

  it('returns empty array for unknown domain', () => {
    const result = selectQuestionInspiration('nonexistent', 'screening', '0-2')
    expect(result).toEqual([])
  })

  it('returns different results on repeated calls (randomized)', () => {
    // Run 10 times and check we get at least 2 different orderings
    const results = Array.from({ length: 10 }, () =>
      selectQuestionInspiration('pm', 'behavioral', '3-6').map(q => q.question).join('|')
    )
    const unique = new Set(results)
    // With randomization, we should get variation (may rarely fail but highly unlikely)
    expect(unique.size).toBeGreaterThanOrEqual(2)
  })

  it('excludes questions matching excludeTopics', () => {
    const pool = QUESTION_POOL['sales:screening']
    const firstQuestion = pool[0].question
    const result = selectQuestionInspiration('sales', 'screening', 'all', [firstQuestion])
    for (const q of result) {
      expect(q.question).not.toBe(firstQuestion)
    }
  })
})
