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

  // 4. Scale to duration — trim if-time slots when interview is short
  const totalQuestions = getQuestionCount(duration)

  // Count must slots per phase
  const mustSlots = resolvedSlots.filter(s => s.priority === 'must')
  const ifTimeSlots = resolvedSlots.filter(s => s.priority === 'if-time')

  let finalSlots: ResolvedSlot[]

  if (mustSlots.length >= totalQuestions) {
    // More must-slots than questions: take as many as fit, preserving phase order
    finalSlots = mustSlots.slice(0, totalQuestions)
  } else if (resolvedSlots.length <= totalQuestions) {
    // All slots fit
    finalSlots = resolvedSlots
  } else {
    // Include all must-slots, fill remaining capacity with if-time in order
    const remainingCapacity = totalQuestions - mustSlots.length
    const includedIfTime = ifTimeSlots.slice(0, remainingCapacity)
    const includedIds = new Set([
      ...mustSlots.map(s => s.id),
      ...includedIfTime.map(s => s.id),
    ])
    // Maintain original order
    finalSlots = resolvedSlots.filter(s => includedIds.has(s.id))
  }

  // Guarantee at least 1 warm-up and 1 closing if they exist
  const hasWarmUp = finalSlots.some(s => s.phase === 'warm-up')
  const hasClosing = finalSlots.some(s => s.phase === 'closing')
  if (!hasWarmUp) {
    const warmUp = resolvedSlots.find(s => s.phase === 'warm-up')
    if (warmUp) finalSlots.unshift(warmUp)
  }
  if (!hasClosing) {
    const closing = resolvedSlots.find(s => s.phase === 'closing')
    if (closing) finalSlots.push(closing)
  }

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
