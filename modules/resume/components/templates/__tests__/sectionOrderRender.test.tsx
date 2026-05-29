import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import { getTemplate } from '../index'
import type { ResumeData } from '../../../validators/resume'

const base = {
  name: 'R',
  contactInfo: { fullName: 'A', email: 'a@b.c' },
  summary: 'Summary text.',
  experience: [{ id: 'e1', company: 'Co', title: 'Eng', startDate: '2020', endDate: '', bullets: ['did a thing'] }],
  skills: [{ category: 'Lang', items: ['TS'] }],
} as unknown as ResumeData

/** Index of a section marker in the rendered HTML (−1 if absent). */
function pos(html: string, sectionId: string): number {
  return html.indexOf(`data-resume-section="${sectionId}"`)
}

describe('data.sectionOrder drives single-column render order', () => {
  it('renders the family default order when sectionOrder is absent', () => {
    const html = renderToStaticMarkup(createElement(getTemplate('professional'), { data: base }))
    // Classic default: summary before experience before skills.
    expect(pos(html, 'summary')).toBeLessThan(pos(html, 'experience'))
    expect(pos(html, 'experience')).toBeLessThan(pos(html, 'skills'))
  })

  it('reorders the preview when the user has reordered sections', () => {
    const data = {
      ...base,
      sectionOrder: ['contactInfo', 'skills', 'summary', 'experience', 'education', 'projects', 'certifications', 'customSections'],
    } as unknown as ResumeData
    const html = renderToStaticMarkup(createElement(getTemplate('professional'), { data }))
    // skills now comes first.
    expect(pos(html, 'skills')).toBeLessThan(pos(html, 'summary'))
    expect(pos(html, 'summary')).toBeLessThan(pos(html, 'experience'))
  })

  it('ignores reorder for columnar templates (creative stays fixed)', () => {
    const reordered = {
      ...base,
      sectionOrder: ['contactInfo', 'skills', 'summary', 'experience', 'education', 'projects', 'certifications', 'customSections'],
    } as unknown as ResumeData
    const fixed = renderToStaticMarkup(createElement(getTemplate('creative'), { data: base }))
    const withOrder = renderToStaticMarkup(createElement(getTemplate('creative'), { data: reordered }))
    expect(withOrder).toBe(fixed)
  })
})
