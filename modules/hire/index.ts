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

// Pipeline: jobs, candidates, applications, stage moves
export {
  createJob,
  listJobs,
  getJobPipeline,
  updateJobStatus,
  addCandidate,
  listCandidates,
  createApplication,
  moveStage,
  getApplicationDetail,
  appendApplicationEvent,
  type JobListItem,
  type JobPipeline,
  type PipelineEntry,
  type StageMoveInput,
  type ApplicationDetail,
} from './services/pipelineService'

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

// Public apply page (tokenized, unauthenticated candidate self-service)
export {
  issueApplyLink,
  disableApplyLink,
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

// Validators
export * from './validators/hire'
