import type mongoose from "mongoose";
import type { ClientSession } from "mongoose";
import { HireCandidateSelectionSnapshot } from "./models/HireCandidateSelectionSnapshot";

type SelectionPurgeInput = {
  workspaceId: mongoose.Types.ObjectId;
  session: ClientSession;
};

function requireTransaction(input: SelectionPurgeInput): void {
  if (!input.session.inTransaction()) {
    throw new Error("Hire candidate selections must be deleted inside a transaction");
  }
}

/** Delete immutable selection children inside the caller-owned workspace purge transaction. */
export async function deleteHireCandidateSelectionWorkspaceData(
  input: SelectionPurgeInput,
): Promise<void> {
  requireTransaction(input);
  await HireCandidateSelectionSnapshot.deleteMany(
    { workspaceId: input.workspaceId },
    { session: input.session },
  );
}

/** Privacy erasure invalidates every snapshot containing an affected application. */
export async function deleteHireCandidateSelectionSubjectData(input: SelectionPurgeInput & {
  applicationIds: readonly mongoose.Types.ObjectId[];
}): Promise<void> {
  requireTransaction(input);
  await HireCandidateSelectionSnapshot.deleteMany(
    { workspaceId: input.workspaceId, "entries.applicationId": { $in: input.applicationIds } },
    { session: input.session },
  );
}
