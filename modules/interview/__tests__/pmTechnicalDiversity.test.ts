/**
 * @vitest-environment node
 *
 * Pins the Bug C (2026-04-22) rebalance: the pm-technical `mid` bucket
 * (3-6 yrs) must NOT define four consecutive data/metrics mandatory
 * slots. Seven sessions on 2026-04-21 → 2026-04-22 showed Q2-Q5 all
 * drifting into metric diagnosis because the template told the LLM to
 * ask exactly that. The rebalance keeps the two canonical signature
 * slots (metrics-framework, ambiguous-data) and diversifies the other
 * two mandatory exploration slots to non-metrics topics.
 *
 * These tests deliberately bind to `competencyBucket` values so a future
 * edit that renames slots but keeps the same topic still passes, and so
 * an edit that silently regresses to "all data-driven" fails loudly.
 */
import { describe, it, expect } from 'vitest'
import { TEMPLATES } from '../flow/templates/pm-technical'
import type { TopicSlot } from '../flow/types'

function midSlots(): TopicSlot[] {
  const mid = TEMPLATES.find((t) => t.domain === 'pm' && t.depth === 'technical' && t.experience === '3-6')
  if (!mid) throw new Error('pm-technical mid template not found — test bootstrap problem')
  return mid.slots
}

describe('pm-technical mid (3-6 yrs) — topic diversity', () => {
  it('contains at least one non-data-driven MUST slot in exploration phase', () => {
    // Bug C regression guard. Before the rebalance every mandatory
    // exploration slot had competencyBucket in {data-driven, analytical,
    // experimentation} — all variations of metric reasoning. At least
    // one must-slot now carries a genuinely different bucket.
    const explorationMusts = midSlots().filter(
      (s) => s.phase === 'exploration' && s.priority === 'must',
    )
    const dataBuckets = new Set(['data-driven', 'analytical', 'experimentation'])
    const nonDataMusts = explorationMusts.filter((s) => !dataBuckets.has(s.competencyBucket))

    expect(nonDataMusts.length).toBeGreaterThanOrEqual(2)
  })

  it('retains the two canonical metric signature slots', () => {
    // The rebalance must not amputate the metrics-framework warmup or
    // the ambiguous-data "ship or not" tradeoff — those are what make
    // this a TECHNICAL PM interview, not a generic PM interview.
    const ids = new Set(midSlots().map((s) => s.id))
    expect(ids.has('metrics-framework')).toBe(true)
    expect(ids.has('ambiguous-data')).toBe(true)
  })

  it('includes a prioritization mandatory slot (the 2026-04-22 rebalance)', () => {
    const prioritization = midSlots().find((s) => s.id === 'prioritization-tradeoffs')
    expect(prioritization).toBeDefined()
    expect(prioritization!.priority).toBe('must')
    expect(prioritization!.competencyBucket).toBe('product-sense')
  })

  it('includes a scoping-under-uncertainty mandatory slot (the 2026-04-22 rebalance)', () => {
    const scoping = midSlots().find((s) => s.id === 'scoping-under-uncertainty')
    expect(scoping).toBeDefined()
    expect(scoping!.priority).toBe('must')
    expect(scoping!.competencyBucket).toBe('problem-solving')
  })

  it('downgrades experiment-design and funnel-at-scale to if-time', () => {
    // These used to be mandatory and drove the metric-heavy convergence.
    // They remain available for sessions with capacity, but no longer
    // guaranteed.
    const expDesign = midSlots().find((s) => s.id === 'experiment-design')
    const funnel = midSlots().find((s) => s.id === 'funnel-at-scale')
    expect(expDesign?.priority).toBe('if-time')
    expect(funnel?.priority).toBe('if-time')
  })

  it('does not regress: at most 3 mandatory slots have a data-flavored bucket', () => {
    // A guardrail. If someone re-adds a fifth data-driven must-slot the
    // convergence regression returns. Cap = 3 (metrics-framework +
    // ambiguous-data + growth-modeling closing).
    const dataBuckets = new Set(['data-driven', 'analytical', 'experimentation'])
    const dataMusts = midSlots().filter(
      (s) => s.priority === 'must' && dataBuckets.has(s.competencyBucket),
    )
    expect(dataMusts.length).toBeLessThanOrEqual(3)
  })
})
