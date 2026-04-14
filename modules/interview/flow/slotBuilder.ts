import type { TopicSlot, FlowPhase, SlotPriority, FlowTemplate } from './types'
import type { ExperienceLevel } from '@shared/types'

/**
 * Compact slot definition — keeps template files small.
 * [id, label, bucket, phase, priority, maxProbes, guidance, probeGuidance, experienceAngle?]
 */
export type CompactSlot = [
  string,       // id
  string,       // label
  string,       // competencyBucket
  FlowPhase,    // phase
  SlotPriority, // priority
  number,       // maxProbes
  string,       // guidance
  string,       // probeGuidance
  string?,      // experienceAngle (optional)
]

export function slot(s: CompactSlot): TopicSlot {
  return {
    id: s[0],
    label: s[1],
    competencyBucket: s[2],
    phase: s[3],
    priority: s[4],
    maxProbes: s[5],
    guidance: s[6],
    probeGuidance: s[7],
    experienceAngle: s[8],
  }
}

/** Build a FlowTemplate from compact slot definitions. */
export function template(
  domain: string,
  depth: string,
  experience: ExperienceLevel,
  slots: CompactSlot[],
  neverAsk: string[],
): FlowTemplate {
  return {
    domain,
    depth,
    experience,
    slots: slots.map(slot),
    neverAsk,
  }
}

/** Standard adaptive deep-dive slots appended to exploration phase. */
export const DEEP_DIVE_1: CompactSlot = [
  'adaptive-deep-dive-1', 'Adaptive Deep-Dive (Weakness)', 'adaptive',
  'deep-dive', 'must', 3,
  'Revisit the candidate\'s weakest area with a new angle. Do NOT repeat a previous question.',
  'Probe the underlying gap — ask what they would do differently or present a new scenario.',
]

export const DEEP_DIVE_2: CompactSlot = [
  'adaptive-deep-dive-2', 'Adaptive Deep-Dive (Challenge/Support)', 'adaptive',
  'deep-dive', 'if-time', 3,
  'If candidate is strong, challenge with a harder question. If struggling, revisit their strongest area.',
  'For strong candidates, force a tradeoff or constraint. For struggling, ask for their best example.',
]
