import type { ExperienceLevel, Duration } from '@shared/types'

// ─── Phase Types ────────────────────────────────────────────────────────────

export type FlowPhase = 'warm-up' | 'exploration' | 'deep-dive' | 'closing'

export const PHASE_WEIGHTS: Record<FlowPhase, number> = {
  'warm-up': 0.10,
  'exploration': 0.55,
  'deep-dive': 0.25,
  'closing': 0.10,
}

// ─── Topic Slot ─────────────────────────────────────────────────────────────

export type SlotPriority = 'must' | 'if-time'

export interface TopicSlot {
  /** Unique identifier within the template, e.g. "incident-response" */
  id: string
  /** Human-readable label, e.g. "Production Incident Leadership" */
  label: string
  /** Competency bucket for diversity tracking, e.g. "leadership", "technical-depth" */
  competencyBucket: string
  /** Which phase this slot belongs to */
  phase: FlowPhase
  /** Prompt guidance injected when this slot is active */
  guidance: string
  /** Probe-specific guidance for follow-up questions */
  probeGuidance: string
  /** Maximum number of probes allowed for this slot */
  maxProbes: number
  /** Priority — determines inclusion in shorter interviews */
  priority: SlotPriority
  /** Experience-level-specific angle (how the same topic shifts by seniority) */
  experienceAngle?: string
}

// ─── Flow Template ──────────────────────────────────────────────────────────

export interface FlowTemplate {
  /** Domain slug, e.g. "backend" */
  domain: string
  /** Depth slug, e.g. "behavioral" */
  depth: string
  /** Experience level this template is designed for */
  experience: ExperienceLevel
  /** Ordered slot sequence — the "playbook" for this exact combination */
  slots: TopicSlot[]
  /** Things to never ask in this combination */
  neverAsk: string[]
}

// ─── JD Overlay ─────────────────────────────────────────────────────────────

export interface JDSlotAnnotation {
  /** Slot id to annotate */
  slotId: string
  /** JD-specific context to inject into the slot guidance */
  jdContext: string
}

export interface JDSlotInsertion {
  /** New slot to insert into the flow */
  slot: TopicSlot
  /** Insert after this slot id */
  insertAfter: string
  /** The JD requirement this slot addresses */
  jdRequirement: string
}

export interface JDOverlay {
  /** Promote if-time slots to must when they match JD requirements */
  promotions: string[] // slot ids to promote
  /** Annotate existing slots with JD-specific context */
  annotations: JDSlotAnnotation[]
  /** Insert new JD-specific slots (max 2) */
  insertions: JDSlotInsertion[]
}

// ─── Resolved Session Flow ──────────────────────────────────────────────────

export interface ResolvedSlot {
  /** Slot id */
  id: string
  /** Human-readable label */
  label: string
  /** Competency bucket */
  competencyBucket: string
  /** Phase this slot belongs to */
  phase: FlowPhase
  /** Prompt guidance (may be JD-enriched) */
  guidance: string
  /** Probe-specific guidance */
  probeGuidance: string
  /** Max probes for this slot */
  maxProbes: number
  /** Resolved priority (may be promoted by JD overlay) */
  priority: SlotPriority
  /** Experience-specific angle, already resolved */
  experienceAngle?: string
  /** JD annotation, if any */
  jdAnnotation?: string
  /** Index in the resolved sequence (0-based) */
  slotIndex: number
}

export interface ResolvedFlow {
  /** Domain slug */
  domain: string
  /** Depth slug */
  depth: string
  /** Experience level */
  experience: ExperienceLevel
  /** Total slots in this resolved flow */
  totalSlots: number
  /** Ordered list of resolved slots */
  slots: ResolvedSlot[]
}

// ─── Prompt Context ─────────────────────────────────────────────────────────

export interface FlowPromptContext {
  /** Full formatted prompt block to inject into system prompt */
  promptBlock: string
  /** Current slot being addressed (null if past all slots) */
  currentSlot: ResolvedSlot | null
  /** Phase label */
  phase: FlowPhase | null
  /** Whether coverage pressure is active (more must-slots than remaining questions) */
  coveragePressure: boolean
}

// ─── Template Registry ──────────────────────────────────────────────────────

/** Key format: "domain:depth:experience" e.g. "backend:behavioral:3-6" */
export type TemplateKey = string

export function makeTemplateKey(domain: string, depth: string, experience: ExperienceLevel): TemplateKey {
  return `${domain}:${depth}:${experience}`
}
