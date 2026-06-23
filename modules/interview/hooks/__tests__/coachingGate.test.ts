/**
 * Codex P2 fix — coach-mode dead-air when the live-coaching switch is off.
 *
 * `showCoachingTip` in useInterview blocks 3-6s in coach mode so the candidate
 * can read the tip. When the candidate turns the in-room master switch OFF, the
 * tip is hidden — so the block MUST be skipped, or they sit through dead air
 * after every answer. `shouldBlockForCoaching` is the gate that decides this.
 *
 * The load-bearing case is `coachMode=true, enabled=false → false` (the fix).
 */
import { describe, it, expect } from 'vitest'
import { shouldBlockForCoaching } from '../coachingGate'

describe('shouldBlockForCoaching', () => {
  it('does NOT block in coach mode when live coaching is off (the fix — no dead air)', () => {
    expect(shouldBlockForCoaching(true, false)).toBe(false)
  })

  it('blocks in coach mode when live coaching is on (regression guard — read pause preserved)', () => {
    expect(shouldBlockForCoaching(true, true)).toBe(true)
  })

  it('defaults to blocking in coach mode when the preference is unset (matches page seed = on)', () => {
    expect(shouldBlockForCoaching(true, undefined)).toBe(true)
  })

  it('never blocks outside coach mode, regardless of the switch', () => {
    expect(shouldBlockForCoaching(false, true)).toBe(false)
    expect(shouldBlockForCoaching(false, false)).toBe(false)
    expect(shouldBlockForCoaching(false, undefined)).toBe(false)
    expect(shouldBlockForCoaching(undefined, undefined)).toBe(false)
  })
})
