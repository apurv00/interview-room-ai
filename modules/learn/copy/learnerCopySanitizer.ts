/**
 * Learner-facing copy sanitizer.
 *
 * Wave 2 / UAT-023: the `learn.pathway-plan` LLM slot routinely leaked
 * model-prompt jargon into pathway task titles/descriptions —
 * "five different prompts", "Use this template…", "Return as JSON…"
 * Candidates read these in the Learning tab and the framing reads like
 * an instructor talking to the model, not to them.
 *
 * Contract:
 *   - `sanitizeLearnerCopy(text)` returns `{ ok: true, text }` when
 *     the input is clean of banned learner-facing jargon.
 *   - Otherwise returns `{ ok: false, reason }` with the first matched
 *     banned token. Callers should discard the input and substitute
 *     curated copy (see modules/learn/copy/pathwayTaskTemplates.ts).
 *
 * The sanitizer is a hard reject — it does NOT attempt to rewrite the
 * input. Rewriting LLM output text in-place tends to produce ungrammatical
 * results; the curated pool covers every weak-dimension we ship.
 *
 * Banned tokens are matched with word boundaries so legitimate uses
 * inside compound English don't false-positive (e.g. "promptly",
 * "templated work" still match — that's intentional; the curated
 * pool is the safer answer in either case).
 */

export type SanitizeResult =
  | { ok: true; text: string }
  | { ok: false; reason: string }

/**
 * Tokens that should never appear in candidate-facing pathway / drill
 * copy. Lower-cased; matched case-insensitively with word boundaries.
 *
 * Keep this list short and high-confidence — the plan calls for
 * discard-and-substitute, not aggressive rewriting.
 */
const BANNED_TOKENS = [
  'prompt',
  'prompts',
  'json',
  'template',
  'templates',
  'llm',
  'llms',
  'claude',
  'anthropic',
  'gpt',
] as const

const BANNED_PHRASES = [
  'five different prompts',
  'five prompts',
  'as the model',
  'the assistant',
  'as an ai',
] as const

const BANNED_TOKEN_RE = new RegExp(
  `\\b(?:${BANNED_TOKENS.join('|')})\\b`,
  'i',
)

const BANNED_PHRASE_RE = new RegExp(
  `(?:${BANNED_PHRASES.map(p => p.replace(/\s+/g, '\\s+')).join('|')})`,
  'i',
)

export function sanitizeLearnerCopy(text: string | null | undefined): SanitizeResult {
  if (text == null) return { ok: false, reason: 'empty' }
  const value = String(text).trim()
  if (!value) return { ok: false, reason: 'empty' }

  const tokenMatch = value.match(BANNED_TOKEN_RE)
  if (tokenMatch) {
    return { ok: false, reason: `banned-token:${tokenMatch[0].toLowerCase()}` }
  }
  const phraseMatch = value.match(BANNED_PHRASE_RE)
  if (phraseMatch) {
    return { ok: false, reason: `banned-phrase:${phraseMatch[0].toLowerCase()}` }
  }

  return { ok: true, text: value }
}

/**
 * Convenience wrapper for callers that have multiple text fields per
 * record (e.g. a task with title + description). Returns the first
 * rejection encountered, otherwise the original record echoed back.
 */
export function sanitizeLearnerFields<T extends Record<string, string | undefined | null>>(
  record: T,
  fields: ReadonlyArray<keyof T>,
): SanitizeResult {
  for (const f of fields) {
    const r = sanitizeLearnerCopy(record[f] as string | null | undefined)
    if (!r.ok) return { ok: false, reason: `${String(f)}:${r.reason}` }
  }
  return { ok: true, text: '' }
}
