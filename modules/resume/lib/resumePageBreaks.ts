/**
 * Section-aware A4 page breaks with Skills category rules:
 * - If header + first category cannot fit on the current page, move the entire Skills section to the next page.
 * - If the first category fits, keep header + fitting categories on that page.
 * - When a later category does not fit, break before it; the next page shows the section title again + that category.
 * - Categories are never split across pages and never appear twice on one page.
 */

export interface MeasurableUnit {
  offsetTop: number
  offsetHeight: number
}

export interface SkillCategoryUnit extends MeasurableUnit {
  categoryIndex: number
}

export interface SkillsSectionMeasurement {
  kind: 'skills'
  offsetTop: number
  offsetHeight: number
  header: MeasurableUnit
  categories: SkillCategoryUnit[]
}

export interface BlockSectionMeasurement {
  kind: 'block'
  offsetTop: number
  offsetHeight: number
}

export type SectionMeasurement = BlockSectionMeasurement | SkillsSectionMeasurement

export interface PageLayoutPlan {
  breaks: number[]
  skillsContinuationHeader: boolean[]
  truncatedSkillCategoryIndices: number[]
}

function bottom(unit: { offsetTop: number; offsetHeight: number }): number {
  return unit.offsetTop + unit.offsetHeight
}

function pageEnd(pageStart: number, pageHeight: number): number {
  return pageStart + pageHeight
}

function fits(bottom: number, pageStart: number, pageHeight: number): boolean {
  return bottom <= pageEnd(pageStart, pageHeight)
}

function pushBreak(
  breaks: number[],
  continuation: boolean[],
  at: number,
  needsSkillsHeader: boolean,
): void {
  if (breaks[breaks.length - 1] === at) return
  breaks.push(at)
  continuation.push(needsSkillsHeader)
}

function layoutBlockSection(
  section: BlockSectionMeasurement,
  pageStart: number,
  pageHeight: number,
  breaks: number[],
  continuation: boolean[],
): number {
  const blockBottom = bottom(section)

  if (fits(blockBottom, pageStart, pageHeight)) return pageStart

  if (section.offsetHeight > pageHeight) {
    if (section.offsetTop > pageStart) {
      pushBreak(breaks, continuation, section.offsetTop, false)
      pageStart = section.offsetTop
    }
    let next = pageEnd(pageStart, pageHeight)
    while (next < blockBottom) {
      pushBreak(breaks, continuation, next, false)
      pageStart = next
      next += pageHeight
    }
    return pageStart
  }

  pushBreak(breaks, continuation, section.offsetTop, false)
  return section.offsetTop
}

function categoryBottom(skillsTop: number, cat: SkillCategoryUnit): number {
  return skillsTop + bottom(cat)
}

function layoutSkillsSection(
  section: SkillsSectionMeasurement,
  pageStart: number,
  pageHeight: number,
  breaks: number[],
  continuation: boolean[],
  truncatedSkillCategoryIndices: number[],
): number {
  const skillsTop = section.offsetTop
  const skillsBottom = bottom(section)
  const { header, categories } = section

  if (categories.length === 0) {
    if (!fits(skillsBottom, pageStart, pageHeight)) {
      pushBreak(breaks, continuation, skillsTop, false)
      return skillsTop
    }
    return pageStart
  }

  const run = (start: number): number => {
    let pageStartLocal = start

    const wholeSectionFits = () => fits(skillsBottom, pageStartLocal, pageHeight)

    if (wholeSectionFits()) return pageStartLocal

    const firstCatBottom = categoryBottom(skillsTop, categories[0])
    // Use absolute category bottom for fit check (robust to DOM gaps)
    const firstChunkBottom = Math.max(firstCatBottom, skillsTop + bottom(header) + categories[0].offsetHeight)

    if (!fits(firstChunkBottom, pageStartLocal, pageHeight)) {
      if (skillsTop > pageStartLocal) {
        pushBreak(breaks, continuation, skillsTop, false)
        pageStartLocal = skillsTop
      }
      if (wholeSectionFits()) return pageStartLocal
    }

    // One category per page maximum when section is split.
    // First category stays on current page; each next category starts a new page.
    for (let index = 0; index < categories.length; index++) {
      const category = categories[index]
      const categoryBreakTop = skillsTop + category.offsetTop
      const categoryBottomAbs = categoryBottom(skillsTop, category)

      const maxCategoryHeightWithHeader = pageHeight - header.offsetHeight
      if (category.offsetHeight > maxCategoryHeightWithHeader) {
        truncatedSkillCategoryIndices.push(category.categoryIndex)
      }

      if (index === 0) {
        // Keep first category on current page if it fits, otherwise section was already moved above.
        if (!fits(categoryBottomAbs, pageStartLocal, pageHeight) && categoryBreakTop > pageStartLocal) {
          pushBreak(breaks, continuation, categoryBreakTop, false)
          pageStartLocal = categoryBreakTop
        }
        continue
      }

      pushBreak(breaks, continuation, categoryBreakTop, true)
      pageStartLocal = categoryBreakTop
    }

    return pageStartLocal
  }

  return run(pageStart)
}

export function computePageLayoutPlan(
  sections: SectionMeasurement[],
  pageHeight: number,
): PageLayoutPlan {
  if (sections.length === 0) {
    return { breaks: [0], skillsContinuationHeader: [false], truncatedSkillCategoryIndices: [] }
  }

  const breaks: number[] = [0]
  const skillsContinuationHeader: boolean[] = [false]
  const truncatedSkillCategoryIndices: number[] = []
  let pageStart = 0

  for (const section of sections) {
    if (section.kind === 'block') {
      pageStart = layoutBlockSection(section, pageStart, pageHeight, breaks, skillsContinuationHeader)
    } else {
      pageStart = layoutSkillsSection(
        section,
        pageStart,
        pageHeight,
        breaks,
        skillsContinuationHeader,
        truncatedSkillCategoryIndices,
      )
    }
  }

  return { breaks, skillsContinuationHeader, truncatedSkillCategoryIndices }
}

/** @deprecated Use computePageLayoutPlan — kept for callers that only need marginTop breaks */
export function computePageBreaks(children: MeasurableUnit[], pageHeight: number): number[] {
  return computePageLayoutPlan(
    children.map(c => ({ kind: 'block' as const, offsetTop: c.offsetTop, offsetHeight: c.offsetHeight })),
    pageHeight,
  ).breaks
}
