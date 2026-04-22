/**
 * @vitest-environment node
 *
 * Covers the depth allowlist that extends the post-answer intentional-
 * silence window. Wrong membership here directly regresses the Q3/Q6
 * misfires seen 2026-04-21 where the base 1500–2500ms window closed
 * mid-thought on technical-depth answers.
 */
import { describe, it, expect } from 'vitest'
import {
  isThinkingHeavyDepth,
  SILENCE_WINDOW_BONUS_MS,
  computeIntentionalSilenceWindow,
} from '../config/silenceWindow'

describe('isThinkingHeavyDepth', () => {
  it('returns true for the four depths that need extra silence', () => {
    expect(isThinkingHeavyDepth('technical')).toBe(true)
    expect(isThinkingHeavyDepth('case-study')).toBe(true)
    expect(isThinkingHeavyDepth('system-design')).toBe(true)
    expect(isThinkingHeavyDepth('coding')).toBe(true)
  })

  it('returns false for conversational depths — the base window is fine there', () => {
    // Extending these would add dead air without catching anything;
    // screening / behavioral / culture-fit cadence is short and responsive.
    expect(isThinkingHeavyDepth('screening')).toBe(false)
    expect(isThinkingHeavyDepth('hr-screening')).toBe(false)
    expect(isThinkingHeavyDepth('behavioral')).toBe(false)
    expect(isThinkingHeavyDepth('culture-fit')).toBe(false)
  })

  it('returns false for undefined/null/empty (no depth set)', () => {
    expect(isThinkingHeavyDepth(undefined)).toBe(false)
    expect(isThinkingHeavyDepth(null)).toBe(false)
    expect(isThinkingHeavyDepth('')).toBe(false)
  })

  it('returns false for unknown depth slugs (fail-safe — short window stays)', () => {
    // New CMS depth slugs default to "no extension" until explicitly
    // added to the allowlist. Safer than a false positive which would
    // leave a casual-chat depth dragging dead air between turns.
    expect(isThinkingHeavyDepth('new-custom-depth')).toBe(false)
    expect(isThinkingHeavyDepth('TECHNICAL')).toBe(false) // case-sensitive
  })
})

describe('SILENCE_WINDOW_BONUS_MS', () => {
  it('is 1500ms — one extra breath beyond the base windows', () => {
    // Applied to short (2500ms) and medium (2000ms) answers on
    // thinking-heavy depths. Long answers (≥30 words) skip the check
    // entirely per Bug B (2026-04-22), so the bonus no longer stacks
    // on a 1500ms long-answer window.
    expect(SILENCE_WINDOW_BONUS_MS).toBe(1500)
  })
})

/**
 * Pins the Bug B (2026-04-22) fix. Long answers (≥30 words) must NOT
 * trigger the post-answer continuation window because stacking it on
 * Deepgram's graceTimer.complete=3000ms produced ≥6s of dead air between
 * turns — exactly what candidates reported as "capture was very late".
 */
describe('computeIntentionalSilenceWindow', () => {
  const deterministicRandom = (val: number) => () => val

  describe('short answers (<15 words)', () => {
    it('always checks with a 2.5s window', () => {
      const d = computeIntentionalSilenceWindow('short answer here', false)
      expect(d.shouldCheck).toBe(true)
      expect(d.silenceMs).toBe(2500)
    })

    it('adds the 1500ms bonus on thinking-heavy depths', () => {
      const d = computeIntentionalSilenceWindow('short answer here', true)
      expect(d.shouldCheck).toBe(true)
      expect(d.silenceMs).toBe(2500 + SILENCE_WINDOW_BONUS_MS)
    })

    it('ignores the RNG (always checks regardless of random value)', () => {
      // Short answers never go through the probabilistic branch.
      const d1 = computeIntentionalSilenceWindow('one two three', false, deterministicRandom(0.99))
      const d2 = computeIntentionalSilenceWindow('one two three', false, deterministicRandom(0.01))
      expect(d1.shouldCheck).toBe(true)
      expect(d2.shouldCheck).toBe(true)
    })
  })

  describe('medium answers (15–29 words)', () => {
    const mediumAnswer = Array(20).fill('word').join(' ') // 20 words

    it('checks at random < 0.35 (35% probability)', () => {
      const d = computeIntentionalSilenceWindow(mediumAnswer, false, deterministicRandom(0.2))
      expect(d.shouldCheck).toBe(true)
      expect(d.silenceMs).toBe(2000)
    })

    it('skips at random >= 0.35 (65% probability)', () => {
      const d = computeIntentionalSilenceWindow(mediumAnswer, false, deterministicRandom(0.5))
      expect(d.shouldCheck).toBe(false)
    })

    it('adds the 1500ms bonus on thinking-heavy depths when it does check', () => {
      const d = computeIntentionalSilenceWindow(mediumAnswer, true, deterministicRandom(0))
      expect(d.shouldCheck).toBe(true)
      expect(d.silenceMs).toBe(2000 + SILENCE_WINDOW_BONUS_MS)
    })
  })

  describe('long answers (≥30 words) — Bug B contract', () => {
    const longAnswer = Array(30).fill('word').join(' ') // exactly 30 words
    const veryLongAnswer = Array(92).fill('word').join(' ') // Q3 on the 2026-04-22 session

    it('never checks — 30-word threshold is the skip boundary', () => {
      const d = computeIntentionalSilenceWindow(longAnswer, false)
      expect(d.shouldCheck).toBe(false)
    })

    it('never checks — 92-word answer (real user session) skips the window', () => {
      // Q3 of session 69e8c2f3 was 92 words. Pre-fix this opened a
      // 1500+1500=3000ms window on top of graceTimer — the "late
      // capture" the candidate complained about.
      const d = computeIntentionalSilenceWindow(veryLongAnswer, true)
      expect(d.shouldCheck).toBe(false)
    })

    it('skips regardless of thinking-heavy bonus — the bonus no longer stacks on long answers', () => {
      const d = computeIntentionalSilenceWindow(longAnswer, true)
      expect(d.shouldCheck).toBe(false)
      expect(d.silenceMs).toBe(0)
    })

    it('skips regardless of random value — not probabilistic at this tier', () => {
      const d1 = computeIntentionalSilenceWindow(longAnswer, false, deterministicRandom(0))
      const d2 = computeIntentionalSilenceWindow(longAnswer, false, deterministicRandom(0.99))
      expect(d1.shouldCheck).toBe(false)
      expect(d2.shouldCheck).toBe(false)
    })
  })

  describe('word-count tokenizer', () => {
    it('collapses repeated whitespace — does not count empty tokens', () => {
      // Matches `.split(/\s+/).filter(Boolean)` semantics. An answer
      // with trailing spaces or double-spaces inside must still land
      // in the correct tier.
      const d = computeIntentionalSilenceWindow('  one   two   three  ', false)
      // 3 words → short tier → shouldCheck=true
      expect(d.shouldCheck).toBe(true)
    })

    it('empty string falls into short tier (0 words < 15)', () => {
      const d = computeIntentionalSilenceWindow('', false)
      expect(d.shouldCheck).toBe(true)
    })
  })
})
