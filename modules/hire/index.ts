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
  recordConsent,
  bindGuestUser,
  prepareRound,
  revokeRound,
  sha256,
  buildJdSnapshot,
  guestEmailForRound,
  HIRE_CONSENT_VERSION,
  AI_ROUND_INTERVIEW_TYPE,
  INVITE_TOKEN_EXPIRY_DAYS,
  POST_AUTH_GRACE_DAYS,
  type SendAiRoundInput,
  type SendAiRoundResult,
  type VerifiedRound,
  type RoundTokenState,
  type GuestInterviewConfig,
} from './services/aiRoundService'

// Completion reconciliation (read-only against the engine)
export {
  reconcileApplicationRounds,
  buildResultsSnapshot,
  type RoundActivity,
} from './services/roundLinkService'

// Phase 2 intake: idempotent bulk/apply-page candidate creation + dedupe
export {
  intakeCandidate,
  type IntakeInput,
  type IntakeResult,
  type SeenBeforeEntry,
} from './services/intakeService'
export {
  analyzeResumeForJob,
  extractEmailFromText,
  type ResumeIntakeAnalysis,
} from './services/jdMatchService'

// Emails
export { buildAiInviteEmail, type AiInviteEmailParams } from './emails/aiInviteEmail'

// Validators
export * from './validators/hire'
