import { describe, it, expect, vi, beforeEach } from 'vitest'

const { seen, mockUpdateOne } = vi.hoisted(() => {
  const seen = new Set<string>()
  return {
    seen,
    mockUpdateOne: vi.fn(async (filter: { domain: string; interviewType: string; question: string }) => {
      const key = `${filter.domain}|${filter.interviewType}|${filter.question}`
      if (seen.has(key)) return { upsertedCount: 0 }
      seen.add(key)
      return { upsertedCount: 1 }
    }),
  }
})
vi.mock('@shared/db/models', () => ({
  QuestionBank: { updateOne: (...a: unknown[]) => mockUpdateOne(...(a as [never])) },
}))

import {
  enumerateCells, depthApplies, GeneratedQuestionSchema, CellQuestionsSchema,
  upsertCellQuestions, buildCellPrompt, type BackfillDomain, type BackfillDepth,
} from '@interview/services/questionBankBackfill'

const DEPTHS: BackfillDepth[] = [
  { slug: 'behavioral', label: 'Behavioral', applicableDomains: [], applicableCategories: [] },
  { slug: 'technical', label: 'Technical', applicableDomains: [], applicableCategories: [] },
  { slug: 'coding', label: 'Coding', applicableDomains: ['backend'], applicableCategories: ['programming', 'data-ai'] },
  { slug: 'case-study', label: 'Case Study', applicableDomains: ['pm'], applicableCategories: ['product', 'business', 'data-ai', 'design'] },
]
const DOMAINS: BackfillDomain[] = [
  { slug: 'mechanical', label: 'Mechanical Engineer', categorySlug: 'core-engineering', systemPromptContext: 'ME ctx' },
  { slug: 'fullstack', label: 'Full-stack Engineer', categorySlug: 'programming', systemPromptContext: 'FS ctx' },
  { slug: 'finance', label: 'Finance', categorySlug: 'business', systemPromptContext: 'FIN ctx' },
  { slug: 'general', label: 'General', categorySlug: 'general' },
]

const typesFor = (cells: ReturnType<typeof enumerateCells>, domain: string) =>
  cells.filter(c => c.domain === domain).map(c => c.interviewType).sort()

describe('enumerateCells — category-aware matrix', () => {
  const cells = enumerateCells(DOMAINS, DEPTHS)

  it('Core Engineering gets behavioral + technical only (no coding/case-study)', () => {
    expect(typesFor(cells, 'mechanical')).toEqual(['behavioral', 'technical'])
  })
  it('Programming gets coding via category, not case-study', () => {
    expect(typesFor(cells, 'fullstack')).toEqual(['behavioral', 'coding', 'technical'])
  })
  it('Business gets case-study via category, not coding', () => {
    expect(typesFor(cells, 'finance')).toEqual(['behavioral', 'case-study', 'technical'])
  })
  it('the general escape bucket is skipped', () => {
    expect(typesFor(cells, 'general')).toEqual([])
  })
  it('carries the domain context + depth strategy into each cell', () => {
    const c = cells.find(x => x.domain === 'mechanical' && x.interviewType === 'technical')!
    expect(c.systemPromptContext).toBe('ME ctx')
    expect(c.domainLabel).toBe('Mechanical Engineer')
  })
})

describe('depthApplies', () => {
  it('all-empty depth applies to everything', () => {
    expect(depthApplies({ slug: 'b', label: 'B' }, 'mechanical', 'core-engineering')).toBe(true)
  })
  it('category match applies; non-match does not', () => {
    const coding = DEPTHS[2]
    expect(depthApplies(coding, 'fullstack', 'programming')).toBe(true)
    expect(depthApplies(coding, 'mechanical', 'core-engineering')).toBe(false)
  })
})

describe('GeneratedQuestion / CellQuestions validation', () => {
  const validQ = {
    question: 'Walk me through analyzing a simply supported beam under a uniform load.',
    category: 'technical',
    targetCompetencies: ['structural_analysis'],
    difficulty: 'medium' as const,
    idealAnswerPoints: ['Finds the max bending moment', 'Checks against section capacity'],
    commonMistakes: ['Skips the load path'],
    tags: ['beams'],
  }
  it('accepts a well-formed question + cell', () => {
    expect(GeneratedQuestionSchema.safeParse(validQ).success).toBe(true)
    expect(CellQuestionsSchema.safeParse({ domain: 'civil', interviewType: 'technical', questions: [validQ] }).success).toBe(true)
  })
  it('rejects bad difficulty / empty competencies / too-short question', () => {
    expect(GeneratedQuestionSchema.safeParse({ ...validQ, difficulty: 'extreme' }).success).toBe(false)
    expect(GeneratedQuestionSchema.safeParse({ ...validQ, targetCompetencies: [] }).success).toBe(false)
    expect(GeneratedQuestionSchema.safeParse({ ...validQ, question: 'too short' }).success).toBe(false)
    expect(CellQuestionsSchema.safeParse({ domain: 'civil', interviewType: 'technical', questions: [] }).success).toBe(false)
  })
})

describe('upsertCellQuestions — idempotent', () => {
  const q1 = { question: 'Q one about thermodynamics cycles.', category: 'technical', targetCompetencies: ['fundamentals'], difficulty: 'medium' as const, idealAnswerPoints: ['a', 'bb'], commonMistakes: ['cc'], tags: [] }
  const q2 = { question: 'Q two about heat transfer modes.', category: 'technical', targetCompetencies: ['fundamentals'], difficulty: 'easy' as const, idealAnswerPoints: ['a', 'bb'], commonMistakes: ['cc'], tags: [] }

  beforeEach(() => { seen.clear(); mockUpdateOne.mockClear() })

  it('first run inserts all; re-run skips all (no duplicates)', async () => {
    const first = await upsertCellQuestions('mechanical', 'technical', [q1, q2])
    expect(first).toEqual({ domain: 'mechanical', interviewType: 'technical', inserted: 2, skipped: 0 })

    const second = await upsertCellQuestions('mechanical', 'technical', [q1, q2])
    expect(second).toEqual({ domain: 'mechanical', interviewType: 'technical', inserted: 0, skipped: 2 })
  })

  it('keys on (domain, interviewType, question) — same text under a different type is a new row', async () => {
    await upsertCellQuestions('mechanical', 'technical', [q1])
    const other = await upsertCellQuestions('mechanical', 'behavioral', [q1])
    expect(other.inserted).toBe(1)
  })
})

describe('buildCellPrompt', () => {
  it('embeds the domain label, depth, context, and the return shape', () => {
    const cells = enumerateCells(DOMAINS, DEPTHS)
    const cell = cells.find(c => c.domain === 'mechanical' && c.interviewType === 'technical')!
    const p = buildCellPrompt(cell, 8)
    expect(p).toContain('Mechanical Engineer')
    expect(p).toContain('Technical')
    expect(p).toContain('ME ctx')
    expect(p).toContain('"domain": "mechanical"')
  })
})
