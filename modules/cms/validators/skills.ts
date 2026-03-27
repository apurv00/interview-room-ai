import { z } from 'zod'

const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export const UpdateSkillSchema = z.object({
  content: z.string().min(10).max(50000),
  isActive: z.boolean().optional(),
})

export const SkillParamsSchema = z.object({
  domain: z.string().min(1).max(100).regex(slugPattern, 'Domain must be lowercase alphanumeric with hyphens'),
  depth: z.string().min(1).max(100).regex(slugPattern, 'Depth must be lowercase alphanumeric with hyphens'),
})

// Required section headings for validation warnings
export const REQUIRED_SKILL_SECTIONS = [
  'Interviewer Persona',
  'Question Strategy',
  'Anti-Patterns',
  'Experience Calibration',
  'Scoring Emphasis',
  'Red Flags',
  'Sample Questions',
] as const

/**
 * Validate that markdown content has the required ## headings.
 * Returns array of missing section names (empty = all present).
 */
export function validateSkillSections(content: string): string[] {
  const missing: string[] = []
  for (const section of REQUIRED_SKILL_SECTIONS) {
    const pattern = new RegExp(`^## ${section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'm')
    if (!pattern.test(content)) {
      missing.push(section)
    }
  }
  return missing
}
