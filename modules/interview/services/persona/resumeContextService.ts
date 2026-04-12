import { parseResumeToStructured } from '@resume'
import { isFeatureEnabled } from '@shared/featureFlags'
import { logger } from '@shared/logger'

// ─── Types ─────────────────────────────────────────────────────────────────

export interface ResumeExperience {
  id: string
  company: string
  title: string
  location?: string
  startDate?: string
  endDate?: string
  bullets: string[]
}

export interface ResumeEducation {
  id?: string
  institution: string
  degree: string
  field?: string
  graduationDate?: string
}

export interface ResumeSkillGroup {
  category: string
  items: string[]
}

export interface ResumeProject {
  id: string
  name: string
  description: string
  technologies: string[]
  url?: string
}

export interface ResumeCertification {
  name: string
  issuer: string
  date?: string
}

export interface ParsedResume {
  contactInfo?: {
    fullName?: string
    email?: string
    phone?: string
    location?: string
    linkedin?: string
    website?: string
    github?: string
  }
  summary?: string
  experience: ResumeExperience[]
  education: ResumeEducation[]
  skills: ResumeSkillGroup[]
  projects: ResumeProject[]
  certifications?: ResumeCertification[]
}

// ─── Domain Keyword Bags ───────────────────────────────────────────────────
// Keys mirror the 8 built-in domain slugs in shared/db/seed.ts. Unknown
// domains fall back to an empty list, so `filterResumeByDomain` degrades to
// "keep the most recent entries" rather than erroring.

const DOMAIN_KEYWORDS: Record<string, string[]> = {
  general: ['leadership', 'team', 'project', 'stakeholder', 'impact', 'ownership', 'result'],
  frontend: ['react', 'vue', 'angular', 'typescript', 'css', 'accessibility', 'ui', 'component', 'web', 'next.js', 'performance'],
  backend: ['api', 'service', 'database', 'distributed', 'scal', 'microservice', 'sql', 'nosql', 'infrastructure', 'ci/cd', 'observability'],
  sdet: ['test', 'automation', 'qa', 'selenium', 'cypress', 'e2e', 'coverage', 'regression', 'quality', 'framework'],
  'data-science': ['ml', 'model', 'python', 'pandas', 'sql', 'statistics', 'experiment', 'a/b', 'feature', 'prediction', 'forecast'],
  pm: ['product', 'roadmap', 'stakeholder', 'strategy', 'launch', 'metrics', 'user', 'growth', 'prioritiz', 'okr', 'kpi', 'experiment'],
  design: ['figma', 'prototype', 'user research', 'ux', 'wireframe', 'design system', 'accessibility', 'interaction'],
  business: ['strategy', 'revenue', 'client', 'deal', 'gtm', 'market', 'financial', 'p&l', 'growth', 'negotiation', 'forecast'],
}

const MAX_EXPERIENCES = 5
const MAX_SKILLS = 10
const MAX_PROJECTS = 3
const MAX_BULLETS_PER_EXPERIENCE = 3

// ─── Scoring Helpers ───────────────────────────────────────────────────────

function countKeywordHits(text: string, keywords: string[]): number {
  if (!text || keywords.length === 0) return 0
  const lower = text.toLowerCase()
  let hits = 0
  for (const kw of keywords) {
    // Simple substring count — good enough for rank-based filtering and avoids
    // the regex-escape surface area.
    let idx = 0
    while ((idx = lower.indexOf(kw, idx)) !== -1) {
      hits += 1
      idx += kw.length
    }
  }
  return hits
}

function scoreExperience(exp: ResumeExperience, keywords: string[]): number {
  const titleHits = countKeywordHits(exp.title, keywords)
  const bulletHits = countKeywordHits(exp.bullets.join(' '), keywords)
  const base = titleHits * 2 + bulletHits
  // Recency boost — current roles float to the top.
  const isCurrent = (exp.endDate || '').toLowerCase() === 'present'
  return isCurrent ? base * 1.5 : base
}

function scoreSkillGroup(group: ResumeSkillGroup, keywords: string[]): number {
  return countKeywordHits(group.items.join(' '), keywords) + countKeywordHits(group.category, keywords)
}

function scoreProject(project: ResumeProject, keywords: string[]): number {
  return (
    countKeywordHits(project.description, keywords) +
    countKeywordHits((project.technologies || []).join(' '), keywords) +
    countKeywordHits(project.name, keywords)
  )
}

// ─── Domain-Relevance Filter ───────────────────────────────────────────────

/**
 * Rank-based filter — non-LLM. Keeps the top N most domain-relevant
 * experiences / skills / projects. Always includes the most recent experience
 * (even if it scores 0) so the prompt still has recency context.
 *
 * Returns a SHALLOW copy; the original ParsedResume is not mutated.
 */
export function filterResumeByDomain(parsed: ParsedResume, domain: string): ParsedResume {
  const keywords = DOMAIN_KEYWORDS[domain] || []

  // ── Experience ──
  const scoredExps = (parsed.experience || []).map((exp, idx) => ({
    exp,
    score: scoreExperience(exp, keywords),
    originalIndex: idx,
  }))

  // Most-recent wins tie-breakers. We assume the array is already ordered by
  // recency (standard resume convention) — index 0 is the most recent.
  const mostRecentIdx = 0
  const sortedByScore = [...scoredExps].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    return a.originalIndex - b.originalIndex
  })

  const picked = new Set<number>()
  const selectedExps: ResumeExperience[] = []
  // Always include the most recent experience first, regardless of score.
  if (scoredExps[mostRecentIdx]) {
    selectedExps.push(scoredExps[mostRecentIdx].exp)
    picked.add(mostRecentIdx)
  }
  for (const entry of sortedByScore) {
    if (selectedExps.length >= MAX_EXPERIENCES) break
    if (picked.has(entry.originalIndex)) continue
    selectedExps.push(entry.exp)
    picked.add(entry.originalIndex)
  }

  // ── Skills (flatten, score items individually, regroup top N) ──
  type ScoredSkill = { category: string; item: string; score: number }
  const scoredItems: ScoredSkill[] = []
  for (const group of parsed.skills || []) {
    for (const item of group.items || []) {
      scoredItems.push({
        category: group.category,
        item,
        score: countKeywordHits(item, keywords),
      })
    }
  }
  scoredItems.sort((a, b) => b.score - a.score)
  const topSkillItems = scoredItems.slice(0, MAX_SKILLS)
  // Regroup by category, preserving per-category order based on the top slice.
  const regroupedMap = new Map<string, string[]>()
  for (const s of topSkillItems) {
    const list = regroupedMap.get(s.category) || []
    list.push(s.item)
    regroupedMap.set(s.category, list)
  }
  const filteredSkills: ResumeSkillGroup[] = Array.from(regroupedMap.entries()).map(([category, items]) => ({
    category,
    items,
  }))

  // ── Projects ──
  const scoredProjects = (parsed.projects || []).map((p) => ({ p, score: scoreProject(p, keywords) }))
  scoredProjects.sort((a, b) => b.score - a.score)
  const filteredProjects = scoredProjects.slice(0, MAX_PROJECTS).map((sp) => sp.p)

  return {
    ...parsed,
    experience: selectedExps,
    skills: filteredSkills,
    projects: filteredProjects,
  }
}

// ─── Prompt Context Builder ────────────────────────────────────────────────

/**
 * Compact prompt block — analog of `buildParsedJDContext` in jdParserService.
 * Importance-ranked and token-efficient; typically 300–600 chars vs. the
 * ~2500 chars of raw resume text that the old .slice() path injected.
 */
export function buildParsedResumeContext(parsed: ParsedResume, domain: string): string {
  const filtered = filterResumeByDomain(parsed, domain)
  const parts: string[] = []

  if (filtered.summary) {
    parts.push(`SUMMARY: ${filtered.summary.slice(0, 240)}`)
  }

  if (filtered.experience.length) {
    parts.push('RELEVANT EXPERIENCE:')
    for (const e of filtered.experience) {
      const dateRange = [e.startDate, e.endDate].filter(Boolean).join(' – ')
      const header = dateRange ? `${e.title} @ ${e.company} (${dateRange})` : `${e.title} @ ${e.company}`
      parts.push(`  - ${header}`)
      for (const b of (e.bullets || []).slice(0, MAX_BULLETS_PER_EXPERIENCE)) {
        parts.push(`    • ${b}`)
      }
    }
  }

  if (filtered.skills.length) {
    const flat = filtered.skills.flatMap((g) => g.items).slice(0, MAX_SKILLS)
    if (flat.length) {
      parts.push(`KEY SKILLS: ${flat.join(', ')}`)
    }
  }

  if (filtered.projects.length) {
    parts.push('NOTABLE PROJECTS:')
    for (const p of filtered.projects) {
      parts.push(`  - ${p.name}: ${(p.description || '').slice(0, 140)}`)
    }
  }

  if (parts.length === 0) return ''
  return `CANDIDATE RESUME ANALYSIS:\n${parts.join('\n')}`
}

// ─── Parse + Cache Entry Point ─────────────────────────────────────────────

/**
 * Parse raw resume text via the existing Resume Builder LLM parser, normalize
 * the shape, and return it. Returns null when the feature flag is off or the
 * parser fails — callers must handle null (fall back to raw .slice()).
 *
 * Does NOT touch Redis or Mongo itself; the caller (createSession) is
 * responsible for persisting to `InterviewSession.parsedResume` and warming
 * the Redis cache via `documentContextCache`.
 */
export async function parseAndCacheResume(
  sessionId: string,
  resumeText: string,
  _domain: string,
): Promise<ParsedResume | null> {
  if (!isFeatureEnabled('resume_structured_parsing')) return null
  if (!resumeText || resumeText.trim().length < 20) return null

  try {
    const raw = await parseResumeToStructured(resumeText)
    if (!raw || typeof raw !== 'object') return null

    const normalized: ParsedResume = {
      contactInfo: raw.contactInfo || undefined,
      summary: typeof raw.summary === 'string' ? raw.summary : undefined,
      experience: Array.isArray(raw.experience) ? raw.experience : [],
      education: Array.isArray(raw.education) ? raw.education : [],
      skills: Array.isArray(raw.skills) ? raw.skills : [],
      projects: Array.isArray(raw.projects) ? raw.projects : [],
      certifications: Array.isArray(raw.certifications) ? raw.certifications : undefined,
    }

    return normalized
  } catch (err) {
    logger.warn({ err, sessionId }, 'parseAndCacheResume failed — falling back to raw slice')
    return null
  }
}
