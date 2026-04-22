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

/** Decision returned by {@link computeIntentionalSilenceWindow}. */
export interface SilenceWindowDecision {
  /** When false, skip the post-answer silence check entirely. */
  shouldCheck: boolean
  /** Window length in ms (including thinking-heavy bonus if applicable). */
  silenceMs: number
}

/**
 * Decide whether to open the post-answer "wait-for-continuation" window
 * and how long it should be. Pure function of the answer length + depth.
 * Extracted from {@link useInterview} so the decision matrix is unit-
 * testable (without a React render) and so the Bug B fix is pinned:
 *
 *   - Short answers (<15 words): always check, 2.5s base — likely incomplete.
 *   - Medium answers (15–29 words): 35% probabilistic check, 2.0s base.
 *   - Long answers (≥30 words): SKIP ENTIRELY (Bug B fix).
 *
 * **Bug B context (2026-04-22 session 69e8c2f3):** the prior version
 * opened a 1500ms window on long answers (+1500ms thinking-heavy bonus =
 * 3000ms). Stacked on top of Deepgram's graceTimer.complete=3000ms that
 * meant ≥6s of silence between "candidate stops speaking" and "next
 * question starts synthesizing". Long answers are structured enough that
 * continuation is rare — the cost of the extra window exceeded its
 * benefit. Short/medium stay because they're frequently mid-thought.
 *
 * The thinking-heavy bonus (technical / case-study / system-design /
 * coding) is still applied to short/medium because those depths
 * genuinely pause to weigh tradeoffs.
 *
 * @param answer - Candidate's transcribed answer
 * @param thinkingHeavy - Result of {@link isThinkingHeavyDepth} for the
 *                       interview type
 * @param random - Optional RNG for deterministic tests (defaults to
 *                 Math.random)
 */
export function computeIntentionalSilenceWindow(
  answer: string,
  thinkingHeavy: boolean,
  random: () => number = Math.random,
): SilenceWindowDecision {
  const wordCount = answer.trim().split(/\s+/).filter(Boolean).length

  if (wordCount < 15) {
    // Short — always check, longer window.
    return {
      shouldCheck: true,
      silenceMs: 2500 + (thinkingHeavy ? SILENCE_WINDOW_BONUS_MS : 0),
    }
  }
  if (wordCount < 30) {
    // Medium — 35% probabilistic check, 2.0s base.
    if (random() >= 0.35) return { shouldCheck: false, silenceMs: 0 }
    return {
      shouldCheck: true,
      silenceMs: 2000 + (thinkingHeavy ? SILENCE_WINDOW_BONUS_MS : 0),
    }
  }
  // Long (≥30 words) — Bug B fix: skip entirely. Continuation is rare
  // after a structured, long answer; the wait felt like "late capture"
  // to candidates who had clearly finished.
  return { shouldCheck: false, silenceMs: 0 }
}
