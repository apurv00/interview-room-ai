/**
 * @vitest-environment node
 *
 * Covers the depth allowlist that extends the post-answer intentional-
 * silence window. Wrong membership here directly regresses the Q3/Q6
 * misfires seen 2026-04-21 where the base 1500–2500ms window closed
 * mid-thought on technical-depth answers.
 */
import { describe, it, expect } from 'vitest'
import { isThinkingHeavyDepth, SILENCE_WINDOW_BONUS_MS } from '../config/silenceWindow'

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
  it('is 1500ms — one extra breath beyond the longest base window', () => {
    // Base windows: 1500 (long), 2000 (medium), 2500 (short). +1500ms
    // brings the long-answer window to 3000ms, matching the natural
    // "mid-thought pause" observed in technical deep-dives.
    expect(SILENCE_WINDOW_BONUS_MS).toBe(1500)
  })
})
