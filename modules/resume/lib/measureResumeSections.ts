import type { SectionMeasurement, SkillsSectionMeasurement } from './resumePageBreaks'

function relativeTop(el: HTMLElement, root: HTMLElement): number {
  const rootRect = root.getBoundingClientRect()
  return Math.round(el.getBoundingClientRect().top - rootRect.top)
}

function measureSkillsBlock(skillsEl: HTMLElement, templateRoot: HTMLElement): SkillsSectionMeasurement {
  const skillsTop = relativeTop(skillsEl, templateRoot)
  const headerEl = skillsEl.querySelector('[data-resume-skills-header]') as HTMLElement | null
  const categoryEls = Array.from(
    skillsEl.querySelectorAll('[data-resume-skills-category]'),
  ) as HTMLElement[]

  const header = headerEl
    ? {
        offsetTop: relativeTop(headerEl, templateRoot) - skillsTop,
        offsetHeight: headerEl.offsetHeight,
      }
    : { offsetTop: 0, offsetHeight: 0 }

  const categories = categoryEls.map((el, categoryIndex) => ({
    categoryIndex,
    offsetTop: relativeTop(el, templateRoot) - skillsTop,
    offsetHeight: el.offsetHeight,
  }))

  return {
    kind: 'skills',
    offsetTop: skillsTop,
    offsetHeight: skillsEl.offsetHeight,
    header,
    categories,
  }
}

function measureBlock(el: HTMLElement, templateRoot: HTMLElement): SectionMeasurement {
  return {
    kind: 'block',
    offsetTop: relativeTop(el, templateRoot),
    offsetHeight: el.offsetHeight,
  }
}

/**
 * Measure resume sections for pagination. Uses `data-resume-section` markers when present
 * (supports nested layouts like Creative sidebar); otherwise top-level template children.
 */
export function measureResumeSections(templateRoot: HTMLElement): SectionMeasurement[] {
  const marked = Array.from(
    templateRoot.querySelectorAll('[data-resume-section]'),
  ) as HTMLElement[]
  const hasNonSkillsMarker = marked.some(
    el => el.getAttribute('data-resume-section') !== 'skills',
  )

  if (marked.length > 0 && hasNonSkillsMarker) {
    return marked
      .sort((a, b) => relativeTop(a, templateRoot) - relativeTop(b, templateRoot))
      .map(el => {
        if (el.getAttribute('data-resume-section') === 'skills') {
          return measureSkillsBlock(el, templateRoot)
        }
        return measureBlock(el, templateRoot)
      })
  }

  const children = Array.from(templateRoot.children) as HTMLElement[]
  return children.map(child => {
    if (child.getAttribute('data-resume-section') === 'skills') {
      return measureSkillsBlock(child, templateRoot)
    }
    return measureBlock(child, templateRoot)
  })
}

export function readSkillsSectionTitle(templateRoot: HTMLElement): string {
  const header = templateRoot.querySelector('[data-resume-skills-header]')
  return header?.getAttribute('data-resume-skills-header') || header?.textContent?.trim() || 'Skills'
}

export function readSkillsHeaderHeight(templateRoot: HTMLElement): number {
  const header = templateRoot.querySelector('[data-resume-skills-header]') as HTMLElement | null
  return header?.offsetHeight ?? 0
}

export interface SkillsHeaderMetrics {
  title: string
  height: number
  left: number
  width: number
  html: string
}

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

  const headerRect = header.getBoundingClientRect()
  const rootRect = templateRoot.getBoundingClientRect()

  return {
    title: header.getAttribute('data-resume-skills-header') || header.textContent?.trim() || 'Skills',
    height: header.offsetHeight,
    left: Math.max(0, Math.round(headerRect.left - rootRect.left)),
    width: Math.max(0, Math.round(headerRect.width)),
    html: header.innerHTML,
  }
}
