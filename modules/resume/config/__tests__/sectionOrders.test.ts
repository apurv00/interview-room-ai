import { describe, it, expect } from 'vitest'
import {
  resolveSectionOrder,
  getTemplateSectionOrder,
  templateHonorsSectionOrder,
  CLASSIC_ORDER,
  TECHNICAL_ORDER,
  DEFAULT_BODY_ORDER,
} from '../sectionOrders'

const GLOBAL_DEFAULT = ['contactInfo', ...DEFAULT_BODY_ORDER]

describe('resolveSectionOrder', () => {
  it('returns the family default when no order is persisted (untouched resume)', () => {
    expect(resolveSectionOrder(undefined, TECHNICAL_ORDER)).toEqual(TECHNICAL_ORDER)
  })

  it('honors an explicit global-default order on a non-Classic family (Codex r3325509679)', () => {
    // A Technical user who deliberately arranges sections into the global order
    // must get exactly that — not have it snapped back to the family default,
    // which would make a valid arrangement impossible to render.
    expect(resolveSectionOrder(GLOBAL_DEFAULT, TECHNICAL_ORDER)).toEqual(DEFAULT_BODY_ORDER)
  })

  it('honors a genuinely reordered order', () => {
    const reordered = ['contactInfo', 'skills', 'summary', 'experience', 'education', 'projects', 'certifications', 'customSections']
    expect(resolveSectionOrder(reordered, CLASSIC_ORDER)).toEqual([
      'skills', 'summary', 'experience', 'education', 'projects', 'certifications', 'customSections',
    ])
  })

  it('appends family sections the user order omits (reconciliation)', () => {
    const partial = ['contactInfo', 'skills', 'summary'] // omits the rest
    const resolved = resolveSectionOrder(partial, CLASSIC_ORDER)
    expect(resolved.slice(0, 2)).toEqual(['skills', 'summary'])
    // every family section is still present
    expect([...resolved].sort()).toEqual([...CLASSIC_ORDER].sort())
  })

  it('drops ids that are not part of the family section set', () => {
    const withUnknown = ['contactInfo', 'skills', 'bogus', 'summary']
    const resolved = resolveSectionOrder(withUnknown, CLASSIC_ORDER)
    expect(resolved).not.toContain('bogus')
    expect(resolved).not.toContain('contactInfo')
  })
})

describe('getTemplateSectionOrder', () => {
  it('returns contactInfo + the family body order for a single-column template', () => {
    expect(getTemplateSectionOrder('technical')).toEqual(['contactInfo', ...TECHNICAL_ORDER])
  })

  it('falls back to the global default for columnar templates (sidebar/startup)', () => {
    expect(getTemplateSectionOrder('creative')).toEqual(GLOBAL_DEFAULT)
    expect(getTemplateSectionOrder('startup')).toEqual(GLOBAL_DEFAULT)
  })
})

describe('templateHonorsSectionOrder', () => {
  it('returns true for single-column families (drag-to-reorder works)', () => {
    for (const id of [
      'professional', 'classic-navy', 'minimalist', 'federal',
      'modern-indigo', 'modern-emerald', 'modern-rose',
      'technical', 'technical-slate', 'executive', 'executive-gold',
      'career-change', 'career-change-emerald', 'entry-level', 'academic',
      'early-career-teal',
    ]) {
      expect(templateHonorsSectionOrder(id)).toBe(true)
    }
  })

  it('returns false for columnar families where reorder is a no-op (sidebar/creative, startup)', () => {
    for (const id of ['creative', 'sidebar-slate', 'sidebar-violet', 'startup']) {
      expect(templateHonorsSectionOrder(id)).toBe(false)
    }
  })

  it('returns false for an unknown template id', () => {
    expect(templateHonorsSectionOrder('does-not-exist')).toBe(false)
  })
})
