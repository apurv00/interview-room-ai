/**
 * IPG Hire v2 — workspace-based hiring (docs/ipg-hire-build-plan.md).
 * Barrel: the only sanctioned import surface for other layers (`@hire`).
 */

// Models (types + collections; hire-owned tables only — ADR 0028)
export * from './models'

// Workspace + membership (tenancy gate)
export {
  createWorkspace,
  getWorkspaceForUser,
  requireMembership,
  addMember,
  listMembers,
  removeMember,
  updateWorkspaceSettings,
  type WorkspaceActor,
  type MembershipContext,
  type AddMemberInput,
} from './services/workspaceService'

// Stable control-plane primitives for the isolated Hire multimodal module.
// These exports intentionally preserve the existing service implementations;
// consumers outside `modules/hire` must not reach into service internals.
export { listHireWorkspaceIdsForSweep } from './services/workspaceSweepService'
export { connectHireControlDB } from './services/hireControlBoundary'
export {
  claimHireCandidatePiiWriteFence,
  HireCandidatePiiTombstoneError,
} from './services/hireCandidatePrivacyWriteFence'
export { addCalendarMonths } from './services/mediaLifecycleService'
export {
  activateRuntimeMediaArtifacts,
  HireRuntimeMediaStaleError,
  ingestRuntimeMediaArtifacts,
  quarantineRuntimeMediaAssets,
} from './services/runtimeMediaIngestionService'
export {
  completeHireRoundIngestion,
  releaseHireRoundIngestion,
  reserveHireRoundIngestion,
  type HireIngestionPriorOutcome,
} from './services/ingestionRevisionReservationService'
export { assertHireMediaKeyScope } from './services/hireMediaStorage'
export {
  HIRE_AI_CONSENT_VERSION,
  HIRE_AI_DISCLOSURE_DIGEST,
  isRecognizedHireConsentSnapshot,
  supportsHireMultimodalObservations,
} from './policies/aiInterviewConsent'

// Pipeline: jobs, candidates, applications, stage moves
export {
  createJob,
  duplicateJob,
  updateJobDepartment,
  listJobs,
  getJobPipeline,
  updateJobStatus,
  addCandidate,
  listCandidates,
  createApplication,
  addOrMergeJobCandidate,
  moveStage,
  getApplicationDetail,
  appendApplicationEvent,
  type JobListItem,
  type DuplicateJobResult,
  type JobPipeline,
  type PipelineEntry,
  type HumanRoundSummary,
  type HumanRoundDetail,
  type StageMoveInput,
  type ApplicationDetail,
  type AddOrMergeJobCandidateInput,
  type AddOrMergeJobCandidateResult,
} from './services/pipelineService'

// Duplicate-job talent-pool review. Listing is read-only; an explicit member
// action uses the existing recruiter-only job candidate command to add a card.
export {
  listJobPoolSuggestions,
  type PoolSuggestion,
} from './services/duplicateJobPoolService'

// AI rounds (engine-seam consumer)
export {
  sendAiRound,
  verifyRoundToken,
  revokeRound,
  sha256,
  buildJdSnapshot,
  AI_ROUND_INTERVIEW_TYPE,
  INVITE_TOKEN_EXPIRY_DAYS,
  type SendAiRoundInput,
  type SendAiRoundResult,
  type VerifiedRound,
  type RoundTokenState,
} from './services/aiRoundService'

// Phase 2 intake: idempotent bulk/apply-page candidate creation + dedupe
export {
  intakeCandidate,
  intakeFromApplyPage,
  type IntakeInput,
  type IntakeResult,
  type IntakeActor,
  type SeenBeforeEntry,
} from './services/intakeService'
// Durable Phase 2 intake queue. Request paths enqueue opaque Hire tasks;
// parsing, scoring, and candidate writes execute only in the worker.
export {
  enqueueMemberResumeIntake,
  enqueuePublicApplyIntake,
  getHireIntakeTask,
  supplyHireIntakeIdentity,
  type QueuedHireIntakeTask,
  type EnqueueMemberResumeIntakeInput,
  type EnqueuePublicApplyIntakeInput,
  type HireIntakeTaskView,
  type SupplyHireIntakeIdentityInput,
} from './services/intakeQueueService'

// Phase 2 screening: deterministic preview plus one human-confirmed,
// immutable gate and unsent invitation batch. It never moves a stage or
// dispatches an interview by itself.
export {
  previewJobScreeningGate,
  confirmJobScreeningGate,
  listJobScreeningGates,
  type ScreeningGateExceptionRequest,
  type ScreeningGatePreviewRequest,
  type ConfirmScreeningGateRequest,
  type ScreeningGatePreviewResult,
  type ConfirmedScreeningGateResult,
  type ScreeningGateListItem,
} from './services/screeningGateService'

// Phase 2 screening invitation dispatch. Gates create immutable planned
// waves; this service is the only path that claims/sends/retries those items.
export {
  dispatchHireScreeningInvitationItem,
  listDueHireScreeningInvitationItemIds,
  processHireScreeningInvitationItem,
  retryFailedHireScreeningInvitationBatch,
  createHireScreeningInvitationWaterfall,
  HIRE_SCREENING_INVITATION_MAX_ATTEMPTS,
  HIRE_SCREENING_INVITATION_RECOVERY_LIMIT_PER_WORKSPACE,
  HIRE_SCREENING_WATERFALL_MAX_COUNT,
} from './services/screeningInvitationService'

// Public apply page (tokenized, unauthenticated candidate self-service)
export {
  issueApplyLink,
  disableApplyLink,
  recoverApplyLink,
  resolveApplyToken,
  resolveWorkspaceWriteAuthority,
  type ApplyLinkResult,
  type PublicJobView,
} from './services/applyPageService'
export {
  analyzeResumeForJob,
  extractEmailFromText,
  extractAllEmails,
  type ResumeIntakeAnalysis,
} from './services/jdMatchService'

// Emails
export { buildAiInviteEmail, type AiInviteEmailParams } from './emails/aiInviteEmail'
export {
  createAiInviteDeliveryRecord,
  deliverAiInvite,
  getAiInviteDeliveryViews,
  type AiInviteDeliveryResult,
  type AiInviteDeliveryView,
} from './services/aiInviteDeliveryService'
export {
  getJobCloseEmailDelivery,
  retryFailedJobCloseEmails,
  type HireJobEmailDeliveryFailure,
  type HireJobEmailDeliverySummary,
} from './services/emailOutboxService'

// Phase 3 human rounds deliberately stay outside the AI/engine `HireRound`
// aggregate. Public kit capability operations return only least-disclosure
// views and are consumed by the sessionless `/interview-kit` routes.
export {
  createGuestHumanRound,
  createMemberHumanRound,
  submitMemberHumanRoundScorecard,
  revokeHumanInterviewKit,
  bootstrapHumanInterviewKit,
  submitHumanInterviewKitScorecard,
  HUMAN_INTERVIEW_KIT_EXPIRY_DAYS,
  type CreateGuestHumanRoundInput,
  type CreateGuestHumanRoundResult,
  type CreateMemberHumanRoundInput,
  type SubmitMemberHumanRoundScorecardInput,
  type HumanKitBootstrapView,
  type SubmitHumanInterviewKitScorecardInput,
} from './services/humanRoundService'
export {
  createHumanInterviewKitDelivery,
  deliverHumanInterviewKit,
  listDueHumanInterviewKitDeliveryIds,
  processHumanInterviewKitDelivery,
  HIRE_HUMAN_KIT_MAX_ATTEMPTS,
  HIRE_HUMAN_KIT_RECOVERY_LIMIT_PER_WORKSPACE,
  type HumanInterviewKitDeliveryResult,
  type HumanInterviewKitDeliveryView,
} from './services/humanKitDeliveryService'
export {
  buildHumanInterviewKitEmail,
  type HumanInterviewKitEmailParams,
} from './emails/humanInterviewKitEmail'

// Validators
export * from './validators/hire'
