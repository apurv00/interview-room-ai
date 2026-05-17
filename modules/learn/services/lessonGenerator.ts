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
  const generated = await generateLessonContent(input, budget.maxTokens)
  if (!generated) return staleDoc ?? null

  const { content, wasRepaired } = generated
  const doc = await GeneratedLesson.findOneAndUpdate(
    { cacheKey },
    {
      cacheKey,
      competency: input.competency,
      domain: input.domain,
      depth: input.depth,
      title: content.title,
      conceptSummary: content.conceptSummary,
      conceptDeepDive: content.conceptDeepDive,
      example: content.example,
      keyTakeaways: content.keyTakeaways,
      tokenBudgetUsed: budget.maxTokens,
      generatedByModel: 'learn.pathway-lesson',
      // Codex P2 on PR #387 — repaired output may be missing trailing
      // fields (e.g. only 1 of 4 keyTakeaways) but still pass the
      // shape validator. Caching as 'flagged' makes the next read
      // bypass the cache (see getOrGenerateLesson's
      // `cached.reviewStatus !== 'flagged'` check) and regenerate
      // with a fresh LLM call. Trade-off: a permanently-too-large
      // lesson regenerates on every load; in practice the bumped
      // token budgets in lessonBudgets.ts make repair rare, so this
      // is acceptable. If logs show repeated repairs for the same
      // cacheKey, bump that competency's budget further.
      reviewStatus: wasRepaired ? 'flagged' : 'pending',
    },
    { upsert: true, returnDocument: 'after' },
  )

  return doc
}

interface GeneratedLessonContent {
  content: LessonContent
  /** True iff parse only succeeded after repairTruncatedJson — caller
   *  must cache as reviewStatus='flagged' so the next request
   *  regenerates instead of serving the partial forever. */
  wasRepaired: boolean
}

async function generateLessonContent(
  input: GenerateLessonInput,
  maxTokens: number,
): Promise<GeneratedLessonContent | null> {
  let raw = ''
  try {
    const prompt = buildLessonPrompt(input)
    const result = await completion({
      taskSlot: 'learn.pathway-lesson',
      system:
        'You are an expert interview coach. Generate a concise, actionable lesson for a single competency. Keep explanations concrete and example-driven. Avoid fluff.',
      messages: [{ role: 'user', content: prompt }],
      maxTokens,
    })

    raw = (result.text || '{}').trim()
    const cleaned = extractJsonObject(raw)
    const parsed = parseLessonJsonWithRepair(cleaned)

    if (!parsed || !isValidLesson(parsed.value)) {
      logger.warn(
        { input, rawTextPrefix: raw.slice(0, 400) },
        'Generated lesson failed validation',
      )
      return null
    }
    if (parsed.repaired) {
      // Codex P2 on PR #387 — surface repaired-but-valid lessons in the
      // logs so ops can see how often this fires post-budget-bump. The
      // caller marks the cached doc as 'flagged' (see generateAndCache)
      // so the next request regenerates fresh rather than serving the
      // partial content indefinitely.
      logger.warn(
        { input, rawTextPrefix: raw.slice(0, 400) },
        'Generated lesson required JSON repair — caching as flagged for regen',
      )
    }
    return { content: parsed.value as LessonContent, wasRepaired: parsed.repaired }
  } catch (err) {
    // Production diagnosis (2026-05-17): all 3 lessons on the Pathway
    // page returned 502 because the model occasionally returns prose
    // around the JSON, or fence variants the strip-regex didn't handle.
    // We now use extractJsonObject (front+back fence variants + balanced
    // {…} fallback) above, AND log the raw text (truncated) on parse
    // failure so future regressions are debuggable directly from Vercel
    // runtime logs instead of requiring a code-side reproduction.
    logger.error(
      { err, input, rawTextPrefix: raw.slice(0, 400) },
      'LLM lesson generation call failed',
    )
    return null
  }
}

/**
 * Pull a JSON object out of an LLM response, handling the most common
 * wrapping the model produces despite "respond with ONLY valid JSON":
 *
 *   1. Code-fenced output (with or without `json` hint, surrounding
 *      whitespace, trailing-only fences).
 *   2. Prose before/after the JSON ("Here's the lesson: {…}").
 *
 * Strategy:
 *   a) Strip leading/trailing whitespace and code fences (case-insensitive,
 *      both ``` and ```json variants, leading or trailing whitespace).
 *   b) If the result still doesn't start with `{`, fall back to slicing
 *      from the first `{` to the last `}` — a safe heuristic for any
 *      single-object response.
 *
 * Exported for tests; not part of the public API otherwise.
 */
/**
 * Parse JSON with a fallback repair pass for truncated output.
 *
 * Production diagnosis 2026-05-17 — even after the wrapping-extraction
 * fix in PR #386, lessons still 502'd. Vercel logs showed
 * "Unexpected end of JSON input" — the LLM was generating valid JSON
 * that ran out of tokens mid-output. We've bumped lesson token budgets
 * (lessonBudgets.ts), but as a belt-and-suspenders defence we also
 * try to repair truncated JSON before giving up.
 *
 * Strategy when the initial parse fails:
 *   1. Trim trailing junk after the last clean "field": ... boundary
 *   2. Close any unclosed string by dropping back to last balanced "
 *   3. Close unclosed brackets/braces in reverse open order
 *   4. Try parse again
 *
 * Returns null when both attempts fail — caller logs raw text for
 * debugging. We deliberately don't pull in a json-repair library:
 * lesson JSON is a known schema with no nested arrays of arrays, so
 * a small heuristic repair is enough.
 *
 * Exported for tests.
 */
export interface ParseLessonJsonResult {
  value: unknown
  /**
   * True when the JSON only parsed after `repairTruncatedJson` ran.
   * Caller MUST treat repaired output as a degraded result — the lesson
   * may be missing trailing fields (e.g. only 1 keyTakeaway of 4) even
   * when isValidLesson() passes, because the validator only enforces
   * non-empty arrays. Codex P2 on PR #387 — without flagging these,
   * partial lessons silently cached as successful and the user got
   * thin content forever.
   */
  repaired: boolean
}

export function parseLessonJsonWithRepair(text: string): ParseLessonJsonResult | null {
  try {
    return { value: JSON.parse(text), repaired: false }
  } catch {
    const repaired = repairTruncatedJson(text)
    if (repaired === text) return null // nothing changed; pointless to retry
    try {
      return { value: JSON.parse(repaired), repaired: true }
    } catch {
      return null
    }
  }
}

/**
 * Best-effort close on truncated JSON. Walks the string tracking
 * brace/bracket depth and whether we're inside a string. When we
 * stop at the end, we close any open string + structures in reverse
 * order. If the truncation occurred mid-value (e.g. `..."key": "abc`
 * with no closing quote), we trim back to the last comma or
 * structural boundary and close from there — yields a partial but
 * parseable object the validator can decide what to do with.
 *
 * Exported for tests.
 */
export function repairTruncatedJson(text: string): string {
  // Don't bother if the input doesn't even start as an object.
  if (!text.startsWith('{')) return text

  const stack: Array<'{' | '['> = []
  let inString = false
  let escape = false
  let lastSafeBoundary = -1 // index of last char where a clean close is possible

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (escape) { escape = false; continue }
    if (ch === '\\') { escape = true; continue }
    if (ch === '"') { inString = !inString; continue }
    if (inString) continue
    if (ch === '{' || ch === '[') stack.push(ch as '{' | '[')
    else if (ch === '}') { if (stack[stack.length - 1] === '{') stack.pop() }
    else if (ch === ']') { if (stack[stack.length - 1] === '[') stack.pop() }
    // A comma or closing structural char outside a string marks a
    // safe truncation point — the JSON up to and including this index
    // is potentially a complete prefix of fields.
    if ((ch === ',' || ch === '}' || ch === ']') && !inString) {
      lastSafeBoundary = i
    }
  }

  // If we ended inside a string, drop back to the last safe boundary
  // (a comma or closing brace) so we don't include the half-written
  // value when we close.
  let trimmed = text
  if (inString && lastSafeBoundary > 0) {
    trimmed = text.slice(0, lastSafeBoundary + 1)
    // Strip trailing comma — invalid in JSON.
    if (trimmed.endsWith(',')) trimmed = trimmed.slice(0, -1)
  } else if (trimmed.endsWith(',')) {
    // Even if we ended cleanly outside a string, JSON doesn't permit
    // trailing commas. Drop one if present.
    trimmed = trimmed.slice(0, -1)
  }

  // Recount structures on the trimmed string to know what to close.
  // (Cheaper than tracking diffs from above.)
  const closeStack: string[] = []
  let inStr2 = false
  let esc2 = false
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i]
    if (esc2) { esc2 = false; continue }
    if (ch === '\\') { esc2 = true; continue }
    if (ch === '"') { inStr2 = !inStr2; continue }
    if (inStr2) continue
    if (ch === '{') closeStack.push('}')
    else if (ch === '[') closeStack.push(']')
    else if (ch === '}' || ch === ']') closeStack.pop()
  }

  // Vercel Agent on PR #387 — close any unclosed string BEFORE closing
  // braces. Reaches here when the original walk ended inside a string
  // AND `lastSafeBoundary` was -1 (no comma/close-brace ever seen
  // outside a string), so the trim block above couldn't trim back to
  // a safe spot. Without this, `{"title":"unfinished` becomes
  // `{"title":"unfinished}` (invalid: string never terminates).
  let result = trimmed
  if (inStr2) {
    result += '"'
  }
  // Close any remaining open structures in reverse open order.
  while (closeStack.length > 0) {
    result += closeStack.pop()
  }
  return result
}

export function extractJsonObject(raw: string): string {
  let s = raw.trim()
  // Strip a leading code fence (```json\n / ```\n / ```)
  s = s.replace(/^```(?:json)?\s*/i, '')
  // Strip a trailing code fence (\n``` / ```)
  s = s.replace(/\s*```\s*$/i, '')
  s = s.trim()
  if (s.startsWith('{')) return s

  // Fall back: pull the first balanced-looking {…} block. We don't
  // try to be clever about nested braces inside strings — the entire
  // payload is a single object so first-{ to last-} is the right cut.
  const start = s.indexOf('{')
  const end = s.lastIndexOf('}')
  if (start >= 0 && end > start) {
    return s.slice(start, end + 1)
  }
  return s
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
