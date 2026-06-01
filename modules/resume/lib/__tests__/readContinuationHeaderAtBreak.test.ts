import { describe, it, expect } from 'vitest'
import { JSDOM } from 'jsdom'
import { readContinuationHeaderAtBreak } from '../measureResumeSections'

/**
 * Regression coverage for the continuation-header lookup.
 *
 * Old behaviour matched the nearest *unit* (with a ±4px fuzzy fallback), which
 * (a) returned null for block sections that have no units — so the repeated
 * header the planner reserved space for never rendered (Codex r3319929068) —
 * and (b) could attach an adjacent section's header when no unit sat at the
 * break. The fix resolves the section by vertical-range containment instead.
 */

type Geom = { top: number; height: number; left?: number; width?: number }

function setGeom(el: HTMLElement, { top, height, left = 0, width = 500 }: Geom) {
  Object.defineProperty(el, 'offsetHeight', { value: height, configurable: true })
  el.getBoundingClientRect = () =>
    ({
      top,
      left,
      width,
      height,
      bottom: top + height,
      right: left + width,
      x: left,
      y: top,
      toJSON() {},
    }) as DOMRect
}

function makeRoot(html: string): HTMLElement {
  const dom = new JSDOM(`<div id="root">${html}</div>`)
  const root = dom.window.document.getElementById('root') as HTMLElement
  setGeom(root, { top: 0, height: 2000 })
  return root
}

describe('readContinuationHeaderAtBreak', () => {
  it('returns the header of a block section that has no units (long Summary)', () => {
    const root = makeRoot(`
      <div data-resume-section="summary">
        <h2 data-resume-section-header="Summary">Summary</h2>
        <p>long body</p>
      </div>
    `)
    const section = root.querySelector('[data-resume-section="summary"]') as HTMLElement
    const header = root.querySelector('[data-resume-section-header]') as HTMLElement
    setGeom(section, { top: 0, height: 1000 })
    setGeom(header, { top: 0, height: 20 })

    const metrics = readContinuationHeaderAtBreak(root, 800)
    expect(metrics).not.toBeNull()
    expect(metrics?.title).toBe('Summary')
    expect(metrics?.height).toBe(20)
    expect(metrics?.sectionId).toBe('summary')
    expect(metrics?.html).toMatch(/<h2[^>]*data-resume-section-header/)
  })

  it('resolves the section whose range contains the break, not a neighbour', () => {
    const root = makeRoot(`
      <div data-resume-section="experience">
        <h2 data-resume-section-header="Experience">Experience</h2>
        <div data-resume-section-unit>job</div>
      </div>
      <div data-resume-section="skills">
        <div data-resume-skills-header="Skills"><h2>Skills</h2></div>
        <div data-resume-section-unit data-resume-skills-category data-category-index="0">cat</div>
      </div>
    `)
    const exp = root.querySelector('[data-resume-section="experience"]') as HTMLElement
    const expHeader = root.querySelector('[data-resume-section-header]') as HTMLElement
    const skills = root.querySelector('[data-resume-section="skills"]') as HTMLElement
    const skillsHeader = root.querySelector('[data-resume-skills-header]') as HTMLElement
    setGeom(exp, { top: 0, height: 760 })
    setGeom(expHeader, { top: 0, height: 20 })
    setGeom(skills, { top: 760, height: 240 })
    setGeom(skillsHeader, { top: 760, height: 20 })

    // A break at 758 sits inside Experience (range [0,760)) even though the
    // Skills section's first unit starts only 2px away at 760.
    const metrics = readContinuationHeaderAtBreak(root, 758)
    expect(metrics?.title).toBe('Experience')
    expect(metrics?.sectionId).toBe('experience')
  })

  it('returns the Skills header for a break inside the Skills range', () => {
    const root = makeRoot(`
      <div data-resume-section="skills">
        <div data-resume-skills-header="Core Competencies"><h2>Core Competencies</h2></div>
        <div data-resume-section-unit data-resume-skills-category data-category-index="0">a</div>
        <div data-resume-section-unit data-resume-skills-category data-category-index="1">b</div>
      </div>
    `)
    const skills = root.querySelector('[data-resume-section="skills"]') as HTMLElement
    const header = root.querySelector('[data-resume-skills-header]') as HTMLElement
    setGeom(skills, { top: 0, height: 1000 })
    setGeom(header, { top: 0, height: 24 })

    const metrics = readContinuationHeaderAtBreak(root, 500)
    expect(metrics?.title).toBe('Core Competencies')
    expect(metrics?.height).toBe(24)
  })

  it('returns null when the break falls outside every marked section', () => {
    const root = makeRoot(`
      <div data-resume-section="summary">
        <h2 data-resume-section-header="Summary">Summary</h2>
      </div>
    `)
    const section = root.querySelector('[data-resume-section="summary"]') as HTMLElement
    const header = root.querySelector('[data-resume-section-header]') as HTMLElement
    setGeom(section, { top: 0, height: 100 })
    setGeom(header, { top: 0, height: 20 })

    expect(readContinuationHeaderAtBreak(root, 500)).toBeNull()
  })
})
