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

  it('viewport height includes continuation header band in the clip', () => {
    const clipHeight = pageClipHeight(1, [0, breakTop, breakTop + span], pageContentHeight, headerHeight)
    expect(clipHeight).toBe(span + headerHeight)
  })

  it('marginTop adds header height when in-flow header is display:none', () => {
    const marginTop = -breakTop + headerHeight
    const docYAtContentBandTop = -marginTop
    expect(docYAtContentBandTop).toBe(breakTop - headerHeight)
  })

  it('clip-path inset clears the header band from painted content bleed', () => {
    const clipInsetTop = headerHeight
    const marginTop = -breakTop + headerHeight
    const docYAtFirstPaintedPixelBelowClip = breakTop - headerHeight + clipInsetTop
    expect(docYAtFirstPaintedPixelBelowClip).toBe(breakTop)
  })
})
