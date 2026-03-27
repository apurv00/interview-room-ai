import * as fs from 'fs'
import * as path from 'path'
import type { ExperienceLevel } from '@shared/types'
import { aiLogger } from '@shared/logger'

export type SkillSection =
  | 'interviewer-persona'
  | 'depth-meaning'
  | 'question-strategy'
  | 'anti-patterns'
  | 'experience-calibration'
  | 'scoring-emphasis'
  | 'red-flags'
  | 'sample-questions'

// Heading text → SkillSection key mapping
const HEADING_MAP: Record<string, SkillSection> = {
  'interviewer persona': 'interviewer-persona',
  'what this depth means for this domain': 'depth-meaning',
  'question strategy': 'question-strategy',
  'anti-patterns': 'anti-patterns',
  'experience calibration': 'experience-calibration',
  'scoring emphasis': 'scoring-emphasis',
  'red flags': 'red-flags',
  'sample questions': 'sample-questions',
}

// Experience heading → ExperienceLevel mapping
const EXP_HEADING_MAP: Record<string, ExperienceLevel | 'all'> = {
  'entry level (0-2 years)': '0-2',
  'mid level (3-6 years)': '3-6',
  'senior (7+ years)': '7+',
  'all levels': 'all',
}

// ─── Cache ─────────────────────────────────────────────────────────────────────

const skillCache = new Map<string, string>()
const parsedCache = new Map<string, Map<SkillSection, string>>()

function getSkillsDir(): string {
  return path.join(process.cwd(), 'modules', 'interview', 'skills')
}

function loadSkillFile(domain: string, depth: string): string | null {
  const key = `${domain}-${depth}`
  if (skillCache.has(key)) return skillCache.get(key)!

  try {
    const filePath = path.join(getSkillsDir(), `${key}.md`)
    const content = fs.readFileSync(filePath, 'utf-8')
    skillCache.set(key, content)
    return content
  } catch {
    aiLogger.warn({ domain, depth }, 'Skill file not found')
    return null
  }
}

// ─── Section Parsing ────────────────────────────────────────────────────────────

function parseSections(content: string): Map<SkillSection, string> {
  const sections = new Map<SkillSection, string>()
  const lines = content.split('\n')
  let currentSection: SkillSection | null = null
  let currentContent: string[] = []

  for (const line of lines) {
    // Match ## headings (not ### sub-headings)
    const h2Match = line.match(/^## (.+)$/)
    if (h2Match) {
      // Save previous section
      if (currentSection) {
        sections.set(currentSection, currentContent.join('\n').trim())
      }
      const heading = h2Match[1].trim().toLowerCase()
      currentSection = HEADING_MAP[heading] || null
      currentContent = []
      continue
    }
    if (currentSection) {
      currentContent.push(line)
    }
  }
  // Save last section
  if (currentSection) {
    sections.set(currentSection, currentContent.join('\n').trim())
  }

  return sections
}

function getParsedSections(domain: string, depth: string): Map<SkillSection, string> | null {
  const key = `${domain}-${depth}`
  if (parsedCache.has(key)) return parsedCache.get(key)!

  const content = loadSkillFile(domain, depth)
  if (!content) return null

  const sections = parseSections(content)
  parsedCache.set(key, sections)
  return sections
}

// ─── Public API ─────────────────────────────────────────────────────────────────

/**
 * Get full skill file content for a domain:depth combination.
 */
export function getSkillContent(domain: string, depth: string): string | null {
  return loadSkillFile(domain, depth)
}

/**
 * Extract specific sections from a skill file.
 * Returns concatenated content of requested sections, or empty string if none found.
 */
export function getSkillSections(
  domain: string,
  depth: string,
  sections: SkillSection[],
): string {
  const parsed = getParsedSections(domain, depth)
  if (!parsed) return ''

  const parts: string[] = []
  for (const section of sections) {
    const content = parsed.get(section)
    if (content) parts.push(content)
  }
  return parts.join('\n\n')
}

/**
 * Select experience-appropriate questions from the skill file's Sample Questions section.
 * Returns a formatted string of up to `count` questions, randomized for variety.
 */
export function selectSkillQuestions(
  domain: string,
  depth: string,
  experience: ExperienceLevel,
  count: number = 3,
): string {
  const parsed = getParsedSections(domain, depth)
  if (!parsed) return ''

  const questionsSection = parsed.get('sample-questions')
  if (!questionsSection) return ''

  // Parse questions grouped by experience level sub-heading
  const lines = questionsSection.split('\n')
  let currentExpLevel: ExperienceLevel | 'all' | null = null
  const questionsByLevel = new Map<ExperienceLevel | 'all', string[]>()

  for (const line of lines) {
    const h3Match = line.match(/^### (.+)$/)
    if (h3Match) {
      const heading = h3Match[1].trim().toLowerCase()
      currentExpLevel = EXP_HEADING_MAP[heading] || null
      continue
    }
    // Collect question lines (start with number + dot + space + quote)
    if (currentExpLevel && /^\d+\.\s+"/.test(line)) {
      if (!questionsByLevel.has(currentExpLevel)) {
        questionsByLevel.set(currentExpLevel, [])
      }
      // Collect this question and its metadata (next line with "- Targets:")
      questionsByLevel.get(currentExpLevel)!.push(line)
    }
    // Collect metadata lines for the last question
    if (currentExpLevel && line.trim().startsWith('- Targets:')) {
      const arr = questionsByLevel.get(currentExpLevel)
      if (arr && arr.length > 0) {
        arr[arr.length - 1] += '\n   ' + line.trim()
      }
    }
  }

  // Gather matching questions (exact experience + 'all')
  const candidates: string[] = [
    ...(questionsByLevel.get(experience) || []),
    ...(questionsByLevel.get('all') || []),
  ]

  if (candidates.length === 0) return ''

  // Shuffle and pick `count`
  const shuffled = [...candidates].sort(() => Math.random() - 0.5)
  return shuffled.slice(0, count).map((q, i) => `${i + 1}. ${q.replace(/^\d+\.\s+/, '')}`).join('\n')
}
