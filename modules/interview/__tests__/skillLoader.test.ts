import { describe, it, expect, vi } from 'vitest'

// Mock DB so skillLoader falls back to filesystem in tests
vi.mock('@shared/db/connection', () => ({ connectDB: vi.fn().mockRejectedValue(new Error('no db in test')) }))
vi.mock('@shared/db/models', () => ({ InterviewSkill: { findOne: vi.fn().mockResolvedValue(null) } }))

import { getSkillContent, getSkillSections, selectSkillQuestions } from '../services/skillLoader'

const DOMAINS = [
  'general', 'frontend', 'backend', 'sdet', 'data-science',
  'pm', 'design', 'business',
]

const DEPTHS = ['behavioral', 'technical', 'case-study']

// Domains that also have system-design and coding files
const SYSTEM_DESIGN_DOMAINS = ['general', 'backend', 'frontend', 'sdet', 'data-science']
const CODING_DOMAINS = ['backend', 'frontend', 'sdet', 'data-science', 'general']

// Build the full list of expected domain-depth combinations
function allCombinations(): Array<{ domain: string; depth: string }> {
  const combos: Array<{ domain: string; depth: string }> = []
  for (const domain of DOMAINS) {
    for (const depth of DEPTHS) {
      combos.push({ domain, depth })
    }
  }
  for (const domain of SYSTEM_DESIGN_DOMAINS) {
    combos.push({ domain, depth: 'system-design' })
  }
  for (const domain of CODING_DOMAINS) {
    combos.push({ domain, depth: 'coding' })
  }
  return combos
}

const ALL_COMBOS = allCombinations()

describe('getSkillContent', () => {
  it('loads all expected skill files', async () => {
    for (const { domain, depth } of ALL_COMBOS) {
      const content = await getSkillContent(domain, depth)
      expect(content, `Missing skill file: ${domain}-${depth}.md`).not.toBeNull()
      expect(content!.length).toBeGreaterThan(100)
    }
  })

  it('returns null for unknown domain', async () => {
    expect(await getSkillContent('nonexistent', 'behavioral')).toBeNull()
  })
})

describe('getSkillSections', () => {
  it('extracts interviewer-persona from every skill file', async () => {
    for (const { domain, depth } of ALL_COMBOS) {
      const persona = await getSkillSections(domain, depth, ['interviewer-persona'])
      expect(persona, `${domain}-${depth} missing interviewer-persona`).toBeTruthy()
      expect(persona.length).toBeGreaterThan(10)
    }
  })

  it('extracts question-strategy from every skill file', async () => {
    for (const { domain, depth } of ALL_COMBOS) {
      const strategy = await getSkillSections(domain, depth, ['question-strategy'])
      expect(strategy, `${domain}-${depth} missing question-strategy`).toBeTruthy()
    }
  })

  it('extracts scoring-emphasis from every skill file', async () => {
    for (const { domain, depth } of ALL_COMBOS) {
      const scoring = await getSkillSections(domain, depth, ['scoring-emphasis'])
      expect(scoring, `${domain}-${depth} missing scoring-emphasis`).toBeTruthy()
    }
  })

  it('extracts experience-calibration from every skill file', async () => {
    for (const { domain, depth } of ALL_COMBOS) {
      const cal = await getSkillSections(domain, depth, ['experience-calibration'])
      expect(cal, `${domain}-${depth} missing experience-calibration`).toBeTruthy()
      expect(cal).toContain('Entry Level')
      expect(cal).toContain('Mid Level')
      expect(cal).toContain('Senior')
    }
  })

  it('extracts anti-patterns from every skill file', async () => {
    for (const { domain, depth } of ALL_COMBOS) {
      const ap = await getSkillSections(domain, depth, ['anti-patterns'])
      expect(ap, `${domain}-${depth} missing anti-patterns`).toBeTruthy()
    }
  })

  it('extracts red-flags from every skill file', async () => {
    for (const { domain, depth } of ALL_COMBOS) {
      const flags = await getSkillSections(domain, depth, ['red-flags'])
      expect(flags, `${domain}-${depth} missing red-flags`).toBeTruthy()
    }
  })

  it('extracts sample-questions from every skill file', async () => {
    for (const { domain, depth } of ALL_COMBOS) {
      const questions = await getSkillSections(domain, depth, ['sample-questions'])
      expect(questions, `${domain}-${depth} missing sample-questions`).toBeTruthy()
    }
  })

  it('concatenates multiple sections', async () => {
    const combined = await getSkillSections('business', 'technical', [
      'scoring-emphasis', 'red-flags',
    ])
    expect(combined).toContain('framework')
    expect(combined).toContain('Cannot')
  })

  it('returns empty string for unknown domain', async () => {
    expect(await getSkillSections('nonexistent', 'behavioral', ['question-strategy'])).toBe('')
  })

  it('technical depths have depth-meaning section', async () => {
    for (const domain of DOMAINS) {
      const meaning = await getSkillSections(domain, 'technical', ['depth-meaning'])
      expect(meaning, `${domain}-technical missing depth-meaning`).toBeTruthy()
    }
  })
})

describe('selectSkillQuestions', () => {
  it('returns questions for a valid combination', async () => {
    const questions = await selectSkillQuestions('frontend', 'behavioral', '0-2')
    expect(questions).toBeTruthy()
    expect(questions.length).toBeGreaterThan(10)
  })

  it('returns different results on repeated calls (randomized)', async () => {
    const results: string[] = []
    for (let i = 0; i < 10; i++) {
      results.push(await selectSkillQuestions('pm', 'behavioral', '3-6'))
    }
    const unique = new Set(results)
    expect(unique.size).toBeGreaterThanOrEqual(2)
  })

  it('returns empty string for unknown domain', async () => {
    expect(await selectSkillQuestions('nonexistent', 'behavioral', '0-2')).toBe('')
  })

  // Content quality checks — updated for merged domains
  it('business:technical mentions MEDDIC or strategy frameworks', async () => {
    const content = (await getSkillContent('business', 'technical'))!
    expect(content.toLowerCase()).toMatch(/meddic|porter|framework|valuation/)
  })

  it('frontend:case-study mentions component or architecture', async () => {
    const content = (await getSkillContent('frontend', 'case-study'))!
    expect(content.toLowerCase()).toMatch(/component|architecture|micro-frontend/)
  })

  it('backend:case-study mentions system design or microservice', async () => {
    const content = (await getSkillContent('backend', 'case-study'))!
    expect(content.toLowerCase()).toMatch(/system design|microservice|migration/)
  })

  it('general:behavioral mentions STAR method', async () => {
    const content = (await getSkillContent('general', 'behavioral'))!
    expect(content.toLowerCase()).toMatch(/star/)
  })
})
