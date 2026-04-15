/**
 * Regression guard — every model string in TASK_SLOT_DEFAULTS must have
 * a matching key in the PRICING table in usageTracking.ts. When a key is
 * missing, `buildUsageRecordData` falls through to the Opus-priced
 * default (`{ input: 0.015, output: 0.075 }`) and silently inflates the
 * recorded cost for non-Opus models by up to ~15×.
 *
 * Historical incidents this guards against:
 *   - PR #264 switched Anthropic model IDs from dated form (e.g.
 *     `claude-sonnet-4-6-20250514`) to the durable alias form
 *     (`claude-sonnet-4-6`). The PRICING table had already been keyed
 *     on a stale dated form (`claude-sonnet-4-20250514` — note the
 *     missing `-6-`), so the rename exposed a pre-existing typo plus
 *     introduced a new Haiku mismatch. Codex flagged it on the PR;
 *     fix landed in a follow-up.
 */

import { describe, it, expect } from 'vitest'
import { __PRICING } from '../services/usageTracking'
import { TASK_SLOT_DEFAULTS } from '../services/taskSlots'

describe('usageTracking PRICING table', () => {
  it('has a pricing entry for every model referenced in TASK_SLOT_DEFAULTS', () => {
    const referencedModels = new Set(
      Object.values(TASK_SLOT_DEFAULTS).map((slot) => slot.model),
    )
    const missing: string[] = []
    for (const model of referencedModels) {
      if (!(model in __PRICING)) missing.push(model)
    }
    expect(
      missing,
      `PRICING is missing keys for models referenced in TASK_SLOT_DEFAULTS. ` +
        `Models without a PRICING entry fall through to the default ` +
        `Opus-priced rate, inflating recorded cost. Add these keys to ` +
        `shared/services/usageTracking.ts::__PRICING: ${missing.join(', ')}`,
    ).toEqual([])
  })

  it('has non-negative numeric rates for every entry', () => {
    for (const [model, rate] of Object.entries(__PRICING)) {
      expect(rate.input, `${model}.input`).toBeGreaterThanOrEqual(0)
      expect(rate.output, `${model}.output`).toBeGreaterThanOrEqual(0)
    }
  })
})
