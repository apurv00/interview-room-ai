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
 * Every failure path degrades to '' — seeding must never block generation.
 */

const SEED_INSTRUCTION =
  'Reference problems in the register we want — match their QUALITY, SCOPING, and CLARITY. ' +
  'Do NOT reuse their scenario, storyline, or a renamed variant of them.'

const DESC_HEAD = 300

function wrapSeedBlock(lines: string[]): string {
  if (lines.length === 0) return ''
  const numbered = lines.map((l, i) => `${i + 1}. ${l}`)
  return `\n<style_exemplars>\n${SEED_INSTRUCTION}\n${numbered.join('\n')}\n</style_exemplars>\n`
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

function pickDesignExemplar(domain: string, difficulty: DesignProblem['difficulty']): DesignProblem | null {
  let pool = DESIGN_PROBLEMS.filter((p) => p.applicableDomains.includes(domain))
  if (pool.length === 0) pool = DESIGN_PROBLEMS
  return pool.find((p) => p.difficulty === difficulty) ?? pool[0] ?? null
}

async function bankExemplars(domain: string, interviewType: 'coding' | 'system-design'): Promise<string[]> {
  try {
    // No difficulty filter on purpose: the bank has almost no 'easy' rows for
    // these types, so filtering would starve 0-2 candidates of exemplars.
    const rows = await retrieveQuestions({ domain, interviewType, limit: 2 })
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
): Promise<string> {
  const lines: string[] = []
  const exemplar = pickCodingExemplar(domain, difficulty)
  if (exemplar) lines.push(`"${exemplar.title}" — ${exemplar.description.slice(0, DESC_HEAD)}`)
  lines.push(...(await bankExemplars(domain, 'coding')))
  return wrapSeedBlock(lines)
}

export async function buildDesignSeedBlock(
  domain: string,
  difficulty: DesignProblem['difficulty'],
): Promise<string> {
  const lines: string[] = []
  const exemplar = pickDesignExemplar(domain, difficulty)
  if (exemplar) {
    const reqs = exemplar.requirements?.length
      ? ` Requirements include: ${exemplar.requirements.slice(0, 3).join('; ')}.`
      : ''
    lines.push(`"${exemplar.title}" — ${exemplar.description.slice(0, DESC_HEAD)}${reqs}`)
  }
  lines.push(...(await bankExemplars(domain, 'system-design')))
  return wrapSeedBlock(lines)
}

/**
 * Render the avoid-list for a generation prompt. Titled entries (from the
 * ServedProblem ledger) render as "- Title (id)" — a title is something the
 * model can actually avoid, unlike an opaque `ai-generated-<timestamp>` id.
 * Cap raised from 20 bare ids to 30 lines; entries arrive most-recent-first
 * so the cap keeps the freshest exclusions.
 */
export function formatAvoidList(
  entries: Array<{ id: string; title?: string }>,
  cap: number = 30,
): string {
  return entries
    .slice(0, cap)
    .map((e) => (e.title ? `- ${e.title} (${e.id})` : `- ${e.id}`))
    .join('\n')
}
