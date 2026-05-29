import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import { getTemplate } from '../index'
import { FIXTURE, normalizeClassOrder } from './parityFixture'
import type { ResumeData } from '../../../validators/resume'

const MODERN_IDS = ['modern-indigo', 'modern-emerald', 'modern-rose'] as const

describe('Modern family', () => {
  it('emits the pagination marker contract (single-column, skills via ResumeSkillsSection)', () => {
    const html = renderToStaticMarkup(createElement(getTemplate('modern-indigo'), { data: FIXTURE }))
    for (const id of ['summary', 'experience', 'education', 'skills', 'projects', 'certifications']) {
      expect(html).toContain(`data-resume-section="${id}"`)
    }
    expect(html).toContain('data-resume-skills-category')
    expect(html).toContain('data-resume-section-unit')
    // No columnar marker — Modern is single-column.
    expect(html).not.toContain('data-resume-columns')
  })

  it('renders the distinct Modern look (accent header band + left-bar section titles)', () => {
    const html = renderToStaticMarkup(createElement(getTemplate('modern-indigo'), { data: FIXTURE }))
    expect(html).toContain('bg-indigo-600') // header band
    expect(html).toContain('border-l-4') // section-title accent bar
  })

  it('honors data.sectionOrder (single-column family)', () => {
    const data = {
      ...FIXTURE,
      sectionOrder: ['contactInfo', 'skills', 'summary', 'experience', 'education', 'projects', 'certifications', 'customSections'],
    } as unknown as ResumeData
    const html = renderToStaticMarkup(createElement(getTemplate('modern-indigo'), { data }))
    expect(html.indexOf('data-resume-section="skills"')).toBeLessThan(
      html.indexOf('data-resume-section="summary"'),
    )
  })

  it('the three variants are geometry-identical and differ only in accent color', () => {
    const normalized = MODERN_IDS.map(id => {
      const html = renderToStaticMarkup(createElement(getTemplate(id), { data: FIXTURE }))
      // Collapse accent color tokens FIRST, then sort class order — otherwise the
      // class-token sort key differs by color name and masks true equality.
      return normalizeClassOrder(html.replace(/indigo|emerald|rose/g, 'ACCENT'))
    })
    expect(normalized[1]).toBe(normalized[0])
    expect(normalized[2]).toBe(normalized[0])
  })

  it('matches the committed snapshot for every variant', () => {
    for (const id of MODERN_IDS) {
      const html = normalizeClassOrder(
        renderToStaticMarkup(createElement(getTemplate(id), { data: FIXTURE })),
      )
      expect(html).toMatchSnapshot(id)
    }
  })
})
