import { describe, it, expect } from 'vitest'
import { computePageLayoutPlan, type SectionMeasurement } from '../resumePageBreaks'

const PAGE = 800

function block(top: number, height: number, headerHeight = 0): SectionMeasurement {
  return { kind: 'block', offsetTop: top, offsetHeight: height, headerHeight }
}

function skills(
  top: number,
  height: number,
  headerHeight: number,
  categories: { offsetTop: number; height: number }[],
): SectionMeasurement {
  return {
    kind: 'skills',
    offsetTop: top,
    offsetHeight: height,
    header: { offsetTop: 0, offsetHeight: headerHeight },
    categories: categories.map((c, categoryIndex) => ({
      categoryIndex,
      offsetTop: c.offsetTop,
      offsetHeight: c.height,
    })),
  }
}

describe('computePageLayoutPlan — section pagination', () => {
  it('keeps entire skills section on page 1 when it fits', () => {
    const plan = computePageLayoutPlan(
      [
        block(0, 600),
        skills(600, 120, 20, [
          { offsetTop: 24, height: 40 },
          { offsetTop: 72, height: 40 },
        ]),
      ],
      PAGE,
    )
    expect(plan.breaks).toEqual([0])
  })

  it('moves whole skills section to page 2 when header + first category do not fit', () => {
    const plan = computePageLayoutPlan(
      [
        block(0, 750),
        skills(750, 120, 20, [
          { offsetTop: 24, height: 40 },
          { offsetTop: 72, height: 40 },
        ]),
      ],
      PAGE,
    )
    expect(plan.breaks).toEqual([0, 750])
    expect(plan.skillsContinuationHeader[1]).toBe(false)
  })

  it('breaks before a later skills category only when it cannot fit on the page', () => {
    const plan = computePageLayoutPlan(
      [
        block(0, 700),
        skills(700, 220, 20, [
          { offsetTop: 24, height: 50 },
          { offsetTop: 82, height: 60 },
          { offsetTop: 150, height: 50 },
        ]),
      ],
      PAGE,
    )
    expect(plan.breaks).toEqual([0, 782])
    expect(plan.skillsContinuationHeader[1]).toBe(true)
  })

  it('keeps a skills category on the current page when it fits in the remainder', () => {
    const plan = computePageLayoutPlan(
      [
        block(0, 700),
        skills(700, 100, 20, [
          { offsetTop: 24, height: 50 },
          { offsetTop: 82, height: 18 },
        ]),
      ],
      PAGE,
    )
    expect(plan.breaks).toEqual([0])
  })

  it('does not split categories across pages', () => {
    const plan = computePageLayoutPlan(
      [
        skills(0, 220, 20, [
          { offsetTop: 24, height: 90 },
          { offsetTop: 122, height: 90 },
        ]),
      ],
      140,
    )
    expect(plan.breaks.length).toBeGreaterThanOrEqual(2)
    expect(plan.breaks).toContain(122)
    expect(plan.skillsContinuationHeader[1]).toBe(true)
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

  it('breaks skills category on continuation page when it does not fit below reserved header', () => {
    const pageH = 200
    const headerH = 20
    const plan = computePageLayoutPlan(
      [
        block(0, 100),
        skills(100, 300, headerH, [
          { offsetTop: 24, height: 70 },
          { offsetTop: 100, height: 95 },
        ]),
      ],
      pageH,
    )
    expect(plan.breaks).toEqual([0, 200])
    expect(plan.skillsContinuationHeader[1]).toBe(true)
  })

  it('splits tall block sections with reserved header height on continuation slices', () => {
    const pageH = 200
    const headerH = 20
    const plan = computePageLayoutPlan(
      [block(0, 450, headerH)],
      pageH,
    )
    expect(plan.breaks.length).toBeGreaterThanOrEqual(3)
    expect(plan.skillsContinuationHeader[2]).toBe(true)
  })

  it('marks oversized categories for safe truncation', () => {
    const plan = computePageLayoutPlan(
      [
        skills(0, 420, 20, [
          { offsetTop: 24, height: 160 },
          { offsetTop: 192, height: 220 },
        ]),
      ],
      200,
    )
    expect(plan.truncatedSkillCategoryIndices).toContain(1)
  })
})
