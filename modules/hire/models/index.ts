/**
 * IPG Hire v2 models — module-local (modules/payments precedent, ADR 0028).
 * Every collection here is workspace-scoped: workspaceId is required and
 * immutable on every schema, and every service query must thread it.
 * These are the ONLY collections the Hire control plane writes. Candidate
 * flows never read or write B2C User/InterviewSession collections.
 */
export {
  HireWorkspace,
  GUEST_AUTH_MODES,
  HIRE_WORKSPACE_LIFECYCLE_STATES,
  HIRE_WORKSPACE_PURGE_STATES,
  type GuestAuthMode,
  type HireWorkspaceLifecycleState,
  type HireWorkspacePurgeState,
  HIRE_WORKSPACE_LOGO_CONTENT_TYPES,
  type HireWorkspaceLogoContentType,
  type IHireWorkspaceLogo,
  type IHireWorkspaceAdminTransferEvent,
  type IHireWorkspaceLifecycleEvent,
  type IHireWorkspace,
} from './HireWorkspace'
export {
  HireWorkspaceMember,
  HIRE_MEMBER_ROLES,
  HIRE_MEMBER_AUTH_STATES,
  HIRE_MEMBER_ACTIVE_EMAIL_INDEX_NAME,
  HIRE_MEMBER_ACTIVE_EMAIL_INDEX_KEY,
  HIRE_MEMBER_ACTIVE_EMAIL_INDEX_PARTIAL,
  normalizeHireMemberEmail,
  type HireMemberRole,
  type HireMemberAuthState,
  type IHireWorkspaceMember,
} from './HireWorkspaceMember'
export { HireMemberSetup, type IHireMemberSetup } from './HireMemberSetup'
export { HireMemberSession, type IHireMemberSession } from './HireMemberSession'
export { HireJob, HIRE_JOB_STATUSES, type HireJobStatus, type IHireJob } from './HireJob'
export {
  HireJobRequirementVersion,
  HIRE_WORK_MODES,
  HIRE_REQUIREMENT_IMPORTANCE,
  HIRE_REQUIREMENT_VERSION_STATES,
  type HireWorkMode,
  type HireRequirementImportance,
  type HireRequirementVersionState,
  type IHireStructuredRequirement,
  type IHireJobBuilderInput,
  type IHireJobRequirementVersion,
} from './HireJobRequirementVersion'
export {
  HireEmailOutbox,
  HIRE_EMAIL_OUTBOX_KINDS,
  HIRE_EMAIL_OUTBOX_STATUSES,
  type HireEmailOutboxKind,
  type HireEmailOutboxStatus,
  type IHireEmailOutbox,
} from './HireEmailOutbox'
export {
  HireAiInviteDelivery,
  HIRE_AI_INVITE_DELIVERY_STATUSES,
  type HireAiInviteDeliveryStatus,
  type IHireAiInviteDelivery,
} from './HireAiInviteDelivery'
export {
  HireCandidate,
  HIRE_CANDIDATE_SOURCES,
  HIRE_CANDIDATE_PROVENANCE_SOURCES,
  HIRE_CANDIDATE_ANONYMIZATION_REASONS,
  type HireCandidateSource,
  type HireCandidateProvenanceSource,
  type HireCandidateAnonymizationReason,
  type IHireCandidateScreeningProfile,
  type IHireCandidate,
} from './HireCandidate'
export {
  HireApplication,
  HIRE_STAGES,
  TERMINAL_STAGES,
  HIRE_EVENT_TYPES,
  type HireStage,
  type HireEventType,
  type IHireApplication,
  type IHireApplicationEvent,
  type IHireResumeMatch,
  type IHireApplicantSubmission,
  APPLICANT_SUBMISSION_CAP,
} from './HireApplication'
export {
  HireIntakeTask,
  HIRE_INTAKE_TASK_MAX_PAYLOAD_BYTES,
  HIRE_INTAKE_TASK_SOURCES,
  HIRE_INTAKE_TASK_STATUSES,
  type HireIntakeTaskSource,
  type HireIntakeTaskStatus,
  type IHireIntakeTask,
} from './HireIntakeTask'
export {
  HireScreeningGate,
  HIRE_SCREENING_SELECTION_MODES,
  HIRE_SCREENING_GATE_STATUSES,
  HIRE_SCREENING_SCORE_STATES,
  HIRE_SCREENING_KNOCKOUT_REASONS,
  HIRE_SCREENING_SELECTION_REASONS,
  HIRE_SCREENING_EXCEPTION_ACTIONS,
  HIRE_SCREENING_GATE_SNAPSHOT_CAP,
  type HireScreeningSelectionMode,
  type HireScreeningGateStatus,
  type HireScreeningScoreState,
  type HireScreeningKnockoutReason,
  type HireScreeningSelectionReason,
  type HireScreeningExceptionAction,
  type IHireScreeningKnockoutSettings,
  type IHireScreeningCutLine,
  type IHireScreeningRankedApplication,
  type IHireScreeningException,
  type IHireScreeningGate,
} from './HireScreeningGate'
export {
  HireInvitationBatch,
  HIRE_INVITATION_BATCH_STATUSES,
  type HireInvitationBatchStatus,
  type IHireInvitationBatch,
} from './HireInvitationBatch'
export {
  HireInvitationBatchItem,
  HIRE_INVITATION_BATCH_ITEM_STATUSES,
  HIRE_INVITATION_BATCH_ITEM_DELIVERY_STATUSES,
  HIRE_INVITATION_BATCH_ITEM_SELECTION_REASONS,
  type HireInvitationBatchItemStatus,
  type HireInvitationBatchItemDeliveryStatus,
  type HireInvitationBatchItemSelectionReason,
  type IHireInvitationBatchItem,
} from './HireInvitationBatchItem'
export {
  HireRound,
  HIRE_ROUND_KINDS,
  HIRE_ROUND_STATUSES,
  type HireRoundKind,
  type HireRoundStatus,
  type IHireRound,
  type HireRoundResults,
  type HireRoundPerQuestion,
} from './HireRound'
export {
  HireHumanRound,
  HIRE_HUMAN_ROUND_MODES,
  HIRE_HUMAN_ROUND_STATUSES,
  type HireHumanRoundMode,
  type HireHumanRoundStatus,
  type IHireHumanRoundBrief,
  type IHireHumanRound,
} from './HireHumanRound'
export {
  HireInterviewKit,
  HIRE_INTERVIEW_KIT_STATUSES,
  type HireInterviewKitStatus,
  type IHireInterviewKit,
} from './HireInterviewKit'
export {
  HireHumanScorecard,
  HIRE_HUMAN_SCORECARD_DIMENSIONS,
  HIRE_HUMAN_SCORECARD_RECOMMENDATIONS,
  HIRE_HUMAN_SCORECARD_STATUSES,
  HIRE_HUMAN_SCORECARD_REVIEWER_KINDS,
  type HireHumanScorecardDimensionKey,
  type HireHumanScorecardRecommendation,
  type HireHumanScorecardStatus,
  type HireHumanScorecardReviewerKind,
  type IHireHumanScorecardDimension,
  type IHireHumanScorecard,
} from './HireHumanScorecard'
export {
  HireHumanKitDelivery,
  HIRE_HUMAN_KIT_DELIVERY_PURPOSES,
  HIRE_HUMAN_KIT_DELIVERY_STATUSES,
  type HireHumanKitDeliveryPurpose,
  type HireHumanKitDeliveryStatus,
  type IHireHumanKitDelivery,
} from './HireHumanKitDelivery'
export { HireEngineHandoff, type IHireEngineHandoff } from './HireEngineHandoff'
export {
  HireEngineIngestionEvent,
  type IHireEngineIngestionEvent,
} from './HireEngineIngestionEvent'
export { HireGuestSession, type IHireGuestSession } from './HireGuestSession'
export {
  HireConsentReceipt,
  type HireConsentAcknowledgements,
  type IHireConsentReceipt,
} from './HireConsentReceipt'
export {
  HireInterviewAttempt,
  HIRE_INTERVIEW_ATTEMPT_STATUSES,
  type HireInterviewAttemptStatus,
  type IHireInterviewAttempt,
} from './HireInterviewAttempt'
export {
  HireInterviewResult,
  type HireEvidenceType,
  type HireEvidenceRef,
  type HireNumericSummary,
  type HireAssessmentProjection,
  type IHireInterviewResult,
} from './HireInterviewResult'
export {
  HireMediaAsset,
  HIRE_MEDIA_KINDS,
  HIRE_MEDIA_STATES,
  HIRE_MEDIA_PURGE_REASONS,
  type HireMediaKind,
  type HireMediaState,
  type HireMediaPurgeReason,
  type IHireMediaAsset,
} from './HireMediaAsset'
export { HirePrivacyRequest, type IHirePrivacyRequest } from './HirePrivacyRequest'
