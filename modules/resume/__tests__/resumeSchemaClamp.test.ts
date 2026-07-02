import { describe, it, expect } from 'vitest'
import { ResumeSchema } from '@resume/validators/resume'

// ─── Clamp-instead-of-reject size caps ───────────────────────────────────────
// Size overflows on user/AI-shaped content must TRUNCATE, not fail the whole
// save: one AI-enhanced 1001-char bullet used to make a resume permanently
// unsavable with a bare "Invalid data". Structural rules (required name,
// enums, numeric ranges) still reject with field-level issues.

const baseResume = { name: 'My Resume' }

describe('ResumeSchema clamping', () => {
  it('clamps an over-long experience bullet instead of rejecting the save', () => {
    const result = ResumeSchema.safeParse({
      ...baseResume,
      experience: [{
        id: 'e1', company: 'Acme', title: 'Engineer', startDate: '2020',
        bullets: ['x'.repeat(1500)],
      }],
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.experience![0].bullets[0]).toHaveLength(1000)
    }
  })

  it('clamps an over-long summary to 5000 chars', () => {
    const result = ResumeSchema.safeParse({ ...baseResume, summary: 's'.repeat(6000) })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.summary).toHaveLength(5000)
    }
  })

  it('clamps oversized arrays (25 experience entries → 20)', () => {
    const entries = Array.from({ length: 25 }, (_, i) => ({
      id: `e${i}`, company: 'Acme', title: 'Engineer', startDate: '2020', bullets: [],
    }))
    const result = ResumeSchema.safeParse({ ...baseResume, experience: entries })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.experience).toHaveLength(20)
    }
  })

  it('clamps skill items to 50 per category and each item to 100 chars', () => {
    const result = ResumeSchema.safeParse({
      ...baseResume,
      skills: [{ category: 'Languages', items: Array.from({ length: 60 }, () => 'k'.repeat(150)) }],
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.skills![0].items).toHaveLength(50)
      expect(result.data.skills![0].items[0]).toHaveLength(100)
    }
  })

  it('clamps a >200-char resume name instead of rejecting', () => {
    const result = ResumeSchema.safeParse({ name: 'n'.repeat(300) })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.name).toHaveLength(200)
    }
  })

  it('still rejects an empty name (structural rule)', () => {
    const result = ResumeSchema.safeParse({ name: '' })
    expect(result.success).toBe(false)
  })

  it('still rejects an out-of-range atsScore (structural rule)', () => {
    const result = ResumeSchema.safeParse({ ...baseResume, atsScore: 150 })
    expect(result.success).toBe(false)
  })

  it('still rejects an unknown styling fontFamily (enum kept strict)', () => {
    const result = ResumeSchema.safeParse({ ...baseResume, styling: { fontFamily: 'comic-sans' } })
    expect(result.success).toBe(false)
  })

  it('accepts sectionOrder and styling round-trip', () => {
    const result = ResumeSchema.safeParse({
      ...baseResume,
      sectionOrder: ['skills', 'experience'],
      styling: { fontFamily: 'georgia', headingSize: 20 },
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.sectionOrder).toEqual(['skills', 'experience'])
      expect(result.data.styling).toEqual({ fontFamily: 'georgia', headingSize: 20 })
    }
  })
})
