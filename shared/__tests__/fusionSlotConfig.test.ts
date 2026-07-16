import { describe, it, expect } from 'vitest'

import { TASK_SLOT_DEFAULTS } from '../services/taskSlots'

// Regression pin for the 2026-07-11→17 prod incident: the GPT-5.6 cutover set
// fusion to reasoningEffort 'high', which overran the fusion timeout on most
// runs and emitted reasoning preambles that broke the strict JSON parse —
// every multimodal analysis failed for six days before anyone noticed
// (feature is quota-gated, volume near zero). Fusion merges already-computed
// signals into a fixed JSON shape; it is not a judgment slot. If you are
// changing this deliberately, re-verify a full analysis run end-to-end and
// re-size FUSION_TIMEOUT_MS in fusionService.ts to the new model's latency.
describe('interview.fusion-analysis slot', () => {
  it('stays on low reasoning effort', () => {
    expect(TASK_SLOT_DEFAULTS['interview.fusion-analysis']?.reasoningEffort).toBe('low')
  })
})
