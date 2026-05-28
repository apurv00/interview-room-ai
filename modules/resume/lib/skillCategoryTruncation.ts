import type { ResumeData } from '../validators/resume'
import type { SkillsSectionMeasurement } from './resumePageBreaks'

/** Height ratio (0..1) for categories taller than one page minus the section header. */
export function computeSkillCategoryRatios(
  skillsSection: SkillsSectionMeasurement,
  pageContentHeight: number,
): Record<number, number> {
  const ratios: Record<number, number> = {}
  const maxAllowed = Math.max(1, pageContentHeight - skillsSection.header.offsetHeight)

  for (const category of skillsSection.categories) {
    if (category.offsetHeight > maxAllowed) {
      ratios[category.categoryIndex] = maxAllowed / category.offsetHeight
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
