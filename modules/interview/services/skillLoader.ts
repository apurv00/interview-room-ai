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

// ─── Cache (DB content uses TTL, filesystem is permanent) ────────────────────

const DB_CACHE_TTL = 5 * 60 * 1000 // 5 minutes
const dbCache = new Map<string, { content: string; timestamp: number }>()
const fileCache = new Map<string, string>()
const parsedCache = new Map<string, { sections: Map<SkillSection, string>; timestamp: number }>()

function getSkillsDir(): string {
  return path.join(process.cwd(), 'modules', 'interview', 'skills')
}

function loadSkillFromFile(domain: string, depth: string): string | null {
  const key = `${domain}-${depth}`
  if (fileCache.has(key)) return fileCache.get(key)!

  try {
    const filePath = path.join(getSkillsDir(), `${key}.md`)
    const content = fs.readFileSync(filePath, 'utf-8')
    fileCache.set(key, content)
    return content
  } catch {
    return null
  }
}

async function loadSkillFromDB(domain: string, depth: string): Promise<string | null> {
  const key = `${domain}-${depth}`
  const cached = dbCache.get(key)
  if (cached && Date.now() - cached.timestamp < DB_CACHE_TTL) {
    return cached.content
  }

  try {
    // Dynamic import to avoid pulling mongoose into client bundles
    const { connectDB } = await import('@shared/db/connection')
    const { InterviewSkill } = await import('@shared/db/models')
    await connectDB()
    const doc = await InterviewSkill.findOne({ domain, depth, isActive: true }).lean()
    if (doc?.content) {
      dbCache.set(key, { content: doc.content, timestamp: Date.now() })
      return doc.content
    }
  } catch {
    // DB unavailable — fall through to file
  }
  return null
}

/**
 * Load the default skill content from the filesystem .md file.
 * Used by the "Reset to Default" CMS feature.
 */
export function getDefaultSkillContent(domain: string, depth: string): string | null {
  return loadSkillFromFile(domain, depth)
}

// ─── Section Parsing ────────────────────────────────────────────────────────────

function parseSections(content: string): Map<SkillSection, string> {
  const sections = new Map<SkillSection, string>()
  const lines = content.split('\n')
  let currentSection: SkillSection | null = null
  let currentContent: string[] = []

  for (const line of lines) {
    const h2Match = line.match(/^## (.+)$/)
    if (h2Match) {
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
  if (currentSection) {
    sections.set(currentSection, currentContent.join('\n').trim())
  }

  return sections
}

async function getParsedSections(domain: string, depth: string): Promise<Map<SkillSection, string> | null> {
  const key = `${domain}-${depth}`
  const cached = parsedCache.get(key)
  if (cached && Date.now() - cached.timestamp < DB_CACHE_TTL) {
    return cached.sections
  }

  const content = await getSkillContent(domain, depth)
  if (!content) return null

  const sections = parseSections(content)
  parsedCache.set(key, { sections, timestamp: Date.now() })
  return sections
}

// ─── Public API (async — checks DB first, falls back to filesystem) ──────────

/**
 * Get full skill content for a domain:depth combination.
 * Checks MongoDB first (CMS-edited), falls back to filesystem default.
 */
export async function getSkillContent(domain: string, depth: string): Promise<string | null> {
  const dbContent = await loadSkillFromDB(domain, depth)
  if (dbContent) return dbContent
  return loadSkillFromFile(domain, depth)
}

/**
 * Extract specific sections from a skill file.
 * Returns concatenated content of requested sections, or empty string if none found.
 */
export async function getSkillSections(
  domain: string,
  depth: string,
  sections: SkillSection[],
): Promise<string> {
  const parsed = await getParsedSections(domain, depth)
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
export async function selectSkillQuestions(
  domain: string,
  depth: string,
  experience: ExperienceLevel,
  count: number = 3,
): Promise<string> {
  const parsed = await getParsedSections(domain, depth)
  if (!parsed) return ''

  const questionsSection = parsed.get('sample-questions')
  if (!questionsSection) return ''

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
    if (currentExpLevel && /^\d+\.\s+"/.test(line)) {
      if (!questionsByLevel.has(currentExpLevel)) {
        questionsByLevel.set(currentExpLevel, [])
      }
      questionsByLevel.get(currentExpLevel)!.push(line)
    }
    if (currentExpLevel && line.trim().startsWith('- Targets:')) {
      const arr = questionsByLevel.get(currentExpLevel)
      if (arr && arr.length > 0) {
        arr[arr.length - 1] += '\n   ' + line.trim()
      }
    }
  }

  const candidates: string[] = [
    ...(questionsByLevel.get(experience) || []),
    ...(questionsByLevel.get('all') || []),
  ]

  if (candidates.length === 0) return ''

  const shuffled = [...candidates].sort(() => Math.random() - 0.5)
  return shuffled.slice(0, count).map((q, i) => `${i + 1}. ${q.replace(/^\d+\.\s+/, '')}`).join('\n')
}

/**
 * Invalidate cache for a specific skill (called after CMS edit).
 */
export function invalidateSkillCache(domain: string, depth: string): void {
  const key = `${domain}-${depth}`
  dbCache.delete(key)
  parsedCache.delete(key)
}
