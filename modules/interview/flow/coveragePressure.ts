import type { AnswerEvaluation, Duration } from '@shared/types'
import type { ResolvedFlow } from './types'
import { getMinimumTopics } from '@interview/config/interviewConfig'

/**
 * Flow-aware probe-or-advance decision.
 *
 * Extends the existing shouldProbeOrAdvance logic with:
 * - Per-slot maxProbes enforcement
 * - Coverage pressure: force advance when remaining must-slots >= remaining question budget
 * - Phase-aware behavior: no probing in warm-up, extended probing in deep-dive
 *
 * Falls back to existing logic when flow is null.
 */
export function shouldProbeOrAdvanceWithFlow(params: {
  evaluation: AnswerEvaluation
  timeRemaining: number
  completedThreadsCount: number
  duration: Duration
  flow: ResolvedFlow | null
  currentProbeDepth: number
}): 'probe' | 'advance' {
  const { evaluation, timeRemaining, completedThreadsCount, duration, flow, currentProbeDepth } = params
  const probe = evaluation.probeDecision

  // Hard constraints: never probe if evaluator says no or time is critical
  if (!probe?.shouldProbe) return 'advance'
  if (timeRemaining < 60) return 'advance'

  if (flow) {
    const currentSlot = flow.slots[completedThreadsCount]

    if (currentSlot) {
      // Respect per-slot maxProbes limit
      if (currentProbeDepth >= currentSlot.maxProbes) return 'advance'

      // Warm-up phase: always advance quickly (no probing)
      if (currentSlot.phase === 'warm-up') return 'advance'

      // Coverage pressure: if remaining must-slots can't all fit, force advance
      const remainingSlots = flow.slots.slice(completedThreadsCount + 1)
      const remainingMustSlots = remainingSlots.filter(s => s.priority === 'must').length
      const roughTimePerTopic = 90 // ~1.5 min per topic
      const questionsRemainingByTime = Math.floor(timeRemaining / roughTimePerTopic)

      if (remainingMustSlots > 0 && remainingMustSlots >= questionsRemainingByTime) {
        return 'advance'
      }

      // Deep-dive phase: allow probing if evaluator recommends it
      if (currentSlot.phase === 'deep-dive') {
        return 'probe'
      }
    }

    // Default for flow-enabled sessions: follow the evaluator recommendation
    return 'probe'
  }

  // Fallback: existing logic for non-flow sessions
  const topicsNeeded = getMinimumTopics(duration) - completedThreadsCount
  const roughTimePerTopic = 90
  if (topicsNeeded > 0 && topicsNeeded * roughTimePerTopic > timeRemaining) return 'advance'

  return 'probe'
}
