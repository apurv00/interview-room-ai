import { describe, it, expect } from 'vitest'
import { resolveFlow } from '../flow/resolver'
import { TEMPLATE_REGISTRY } from '../flow/templates'
import { getQuestionCount } from '../config/interviewConfig'
import type { Duration } from '@shared/types'
import type { FlowTemplate } from '../flow/types'

/**
 * Full-matrix invariant test for resolveFlow.
 *
 * Asserts for every registered template × {10, 20, 30} min:
 *   1. resolveFlow() returns non-null
 *   2. flow.slots.length >= 5 at every duration (usable minimum)
 *   3. flow.totalSlots === flow.slots.length (internal consistency)
 *   4. slot.slotIndex values are 0..N-1 sequential
 *   5. No two slots share the same id
 *   6. At least one warm-up slot (when template has one)
 *   7. At least one closing slot (when template has one)
 *   8. totalSlots <= getQuestionCount(duration) - 1 — the true AI-question
 *      budget, since useInterview.ts:1043-1047 runs `qIdx in [1, maxQ)`.
 *   9. Every template must-slot is EITHER present in the resolved flow
 *      OR legitimately trimmed by capacity. Specifically: no if-time slot
 *      is kept while a must-slot is dropped.
 */

const DURATIONS: Duration[] = [10, 20, 30]

function keyOf(t: FlowTemplate): string {
  return `${t.domain}:${t.depth}:${t.experience}`
}

describe('flowMatrix — every template × every duration', () => {
  const entries: Array<[string, FlowTemplate]> = []
  for (const [key, tmpl] of TEMPLATE_REGISTRY) {
    entries.push([key, tmpl])
  }

  it(`enumerates at least 90 templates × 3 durations`, () => {
    expect(entries.length).toBeGreaterThanOrEqual(90)
  })

  for (const [key, tmpl] of entries) {
    for (const duration of DURATIONS) {
      const label = `${key} @ ${duration}min`

      it(label, () => {
        const flow = resolveFlow({
          domain: tmpl.domain,
          depth: tmpl.depth,
          experience: tmpl.experience,
          duration,
        })

        // 1. Non-null
        expect(flow, `${label}: resolveFlow returned null`).not.toBeNull()
        const f = flow!

        // 2. Minimum usable slots
        expect(
          f.slots.length,
          `${label}: flow has ${f.slots.length} slots, expected >= 5`,
        ).toBeGreaterThanOrEqual(5)

        // 3. Internal consistency
        expect(
          f.totalSlots,
          `${label}: totalSlots (${f.totalSlots}) != slots.length (${f.slots.length})`,
        ).toBe(f.slots.length)

        // 4. Sequential slotIndex
        f.slots.forEach((s, i) => {
          expect(
            s.slotIndex,
            `${label}: slot "${s.id}" at position ${i} has slotIndex ${s.slotIndex}`,
          ).toBe(i)
        })

        // 5. Unique ids
        const ids = f.slots.map(s => s.id)
        const uniqueIds = new Set(ids)
        expect(
          uniqueIds.size,
          `${label}: duplicate slot ids — ${ids.join(', ')}`,
        ).toBe(ids.length)

        // 6. Warm-up present when template has one
        const templateHasWarmUp = tmpl.slots.some(s => s.phase === 'warm-up')
        if (templateHasWarmUp) {
          expect(
            f.slots.some(s => s.phase === 'warm-up'),
            `${label}: template has warm-up but resolved flow has none`,
          ).toBe(true)
        }

        // 7. Closing present when template has one
        const templateHasClosing = tmpl.slots.some(s => s.phase === 'closing')
        if (templateHasClosing) {
          expect(
            f.slots.some(s => s.phase === 'closing'),
            `${label}: template has closing but resolved flow has none`,
          ).toBe(true)
        }

        // 8. THE BUDGET INVARIANT — totalSlots must fit the actual question loop
        const usableQuestions = getQuestionCount(duration) - 1
        expect(
          f.totalSlots,
          `${label}: totalSlots=${f.totalSlots} exceeds usable budget ${usableQuestions} (getQuestionCount(${duration}) - 1)`,
        ).toBeLessThanOrEqual(usableQuestions)

        // 9. Must-slots not silently dropped for if-time slots
        const templateMustIds = new Set(
          tmpl.slots.filter(s => s.priority === 'must').map(s => s.id),
        )
        const templateIfTimeIds = new Set(
          tmpl.slots.filter(s => s.priority === 'if-time').map(s => s.id),
        )
        const resolvedIds = new Set(f.slots.map(s => s.id))
        const droppedMust = [...templateMustIds].filter(id => !resolvedIds.has(id))
        const keptIfTime = [...templateIfTimeIds].filter(id => resolvedIds.has(id))

        if (droppedMust.length > 0 && keptIfTime.length > 0) {
          throw new Error(
            `${label}: dropped must-slot(s) [${droppedMust.join(', ')}] ` +
            `while keeping if-time slot(s) [${keptIfTime.join(', ')}] — ` +
            `must-slots have priority by contract`,
          )
        }
      })
    }
  }
})
