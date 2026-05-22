/**
 * Detect and rewrite robotic / evaluator-style drill questions.
 *
 * Wave 2 / UAT-019: drill mode replays past evaluation questions
 * verbatim. The live interview pipeline occasionally asks short
 * probe follow-ups like "What exactly do you mean by X?" — those
 * are coherent in the live context (X refers to the prior answer)
 * but useless when surfaced standalone in the drill list.
 *
 * Strategy:
 *   - Detect meta probes via a small set of anchored regexes.
 *     Anchors are at the start of the string so a real question
 *     that happens to contain "elaborate" inside it doesn't trip
 *     the filter.
 *   - When matched, replace with a competency-targeted drill
 *     question drawn from a curated pool (deterministically
 *     rotated by sessionId + questionIndex).
 *   - Pass non-meta questions through unchanged.
 *
 * Probe templates live at modules/interview/hooks/interviewUtils.ts
 * (`buildProbeText`). Keep the anchors here in sync if those
 * templates are renamed.
 */

const META_PROBE_PATTERNS: RegExp[] = [
  /^\s*can you tell me more about\b/i,
  /^\s*what exactly do you mean by\b/i,
  /^\s*how did you specifically approach\b/i,
  /^\s*can you put a number on\b/i,
  /^\s*can you elaborate on\b/i,
  // Adjacent shapes seen in past sessions (clarify/expand variants).
  /^\s*could you walk me through\b.*\?\s*$/i,
  /^\s*could you elaborate\b/i,
]

/**
 * Curated per-competency drill questions. 2 variants each so the same
 * meta probe doesn't always rewrite to the identical fallback.
 *
 * Voice intentionally matches Alex Chen's behavioral style — open-ended,
 * one short setup sentence, no model-prompt jargon.
 */
const DRILL_QUESTIONS: Record<string, string[]> = {
  relevance: [
    'Tell me about a time you had to choose between two competing priorities. How did you decide which one to focus on?',
    'Describe a moment when you realized you were solving the wrong problem. How did you reset?',
  ],
  structure: [
    'Walk me through a complex project from kickoff to launch. Keep it under two minutes.',
    'Tell me about a launch you led. What were the major beats from start to finish?',
  ],
  specificity: [
    'Tell me about a result you\'re proud of — give me the actual numbers behind it.',
    'Describe an outcome you delivered. What was the measurable impact and how did you know?',
  ],
  ownership: [
    'Tell me about a decision you owned that turned out to be wrong. What did you do next?',
    'Describe a time you took on something nobody else wanted. What was the result?',
  ],
}

const GENERIC_DRILL_QUESTIONS = [
  'Tell me about a recent project where you had to deliver something difficult. What did you do?',
  'Describe a moment where your judgment changed the outcome of a project. Walk me through it.',
]

function hashString(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0
  }
  return Math.abs(h)
}

export function isMetaDrillQuestion(question: string | null | undefined): boolean {
  if (!question) return false
  const q = String(question).trim()
  if (!q) return false
  return META_PROBE_PATTERNS.some(p => p.test(q))
}

/**
 * Pick a competency-targeted drill question, deterministically rotated.
 * Same rotationKey + same competency => same question, every call.
 */
export function pickDrillQuestion(
  competency: string | null | undefined,
  rotationKey: string,
): string {
  const key = (competency || '').toLowerCase().trim().replace(/[-\s]/g, '_')
  const pool = DRILL_QUESTIONS[key] || GENERIC_DRILL_QUESTIONS
  const idx = hashString(`${key}|${rotationKey}`) % pool.length
  return pool[idx]
}

/**
 * Returns the rewritten question if the input matches a meta probe
 * pattern, otherwise the input unchanged. `rotationKey` should be
 * stable per source-question (e.g. `${sessionId}-${questionIndex}`)
 * so the same robotic prompt always rewrites to the same fallback.
 */
export function rewriteMetaDrillQuestion(
  question: string,
  competency: string,
  rotationKey: string,
): { rewritten: boolean; question: string } {
  if (!isMetaDrillQuestion(question)) {
    return { rewritten: false, question }
  }
  return { rewritten: true, question: pickDrillQuestion(competency, rotationKey) }
}

/**
 * Exported for testing — every shipped fallback question is asserted
 * to be sanitizer-clean (no model-prompt jargon) and non-empty.
 */
export function _allDrillQuestions(): string[] {
  return [...Object.values(DRILL_QUESTIONS).flat(), ...GENERIC_DRILL_QUESTIONS]
}
