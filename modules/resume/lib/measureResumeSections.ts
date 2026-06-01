import type { SectionMeasurement, SplittableSectionMeasurement } from './resumePageBreaks'

function relativeTop(el: HTMLElement, root: HTMLElement): number {
  const rootRect = root.getBoundingClientRect()
  return Math.round(el.getBoundingClientRect().top - rootRect.top)
}

/** Visual block height for section headers (borders, line-height, not just offsetHeight). */
export function headerBlockHeight(headerEl: HTMLElement): number {
  const rectH = headerEl.getBoundingClientRect().height
  return Math.max(headerEl.offsetHeight, Math.ceil(rectH))
}

const UNIT_SELECTOR = '[data-resume-section-unit], [data-resume-skills-category]'

/**
 * Collect text-LINE top offsets (relative to `templateRoot`) for every wrapped
 * line of every text node inside `el`. Uses Range.getClientRects(), which returns
 * one rect per visual line — so this is content-agnostic (bullets, paragraphs,
 * summary, custom blocks all work) and lets the paginator snap a break to a line
 * boundary instead of cutting a line in half. De-duplicated + sorted ascending.
 */
function collectLineTops(el: HTMLElement, templateRoot: HTMLElement): number[] {
  const rootTop = templateRoot.getBoundingClientRect().top
  const tops = new Set<number>()
  // Guard for non-DOM environments (jsdom lacks layout / createRange rects).
  const doc = el.ownerDocument
  if (!doc || typeof doc.createRange !== 'function') return []
  const walker = doc.createTreeWalker(el, NodeFilter.SHOW_TEXT)
  let node = walker.nextNode()
  while (node) {
    const text = node.textContent ?? ''
    if (text.trim().length > 0) {
      try {
        const range = doc.createRange()
        range.selectNodeContents(node)
        const rects = range.getClientRects()
        for (let i = 0; i < rects.length; i++) {
          const top = Math.round(rects[i].top - rootTop)
          if (rects[i].height > 0) tops.add(top)
        }
      } catch {
        /* ignore unsupported nodes */
      }
    }
    node = walker.nextNode()
  }
  return Array.from(tops).sort((a, b) => a - b)
}

/** Skill categories are atomic units; ignore nested per-item unit markers inside a category. */
function collectSectionUnits(sectionEl: HTMLElement): HTMLElement[] {
  return (Array.from(sectionEl.querySelectorAll(UNIT_SELECTOR)) as HTMLElement[]).filter(el => {
    const categoryRow = el.closest('[data-resume-skills-category]')
    return !categoryRow || categoryRow === el
  })
}

function measureSplittableSection(
  sectionEl: HTMLElement,
  templateRoot: HTMLElement,
  sectionId: string,
): SplittableSectionMeasurement {
  const sectionTop = relativeTop(sectionEl, templateRoot)
  const headerEl = sectionEl.querySelector(
    '[data-resume-section-header], [data-resume-skills-header]',
  ) as HTMLElement | null
  const unitEls = collectSectionUnits(sectionEl)

  const header = headerEl
    ? {
        offsetTop: relativeTop(headerEl, templateRoot) - sectionTop,
        offsetHeight: headerBlockHeight(headerEl),
      }
    : { offsetTop: 0, offsetHeight: 0 }

  const units = unitEls.map((el, unitIndex) => ({
    unitIndex,
    offsetTop: relativeTop(el, templateRoot) - sectionTop,
    offsetHeight: el.offsetHeight,
  }))

  return {
    kind: 'splittable',
    sectionId,
    offsetTop: sectionTop,
    offsetHeight: sectionEl.offsetHeight,
    header,
    units,
    lineTops: collectLineTops(sectionEl, templateRoot),
  }
}

function measureBlock(
  el: HTMLElement,
  templateRoot: HTMLElement,
  sectionId: string,
): SectionMeasurement {
  const headerEl = el.querySelector('[data-resume-section-header]') as HTMLElement | null
  return {
    kind: 'block',
    sectionId,
    offsetTop: relativeTop(el, templateRoot),
    offsetHeight: el.offsetHeight,
    headerHeight: headerEl?.offsetHeight ?? 0,
    lineTops: collectLineTops(el, templateRoot),
  }
}

function isSplittableSection(el: HTMLElement): boolean {
  return collectSectionUnits(el).length > 0
}

/** Leaf markers only — ignore a parent marker when a nested section marker exists inside it. */
function collectLeafMarkedSections(templateRoot: HTMLElement): HTMLElement[] {
  const marked = Array.from(
    templateRoot.querySelectorAll('[data-resume-section]'),
  ) as HTMLElement[]

  return marked.filter(el => {
    let parent = el.parentElement
    while (parent && parent !== templateRoot) {
      if (parent.hasAttribute('data-resume-section')) return false
      parent = parent.parentElement
    }
    return true
  })
}

function measureMarkedSection(el: HTMLElement, templateRoot: HTMLElement): SectionMeasurement {
  const sectionId = el.getAttribute('data-resume-section') || 'section'
  // Multi-column regions (e.g. the Creative sidebar + main flex container)
  // cannot be paginated as a linear stack — their child sections live in
  // parallel columns, so sorting markers by top offset and advancing a single
  // pageStart double-counts heights and slices the columns at the wrong
  // offsets (Codex r3319377021 / r3319417932). Treat the whole region as one
  // atomic block sliced by height, with no single header to repeat.
  if (el.hasAttribute('data-resume-columns')) {
    return {
      kind: 'block',
      sectionId,
      offsetTop: relativeTop(el, templateRoot),
      offsetHeight: el.offsetHeight,
      headerHeight: 0,
      // Even though a columnar region is height-sliced as one block, snapping
      // the slice to a line boundary still reduces mid-line clipping. The two
      // columns' lines won't perfectly align, so this is best-effort (coarser
      // pagination is expected for Sidebar per TEMPLATE_PAGINATION.md).
      lineTops: collectLineTops(el, templateRoot),
    }
  }
  if (isSplittableSection(el)) {
    return measureSplittableSection(el, templateRoot, sectionId)
  }
  return measureBlock(el, templateRoot, sectionId)
}

/**
 * Measure resume sections for pagination. Splittable sections use `data-resume-section-unit`
 * (experience jobs, education entries, projects, skill categories, …).
 */
export function measureResumeSections(templateRoot: HTMLElement): SectionMeasurement[] {
  const marked = collectLeafMarkedSections(templateRoot)

  if (marked.length > 0) {
    return marked
      .sort((a, b) => relativeTop(a, templateRoot) - relativeTop(b, templateRoot))
      .map(el => measureMarkedSection(el, templateRoot))
  }

  const children = Array.from(templateRoot.children) as HTMLElement[]
  return children.map(child => {
    const skillsEl = child.querySelector('[data-resume-section="skills"]') as HTMLElement | null
    if (skillsEl) {
      return measureSplittableSection(skillsEl, templateRoot, 'skills')
    }
    return measureBlock(child, templateRoot, 'block')
  })
}

export interface SectionHeaderMetrics {
  title: string
  height: number
  left: number
  width: number
  html: string
  sectionId: string
}

function headerMetricsFromElement(
  header: HTMLElement,
  templateRoot: HTMLElement,
): SectionHeaderMetrics {
  const headerRect = header.getBoundingClientRect()
  const rootRect = templateRoot.getBoundingClientRect()
  const title =
    header.getAttribute('data-resume-section-header')
    || header.getAttribute('data-resume-skills-header')
    || header.textContent?.trim()
    || 'Section'

  const sectionEl = header.closest('[data-resume-section]')

  return {
    title,
    height: headerBlockHeight(header),
    left: Math.max(0, Math.round(headerRect.left - rootRect.left)),
    width: Math.max(0, Math.round(headerRect.width)),
    html: header.innerHTML,
    sectionId: sectionEl?.getAttribute('data-resume-section') || 'section',
  }
}

/**
 * Header overlay for a continuation page starting at `breakTop`.
 *
 * A continuation page belongs to whichever section's vertical range
 * [top, top+height) straddles `breakTop` — NOT to the nearest unit. The old
 * unit-only lookup had two failure modes:
 *   1. Block sections (long Summary / custom section) have no units, so the
 *      lookup returned null and the repeated header the planner reserved space
 *      for was never rendered (Codex r3319929068).
 *   2. When no unit sat exactly at the break, a ±4px nearest-unit fallback
 *      could attach an adjacent section's header to the continuation page.
 * Range containment fixes both: it resolves the section directly and never
 * crosses into a neighbour. For overlapping sections (e.g. the two Creative
 * columns) we prefer the section that starts latest at/above the break.
 */
export function readContinuationHeaderAtBreak(
  templateRoot: HTMLElement,
  breakTop: number,
): SectionHeaderMetrics | null {
  const sections = collectLeafMarkedSections(templateRoot)
  let matched: HTMLElement | null = null
  let matchedTop = -Infinity

  for (const section of sections) {
    const top = relativeTop(section, templateRoot)
    const sectionBottom = top + section.offsetHeight
    if (breakTop >= top && breakTop < sectionBottom && top > matchedTop) {
      matched = section
      matchedTop = top
    }
  }

  if (!matched) return null

  const header = matched.querySelector(
    '[data-resume-section-header], [data-resume-skills-header]',
  ) as HTMLElement | null
  if (!header) return null

  return headerMetricsFromElement(header, templateRoot)
}

export function readSkillsSectionTitle(templateRoot: HTMLElement): string {
  const header = templateRoot.querySelector('[data-resume-skills-header]')
  return header?.getAttribute('data-resume-skills-header') || header?.textContent?.trim() || 'Skills'
}

export function readSkillsHeaderHeight(templateRoot: HTMLElement): number {
  const header = templateRoot.querySelector('[data-resume-skills-header]') as HTMLElement | null
  return header?.offsetHeight ?? 0
}

/** @deprecated Use readContinuationHeaderAtBreak */
export interface SkillsHeaderMetrics extends SectionHeaderMetrics {}

/** @deprecated Use readContinuationHeaderAtBreak */
export function readSkillsHeaderMetrics(templateRoot: HTMLElement): SkillsHeaderMetrics {
  const header = templateRoot.querySelector('[data-resume-skills-header]') as HTMLElement | null
  if (!header) {
    return {
      title: 'Skills',
      height: 0,
      left: 0,
      width: 0,
      html: '<h2>Skills</h2>',
      sectionId: 'skills',
    }
  }
  return headerMetricsFromElement(header, templateRoot)
}
