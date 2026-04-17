import crypto from 'crypto'
import { completion } from '@shared/services/modelRouter'
import { JSON_OUTPUT_RULE } from '@shared/services/promptSecurity'
import { connectDB } from '@shared/db/connection'
import { GeneratedLesson } from '@shared/db/models/GeneratedLesson'
import type { IGeneratedLesson } from '@shared/db/models/GeneratedLesson'
import { logger } from '@shared/logger'
import { getLessonBudget } from '@learn/config/lessonBudgets'

const _inFlight = new Map<string, Promise<IGeneratedLesson | null>>()

export interface GenerateLessonInput {
  competency: string
  domain: string
  depth: string
}

export interface LessonContent {
  title: string
  conceptSummary: string
  conceptDeepDive: string
  example: {
    question: string
    goodAnswer: string
    annotations: string[]
  }
  keyTakeaways: string[]
}

/**
 * Deterministic cache key so the same competency/domain/depth triple maps to the
 * same cached lesson across users.
 */
export function buildLessonCacheKey(competency: string, domain: string, depth: string): string {
  const normalized = `${competency}|${domain}|${depth}`.toLowerCase()
  return crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 24)
}

/**
 * Get or generate a lesson. Returns the cached lesson if one exists with a
 * non-flagged review status; otherwise calls the LLM and caches.
 * If a lesson is flagged as 'overridden', returns the overrideContent wrapped
 * as a minimal LessonContent.
 */
export async function getOrGenerateLesson(
  input: GenerateLessonInput,
): Promise<IGeneratedLesson | null> {
  try {
    await connectDB()
    const cacheKey = buildLessonCacheKey(input.competency, input.domain, input.depth)

    const cached = await GeneratedLesson.findOne({ cacheKey })
    if (cached && cached.reviewStatus !== 'flagged') {
      return cached
    }

    const existing = _inFlight.get(cacheKey)
    if (existing) return await existing

    const promise = generateAndCache(cacheKey, input, cached)
    _inFlight.set(cacheKey, promise)
    try {
      return await promise
    } finally {
      _inFlight.delete(cacheKey)
    }
  } catch (err) {
    logger.error({ err, input }, 'Lesson generation failed')
    return null
  }
}

async function generateAndCache(
  cacheKey: string,
  input: GenerateLessonInput,
  staleDoc: IGeneratedLesson | null,
): Promise<IGeneratedLesson | null> {
  const budget = getLessonBudget(input.competency)
  const lesson = await generateLessonContent(input, budget.maxTokens)
  if (!lesson) return staleDoc ?? null

  const doc = await GeneratedLesson.findOneAndUpdate(
    { cacheKey },
    {
      cacheKey,
      competency: input.competency,
      domain: input.domain,
      depth: input.depth,
      title: lesson.title,
      conceptSummary: lesson.conceptSummary,
      conceptDeepDive: lesson.conceptDeepDive,
      example: lesson.example,
      keyTakeaways: lesson.keyTakeaways,
      tokenBudgetUsed: budget.maxTokens,
      generatedByModel: 'learn.pathway-lesson',
      reviewStatus: 'pending',
    },
    { upsert: true, new: true },
  )

  return doc
}

async function generateLessonContent(
  input: GenerateLessonInput,
  maxTokens: number,
): Promise<LessonContent | null> {
  try {
    const prompt = buildLessonPrompt(input)
    const result = await completion({
      taskSlot: 'learn.pathway-lesson',
      system:
        'You are an expert interview coach. Generate a concise, actionable lesson for a single competency. Keep explanations concrete and example-driven. Avoid fluff.',
      messages: [{ role: 'user', content: prompt }],
      maxTokens,
    })

    const raw = (result.text || '{}').trim()
    const cleaned = raw
      .replace(/^```(?:json)?\n?/, '')
      .replace(/\n?```$/, '')
    const parsed = JSON.parse(cleaned) as LessonContent

    if (!isValidLesson(parsed)) {
      logger.warn({ input }, 'Generated lesson failed validation')
      return null
    }
    return parsed
  } catch (err) {
    logger.error({ err, input }, 'LLM lesson generation call failed')
    return null
  }
}

function buildLessonPrompt(input: GenerateLessonInput): string {
  const { competency, domain, depth } = input
  const niceCompetency = competency.replace(/_/g, ' ')
  return `Generate a lesson teaching "${niceCompetency}" for a ${domain} candidate preparing for a ${depth} interview.

${JSON_OUTPUT_RULE}
{
  "title": "Short lesson title (6-10 words)",
  "conceptSummary": "2-3 sentence plain-English summary of what ${niceCompetency} means and why it matters in ${domain} interviews",
  "conceptDeepDive": "3-5 sentences: the concrete framework or technique, with specific steps or heuristics",
  "example": {
    "question": "Realistic ${depth} interview question where ${niceCompetency} is tested",
    "goodAnswer": "A concrete, impressive answer (120-200 words) demonstrating ${niceCompetency}",
    "annotations": ["3-4 bullets explaining what makes the answer strong, each 8-15 words"]
  },
  "keyTakeaways": ["3-4 bullets, each 6-12 words, that a candidate can remember before the interview"]
}`
}

function isValidLesson(obj: unknown): obj is LessonContent {
  if (!obj || typeof obj !== 'object') return false
  const l = obj as Record<string, unknown>
  if (typeof l.title !== 'string' || !l.title) return false
  if (typeof l.conceptSummary !== 'string' || !l.conceptSummary) return false
  if (typeof l.conceptDeepDive !== 'string') return false
  if (!l.example || typeof l.example !== 'object') return false
  const ex = l.example as Record<string, unknown>
  if (typeof ex.question !== 'string' || !ex.question) return false
  if (typeof ex.goodAnswer !== 'string' || !ex.goodAnswer) return false
  if (!Array.isArray(ex.annotations)) return false
  if (!Array.isArray(l.keyTakeaways) || l.keyTakeaways.length === 0) return false
  return true
}

/**
 * Mark a lesson as flagged so it will be regenerated on next access.
 * Used by CMS review flow when a lesson quality issue is detected.
 */
export async function flagLesson(cacheKey: string): Promise<boolean> {
  try {
    await connectDB()
    const result = await GeneratedLesson.updateOne(
      { cacheKey },
      { $set: { reviewStatus: 'flagged' } },
    )
    return result.modifiedCount > 0
  } catch (err) {
    logger.error({ err, cacheKey }, 'Failed to flag lesson')
    return false
  }
}
