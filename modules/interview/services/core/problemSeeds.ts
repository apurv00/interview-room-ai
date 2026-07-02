import { CODING_PROBLEMS, PROBLEM_POOL_FALLBACK } from '@interview/config/codingProblems'
import { DESIGN_PROBLEMS } from '@interview/config/designProblems'
import { retrieveQuestions } from '@interview/services/persona/retrievalService'
import type { CodingProblem } from '@interview/config/codingProblems'
import type { DesignProblem } from '@interview/config/designProblems'

/**
 * Exemplar seeding for AI problem generation.
 *
 * The static pools (52 coding / 10 design problems) and the QuestionBank's
 * coding/system-design rows are hand-curated content that previously never
 * reached the generation path. These builders render a small
 * <style_exemplars> block for the generation prompt: the model matches the
 * register (scoping, clarity, rubric depth) WITHOUT reusing the scenarios.
 * Every failure path degrades to an empty block — seeding must never block
 * generation. The pool exemplar's title is returned alongside the block so
 * the near-duplicate guard can catch the model copying the one problem the
 * prompt shows it every time.
 */

export interface SeedBlock {
  block: string
  /** Pool exemplar title(s) — fed into the near-duplicate collision set. */
  exemplarTitles: Array<{ title: string }>
}

const EMPTY_SEED: SeedBlock = { block: '', exemplarTitles: [] }

const SEED_INSTRUCTION =
  'Reference problems in the register we want — match their QUALITY, SCOPING, and CLARITY. ' +
  'Do NOT reuse their scenario, storyline, or a renamed variant of them.'

const DESC_HEAD = 300

function wrapSeedBlock(lines: string[]): string {
  if (lines.length === 0) return ''
  const numbered = lines.map((l, i) => `${i + 1}. ${l}`)
  // The instruction sits OUTSIDE the tags: the generation prompts carry
  // DATA_BOUNDARY_RULE, which tells the model XML-tagged content is reference
  // data whose embedded directives must be ignored. Only the exemplar TEXT
  // (bank rows could theoretically carry adversarial content) belongs inside.
  return `\nStyle exemplars are provided in <style_exemplars> below. ${SEED_INSTRUCTION}\n<style_exemplars>\n${numbered.join('\n')}\n</style_exemplars>\n`
}

/** Deterministic pool exemplar: first native (or borrowed) problem at the target difficulty. */
function pickCodingExemplar(domain: string, difficulty: CodingProblem['difficulty']): CodingProblem | null {
  const forDomain = (dom: string) => CODING_PROBLEMS.filter((p) => p.applicableDomains.includes(dom))
  let pool = forDomain(domain)
  if (pool.length === 0) {
    const fallback = PROBLEM_POOL_FALLBACK[domain]
    if (fallback) pool = forDomain(fallback)
  }
  if (pool.length === 0) return null
  return pool.find((p) => p.difficulty === difficulty) ?? pool[0]
}

// Design twin of PROBLEM_POOL_FALLBACK. Deliberately NO whole-pool fallback:
// the generation prompt tells non-web roles "do NOT default to a generic web
// service (URL shortener…)" — falling back to DESIGN_PROBLEMS[0] handed those
// exact roles "Design a URL Shortener" as their style exemplar, contradicting
// the instruction in the same prompt. Unmapped domains get bank exemplars only.
const DESIGN_POOL_FALLBACK: Record<string, string> = {
  fullstack: 'backend',
  devops: 'backend',
  mobile: 'frontend',
  'ml-engineer': 'data-science',
  'data-analyst': 'data-science',
}

function pickDesignExemplar(domain: string, difficulty: DesignProblem['difficulty']): DesignProblem | null {
  const forDomain = (dom: string) => DESIGN_PROBLEMS.filter((p) => p.applicableDomains.includes(dom))
  let pool = forDomain(domain)
  if (pool.length === 0) {
    const fallback = DESIGN_POOL_FALLBACK[domain]
    pool = fallback ? forDomain(fallback) : []
  }
  if (pool.length === 0) return null
  return pool.find((p) => p.difficulty === difficulty) ?? pool[0]
}

async function bankExemplars(domain: string, interviewType: 'coding' | 'system-design'): Promise<string[]> {
  try {
    // No difficulty filter on purpose: the bank has almost no 'easy' rows for
    // these types, so filtering would starve 0-2 candidates of exemplars.
    // trackUsage:false — these rows are style references, never served to the
    // candidate; counting them would bias the real RAG's prefer-less-used
    // ordering (Codex P2 on #486).
    const rows = await retrieveQuestions({ domain, interviewType, limit: 2, trackUsage: false })
    return rows.map((q) => {
      const points = q.idealAnswerPoints?.length
        ? ` (a strong answer covers: ${q.idealAnswerPoints.slice(0, 3).join('; ')})`
        : ''
      return `${q.question.slice(0, DESC_HEAD)}${points}`
    })
  } catch {
    return []
  }
}

export async function buildCodingSeedBlock(
  domain: string,
  difficulty: CodingProblem['difficulty'],
): Promise<SeedBlock> {
  const lines: string[] = []
  const exemplarTitles: Array<{ title: string }> = []
  const exemplar = pickCodingExemplar(domain, difficulty)
  if (exemplar) {
    lines.push(`"${exemplar.title}" — ${exemplar.description.slice(0, DESC_HEAD)}`)
    exemplarTitles.push({ title: exemplar.title })
  }
  lines.push(...(await bankExemplars(domain, 'coding')))
  if (lines.length === 0) return EMPTY_SEED
  return { block: wrapSeedBlock(lines), exemplarTitles }
}

export async function buildDesignSeedBlock(
  domain: string,
  difficulty: DesignProblem['difficulty'],
): Promise<SeedBlock> {
  const lines: string[] = []
  const exemplarTitles: Array<{ title: string }> = []
  const exemplar = pickDesignExemplar(domain, difficulty)
  if (exemplar) {
    const reqs = exemplar.requirements?.length
      ? ` Requirements include: ${exemplar.requirements.slice(0, 3).join('; ')}.`
      : ''
    lines.push(`"${exemplar.title}" — ${exemplar.description.slice(0, DESC_HEAD)}${reqs}`)
    exemplarTitles.push({ title: exemplar.title })
  }
  lines.push(...(await bankExemplars(domain, 'system-design')))
  if (lines.length === 0) return EMPTY_SEED
  return { block: wrapSeedBlock(lines), exemplarTitles }
}

/**
 * Neutralize a ledger/LLM-sourced string for inline prompt interpolation:
 * strip angle brackets (no tag escapes), collapse whitespace (no multi-line
 * instruction smuggling), cap the length. Ledger titles are client-writable
 * via POST /api/problems/served, so they are untrusted.
 */
export function neutralizePromptLine(s: string, cap: number = 80): string {
  return s.replace(/[<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, cap)
}

/**
 * Render the avoid-list for a generation prompt. Titled entries (from the
 * ServedProblem ledger) render as "- Title (id)" — a title is something the
 * model can actually avoid, unlike an opaque `ai-generated-<timestamp>` id.
 * Cap raised from 20 bare ids to 30 lines; entries arrive most-recent-first
 * so the cap keeps the freshest exclusions. Every field is neutralized —
 * titles are candidate-writable — and the caller must place the result
 * inside a data-boundary tag (<already_served_problems>).
 */
export function formatAvoidList(
  entries: Array<{ id: string; title?: string }>,
  cap: number = 30,
): string {
  return entries
    .slice(0, cap)
    .map((e) => (e.title
      ? `- ${neutralizePromptLine(e.title)} (${neutralizePromptLine(e.id)})`
      : `- ${neutralizePromptLine(e.id)}`))
    .join('\n')
}

/**
 * AI problem ids come from the model — unbounded and unsanitized, and once
 * recorded in the ledger they round-trip through the history routes into the
 * generate routes' 64-char per-item Zod cap, where ONE over-long id would 400
 * every future generation call. Slug + clamp at the source; a non-string or
 * empty id falls back to the caller's timestamped unique fallback.
 */
export function toAiProblemId(raw: unknown, fallback: string): string {
  const slug = (typeof raw === 'string' ? raw : '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 56)
  return `ai-${slug || fallback}`.slice(0, 64)
}
