import { describe, it, expect } from 'vitest'
import { getSkillContent, getSkillSections, selectSkillQuestions } from '../services/skillLoader'

const DOMAINS = [
  'frontend', 'backend', 'sdet', 'devops', 'data-science',
  'pm', 'design',
  'business', 'marketing', 'finance', 'sales',
]

const DEPTHS = ['screening', 'behavioral', 'technical', 'case-study']

describe('getSkillContent', () => {
  it('loads all 44 skill files', () => {
    for (const domain of DOMAINS) {
      for (const depth of DEPTHS) {
        const content = getSkillContent(domain, depth)
        expect(content, `Missing skill file: ${domain}-${depth}.md`).not.toBeNull()
        expect(content!.length).toBeGreaterThan(100)
      }
    }
  })

  it('returns null for unknown domain', () => {
    expect(getSkillContent('nonexistent', 'screening')).toBeNull()
  })

  it('each skill file is under 3500 chars (~850 tokens)', () => {
    for (const domain of DOMAINS) {
      for (const depth of DEPTHS) {
        const content = getSkillContent(domain, depth)!
        expect(content.length, `${domain}-${depth}.md is too large: ${content.length} chars`).toBeLessThan(3500)
      }
    }
  })
})

describe('getSkillSections', () => {
  it('extracts interviewer-persona from every skill file', () => {
    for (const domain of DOMAINS) {
      for (const depth of DEPTHS) {
        const persona = getSkillSections(domain, depth, ['interviewer-persona'])
        expect(persona, `${domain}-${depth} missing interviewer-persona`).toBeTruthy()
        expect(persona.length).toBeGreaterThan(10)
      }
    }
  })

  it('extracts question-strategy from every skill file', () => {
    for (const domain of DOMAINS) {
      for (const depth of DEPTHS) {
        const strategy = getSkillSections(domain, depth, ['question-strategy'])
        expect(strategy, `${domain}-${depth} missing question-strategy`).toBeTruthy()
      }
    }
  })

  it('extracts scoring-emphasis from every skill file', () => {
    for (const domain of DOMAINS) {
      for (const depth of DEPTHS) {
        const scoring = getSkillSections(domain, depth, ['scoring-emphasis'])
        expect(scoring, `${domain}-${depth} missing scoring-emphasis`).toBeTruthy()
      }
    }
  })

  it('extracts experience-calibration from every skill file', () => {
    for (const domain of DOMAINS) {
      for (const depth of DEPTHS) {
        const cal = getSkillSections(domain, depth, ['experience-calibration'])
        expect(cal, `${domain}-${depth} missing experience-calibration`).toBeTruthy()
        expect(cal).toContain('Entry Level')
        expect(cal).toContain('Mid Level')
        expect(cal).toContain('Senior')
      }
    }
  })

  it('extracts anti-patterns from every skill file', () => {
    for (const domain of DOMAINS) {
      for (const depth of DEPTHS) {
        const ap = getSkillSections(domain, depth, ['anti-patterns'])
        expect(ap, `${domain}-${depth} missing anti-patterns`).toBeTruthy()
      }
    }
  })

  it('extracts red-flags from every skill file', () => {
    for (const domain of DOMAINS) {
      for (const depth of DEPTHS) {
        const flags = getSkillSections(domain, depth, ['red-flags'])
        expect(flags, `${domain}-${depth} missing red-flags`).toBeTruthy()
      }
    }
  })

  it('extracts sample-questions from every skill file', () => {
    for (const domain of DOMAINS) {
      for (const depth of DEPTHS) {
        const questions = getSkillSections(domain, depth, ['sample-questions'])
        expect(questions, `${domain}-${depth} missing sample-questions`).toBeTruthy()
      }
    }
  })

  it('concatenates multiple sections', () => {
    const combined = getSkillSections('sales', 'technical', [
      'scoring-emphasis', 'red-flags',
    ])
    expect(combined).toContain('methodology')
    expect(combined).toContain('Cannot articulate')
  })

  it('returns empty string for unknown domain', () => {
    expect(getSkillSections('nonexistent', 'screening', ['question-strategy'])).toBe('')
  })

  // Only technical and case-study have depth-meaning
  it('technical depths have depth-meaning section', () => {
    for (const domain of DOMAINS) {
      const meaning = getSkillSections(domain, 'technical', ['depth-meaning'])
      expect(meaning, `${domain}-technical missing depth-meaning`).toBeTruthy()
    }
  })
})

describe('selectSkillQuestions', () => {
  it('returns questions for a valid combination', () => {
    const questions = selectSkillQuestions('frontend', 'screening', '0-2')
    expect(questions).toBeTruthy()
    expect(questions.length).toBeGreaterThan(10)
  })

  it('returns different results on repeated calls (randomized)', () => {
    const results = Array.from({ length: 10 }, () =>
      selectSkillQuestions('pm', 'behavioral', '3-6')
    )
    const unique = new Set(results)
    expect(unique.size).toBeGreaterThanOrEqual(2)
  })

  it('returns empty string for unknown domain', () => {
    expect(selectSkillQuestions('nonexistent', 'screening', '0-2')).toBe('')
  })

  // Content quality checks
  it('sales:technical mentions MEDDIC or SPIN or Challenger', () => {
    const content = getSkillContent('sales', 'technical')!
    expect(content.toLowerCase()).toMatch(/meddic|spin|challenger/)
  })

  it('finance:technical mentions DCF or valuation', () => {
    const content = getSkillContent('finance', 'technical')!
    expect(content.toLowerCase()).toMatch(/dcf|valuation|financial model/)
  })

  it('frontend:case-study mentions component or architecture', () => {
    const content = getSkillContent('frontend', 'case-study')!
    expect(content.toLowerCase()).toMatch(/component|architecture|micro-frontend/)
  })

  it('backend:case-study mentions system design or microservice', () => {
    const content = getSkillContent('backend', 'case-study')!
    expect(content.toLowerCase()).toMatch(/system design|microservice|migration/)
  })
})
