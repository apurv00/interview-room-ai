import { describe, it, expect } from 'vitest'
import { buildJDOverlayFromParsedJD } from '@interview/flow/jdOverlayBuilder'
import { resolveFlow } from '@interview/flow/resolver'
import { TEMPLATE_REGISTRY } from '@interview/flow/templates'
import { getQuestionCount } from '@interview/config/interviewConfig'
import type { Duration } from '@shared/types'
import type { FlowTemplate } from '@interview/flow/types'
import type { IParsedJobDescription, ParsedRequirement } from '@shared/db/models/SavedJobDescription'

/**
 * Phase 2 audit + E.5 survival: verify that JD overlay insertions
 * produced by buildJDOverlayFromParsedJD land in sensible positions
 * after the resolver runs — specifically, in the exploration interior
 * between warm-up and closing anchors — for every registered template
 * at every supported duration, AND survive the resolver's budget fill.
 *
 * This test is a regression guard. Work Item B's reserved warm-up/closing
 * resolver changed the assumed layout. Phase 4 will wire this function
 * into production, so we want the assumption locked in before the wiring.
 *
 * Invariants asserted universally across all 306 combinations:
 *   a. Every surviving JD insertion has phase === 'exploration'
 *   b. Every surviving JD insertion's slotIndex sits strictly between
 *      the last warm-up slotIndex and the first closing slotIndex
 *   c. totalSlots <= getQuestionCount(duration) - 1 (Work Item B budget)
 *   d. slotIndex values are sequential 0..N-1
 *
 * Survival (post-E.5): BOTH JD insertions must survive the resolver
 * at every duration when the JD supplies 3 unmatched must-haves
 * (the 2-insertion cap in buildJDOverlay applies). E.5 achieves
 * 10-min survival by front-splicing JD insertions right after the
 * warm-up slot, so must-first interior fill picks them up before
 * template must-slots positioned later in the raw order.
 */

const DURATIONS: Duration[] = [10, 20, 30]

// Three requirement strings chosen to contain NONE of the keywords in
// REQUIREMENT_TO_SLOT — so they always flow into the insertion branch.
const UNMATCHED_REQUIREMENTS: ParsedRequirement[] = [
  {
    id: 'req-1',
    category: 'cultural',
    requirement: 'Fluency in Mandarin Chinese for partner calls',
    importance: 'must-have',
    targetCompetencies: [],
  },
  {
    id: 'req-2',
    category: 'experience',
    requirement: 'Willingness to travel to São Paulo quarterly',
    importance: 'must-have',
    targetCompetencies: [],
  },
  {
    id: 'req-3',
    category: 'education',
    requirement: 'Prior work with FedRAMP compliance audits',
    importance: 'must-have',
    targetCompetencies: [],
  },
]

function makeParsedJD(): IParsedJobDescription {
  return {
    rawText: 'synthetic JD for audit',
    company: 'Acme',
    role: 'Senior Engineer',
    inferredDomain: 'backend',
    requirements: UNMATCHED_REQUIREMENTS,
    keyThemes: [],
  }
}

function keyOf(t: FlowTemplate): string {
  return `${t.domain}:${t.depth}:${t.experience}`
}

describe('jdOverlayInsertionPosition — audit across every template × duration', () => {
  const entries: Array<[string, FlowTemplate]> = []
  for (const [key, tmpl] of TEMPLATE_REGISTRY) {
    entries.push([key, tmpl])
  }

  it('enumerates at least 90 templates × 3 durations', () => {
    expect(entries.length).toBeGreaterThanOrEqual(90)
  })

  for (const [key, tmpl] of entries) {
    for (const duration of DURATIONS) {
      const label = `${key} @ ${duration}min`

      it(label, () => {
        const parsed = makeParsedJD()
        const existingSlotIds = tmpl.slots.map(s => s.id)
        // Compute the LAST warm-up slot id in template order. A template may
        // have multiple warm-up slots; only the first becomes the resolver's
        // reserved anchor, but the rest preserve phase='warm-up' in the
        // interior. JD insertions must splice after ALL of them to satisfy
        // the "slotIndex > lastWarmUpIdx" positional invariant.
        const warmUpIds = tmpl.slots.filter(s => s.phase === 'warm-up').map(s => s.id)
        const lastWarmUpId = warmUpIds[warmUpIds.length - 1]
        const overlay = buildJDOverlayFromParsedJD(parsed, existingSlotIds, lastWarmUpId)

        expect(overlay, `${label}: buildJDOverlayFromParsedJD returned null`).not.toBeNull()
        expect(
          overlay!.insertions.length,
          `${label}: expected 2 insertions (cap), got ${overlay!.insertions.length}`,
        ).toBe(2)

        const flow = resolveFlow({
          domain: tmpl.domain,
          depth: tmpl.depth,
          experience: tmpl.experience,
          duration,
          jdOverlay: overlay,
        })

        expect(flow, `${label}: resolveFlow returned null`).not.toBeNull()
        const f = flow!

        // Budget invariant (Work Item B): totalSlots <= usable AI-question budget.
        const usableQuestions = getQuestionCount(duration) - 1
        expect(
          f.totalSlots,
          `${label}: totalSlots=${f.totalSlots} exceeds usable budget ${usableQuestions}`,
        ).toBeLessThanOrEqual(usableQuestions)

        // Sequential slotIndex (JD insertions must not break the sequence).
        f.slots.forEach((s, i) => {
          expect(
            s.slotIndex,
            `${label}: slot "${s.id}" at position ${i} has slotIndex ${s.slotIndex}`,
          ).toBe(i)
        })

        // Locate warm-up / closing boundaries in the resolved flow.
        const warmUpIdxs = f.slots
          .filter(s => s.phase === 'warm-up')
          .map(s => s.slotIndex)
        const closingIdxs = f.slots
          .filter(s => s.phase === 'closing')
          .map(s => s.slotIndex)
        const lastWarmUpIdx = warmUpIdxs.length > 0 ? Math.max(...warmUpIdxs) : -1
        const firstClosingIdx = closingIdxs.length > 0 ? Math.min(...closingIdxs) : Number.POSITIVE_INFINITY

        // Collect JD insertions that survived the resolver (by id prefix).
        const insertedSlots = f.slots.filter(s => /^jd-req-/.test(s.id))

        // E.5 survival invariant: BOTH JD insertions must survive the
        // resolver's interior budget at every duration. The overlay always
        // emits 2 insertions (cap) when given 3 unmatched must-haves; after
        // the front-splice fix both land right after warm-up, so must-first
        // iteration picks them up before template must-slots positioned
        // later in the raw order.
        expect(
          insertedSlots.length,
          `${label}: expected 2 surviving JD insertions, got ${insertedSlots.length} ` +
            `(template has ${tmpl.slots.length} raw slots, budget ${usableQuestions})`,
        ).toBe(2)

        // Per-insertion invariants — apply to every insertion that DID survive,
        // regardless of duration.
        for (const s of insertedSlots) {
          expect(
            s.phase,
            `${label}: inserted slot "${s.id}" has phase "${s.phase}", expected "exploration"`,
          ).toBe('exploration')

          expect(
            s.slotIndex,
            `${label}: inserted slot "${s.id}" at slotIndex ${s.slotIndex} is not ` +
              `strictly after last warm-up slot (idx ${lastWarmUpIdx})`,
          ).toBeGreaterThan(lastWarmUpIdx)

          expect(
            s.slotIndex,
            `${label}: inserted slot "${s.id}" at slotIndex ${s.slotIndex} is not ` +
              `strictly before first closing slot (idx ${firstClosingIdx})`,
          ).toBeLessThan(firstClosingIdx)
        }
      })
    }
  }
})
