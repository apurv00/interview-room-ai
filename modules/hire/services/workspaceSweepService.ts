import { HireWorkspace } from '../models/HireWorkspace'
import { connectHireControlDB } from './hireControlBoundary'

/**
 * Enumerate tenancy roots for a control-plane background sweep. Child
 * collections must then be queried with one of these workspace ids; the root
 * collection is the sole legitimate unscoped Hire query.
 */
export async function listHireWorkspaceIdsForSweep(): Promise<string[]> {
  await connectHireControlDB()
  const workspaces = await HireWorkspace.find({}).select('_id').sort({ _id: 1 }).lean()
  return workspaces.map((workspace) => workspace._id.toString())
}
