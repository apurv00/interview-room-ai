// ─── Interview Flow Templates — barrel export ──────────────────────────────
// Research-backed interview flow engine: topic sequencing, probe depth control,
// coverage pressure, and JD-dynamic slot overlay.

export type {
  FlowPhase,
  SlotPriority,
  TopicSlot,
  FlowTemplate,
  JDOverlay,
  JDSlotAnnotation,
  JDSlotInsertion,
  ResolvedSlot,
  ResolvedFlow,
  FlowPromptContext,
  TemplateKey,
} from './types'

export { makeTemplateKey, PHASE_WEIGHTS } from './types'
export { resolveFlow } from './resolver'
export { buildFlowPromptContext } from './promptBuilder'
export { shouldProbeOrAdvanceWithFlow } from './coveragePressure'
export { buildJDOverlay } from './jdOverlayBuilder'
export { TEMPLATE_REGISTRY } from './templates'
