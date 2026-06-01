import { describe, it, expect } from 'vitest'
import { JSDOM } from 'jsdom'
import { headerBlockHeight } from '../measureResumeSections'

describe('headerBlockHeight', () => {
  it('uses visual rect height when larger than offsetHeight', () => {
    const dom = new JSDOM(`<h2 class="big">Experience</h2>`)
    const h2 = dom.window.document.querySelector('h2') as HTMLElement
    Object.defineProperty(h2, 'offsetHeight', { value: 18, configurable: true })
    h2.getBoundingClientRect = () =>
      ({
        height: 28,
        width: 200,
        top: 0,
        left: 0,
        bottom: 28,
        right: 200,
        x: 0,
        y: 0,
        toJSON() {},
      }) as DOMRect

    expect(headerBlockHeight(h2)).toBe(28)
  })

  it('includes h2 margin-bottom when header is a skills wrapper div', () => {
    const dom = new JSDOM(`
      <div data-resume-skills-header="Technical Skills" style="margin:0;padding:0">
        <h2 style="margin:0 0 8px 0;padding:0 0 2px 0;border-bottom:1px solid #2563eb">Technical Skills</h2>
      </div>
    `)
    const wrapper = dom.window.document.querySelector('[data-resume-skills-header]') as HTMLElement
    const h2 = wrapper.querySelector('h2') as HTMLElement

    Object.defineProperty(wrapper, 'offsetHeight', { value: 14, configurable: true })
    Object.defineProperty(h2, 'offsetHeight', { value: 14, configurable: true })

    wrapper.getBoundingClientRect = () =>
      ({ top: 100, bottom: 114, height: 14, left: 0, right: 200, width: 200, x: 0, y: 100, toJSON() {} }) as DOMRect
    h2.getBoundingClientRect = () =>
      ({ top: 100, bottom: 114, height: 14, left: 0, right: 200, width: 200, x: 0, y: 100, toJSON() {} }) as DOMRect

    // Wrapper offsetHeight ignores the 8px margin-bottom; headerBlockHeight must not.
    expect(headerBlockHeight(wrapper)).toBe(22)
  })
})
