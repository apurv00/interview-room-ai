import type { ExperienceLevel, Duration } from '@shared/types'
import type { FlowTemplate, ResolvedFlow, ResolvedSlot, JDOverlay } from './types'
import { makeTemplateKey } from './types'
import { getQuestionCount } from '@interview/config/interviewConfig'
import { TEMPLATE_REGISTRY } from './templates'

/**
 * Resolve the interview flow for a specific session.
 *
 * 1. Look up the template for this domain × depth × experience
 * 2. Apply JD overlay (promote, annotate, insert slots)
 * 3. Scale to duration (trim if-time slots when short interviews)
 * 4. Return ordered list of resolved slots
 *
 * Returns null if no template exists (CMS custom domains fall back to current behavior).
 */
export function resolveFlow(params: {
  domain: string
  depth: string
  experience: ExperienceLevel
  duration: Duration
  jdOverlay?: JDOverlay | null
}): ResolvedFlow | null {
  const { domain, depth, experience, duration, jdOverlay } = params

  // 1. Look up template
  const key = makeTemplateKey(domain, depth, experience)
  const template = TEMPLATE_REGISTRY.get(key)
  if (!template) return null

  // 2. Build resolved slots from template
  let resolvedSlots: ResolvedSlot[] = template.slots.map((slot, i) => ({
    id: slot.id,
    label: slot.label,
    competencyBucket: slot.competencyBucket,
    phase: slot.phase,
    guidance: slot.guidance,
    probeGuidance: slot.probeGuidance,
    maxProbes: slot.maxProbes,
    priority: slot.priority,
    experienceAngle: slot.experienceAngle,
    slotIndex: i,
  }))

  // 3. Apply JD overlay
  if (jdOverlay) {
    // Promote if-time slots to must
    for (const slotId of jdOverlay.promotions) {
      const slot = resolvedSlots.find(s => s.id === slotId)
      if (slot && slot.priority === 'if-time') {
        slot.priority = 'must'
      }
    }

    // Annotate slots with JD context
    for (const annotation of jdOverlay.annotations) {
      const slot = resolvedSlots.find(s => s.id === annotation.slotId)
      if (slot) {
        slot.jdAnnotation = annotation.jdContext
      }
    }

    // Insert JD-specific slots (max 2)
    for (const insertion of jdOverlay.insertions.slice(0, 2)) {
      const afterIdx = resolvedSlots.findIndex(s => s.id === insertion.insertAfter)
      const insertIdx = afterIdx >= 0 ? afterIdx + 1 : resolvedSlots.length - 1

      const newSlot: ResolvedSlot = {
        id: insertion.slot.id,
        label: insertion.slot.label,
        competencyBucket: insertion.slot.competencyBucket,
        phase: insertion.slot.phase,
        guidance: insertion.slot.guidance,
        probeGuidance: insertion.slot.probeGuidance,
        maxProbes: insertion.slot.maxProbes,
        priority: 'must',
        experienceAngle: insertion.slot.experienceAngle,
        jdAnnotation: `JD Requirement: ${insertion.jdRequirement}`,
        slotIndex: 0, // will be reassigned below
      }

      resolvedSlots.splice(insertIdx, 0, newSlot)
    }
  }

  // 4. Scale to duration — trim slots to fit the AI-question budget.
  //
  // getQuestionCount(duration) is the upper bound on the interview loop's
  // qIdx counter (see interviewConfig.ts:98). The live loop at
  // hooks/useInterview.ts:1043-1047 runs `qIdx in [1, maxQ)`, so the
  // actual number of AI-driven topic slots consumed is
  // getQuestionCount(duration) - 1. Trimming against the raw count
  // overshoots by one; also re-adding warm-up/closing AFTER the trim
  // (the old behavior) could overshoot by up to two more.
  const totalQuestions = getQuestionCount(duration)
  const usableQuestions = Math.max(1, totalQuestions - 1)

  // Warm-up and closing anchors are counted INTO the budget (not added on
  // top). We reserve the first warm-up and the first closing slot from the
  // template so the opening and wrap-up remain sensible even when the
  // interior gets aggressively trimmed.
  const warmUpAnchor = resolvedSlots.find(s => s.phase === 'warm-up') ?? null
  const closingAnchor = resolvedSlots.find(s => s.phase === 'closing') ?? null
  const anchorIds = new Set<string>()
  if (warmUpAnchor) anchorIds.add(warmUpAnchor.id)
  if (closingAnchor) anchorIds.add(closingAnchor.id)

  // Interior = everything else, preserving original template order so the
  // JD-insertion ordering from step 3 is respected.
  const interiorSlots = resolvedSlots.filter(s => !anchorIds.has(s.id))

  const reserved = (warmUpAnchor ? 1 : 0) + (closingAnchor ? 1 : 0)
  const interiorBudget = Math.max(0, usableQuestions - reserved)

  // Fill the interior with must-slots first (in original order), then
  // if-time slots — this guarantees no must-slot is silently dropped
  // while an if-time slot is kept.
  const keptInteriorIds = new Set<string>()
  for (const s of interiorSlots) {
    if (s.priority !== 'must') continue
    if (keptInteriorIds.size >= interiorBudget) break
    keptInteriorIds.add(s.id)
  }
  for (const s of interiorSlots) {
    if (s.priority !== 'if-time') continue
    if (keptInteriorIds.size >= interiorBudget) break
    keptInteriorIds.add(s.id)
  }
  const keptInterior = interiorSlots.filter(s => keptInteriorIds.has(s.id))

  // Assemble final sequence: [warm-up?, ...interior, closing?]
  const finalSlots: ResolvedSlot[] = []
  if (warmUpAnchor) finalSlots.push(warmUpAnchor)
  finalSlots.push(...keptInterior)
  if (closingAnchor) finalSlots.push(closingAnchor)

  // Reassign slot indices
  finalSlots.forEach((s, i) => { s.slotIndex = i })

  return {
    domain,
    depth,
    experience,
    totalSlots: finalSlots.length,
    slots: finalSlots,
  }
}
