import type { ThreadSummary, PerformanceSignal } from '@shared/types'
import type { ResolvedFlow, ResolvedSlot, FlowPromptContext, FlowPhase } from './types'

/**
 * Build the flow prompt context for injection into the generate-question system prompt.
 *
 * This replaces the vague "ask about something different" diversity nudge with
 * a specific, structured instruction based on the resolved flow template.
 */
export function buildFlowPromptContext(params: {
  flow: ResolvedFlow
  currentSlotIndex: number
  completedThreads: ThreadSummary[]
  performanceSignal: PerformanceSignal
}): FlowPromptContext {
  const { flow, currentSlotIndex, completedThreads, performanceSignal } = params

  // Past all slots — no flow guidance (shouldn't happen but handle gracefully)
  if (currentSlotIndex >= flow.totalSlots) {
    return {
      promptBlock: '',
      currentSlot: null,
      phase: null,
      coveragePressure: false,
    }
  }

  const currentSlot = flow.slots[currentSlotIndex]
  const coveredSlots = flow.slots.slice(0, currentSlotIndex)
  const remainingSlots = flow.slots.slice(currentSlotIndex + 1)

  // Calculate coverage pressure: are there more remaining must-slots than remaining questions?
  const remainingMustSlots = remainingSlots.filter(s => s.priority === 'must').length
  const coveredCount = completedThreads.length
  const remainingQuestionBudget = flow.totalSlots - coveredCount - 1
  const coveragePressure = remainingMustSlots > 0 && remainingMustSlots >= remainingQuestionBudget

  // Build the adaptive deep-dive guidance if current slot is deep-dive phase
  let resolvedGuidance = currentSlot.guidance
  if (currentSlot.phase === 'deep-dive' && currentSlot.id.startsWith('adaptive-deep-dive')) {
    resolvedGuidance = buildAdaptiveDeepDiveGuidance(
      currentSlot,
      completedThreads,
      performanceSignal,
    )
  }

  // Build the structured prompt block
  const lines: string[] = []

  lines.push(`INTERVIEW FLOW PLAN:`)
  lines.push(`Phase: ${formatPhase(currentSlot.phase)} (slot ${currentSlotIndex + 1} of ${flow.totalSlots})`)
  lines.push(`Current topic: "${currentSlot.label}"`)
  lines.push(``)
  lines.push(`TOPIC GUIDANCE: ${resolvedGuidance}`)

  if (currentSlot.experienceAngle) {
    lines.push(`EXPERIENCE ANGLE (${flow.experience} years): ${currentSlot.experienceAngle}`)
  }

  lines.push(`PROBE GUIDANCE: ${currentSlot.probeGuidance}`)

  if (currentSlot.jdAnnotation) {
    lines.push(`JD ALIGNMENT: ${currentSlot.jdAnnotation}`)
  }

  lines.push(`Max probes for this topic: ${currentSlot.maxProbes}`)
  lines.push(``)

  // Covered topics
  if (coveredSlots.length > 0) {
    const coveredList = coveredSlots
      .map((s, i) => `[${i + 1}] ${s.label} (${s.phase})`)
      .join(', ')
    lines.push(`COVERED TOPICS: ${coveredList}`)
    lines.push(`Do NOT revisit these topics.`)
  }

  // Remaining topics
  if (remainingSlots.length > 0) {
    const remainingList = remainingSlots
      .map((s, i) => `[${currentSlotIndex + 2 + i}] ${s.label} (${s.phase})`)
      .join(', ')
    lines.push(`REMAINING TOPICS: ${remainingList}`)
    lines.push(`Do NOT ask about remaining topics yet.`)
  }

  // Coverage pressure alert
  if (coveragePressure) {
    lines.push(``)
    lines.push(`COVERAGE ALERT: ${remainingMustSlots} must-cover topics remaining but only ${remainingQuestionBudget} questions left. Advance promptly after ${Math.min(currentSlot.maxProbes, 1)} probe max.`)
  }

  return {
    promptBlock: lines.join('\n'),
    currentSlot,
    phase: currentSlot.phase,
    coveragePressure,
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function formatPhase(phase: FlowPhase): string {
  switch (phase) {
    case 'warm-up': return 'WARM-UP'
    case 'exploration': return 'EXPLORATION'
    case 'deep-dive': return 'DEEP-DIVE'
    case 'closing': return 'CLOSING'
  }
}

/**
 * Build adaptive guidance for deep-dive slots based on candidate performance.
 */
function buildAdaptiveDeepDiveGuidance(
  slot: ResolvedSlot,
  completedThreads: ThreadSummary[],
  performanceSignal: PerformanceSignal,
): string {
  // Find the weakest covered topic
  const scoredThreads = completedThreads.filter(t => t.avgScore > 0)
  const weakest = scoredThreads.length > 0
    ? scoredThreads.reduce((min, t) => t.avgScore < min.avgScore ? t : min)
    : null

  if (slot.id === 'adaptive-deep-dive-1' && weakest && weakest.avgScore < 65) {
    return `ADAPTIVE DEEP-DIVE: The candidate scored lowest on "${weakest.topicQuestion.slice(0, 80)}" (avg: ${weakest.avgScore}). ` +
      `Revisit this area with a different angle — ask a follow-up that probes the underlying gap. ` +
      `DO NOT repeat the same question. Approach the same competency from a new scenario or ask "what would you do differently?"` +
      (slot.guidance ? `\n\nBase guidance: ${slot.guidance}` : '')
  }

  if (slot.id === 'adaptive-deep-dive-2' || (slot.id === 'adaptive-deep-dive-1' && (!weakest || weakest.avgScore >= 65))) {
    if (performanceSignal === 'strong') {
      return `DEEP-DIVE CHALLENGE: The candidate is performing well across all areas. ` +
        `Pick the most strategically important topic from covered areas and ask a significantly harder question. ` +
        `Force a trade-off, present a constraint, or challenge an assumption.` +
        (slot.guidance ? `\n\nBase guidance: ${slot.guidance}` : '')
    }
    if (performanceSignal === 'struggling' && weakest) {
      return `DEEP-DIVE SUPPORT: The candidate is finding this challenging. ` +
        `Revisit their strongest area to build confidence before closing. ` +
        `Ask for their best example in a domain where they showed comfort.` +
        (slot.guidance ? `\n\nBase guidance: ${slot.guidance}` : '')
    }
  }

  // Fallback: use the slot's default guidance
  return slot.guidance
}
