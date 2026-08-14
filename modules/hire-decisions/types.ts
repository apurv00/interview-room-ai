/**
 * Phase 4 decision-core contracts.
 *
 * These types deliberately describe evidence summaries rather than a weighted
 * or blended hiring score. A human member remains the sole authority for a
 * pipeline stage move; this module only makes the evidence legible together.
 */

export const HIRE_SHARE_PACKET_SECTIONS = [
  'candidate_brief',
  'ai_assessments',
  'human_scorecards',
] as const
export type HireSharePacketSection = (typeof HIRE_SHARE_PACKET_SECTIONS)[number]

/** Kept separate from the human-scorecard model so an external verdict is not a scorecard. */
export const HIRE_EXTERNAL_VERDICT_RECOMMENDATIONS = [
  'strong_yes',
  'yes',
  'no',
  'strong_no',
] as const
export type HireExternalVerdictRecommendation =
  (typeof HIRE_EXTERNAL_VERDICT_RECOMMENDATIONS)[number]

export const HIRE_DECISION_DIMENSIONS = [
  'role_capability',
  'problem_solving',
  'communication',
  'collaboration',
] as const
export type HireDecisionDimensionKey = (typeof HIRE_DECISION_DIMENSIONS)[number]

export interface HireDecisionCoordinates {
  workspaceId: string
  applicationId: string
  jobId: string
  candidateId: string
}

/** Minimum-disclosure candidate context safe for an explicitly scoped packet. */
export interface HireDecisionCandidateBrief {
  candidateName: string
  jobTitle: string
  location?: string
  experienceYears?: number
}

export type HireRecommendationTally = Record<HireExternalVerdictRecommendation, number>

/**
 * Per-rubric-dimension distribution. `reviewerSpread` is max - min for this
 * dimension only; there is intentionally no overall cross-dimension score.
 */
export interface HireDecisionDimensionAggregate {
  key: HireDecisionDimensionKey
  count: number
  mean: number | null
  min: number | null
  max: number | null
  reviewerSpread: number | null
}

export interface HireHumanDecisionSourceAggregate {
  count: number
  recommendations: HireRecommendationTally
  dimensions: HireDecisionDimensionAggregate[]
}

/** Member and interview-kit evidence remains visibly separate from external verdicts. */
export interface HireHumanScorecardAggregate {
  total: HireHumanDecisionSourceAggregate
  member: HireHumanDecisionSourceAggregate
  kit: HireHumanDecisionSourceAggregate
}

export interface HireExternalVerdictAggregate {
  count: number
  recommendations: HireRecommendationTally
}

/** Sanitised AI projection; deliberately excludes raw engine output, media, and audit references. */
export interface HireDecisionAiAssessment {
  completedAt: Date
  overallScore: number | null
  recommendation?: string
  confidence?: string
  dimensions: Array<{
    key: string
    label?: string
    score: number | null
  }>
}

/**
 * Server-only read model for a single application. It has no stage action,
 * rank, close note, raw resume/contact data, media, or audit data.
 */
export interface HireDecisionView {
  coordinates: HireDecisionCoordinates
  candidateBrief: HireDecisionCandidateBrief
  aiAssessments: HireDecisionAiAssessment[]
  humanScorecards: HireHumanScorecardAggregate
  externalVerdicts: HireExternalVerdictAggregate
}

/** Immutable value copied onto a share-packet at creation time. */
export interface HireSharePacketSnapshot {
  version: 1
  candidateBrief?: HireDecisionCandidateBrief
  aiAssessments?: HireDecisionAiAssessment[]
  humanScorecards?: HireHumanScorecardAggregate
}

/** Safe application-level context attached to a decision inbox item. */
export interface HireDecisionActionContext {
  coordinates: HireDecisionCoordinates
  candidateBrief: HireDecisionCandidateBrief
  humanScorecards: HireHumanScorecardAggregate
  externalVerdicts: HireExternalVerdictAggregate
}

export interface HirePendingHumanScorecardAction {
  kind: 'pending_human_scorecard'
  occurredAt: Date
  humanRoundMode: 'guest_kit' | 'member_room'
  decision: HireDecisionActionContext
}

export interface HireTerminalHumanKitDeliveryFailureAction {
  kind: 'terminal_human_kit_delivery_failure'
  occurredAt: Date
  deliveryPurpose: 'initial' | 'reminder'
  attempts: number
  decision: HireDecisionActionContext
}

export interface HireExternalVerdictSubmittedAction {
  kind: 'external_verdict_submitted'
  occurredAt: Date
  recommendation: HireExternalVerdictRecommendation
  decision: HireDecisionActionContext
}

export type HireDecisionActionInboxItem =
  | HirePendingHumanScorecardAction
  | HireTerminalHumanKitDeliveryFailureAction
  | HireExternalVerdictSubmittedAction

export interface HireDecisionActionInbox {
  items: HireDecisionActionInboxItem[]
}

/** Compare keeps the caller's deliberate application order; it never supplies a rank. */
export interface HireDecisionComparison {
  workspaceId: string
  jobId: string
  applications: HireDecisionView[]
}
