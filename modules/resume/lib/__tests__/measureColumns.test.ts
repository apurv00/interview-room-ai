import { describe, it, expect } from 'vitest'
import { JSDOM } from 'jsdom'
import { measureResumeSections } from '../measureResumeSections'

/**
 * Regression: a multi-column region (Creative sidebar + main) marked with
 * data-resume-columns must be measured as ONE atomic block, not flattened into
 * a linear list of its inner column sections (Codex r3319377021 / r3319417932).
 */

function setGeom(el: HTMLElement, top: number, height: number) {
  Object.defineProperty(el, 'offsetHeight', { value: height, configurable: true })
  el.getBoundingClientRect = () =>
    ({ top, left: 0, width: 547, height, bottom: top + height, right: 547, x: 0, y: top, toJSON() {} }) as DOMRect
}

describe('measureResumeSections — multi-column regions', () => {
  it('measures a data-resume-columns region as a single block with no header', () => {
    const dom = new JSDOM(`
      <div id="tpl">
        <div class="flex" data-resume-section="body" data-resume-columns>
          <div class="sidebar">
            <div data-resume-section="contact">
              <h2 data-resume-section-header="Contact">Contact</h2>
            </div>
            <div data-resume-section="skills">
              <div data-resume-skills-header="Skills"><h2>Skills</h2></div>
              <div data-resume-section-unit data-resume-skills-category data-category-index="0">a</div>
            </div>
          </div>
          <div class="main">
            <div data-resume-section="experience">
              <h2 data-resume-section-header="Experience">Experience</h2>
              <div data-resume-section-unit>job</div>
            </div>
          </div>
        </div>
      </div>
    `)
    const tpl = dom.window.document.getElementById('tpl') as HTMLElement
    const flex = tpl.querySelector('[data-resume-columns]') as HTMLElement
    setGeom(tpl, 0, 1600)
    setGeom(flex, 0, 1600)

    const sections = measureResumeSections(tpl)

    expect(sections).toHaveLength(1)
    expect(sections[0].kind).toBe('block')
    expect(sections[0].sectionId).toBe('body')
    // No single header to repeat across the two columns' continuation pages.
    expect(sections[0].kind === 'block' && sections[0].headerHeight).toBe(0)
    expect(sections[0].offsetHeight).toBe(1600)
  })
})
