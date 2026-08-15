import type mongoose from 'mongoose'
import type { IHireWorkspace } from '../models/HireWorkspace'

/**
 * Compatibility-safe lifecycle predicate for transactional Hire writes.
 * Workspaces created before Phase 1 have no lifecycleState and are active.
 *
 * This lives below service composition so write-fence and Phase-4 decision
 * boundaries can use it without loading workspace lifecycle side effects.
 */
export function activeHireWorkspaceLifecycleFilter(): mongoose.QueryFilter<IHireWorkspace> {
  return {
    $or: [{ lifecycleState: 'active' }, { lifecycleState: { $exists: false } }],
  }
}
