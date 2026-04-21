/** Depth-aware extension to the post-answer intentional-silence window.
 *
 *  Diagnostic run 2026-04-21 caught `stopListeningIntentionalSilence`
 *  misfires on two technical-depth questions (Q3 and Q6): the 1500–2500ms
 *  base window expired while the candidate was mid-thought gathering
 *  their next elaboration. On thinking-heavy depths (technical, case-
 *  study, system-design, coding) candidates routinely pause to weigh
 *  tradeoffs or mentally diagram — we give those depths +1500ms. */

export const SILENCE_WINDOW_BONUS_MS = 1500

/** Depth slugs where candidates pause mid-elaboration as a matter of
 *  course. Screening / behavioral / culture-fit cadence is conversational
 *  and the base window is adequate there — extending it would add
 *  unnecessary dead air between turns. */
const THINKING_HEAVY_DEPTHS: ReadonlySet<string> = new Set([
  'technical',
  'case-study',
  'system-design',
  'coding',
])

export function isThinkingHeavyDepth(depth: string | undefined | null): boolean {
  if (!depth) return false
  return THINKING_HEAVY_DEPTHS.has(depth)
}
