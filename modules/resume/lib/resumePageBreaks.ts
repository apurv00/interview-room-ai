/**
 * Section-aware A4 page breaks for preview and PDF.
 *
 * All sections (summary, experience, education, skills, …):
 * - If a section cannot fit in the remaining space on the current page, start it on the next page.
 * - Block sections move as a whole unit unless taller than one page (then slice by page height).
 * - Continuation pages that repeat a section title reserve `headerHeight` at the top of the viewport.
 *
 * Skills additionally splits by measured category sub-units:
 * - If header + first category cannot fit on the current page, move the entire Skills section.
 * - Break before a category only when that category cannot fit on the current page.
 * - Continuation pages repeat the Skills heading; categories are not split across pages.
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
  /** Measured `[data-resume-section-header]` height — reserved on continuation pages. */
  headerHeight: number
}

export type SectionMeasurement = BlockSectionMeasurement | SkillsSectionMeasurement

export interface PageLayoutPlan {
  breaks: number[]
  /** Per-page: repeat the continuing section title (skills or any marked block section). */
  skillsContinuationHeader: boolean[]
  truncatedSkillCategoryIndices: number[]
}

function bottom(unit: { offsetTop: number; offsetHeight: number }): number {
  return unit.offsetTop + unit.offsetHeight
}

function pageEnd(pageStart: number, pageHeight: number, reservedTop = 0): number {
  return pageStart + pageHeight - reservedTop
}

/** Whether content up to `bottom` fits on the page that starts at `pageStart`. */
export function fits(
  bottom: number,
  pageStart: number,
  pageHeight: number,
  reservedTop = 0,
): boolean {
  return bottom <= pageEnd(pageStart, pageHeight, reservedTop)
}

function pushBreak(
  breaks: number[],
  continuation: boolean[],
  at: number,
  repeatSectionHeader: boolean,
): void {
  if (breaks[breaks.length - 1] === at) return
  breaks.push(at)
  continuation.push(repeatSectionHeader)
}

function layoutBlockSection(
  section: BlockSectionMeasurement,
  pageStart: number,
  pageHeight: number,
  breaks: number[],
  continuation: boolean[],
): number {
  const blockBottom = bottom(section)
  let reservedTopOnPage = 0

  if (fits(blockBottom, pageStart, pageHeight, reservedTopOnPage)) return pageStart

  const pageEndPx = pageEnd(pageStart, pageHeight, reservedTopOnPage)
  const startsOnCurrentPage =
    section.offsetTop >= pageStart && section.offsetTop < pageEndPx

  if (startsOnCurrentPage && section.offsetTop > pageStart) {
    pushBreak(breaks, continuation, section.offsetTop, false)
    pageStart = section.offsetTop
    reservedTopOnPage = 0
    if (fits(blockBottom, pageStart, pageHeight, reservedTopOnPage)) return pageStart
  }

  if (section.offsetHeight > pageHeight - reservedTopOnPage) {
    if (section.offsetTop > pageStart) {
      pushBreak(breaks, continuation, section.offsetTop, false)
      pageStart = section.offsetTop
      reservedTopOnPage = 0
    }
    let next = pageEnd(pageStart, pageHeight, reservedTopOnPage)
    while (next < blockBottom) {
      const repeatHeader = section.headerHeight > 0
      pushBreak(breaks, continuation, next, repeatHeader)
      pageStart = next
      reservedTopOnPage = repeatHeader ? section.headerHeight : 0
      next = pageEnd(pageStart, pageHeight, reservedTopOnPage)
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
    let reservedTopOnPage = 0

    const wholeSectionFits = () => fits(skillsBottom, pageStartLocal, pageHeight, reservedTopOnPage)

    if (wholeSectionFits()) return pageStartLocal

    const firstCatBottom = categoryBottom(skillsTop, categories[0])
    const firstChunkBottom = Math.max(firstCatBottom, skillsTop + bottom(header) + categories[0].offsetHeight)

    if (!fits(firstChunkBottom, pageStartLocal, pageHeight, reservedTopOnPage)) {
      if (skillsTop > pageStartLocal) {
        pushBreak(breaks, continuation, skillsTop, false)
        pageStartLocal = skillsTop
        reservedTopOnPage = 0
      }
      if (wholeSectionFits()) return pageStartLocal
    }

    for (let index = 0; index < categories.length; index++) {
      const category = categories[index]
      const categoryBreakTop = skillsTop + category.offsetTop
      const categoryBottomAbs = categoryBottom(skillsTop, category)

      const maxCategoryHeightWithHeader = pageHeight - header.offsetHeight
      if (category.offsetHeight > maxCategoryHeightWithHeader) {
        truncatedSkillCategoryIndices.push(category.categoryIndex)
      }

      if (!fits(categoryBottomAbs, pageStartLocal, pageHeight, reservedTopOnPage)
        && categoryBreakTop > pageStartLocal) {
        const repeatHeader = index > 0
        pushBreak(breaks, continuation, categoryBreakTop, repeatHeader)
        pageStartLocal = categoryBreakTop
        reservedTopOnPage = repeatHeader ? header.offsetHeight : 0
      }

      if (category.offsetHeight > maxCategoryHeightWithHeader) {
        let next = pageEnd(pageStartLocal, pageHeight, reservedTopOnPage)
        while (next < categoryBottomAbs) {
          pushBreak(breaks, continuation, next, true)
          pageStartLocal = next
          reservedTopOnPage = header.offsetHeight
          next = pageEnd(pageStartLocal, pageHeight, reservedTopOnPage)
        }
      }
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
    children.map(c => ({
      kind: 'block' as const,
      offsetTop: c.offsetTop,
      offsetHeight: c.offsetHeight,
      headerHeight: 0,
    })),
    pageHeight,
  ).breaks
}
