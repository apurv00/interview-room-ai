import type { ResumeCustomSection } from '../validators/resume'

export interface PartitionedCustomSections {
  sideProjects: ResumeCustomSection[]
  interests: ResumeCustomSection[]
  other: ResumeCustomSection[]
}

/** Startup template routes custom blocks by title keywords. */
export function partitionStartupCustomSections(
  sections: ResumeCustomSection[] | undefined,
): PartitionedCustomSections {
  const list = sections ?? []
  const sideProjects: ResumeCustomSection[] = []
  const interests: ResumeCustomSection[] = []
  const other: ResumeCustomSection[] = []

  for (const section of list) {
    const lower = section.title.toLowerCase()
    if (lower.includes('side project') || lower.includes('side-project')) {
      sideProjects.push(section)
    } else if (lower.includes('interest')) {
      interests.push(section)
    } else {
      other.push(section)
    }
  }

  return { sideProjects, interests, other }
}
