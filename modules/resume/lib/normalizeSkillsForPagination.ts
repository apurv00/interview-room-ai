import type { ResumeData } from '../validators/resume'

const MAX_ITEMS_PER_CATEGORY = 20
const MAX_CATEGORY_TEXT_CHARS = 220

function truncateItems(items: string[]): string[] {
  if (items.length <= MAX_ITEMS_PER_CATEGORY) {
    let textBudget = 0
    const kept: string[] = []
    for (const item of items) {
      const next = (kept.length ? 2 : 0) + item.length
      if (textBudget + next > MAX_CATEGORY_TEXT_CHARS) break
      kept.push(item)
      textBudget += next
    }
    if (kept.length === items.length) return items
    return kept.length > 0 ? [...kept, '…'] : [items[0], '…']
  }

  const capped = items.slice(0, MAX_ITEMS_PER_CATEGORY)
  return [...capped, '…']
}

export function normalizeSkillsForPagination(data: ResumeData): ResumeData {
  if (!data.skills?.length) return data

  return {
    ...data,
    skills: data.skills.map(category => ({
      ...category,
      items: truncateItems(category.items),
    })),
  }
}
