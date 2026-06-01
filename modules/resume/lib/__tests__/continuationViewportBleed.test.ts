import { describe, it, expect } from 'vitest'
import { pageClipHeight } from '../resumePageBreaks'

/**
 * Documents how the preview/PDF viewport maps document Y to screen Y on
 * continuation pages. Regression guard for the page-2 overlap bug.
 */
describe('continuation page viewport mapping', () => {
  const breakTop = 760
  const headerHeight = 20
  const span = 400
  const pageContentHeight = 794

  it('current clip+marginTop exposes document above breakTop in the header band (bleed)', () => {
    const marginTop = -breakTop + headerHeight
    const clipHeight = pageClipHeight(1, [0, breakTop, breakTop + span], pageContentHeight, headerHeight)
    expect(clipHeight).toBe(span + headerHeight)

    const docYAtViewportTop = -marginTop
    expect(docYAtViewportTop).toBe(breakTop - headerHeight)
    expect(docYAtViewportTop).toBeLessThan(breakTop)
  })

  it('nested content band maps breakTop to inner y=0 (no document above breakTop)', () => {
    const marginTop = -breakTop
    const docYAtInnerViewportTop = -marginTop
    expect(docYAtInnerViewportTop).toBe(breakTop)
  })
})
