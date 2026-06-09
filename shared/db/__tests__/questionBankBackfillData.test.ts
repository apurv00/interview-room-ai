import { describe, it, expect } from 'vitest'
import raw from '@shared/db/data/questionBankBackfill.json'

interface QB {
  domain: string; interviewType: string; seniorityBand: string; question: string
  category: string; targetCompetencies: string[]; difficulty: string
  idealAnswerPoints: string[]; commonMistakes: string[]; tags: string[]
}
const backfill = raw as unknown as QB[]

describe('QuestionBank backfill data', () => {
  it('covers all 24 browseable domains with ~640 questions', () => {
    expect(backfill.length).toBeGreaterThanOrEqual(600)
    const domains = new Set(backfill.map(q => q.domain))
    expect(domains.size).toBe(24)
    for (const d of ['mechanical', 'civil', 'electrical', 'electronics', 'finance', 'fullstack', 'ml-engineer']) {
      expect(domains.has(d)).toBe(true)
    }
    expect(domains.has('general')).toBe(false)
  })

  it('every entry is a well-formed QuestionBank row (seniorityBand "*")', () => {
    const DIFF = new Set(['easy', 'medium', 'hard'])
    for (const q of backfill) {
      expect(typeof q.domain === 'string' && q.domain.length > 0).toBe(true)
      expect(typeof q.interviewType === 'string' && q.interviewType.length > 0).toBe(true)
      expect(q.seniorityBand).toBe('*')
      expect(typeof q.question === 'string' && q.question.length > 10).toBe(true)
      expect(DIFF.has(q.difficulty)).toBe(true)
      expect(q.targetCompetencies.length).toBeGreaterThan(0)
      expect(q.idealAnswerPoints.length).toBeGreaterThan(0)
    }
  })

  it('no question text leaks across domains (uniqueness guardrail)', () => {
    const byText = new Map<string, Set<string>>()
    for (const q of backfill) {
      if (!byText.has(q.question)) byText.set(q.question, new Set())
      byText.get(q.question)!.add(q.domain)
    }
    const crossDomain = [...byText.values()].filter(s => s.size > 1)
    expect(crossDomain.length).toBe(0)
  })

  it('only category-applicable types appear (Core Engineering has no coding/case-study)', () => {
    const mech = new Set(backfill.filter(q => q.domain === 'mechanical').map(q => q.interviewType))
    expect(mech.has('technical')).toBe(true)
    expect(mech.has('behavioral')).toBe(true)
    expect(mech.has('coding')).toBe(false)
    expect(mech.has('case-study')).toBe(false)
    // Programming roles DO get coding
    const fs = new Set(backfill.filter(q => q.domain === 'fullstack').map(q => q.interviewType))
    expect(fs.has('coding')).toBe(true)
  })
})
