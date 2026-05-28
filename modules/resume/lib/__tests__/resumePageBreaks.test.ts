import { describe, it, expect } from 'vitest'
import { computePageLayoutPlan, pageClipHeight, type SectionMeasurement } from '../resumePageBreaks'

const PAGE = 800

function block(top: number, height: number, headerHeight = 0): SectionMeasurement {
  return { kind: 'block', sectionId: 'summary', offsetTop: top, offsetHeight: height, headerHeight }
}

function splittable(
  sectionId: string,
  top: number,
  height: number,
  headerHeight: number,
  units: { offsetTop: number; height: number }[],
): SectionMeasurement {
  return {
    kind: 'splittable',
    sectionId,
    offsetTop: top,
    offsetHeight: height,
    header: { offsetTop: 0, offsetHeight: headerHeight },
    units: units.map((u, unitIndex) => ({
      unitIndex,
      offsetTop: u.offsetTop,
      offsetHeight: u.height,
    })),
  }
}

describe('computePageLayoutPlan — section pagination', () => {
  it('keeps entire splittable section on page 1 when it fits', () => {
    const plan = computePageLayoutPlan(
      [
        block(0, 600),
        splittable('skills', 600, 120, 20, [
          { offsetTop: 24, height: 40 },
          { offsetTop: 72, height: 40 },
        ]),
      ],
      PAGE,
    )
    expect(plan.breaks).toEqual([0])
  })

  it('moves whole section to page 2 when header + first unit do not fit', () => {
    const plan = computePageLayoutPlan(
      [
        block(0, 750),
        splittable('skills', 750, 120, 20, [
          { offsetTop: 24, height: 40 },
          { offsetTop: 72, height: 40 },
        ]),
      ],
      PAGE,
    )
    expect(plan.breaks).toEqual([0, 750])
    expect(plan.continuationHeaders[1]).toBe(false)
  })

  it('breaks before a later unit only when it cannot fit on the page', () => {
    const plan = computePageLayoutPlan(
      [
        block(0, 700),
        splittable('skills', 700, 220, 20, [
          { offsetTop: 24, height: 50 },
          { offsetTop: 82, height: 60 },
          { offsetTop: 150, height: 50 },
        ]),
      ],
      PAGE,
    )
    expect(plan.breaks).toEqual([0, 782])
    expect(plan.continuationHeaders[1]).toBe(true)
  })

  it('applies the same unit rules to experience entries', () => {
    const plan = computePageLayoutPlan(
      [
        block(0, 650),
        splittable('experience', 650, 200, 20, [
          { offsetTop: 24, height: 70 },
          { offsetTop: 110, height: 80 },
        ]),
      ],
      PAGE,
    )
    expect(plan.breaks).toEqual([0, 760])
    expect(plan.continuationHeaders[1]).toBe(true)
  })

  it('keeps a unit on the current page when it fits in the remainder', () => {
    const plan = computePageLayoutPlan(
      [
        block(0, 700),
        splittable('skills', 700, 100, 20, [
          { offsetTop: 24, height: 50 },
          { offsetTop: 82, height: 18 },
        ]),
      ],
      PAGE,
    )
    expect(plan.breaks).toEqual([0])
  })

  it('does not split units across pages', () => {
    const plan = computePageLayoutPlan(
      [
        splittable('skills', 0, 220, 20, [
          { offsetTop: 24, height: 90 },
          { offsetTop: 122, height: 90 },
        ]),
      ],
      140,
    )
    expect(plan.breaks.length).toBeGreaterThanOrEqual(2)
    expect(plan.breaks).toContain(122)
    expect(plan.continuationHeaders[1]).toBe(true)
  })

  it('moves a block section to the next page when it does not fit in the page remainder', () => {
    const plan = computePageLayoutPlan(
      [
        block(0, 750),
        block(750, 120),
      ],
      PAGE,
    )
    expect(plan.breaks).toEqual([0, 750])
  })

  it('breaks unit on continuation page when it does not fit below reserved header', () => {
    const pageH = 200
    const headerH = 20
    const plan = computePageLayoutPlan(
      [
        block(0, 100),
        splittable('skills', 100, 300, headerH, [
          { offsetTop: 24, height: 70 },
          { offsetTop: 100, height: 95 },
        ]),
      ],
      pageH,
    )
    expect(plan.breaks).toEqual([0, 200])
    expect(plan.continuationHeaders[1]).toBe(true)
  })

  it('splits tall block sections with reserved header height on continuation slices', () => {
    const pageH = 200
    const headerH = 20
    const plan = computePageLayoutPlan(
      [block(0, 450, headerH)],
      pageH,
    )
    expect(plan.breaks.length).toBeGreaterThanOrEqual(3)
    expect(plan.continuationHeaders[2]).toBe(true)
  })

  it('clips page 0 at next break so moved sections do not peek on the prior page', () => {
    const breaks = [0, 750]
    expect(pageClipHeight(0, breaks, PAGE)).toBe(750)
    expect(pageClipHeight(1, breaks, PAGE)).toBe(PAGE)
  })

  it('clips intermediate pages between consecutive breaks', () => {
    const breaks = [0, 782, 1200]
    expect(pageClipHeight(0, breaks, PAGE)).toBe(782)
    expect(pageClipHeight(1, breaks, PAGE)).toBe(418)
  })

  it('does not slice inside an oversized unit (avoids duplicate subsection on next page)', () => {
    const plan = computePageLayoutPlan(
      [
        block(0, 100),
        splittable('skills', 100, 280, 20, [
          { offsetTop: 24, height: 250 },
        ]),
      ],
      200,
    )
    const breaksInsideUnit = plan.breaks.filter(b => b > 124 && b < 350)
    expect(breaksInsideUnit).toEqual([])
    expect(plan.truncatedUnits).toContainEqual({ sectionId: 'skills', unitIndex: 0 })
  })

  it('marks oversized units for safe truncation', () => {
    const plan = computePageLayoutPlan(
      [
        splittable('skills', 0, 420, 20, [
          { offsetTop: 24, height: 160 },
          { offsetTop: 192, height: 220 },
        ]),
      ],
      200,
    )
    expect(plan.truncatedUnits).toContainEqual({ sectionId: 'skills', unitIndex: 1 })
  })
})
