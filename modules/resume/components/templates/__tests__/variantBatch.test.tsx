import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import { getTemplate } from '../index'
import { FIXTURE } from './parityFixture'

/**
 * New color variants reuse already-tested family layouts (legacy parity gate +
 * marker tests cover those), so these checks just confirm each variant renders
 * the family's marker contract and applies its own accent token.
 */
const CASES = [
  { id: 'technical-slate', accent: 'text-slate-700', skillsCategory: true },
  { id: 'executive-gold', accent: 'text-amber-700', skillsCategory: true },
  { id: 'sidebar-violet', accent: 'bg-violet-700', skillsCategory: true },
  { id: 'early-career-teal', accent: 'text-teal-600', skillsCategory: true },
  { id: 'career-change-emerald', accent: 'text-emerald-600', skillsCategory: true },
] as const

describe('new color variants', () => {
  for (const { id, accent, skillsCategory } of CASES) {
    it(`${id} renders the family marker contract and applies its accent`, () => {
      const html = renderToStaticMarkup(createElement(getTemplate(id), { data: FIXTURE }))
      expect(html).toContain('data-resume-section="experience"')
      expect(html).toContain('data-resume-section-header')
      if (skillsCategory) expect(html).toContain('data-resume-skills-category')
      expect(html).toContain(accent)
    })
  }

  it('sidebar-violet keeps the atomic two-column marker', () => {
    const html = renderToStaticMarkup(createElement(getTemplate('sidebar-violet'), { data: FIXTURE }))
    expect(html).toContain('data-resume-columns')
  })
})
