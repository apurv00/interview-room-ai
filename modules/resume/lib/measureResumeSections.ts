import type { SectionMeasurement, SplittableSectionMeasurement } from './resumePageBreaks'

function relativeTop(el: HTMLElement, root: HTMLElement): number {
  const rootRect = root.getBoundingClientRect()
  return Math.round(el.getBoundingClientRect().top - rootRect.top)
}

const UNIT_SELECTOR = '[data-resume-section-unit], [data-resume-skills-category]'

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
        offsetHeight: headerEl.offsetHeight,
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

  return {
    title,
    height: header.offsetHeight,
    left: Math.max(0, Math.round(headerRect.left - rootRect.left)),
    width: Math.max(0, Math.round(headerRect.width)),
    html: header.innerHTML,
  }
}

/** Header overlay for a continuation page starting at `breakTop`. */
export function readContinuationHeaderAtBreak(
  templateRoot: HTMLElement,
  breakTop: number,
): SectionHeaderMetrics | null {
  const unitEls = collectSectionUnits(templateRoot)
  let matchedUnit: HTMLElement | null = null

  for (const unit of unitEls) {
    const unitTop = relativeTop(unit, templateRoot)
    if (unitTop === breakTop || (breakTop > unitTop && breakTop < unitTop + unit.offsetHeight)) {
      matchedUnit = unit
      break
    }
  }

  if (!matchedUnit && unitEls.length > 0) {
    let best: HTMLElement | null = null
    let bestDelta = Infinity
    for (const unit of unitEls) {
      const unitTop = relativeTop(unit, templateRoot)
      const delta = Math.abs(unitTop - breakTop)
      if (delta < bestDelta) {
        bestDelta = delta
        best = unit
      }
    }
    if (best && bestDelta <= 4) matchedUnit = best
  }

  const section = (matchedUnit?.closest('[data-resume-section]') ?? null) as HTMLElement | null
  if (!section) return null

  const header = section.querySelector(
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
    }
  }
  return headerMetricsFromElement(header, templateRoot)
}
