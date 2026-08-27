import { connectHireControlDB } from "@hire-operations-boundary";
export { HireWorkspace, withActiveHireWorkspaceWriteTransaction } from "@hire-operations-boundary";

/** Operations reads use only the isolated Hire control database. */
export async function connectHireOperationsDB(): Promise<void> {
  await connectHireControlDB();
}
