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
})
