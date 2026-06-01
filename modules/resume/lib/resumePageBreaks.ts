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
  /** Text-line top offsets (relative to template root) for line-snapping a
   *  break inside an oversized unit. Optional for backward compatibility. */
  lineTops?: number[]
}

export interface BlockSectionMeasurement {
  kind: 'block'
  sectionId: string
  offsetTop: number
  offsetHeight: number
  headerHeight: number
  /** Text-line top offsets (relative to template root) for line-snapping a
   *  break inside an oversized block (e.g. a very long summary). Optional. */
  lineTops?: number[]
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
 * Snap an in-content break offset DOWN to the nearest text-line top so a page
 * break never bisects a line. `lineTops` are line-box top offsets (relative to
 * the template root) gathered by `collectLineTops`. We pick the greatest line
 * top that is ≤ the raw break AND strictly below `pageStart` floor (so the page
 * still makes progress); the bisected line then moves WHOLE onto the next page.
 *
 * Without this, a too-tall unit (e.g. an experience entry with several long
 * bullets) is cut at a raw pixel offset that lands mid-line — the half-line
 * bleeds onto the prior page and reappears clipped under the repeated section
 * header on the continuation page. This is template- and section-agnostic.
 *
 * Falls back to `rawBreak` when no usable line boundary exists (e.g. lineTops
 * not supplied, or a single line taller than the page) so progress is
 * guaranteed and the loop can never stall.
 */
export function snapToLine(
  rawBreak: number,
  pageStart: number,
  lineTops?: number[],
): number {
  if (!lineTops || lineTops.length === 0) return rawBreak
  let best = -Infinity
  for (const top of lineTops) {
    if (top <= rawBreak && top > pageStart && top > best) best = top
  }
  return best === -Infinity ? rawBreak : best
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
    const rawBlock0 = pageEnd(pageStart, pageHeight, reservedTopOnPage)
    let next = snapToLine(rawBlock0, pageStart, section.lineTops)
    while (next < blockBottom) {
      const repeatHeader = section.headerHeight > 0
      pushBreak(breaks, continuation, next, repeatHeader)
      pageStart = next
      reservedTopOnPage = repeatHeader ? section.headerHeight : 0
      const rawBlock = pageEnd(pageStart, pageHeight, reservedTopOnPage)
      next = snapToLine(rawBlock, pageStart, section.lineTops)
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
        // Snap the unit-boundary break to a line boundary too: a unit's last
        // line can extend a few px past the unit's measured offsetHeight
        // (line-height / descenders), so breaking exactly at the next unit's top
        // would clip that trailing line on the prior page and re-show it under
        // the continuation header. Snapping down moves the whole line forward.
        const snapped = snapToLine(unitBreakTop, pageStartLocal, section.lineTops)
        pushBreak(breaks, continuation, snapped, true)
        pageStartLocal = snapped
        reservedTopOnPage = header.offsetHeight
      }
    }

    // Split a unit across pages when it is intrinsically taller than a page OR
    // when it simply does not fit from the CURRENT page start. The latter case
    // matters after a snapped boundary break moved pageStart slightly earlier:
    // a normal-height unit can then overflow the page bottom even though its own
    // height is within the max, and without this its tail would be clipped
    // (Codex r3333970641). Re-evaluating fit from pageStartLocal covers both.
    const unitOverflowsPage =
      unit.offsetHeight > maxUnitHeightWithHeader
      || !fits(unitBottomAbs, pageStartLocal, pageHeight, reservedTopOnPage)
    if (unitOverflowsPage) {
      if (section.sectionId === 'skills') {
        // Skill categories: truncate in preview/PDF — never slice mid-category.
        truncatedUnits.push({ sectionId: section.sectionId, unitIndex: unit.unitIndex })
      } else {
        // Experience/project/etc.: paginate inside the unit so tail content is not
        // clipped when index===0 moved the section start (Codex r3320360766).
        // Snap each break DOWN to a line boundary so a text line is never cut in
        // half (which would bleed onto the prior page and overlap the repeated
        // header on the continuation page).
        const raw0 = pageEnd(pageStartLocal, pageHeight, reservedTopOnPage)
        let next = snapToLine(raw0, pageStartLocal, section.lineTops)
        while (next < unitBottomAbs) {
          pushBreak(breaks, continuation, next, true)
          pageStartLocal = next
          reservedTopOnPage = header.offsetHeight
          const raw = pageEnd(pageStartLocal, pageHeight, reservedTopOnPage)
          next = snapToLine(raw, pageStartLocal, section.lineTops)
        }
      }
    }
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
