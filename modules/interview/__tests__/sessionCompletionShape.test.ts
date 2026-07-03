/**
 * Work Item G.7 — session completion shape.
 *
 * Validates:
 *   1. `plannedQuestionCount` is populated at session-create time from
 *      `getQuestionCount(config.duration)`.
 *   2. `UpdateSessionSchema` accepts the new G.7 fields
 *      (answeredCount, endReason, wasTruncatedByTimer).
 *   3. `endReason` enum gates — only the documented five values are
 *      accepted. Unknown strings reject.
 *   4. Back-compat: existing sessions with no G.7 fields validate fine.
 */

import { describe, it, expect } from 'vitest'
import { UpdateSessionSchema } from '@interview/validators/interview'

describe('G.7 — UpdateSessionSchema accepts completion-shape fields', () => {
  it('accepts answeredCount + endReason + wasTruncatedByTimer', () => {
    const result = UpdateSessionSchema.safeParse({
      status: 'completed',
      answeredCount: 5,
      endReason: 'time_up',
      wasTruncatedByTimer: [false, false, true, false, false],
    })
    expect(result.success).toBe(true)
  })

  it('accepts plannedQuestionCount', () => {
    const result = UpdateSessionSchema.safeParse({
      plannedQuestionCount: 11,
    })
    expect(result.success).toBe(true)
  })

  it('rejects unknown endReason values', () => {
    const result = UpdateSessionSchema.safeParse({
      endReason: 'quit_in_shame',
    })
    expect(result.success).toBe(false)
  })

  it('accepts all five documented endReason values', () => {
    const endReasons = ['normal', 'time_up', 'user_ended', 'usage_limit', 'abandoned'] as const
    for (const r of endReasons) {
      const result = UpdateSessionSchema.safeParse({ endReason: r })
      expect(result.success).toBe(true)
    }
  })

  it('rejects negative answeredCount', () => {
    const result = UpdateSessionSchema.safeParse({ answeredCount: -1 })
    expect(result.success).toBe(false)
  })

  it('rejects non-boolean entries in wasTruncatedByTimer', () => {
    const result = UpdateSessionSchema.safeParse({
      wasTruncatedByTimer: [true, 'yes', false],
    })
    expect(result.success).toBe(false)
  })

  it('back-compat: payload without any G.7 fields still validates', () => {
    const result = UpdateSessionSchema.safeParse({
      status: 'completed',
      completedAt: new Date().toISOString(),
    })
    expect(result.success).toBe(true)
  })

  it('accepts answeredCount above the old cap of 100 (long/probed sessions after the main/probe decouple)', () => {
    // answeredCount = intro + main + probe answers; after probes stopped spending the main-question
    // budget (PR #495), a long 60-min probed session can produce >100 evals. The cap was raised from
    // 100 → MAX_EXCHANGE_INDEX (500) so completion no longer rejects those. Codex #495 P1.
    expect(UpdateSessionSchema.safeParse({ answeredCount: 101 }).success).toBe(true)
    expect(UpdateSessionSchema.safeParse({ answeredCount: 417 }).success).toBe(true)
  })

  it('still rejects answeredCount above the raised cap (500)', () => {
    const result = UpdateSessionSchema.safeParse({ answeredCount: 501 })
    expect(result.success).toBe(false)
  })
})

// ─── Session-create path populates plannedQuestionCount ────────────────────

import { getQuestionCount } from '@interview/config/interviewConfig'

describe('G.7 — getQuestionCount returns the canonical planned count', () => {
  // Sanity-checks the value the service layer now denormalizes onto
  // InterviewSession.plannedQuestionCount. If these anchors change in
  // interviewConfig, G.10's completion-ratio math will need to follow.
  it('produces expected counts at each supported duration', () => {
    expect(getQuestionCount(10)).toBe(10)
    expect(getQuestionCount(20)).toBe(20)
    expect(getQuestionCount(30)).toBe(30)
  })

  it('produces a positive integer for a mid-range duration', () => {
    const n = getQuestionCount(15)
    expect(n).toBeGreaterThan(0)
    expect(Number.isFinite(n)).toBe(true)
  })
})
