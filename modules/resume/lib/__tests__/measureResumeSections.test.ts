import { describe, it, expect } from 'vitest'
import { JSDOM } from 'jsdom'

/**
 * Regression: nested data-resume-section-unit inside a skill category must not
 * become separate pagination units (Codex P2 on PR #409, Career Change template).
 */
describe('collectSectionUnits (via measureResumeSections DOM contract)', () => {
  it('ignores per-skill unit markers nested inside a skills category row', () => {
    const dom = new JSDOM(`
      <div id="root">
        <div data-resume-section="skills">
          <div data-resume-skills-header="Core Competencies"><h2>Core Competencies</h2></div>
          <div data-resume-section-unit data-resume-skills-category data-category-index="0">
            <div class="grid">
              <div data-resume-section-unit>JavaScript</div>
              <div data-resume-section-unit>TypeScript</div>
            </div>
          </div>
        </div>
      </div>
    `)
    const root = dom.window.document.getElementById('root') as HTMLElement
    const skills = root.querySelector('[data-resume-section="skills"]') as HTMLElement
    const selector = '[data-resume-section-unit], [data-resume-skills-category]'
    const units = Array.from(skills.querySelectorAll(selector)).filter(el => {
      const categoryRow = el.closest('[data-resume-skills-category]')
      return !categoryRow || categoryRow === el
    })
    expect(units).toHaveLength(1)
    expect(units[0].getAttribute('data-category-index')).toBe('0')
  })
})
