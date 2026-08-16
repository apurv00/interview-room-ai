/**
 * Narrow bridge to the Hire tenancy root. Workspace branding owns no hiring
 * records; it only reads and updates explicitly selected workspace metadata.
 */
export { HireWorkspace } from '../hire/models/HireWorkspace'
export type {
  IHireWorkspace,
  HireWorkspaceLogoContentType,
} from '../hire/models/HireWorkspace'
export { connectHireControlDB } from '../hire/services/hireControlBoundary'
export { activeHireWorkspaceLifecycleFilter } from '../hire/services/hireWorkspaceLifecycleFilter'
export type { MembershipContext } from '../hire/services/workspaceService'
