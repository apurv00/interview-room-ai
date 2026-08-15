/**
 * Focused Phase-4 Hire-control surface.
 *
 * Deliberately independent of `modules/hire/index.ts`: importing the full
 * Hire barrel pulls route-facing pipeline and validator composition, which
 * creates a lifecycle-to-decision module cycle. This facade exposes only the
 * control records and fencing primitives used by decision/export services.
 */
export { HireApplication } from './models/HireApplication'
export { HireCandidate } from './models/HireCandidate'
export { HireHumanKitDelivery } from './models/HireHumanKitDelivery'
export { HireHumanRound } from './models/HireHumanRound'
export { HireHumanScorecard } from './models/HireHumanScorecard'
export { HireInterviewResult } from './models/HireInterviewResult'
export { HireJob } from './models/HireJob'
export { HirePrivacyRequest, activeHirePrivacyRequestFilter } from './models/HirePrivacyRequest'
export { HireWorkspace } from './models/HireWorkspace'

export { connectHireControlDB } from './services/hireControlBoundary'
export { activeHireWorkspaceLifecycleFilter } from './services/hireWorkspaceLifecycleFilter'
export { withActiveHireWorkspaceWriteTransaction } from './services/hireWorkspaceWriteFence'
export {
  claimHireCandidatePiiWriteFence,
  HireCandidatePiiTombstoneError,
} from './services/hireCandidatePrivacyWriteFence'
export { claimNonTerminalHireApplicationDispatchFence } from './services/hireApplicationDispatchFence'
export { resolveWorkspaceWriteAuthority } from './services/applyPageService'
export {
  decodeWorkspaceResourceCapability,
  encodeWorkspaceResourceCapability,
} from './services/workspaceCapability'
export { HIRE_HUMAN_KIT_MAX_ATTEMPTS } from './services/hireHumanKitDeliveryPolicy'
export type { MembershipContext } from './services/workspaceService'
