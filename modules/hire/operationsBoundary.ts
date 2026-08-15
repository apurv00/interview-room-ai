/**
 * Focused Phase-5 Hire-control read surface.
 *
 * This intentionally does not import `modules/hire/index.ts`: the broad Hire
 * barrel includes route-facing commands and validators. Operations needs only
 * immutable/read-model records plus the membership and control-DB gates.
 */
export { HireApplication, HIRE_STAGES } from "./models/HireApplication";
export type { HireStage } from "./models/HireApplication";
export { HireCandidate } from "./models/HireCandidate";
export {
  HirePrivacyRequest,
  activeHirePrivacyRequestFilter,
} from "./models/HirePrivacyRequest";
export { HireHumanKitDelivery } from "./models/HireHumanKitDelivery";
export { HireHumanRound } from "./models/HireHumanRound";
export { HireInterviewResult } from "./models/HireInterviewResult";
export { HireJob } from "./models/HireJob";
export type { HireJobStatus } from "./models/HireJob";

export { connectHireControlDB } from "./services/hireControlBoundary";
export { requireMembership } from "./services/workspaceService";
export { HIRE_HUMAN_KIT_MAX_ATTEMPTS } from "./services/hireHumanKitDeliveryPolicy";
export type {
  MembershipContext,
  WorkspaceActor,
} from "./services/workspaceService";
