import { describe, it, expect } from 'vitest'
import { ResumeSchema, resumeClampedContent, GenerateSchema, TailorSchema, ATSCheckSchema } from '@resume/validators/resume'
import { sliceSkillCategory, applySkillsTruncationToData } from '@resume/lib/skillCategoryTruncation'
import type { ResumeData } from '@resume/validators/resume'

// ─── resumeClampedContent (#5) ───────────────────────────────────────────────
describe('resumeClampedContent', () => {
  const parse = (raw: unknown) => ResumeSchema.parse(raw)

  it('detects a clamped over-long bullet', () => {
    const raw = { name: 'R', experience: [{ id: 'e1', company: 'A', title: 'T', startDate: '2020', bullets: ['x'.repeat(1500)] }] }
    expect(resumeClampedContent(raw, parse(raw))).toBe(true)
  })

  it('detects a clamped summary and an over-long array', () => {
    expect(resumeClampedContent({ name: 'R', summary: 's'.repeat(6000) }, parse({ name: 'R', summary: 's'.repeat(6000) }))).toBe(true)
    const bigSkills = { name: 'R', skills: [{ category: 'C', items: Array.from({ length: 60 }, () => 'k') }] }
    expect(resumeClampedContent(bigSkills, parse(bigSkills))).toBe(true)
  })

  it('returns false when nothing was clamped', () => {
    const raw = { name: 'R', summary: 'short', experience: [{ id: 'e1', company: 'A', title: 'T', startDate: '2020', bullets: ['fine'] }] }
    expect(resumeClampedContent(raw, parse(raw))).toBe(false)
  })
})

// ─── GenerateSchema.currentSections cap (#6) ─────────────────────────────────
describe('GenerateSchema currentSections cap', () => {
  it('rejects an oversized currentSections array', () => {
    const r = GenerateSchema.safeParse({
      action: 'generate_full',
      currentSections: Array.from({ length: 25 }, () => ({ type: 'x', content: 'y' })),
    })
    expect(r.success).toBe(false)
  })
  it('rejects over-long section content', () => {
    const r = GenerateSchema.safeParse({ action: 'generate_full', currentSections: [{ type: 'x', content: 'y'.repeat(2500) }] })
    expect(r.success).toBe(false)
  })
})

// ─── AI-input schemas clamp instead of reject (#16) ──────────────────────────
describe('Tailor/ATS/Parse schemas clamp long resumeText instead of 400ing', () => {
  it('accepts and clamps a 60k resumeText (was a hard 400)', () => {
    const long = 'a'.repeat(60_000)
    const ats = ATSCheckSchema.safeParse({ resumeText: long })
    expect(ats.success).toBe(true)
    const tailor = TailorSchema.safeParse({ resumeText: long, jobDescription: 'b'.repeat(60) })
    expect(tailor.success).toBe(true)
  })
  it('still rejects a too-short resumeText (min floor kept)', () => {
    expect(ATSCheckSchema.safeParse({ resumeText: 'short' }).success).toBe(false)
  })
})

// ─── sliceSkillCategory omittedCount + "+N more" data carry (#23) ─────────────
describe('sliceSkillCategory carries omittedCount', () => {
  it('attaches omittedCount when it slices', () => {
    const out = sliceSkillCategory({ category: 'Langs', items: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'] }, 0.5)
    expect(out.items).toEqual(['a', 'b', 'c', 'd'])
    expect(out.omittedCount).toBe(4)
  })
  it('adds nothing when ratio >= 1', () => {
    const out = sliceSkillCategory({ category: 'Langs', items: ['a', 'b'] }, 1)
    expect(out.items).toEqual(['a', 'b'])
    expect((out as { omittedCount?: number }).omittedCount).toBeUndefined()
  })
  it('applySkillsTruncationToData bakes omittedCount onto truncated categories', () => {
    const data = { skills: [{ category: 'Langs', items: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'] }] } as unknown as ResumeData
    const out = applySkillsTruncationToData(data, { 0: 0.5 })
    expect((out.skills![0] as { omittedCount?: number }).omittedCount).toBe(4)
  })
})
