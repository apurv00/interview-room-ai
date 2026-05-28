import type { ResumeData } from '../validators/resume'
import type { SplittableSectionMeasurement } from './resumePageBreaks'

/** Height ratio (0..1) for skill units taller than one page minus the section header. */
export function computeSkillCategoryRatios(
  skillsSection: SplittableSectionMeasurement,
  pageContentHeight: number,
): Record<number, number> {
  const ratios: Record<number, number> = {}
  const maxAllowed = Math.max(1, pageContentHeight - skillsSection.header.offsetHeight)

  for (const unit of skillsSection.units) {
    if (unit.offsetHeight > maxAllowed) {
      ratios[unit.unitIndex] = maxAllowed / unit.offsetHeight
    }
  }

  return ratios
}

export function keptSkillItemCount(itemCount: number, ratio: number): number {
  if (itemCount <= 1 || ratio >= 1) return itemCount
  return Math.max(1, Math.floor(itemCount * ratio))
}

export function omittedSkillItemCount(itemCount: number, ratio: number): number {
  if (itemCount <= 1 || ratio >= 1) return 0
  return Math.max(0, itemCount - keptSkillItemCount(itemCount, ratio))
}

export function computeOmittedSkillCounts(
  skills: NonNullable<ResumeData['skills']>,
  ratios: Record<number, number>,
): Record<number, number> {
  const omitted: Record<number, number> = {}
  skills.forEach((cat, index) => {
    const ratio = ratios[index] ?? 1
    const count = omittedSkillItemCount(cat.items.length, ratio)
    if (count > 0) omitted[index] = count
  })
  return omitted
}

export function sliceSkillCategory<T extends { items: string[] }>(
  category: T,
  ratio: number,
): T {
  if (ratio >= 1) return category
  const kept = keptSkillItemCount(category.items.length, ratio)
  return { ...category, items: category.items.slice(0, kept) }
}

/** Preview layout data: shorten oversized skill categories so DOM measurement matches visible pages. */
export function applySkillsTruncationToData(
  data: ResumeData,
  ratios: Record<number, number>,
): ResumeData {
  if (!data.skills?.length || Object.keys(ratios).length === 0) return data

  const skills = data.skills.map((cat, index) => sliceSkillCategory(cat, ratios[index] ?? 1))
  const unchanged = skills.every((cat, i) => cat.items.length === (data.skills?.[i]?.items.length ?? 0))
  if (unchanged) return data

  return { ...data, skills }
}

export function skillsMatchTruncationRatios(
  skills: NonNullable<ResumeData['skills']> | undefined,
  ratios: Record<number, number>,
  sourceSkills?: NonNullable<ResumeData['skills']>,
): boolean {
  if (!skills?.length) return Object.keys(ratios).length === 0
  return skills.every((cat, index) => {
    const ratio = ratios[index] ?? 1
    const sourceCount = sourceSkills?.[index]?.items.length ?? cat.items.length
    if (ratio >= 1) return cat.items.length === sourceCount
    return cat.items.length === keptSkillItemCount(sourceCount, ratio)
  })
}

export function isFullSkillsMeasure(
  measureSkills: NonNullable<ResumeData['skills']> | undefined,
  sourceSkills: NonNullable<ResumeData['skills']> | undefined,
): boolean {
  if (!sourceSkills?.length) return true
  if (!measureSkills?.length) return false
  return sourceSkills.every(
    (cat, index) => cat.items.length === (measureSkills[index]?.items.length ?? cat.items.length),
  )
}

/**
 * After truncating items, category chrome (+N more, labels) can still exceed one page.
 * Refine ratios by dropping one more item — never re-derive ratios from truncated DOM heights.
 */
export function refineSkillRatiosIfStillOversized(
  skillsSection: SplittableSectionMeasurement,
  pageContentHeight: number,
  ratios: Record<number, number>,
  sourceSkills: NonNullable<ResumeData['skills']>,
  currentSkills: NonNullable<ResumeData['skills']>,
): Record<number, number> | null {
  const maxAllowed = Math.max(1, pageContentHeight - skillsSection.header.offsetHeight)
  const next = { ...ratios }
  let changed = false

  for (const unit of skillsSection.units) {
    if (unit.offsetHeight <= maxAllowed) continue

    const index = unit.unitIndex
    const sourceCount = sourceSkills[index]?.items.length ?? 0
    const currentKept = currentSkills[index]?.items.length ?? sourceCount
    if (currentKept <= 1) continue

    next[index] = (currentKept - 1) / sourceCount
    changed = true
  }

  return changed ? next : null
}
