import mongoose from "mongoose";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ deleteMany: vi.fn() }));

vi.mock("../models/HireCandidateSelectionSnapshot", () => ({
  HireCandidateSelectionSnapshot: { deleteMany: mocks.deleteMany },
}));

import {
  deleteHireCandidateSelectionSubjectData,
  deleteHireCandidateSelectionWorkspaceData,
} from "../purge-boundary";

describe("candidate-selection workspace purge boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.deleteMany.mockResolvedValue({ deletedCount: 3 });
  });

  it("deletes only workspace rows with the caller-owned transaction", async () => {
    const workspaceId = new mongoose.Types.ObjectId();
    const session = { inTransaction: () => true } as never;

    await deleteHireCandidateSelectionWorkspaceData({ workspaceId, session });

    expect(mocks.deleteMany).toHaveBeenCalledWith(
      { workspaceId },
      { session },
    );
  });

  it("refuses deletion outside the workspace purge transaction", async () => {
    await expect(
      deleteHireCandidateSelectionWorkspaceData({
        workspaceId: new mongoose.Types.ObjectId(),
        session: { inTransaction: () => false } as never,
      }),
    ).rejects.toThrow("inside a transaction");
    expect(mocks.deleteMany).not.toHaveBeenCalled();
  });

  it("invalidates whole workspace-scoped snapshots containing erased applications", async () => {
    const workspaceId = new mongoose.Types.ObjectId();
    const applicationIds = [new mongoose.Types.ObjectId(), new mongoose.Types.ObjectId()];
    const session = { inTransaction: () => true } as never;

    await deleteHireCandidateSelectionSubjectData({ workspaceId, applicationIds, session });

    expect(mocks.deleteMany).toHaveBeenCalledWith(
      { workspaceId, "entries.applicationId": { $in: applicationIds } },
      { session },
    );
  });

  it("refuses subject invalidation outside the caller-owned transaction", async () => {
    await expect(deleteHireCandidateSelectionSubjectData({
      workspaceId: new mongoose.Types.ObjectId(),
      applicationIds: [new mongoose.Types.ObjectId()],
      session: { inTransaction: () => false } as never,
    })).rejects.toThrow("inside a transaction");
    expect(mocks.deleteMany).not.toHaveBeenCalled();
  });
});
