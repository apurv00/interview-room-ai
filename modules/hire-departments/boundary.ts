/**
 * Deliberately narrow bridge to the established Hire control-plane authority.
 *
 * Department commands use the exact workspace write fence as job creation,
 * rather than copying a lifecycle/membership check or importing the broad
 * `@hire` barrel (which would pull pipeline and validator composition here).
 */
export { connectHireControlDB } from '../hire/services/hireControlBoundary'
export {
  withActiveHireWorkspaceWriteTransaction,
} from '../hire/services/hireWorkspaceWriteFence'
export type { MembershipContext } from '../hire/services/workspaceService'
