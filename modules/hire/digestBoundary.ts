/**
 * Narrow Phase-5 digest facade.
 *
 * This keeps operational-email code below Hire's composition/root barrel, so
 * legacy isolated mocks do not load validators or unrelated public surfaces.
 * It is intentionally an additive export surface: no underlying behavior is
 * wrapped, changed, or generalized here.
 */
export { connectHireControlDB } from './services/hireControlBoundary'
export { activeHireWorkspaceLifecycleFilter } from './services/hireWorkspaceLifecycleFilter'
export { HIRE_HUMAN_KIT_MAX_ATTEMPTS } from './services/hireHumanKitDeliveryPolicy'
export { HireApplication } from './models/HireApplication'
export { HireCandidate } from './models/HireCandidate'
export { HireHumanKitDelivery } from './models/HireHumanKitDelivery'
export { HireHumanRound } from './models/HireHumanRound'
export { HireJob } from './models/HireJob'
export { HirePrivacyRequest, activeHirePrivacyRequestFilter } from './models/HirePrivacyRequest'
export { HireWorkspace } from './models/HireWorkspace'
export { HireWorkspaceMember } from './models/HireWorkspaceMember'
// The digest reads only the opaque practice-graph coordinates, never the
// onboarding service or raw invite flow, so synthetic test drives cannot
// alter operational counts delivered to a real member.
export { HireOnboardingTestDrive } from '../hire-onboarding/models/HireOnboardingTestDrive'
