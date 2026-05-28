/**
 * Section-aware A4 page breaks for preview and PDF.
 *
 * Splittable sections (experience, education, skills, projects, certifications, …):
 * - Each `data-resume-section-unit` is an atomic block (e.g. one job, one degree, one skill category).
 * - If header + first unit cannot fit on the current page, move the whole section to the next page.
 * - Break before a later unit only when that unit cannot fit on the current page.
 * - Continuation pages reserve section header height at the top of the viewport.
 * - Units are never split across pages (job + its bullets stay together).
 *
 * Simple sections (summary, single-paragraph custom blocks):
 * - Move as a whole when they do not fit in the page remainder.
 */

export interface MeasurableUnit {
  offsetTop: number
  offsetHeight: number
}

export interface SectionUnit extends MeasurableUnit {
  unitIndex: number
}

export interface SplittableSectionMeasurement {
  kind: 'splittable'
  sectionId: string
  offsetTop: number
  offsetHeight: number
  header: MeasurableUnit
  units: SectionUnit[]
}

export interface BlockSectionMeasurement {
  kind: 'block'
  sectionId: string
  offsetTop: number
  offsetHeight: number
  headerHeight: number
}

export type SectionMeasurement = BlockSectionMeasurement | SplittableSectionMeasurement

/** @deprecated Use SplittableSectionMeasurement */
export type SkillsSectionMeasurement = SplittableSectionMeasurement

export interface PageLayoutPlan {
  breaks: number[]
  /** Per-page: repeat the continuing section title overlay (any splittable section). */
  continuationHeaders: boolean[]
  /** Units taller than one page minus header — preview may truncate (skills today). */
  truncatedUnits: Array<{ sectionId: string; unitIndex: number }>
  /** @deprecated Use continuationHeaders */
  skillsContinuationHeader: boolean[]
  /** @deprecated Use truncatedUnits */
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

/**
 * Viewport height for a rendered page. When the next page starts at `breaks[i+1]`,
 * page i must clip at that offset — otherwise content between breaks appears on both
 * pages (e.g. half a Skills header on page 1 and the full section again on page 2).
 *
 * When this page repeats a continuation header, content is shifted down by
 * `continuationHeaderHeight` (`marginTop = -breakTop + headerHeight`). The clip must
 * include that reserved band so the slice up to the next break is not truncated
 * (Codex r3320336750).
 */
export function pageClipHeight(
  pageIndex: number,
  breaks: number[],
  pageContentHeight: number,
  continuationHeaderHeight = 0,
): number {
  if (pageIndex < 0 || pageIndex >= breaks.length) return pageContentHeight
  const start = breaks[pageIndex]
  const nextStart = breaks[pageIndex + 1]
  if (nextStart === undefined) return pageContentHeight
  const span = nextStart - start
  const withHeader = span + Math.max(0, continuationHeaderHeight)
  return Math.min(pageContentHeight, Math.max(0, withHeader))
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

function unitBottom(sectionTop: number, unit: SectionUnit): number {
  return sectionTop + bottom(unit)
}

function layoutSplittableSection(
  section: SplittableSectionMeasurement,
  pageStart: number,
  pageHeight: number,
  breaks: number[],
  continuation: boolean[],
  truncatedUnits: Array<{ sectionId: string; unitIndex: number }>,
): number {
  const sectionTop = section.offsetTop
  const sectionBottom = bottom(section)
  const { header, units } = section

  if (units.length === 0) {
    if (!fits(sectionBottom, pageStart, pageHeight)) {
      pushBreak(breaks, continuation, sectionTop, false)
      return sectionTop
    }
    return pageStart
  }

  let pageStartLocal = pageStart
  let reservedTopOnPage = 0

  const wholeSectionFits = () => fits(sectionBottom, pageStartLocal, pageHeight, reservedTopOnPage)

  if (wholeSectionFits()) return pageStartLocal

  const firstUnitBottom = unitBottom(sectionTop, units[0])
  const firstChunkBottom = Math.max(
    firstUnitBottom,
    sectionTop + bottom(header) + units[0].offsetHeight,
  )

  if (!fits(firstChunkBottom, pageStartLocal, pageHeight, reservedTopOnPage)) {
    if (sectionTop > pageStartLocal) {
      pushBreak(breaks, continuation, sectionTop, false)
      pageStartLocal = sectionTop
      reservedTopOnPage = 0
    }
    if (wholeSectionFits()) return pageStartLocal
  }

  for (let index = 0; index < units.length; index++) {
    const unit = units[index]
    const unitBreakTop = sectionTop + unit.offsetTop
    const unitBottomAbs = unitBottom(sectionTop, unit)

    const maxUnitHeightWithHeader = pageHeight - header.offsetHeight
    if (unit.offsetHeight > maxUnitHeightWithHeader) {
      truncatedUnits.push({ sectionId: section.sectionId, unitIndex: unit.unitIndex })
    }

    if (!fits(unitBottomAbs, pageStartLocal, pageHeight, reservedTopOnPage)
      && unitBreakTop > pageStartLocal) {
      if (index === 0) {
        // Move the whole section — breaking at unitBreakTop leaves the section
        // header and a clipped first unit on the prior page (duplicate SKILLS).
        if (sectionTop > pageStartLocal) {
          pushBreak(breaks, continuation, sectionTop, false)
          pageStartLocal = sectionTop
          reservedTopOnPage = 0
        }
      } else {
        pushBreak(breaks, continuation, unitBreakTop, true)
        pageStartLocal = unitBreakTop
        reservedTopOnPage = header.offsetHeight
      }
    }

    // Units stay atomic — never slice mid-job / mid-category. Oversized units are
    // truncated in preview (truncatedUnits) instead of duplicated across pages.
  }

  return pageStartLocal
}

function toLegacyPlan(plan: Omit<PageLayoutPlan, 'skillsContinuationHeader' | 'truncatedSkillCategoryIndices'>): PageLayoutPlan {
  return {
    ...plan,
    skillsContinuationHeader: plan.continuationHeaders,
    truncatedSkillCategoryIndices: plan.truncatedUnits
      .filter(u => u.sectionId === 'skills')
      .map(u => u.unitIndex),
  }
}

export function computePageLayoutPlan(
  sections: SectionMeasurement[],
  pageHeight: number,
): PageLayoutPlan {
  if (sections.length === 0) {
    return toLegacyPlan({
      breaks: [0],
      continuationHeaders: [false],
      truncatedUnits: [],
    })
  }

  const breaks: number[] = [0]
  const continuationHeaders: boolean[] = [false]
  const truncatedUnits: Array<{ sectionId: string; unitIndex: number }> = []
  let pageStart = 0

  for (const section of sections) {
    if (section.kind === 'splittable') {
      pageStart = layoutSplittableSection(
        section,
        pageStart,
        pageHeight,
        breaks,
        continuationHeaders,
        truncatedUnits,
      )
    } else {
      pageStart = layoutBlockSection(section, pageStart, pageHeight, breaks, continuationHeaders)
    }
  }

  return toLegacyPlan({ breaks, continuationHeaders, truncatedUnits })
}

/** @deprecated Use computePageLayoutPlan — kept for callers that only need marginTop breaks */
export function computePageBreaks(children: MeasurableUnit[], pageHeight: number): number[] {
  return computePageLayoutPlan(
    children.map(c => ({
      kind: 'block' as const,
      sectionId: 'legacy',
      offsetTop: c.offsetTop,
      offsetHeight: c.offsetHeight,
      headerHeight: 0,
    })),
    pageHeight,
  ).breaks
}
