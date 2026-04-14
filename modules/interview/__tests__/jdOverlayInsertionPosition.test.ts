import { describe, it, expect } from 'vitest'
import { buildJDOverlayFromParsedJD } from '@interview/flow/jdOverlayBuilder'
import { resolveFlow } from '@interview/flow/resolver'
import { TEMPLATE_REGISTRY } from '@interview/flow/templates'
import { getQuestionCount } from '@interview/config/interviewConfig'
import type { Duration } from '@shared/types'
import type { FlowTemplate } from '@interview/flow/types'
import type { IParsedJobDescription, ParsedRequirement } from '@shared/db/models/SavedJobDescription'

/**
 * Phase 2 audit: verify that JD overlay insertions produced by
 * buildJDOverlayFromParsedJD land in sensible positions after the
 * resolver runs — specifically, in the exploration interior between
 * warm-up and closing anchors — for every registered template at
 * every supported duration.
 *
 * This test is a regression guard. The insertAfter position in
 * buildJDOverlay is a raw-index heuristic (~middle of existingSlotIds);
 * Work Item B's reserved warm-up/closing resolver changed the assumed
 * layout. Phase 4 will wire this function into production, so we want
 * the assumption locked in before the wiring.
 *
 * For each (template, duration) the following invariants are asserted
 * and hold universally (audited across 306 combinations — see commit
 * message Root-cause):
 *   a. Every surviving JD insertion has phase === 'exploration'
 *   b. Every surviving JD insertion's slotIndex sits strictly between
 *      the last warm-up slotIndex and the first closing slotIndex
 *   c. totalSlots <= getQuestionCount(duration) - 1 (Work Item B budget)
 *   d. slotIndex values are sequential 0..N-1
 *
 * Survival: at least ONE JD insertion is expected to make it through
 * the resolver when the JD supplies 3 unmatched must-haves. This is
 * asserted only at 20min and 30min. At 10min the interior budget is
 * 3 slots, which is fully consumed by template must-slots in all 102
 * current templates before the resolver's iteration reaches the
 * spliced JD insertions (resolver.ts:119-123 iterates must-slots in
 * original template order). That behaviour is a product question for
 * Phase 3+ (should JD must-haves outrank template must-haves under
 * budget pressure?) — out of scope for this audit. Positioning and
 * phase/budget invariants are still asserted at 10min.
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
        const overlay = buildJDOverlayFromParsedJD(parsed, existingSlotIds)

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

        // At least one JD insertion must survive the budget — only checked at
        // durations whose interior budget can fit one. At 10min the interior
        // budget is 3 slots and every registered template has >= 3 must-slots
        // positioned before the JD splice point; under current resolver
        // semantics (must-first iteration in original order) that fully
        // consumes the budget. Whether to change that is a Phase 3+ question.
        if (duration !== 10) {
          expect(
            insertedSlots.length,
            `${label}: expected at least 1 JD insertion in resolved flow, got 0 ` +
              `(template has ${tmpl.slots.length} raw slots, budget ${usableQuestions})`,
          ).toBeGreaterThanOrEqual(1)
        }

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
