import { describe, it, expect } from 'vitest'
import { JSDOM } from 'jsdom'
import { measureResumeSections, headerBlockHeight, sectionHeaderReserveHeight } from '../measureResumeSections'

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

describe('measureResumeSections skills header height', () => {
  it('records header offsetHeight that includes h2 trailing margin', () => {
    const dom = new JSDOM(`
      <div id="root">
        <div data-resume-section="skills">
          <div data-resume-skills-header="Technical Skills">
            <h2 style="margin:0 0 8px 0;padding:0 0 2px 0;border-bottom:1px solid #2563eb">Technical Skills</h2>
          </div>
          <div data-resume-section-unit data-resume-skills-category>Category</div>
        </div>
      </div>
    `)
    const root = dom.window.document.getElementById('root') as HTMLElement
    const header = root.querySelector('[data-resume-skills-header]') as HTMLElement
    const h2 = header.querySelector('h2') as HTMLElement

    Object.defineProperty(header, 'offsetHeight', { value: 14, configurable: true })
    header.getBoundingClientRect = () =>
      ({ top: 0, bottom: 14, height: 14, left: 0, right: 200, width: 200, x: 0, y: 0, toJSON() {} }) as DOMRect
    h2.getBoundingClientRect = () =>
      ({ top: 0, bottom: 14, height: 14, left: 0, right: 200, width: 200, x: 0, y: 0, toJSON() {} }) as DOMRect

    expect(headerBlockHeight(header)).toBe(22)

    const sections = measureResumeSections(root)
    const skills = sections.find(s => s.kind === 'splittable' && s.sectionId === 'skills')
    expect(skills?.kind).toBe('splittable')
    if (skills?.kind === 'splittable') {
      expect(skills.header.offsetHeight).toBe(26)
    }
  })
})

describe('sectionHeaderReserveHeight', () => {
  it('uses live gap from header top to first unit when larger than headerBlockHeight', () => {
    const dom = new JSDOM(`
      <div id="root">
        <div data-resume-section="experience">
          <h2 data-resume-section-header="Experience" style="margin:0 0 4px 0">Experience</h2>
          <div data-resume-section-unit>Job 1</div>
        </div>
      </div>
    `)
    const root = dom.window.document.getElementById('root') as HTMLElement
    const section = root.querySelector('[data-resume-section="experience"]') as HTMLElement
    const header = root.querySelector('[data-resume-section-header]') as HTMLElement
    const unit = root.querySelector('[data-resume-section-unit]') as HTMLElement

    Object.defineProperty(header, 'offsetHeight', { value: 14, configurable: true })
    header.getBoundingClientRect = () =>
      ({ top: 100, bottom: 114, height: 14, left: 0, right: 200, width: 200, x: 0, y: 100, toJSON() {} }) as DOMRect
    unit.getBoundingClientRect = () =>
      ({ top: 126, bottom: 140, height: 14, left: 0, right: 200, width: 200, x: 0, y: 126, toJSON() {} }) as DOMRect
    root.getBoundingClientRect = () =>
      ({ top: 0, bottom: 200, height: 200, left: 0, right: 200, width: 200, x: 0, y: 0, toJSON() {} }) as DOMRect

    expect(sectionHeaderReserveHeight(section, header, root)).toBe(26)
  })
})

describe('measureResumeSections block header height', () => {
  it('records summary headerHeight including h2 trailing margin', () => {
    const dom = new JSDOM(`
      <div id="root">
        <div data-resume-section="summary">
          <h2 data-resume-section-header="Summary" style="margin:0 0 8px 0;padding:0 0 2px 0;border-bottom:1px solid #ccc">Summary</h2>
          <p>Long summary text.</p>
        </div>
      </div>
    `)
    const root = dom.window.document.getElementById('root') as HTMLElement
    const h2 = root.querySelector('[data-resume-section-header]') as HTMLElement
    Object.defineProperty(h2, 'offsetHeight', { value: 14, configurable: true })
    h2.getBoundingClientRect = () =>
      ({ top: 0, bottom: 14, height: 14, left: 0, right: 200, width: 200, x: 0, y: 0, toJSON() {} }) as DOMRect

    const sections = measureResumeSections(root)
    expect(sections[0].kind).toBe('block')
    if (sections[0].kind === 'block') {
      expect(sections[0].headerHeight).toBe(26)
    }
  })
})
