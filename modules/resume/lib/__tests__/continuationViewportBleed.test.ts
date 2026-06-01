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

  it('legacy clip+marginTop exposes document above breakTop in the header band (bleed)', () => {
    const marginTop = -breakTop + headerHeight
    const clipHeight = pageClipHeight(1, [0, breakTop, breakTop + span], pageContentHeight, headerHeight)
    expect(clipHeight).toBe(span + headerHeight)

    const docYAtViewportTop = -marginTop
    expect(docYAtViewportTop).toBe(breakTop - headerHeight)
    expect(docYAtViewportTop).toBeLessThan(breakTop)
  })

  it('content band uses marginTop -breakTop only when header stays in flow', () => {
    const marginTop = -breakTop
    const docYAtInnerViewportTop = -marginTop
    expect(docYAtInnerViewportTop).toBe(breakTop)
  })

  it('adds header height to marginTop when in-flow header is display:none', () => {
    const marginTop = -breakTop + headerHeight
    const docYAtContentBandTop = -marginTop
    expect(docYAtContentBandTop).toBe(breakTop - headerHeight)
  })
})
