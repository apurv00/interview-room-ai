/**
 * IPG Hire v2 models — module-local (modules/payments precedent, ADR 0028).
 * Every collection here is workspace-scoped: workspaceId is required and
 * immutable on every schema, and every service query must thread it.
 * These are the ONLY collections the hire module writes. Engine/B2C tables
 * (User, InterviewSession, …) are read-only from this module; the single
 * sanctioned B2C write — minting the guest User at OTP verification — lives
 * in the app-layer guest-auth route (the guest-session auth seam), not here.
 */
export { HireWorkspace, type IHireWorkspace } from './HireWorkspace'
export {
  HireWorkspaceMember,
  HIRE_MEMBER_ROLES,
  type HireMemberRole,
  type IHireWorkspaceMember,
} from './HireWorkspaceMember'
export { HireJob, HIRE_JOB_STATUSES, type HireJobStatus, type IHireJob } from './HireJob'
export {
  HireCandidate,
  HIRE_CANDIDATE_SOURCES,
  type HireCandidateSource,
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
} from './HireApplication'
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
