import { beforeEach, describe, expect, it, vi } from "vitest";
import { HIRE_MULTIMODAL_OBSERVATION_CONSENT_VERSION } from "@shared/contracts/hireMultimodalObservationBridge";
import { HIRE_AI_CONSENT_VERSION } from "@hire/policies/aiInterviewConsent";

const mocks = vi.hoisted(() => ({
  roundFind: vi.fn(),
  observationUpdateMany: vi.fn(),
  observationDeleteMany: vi.fn(),
  eventDeleteMany: vi.fn(),
  analysisUpdateMany: vi.fn(),
  analysisDeleteMany: vi.fn(),
  analysisEventDeleteMany: vi.fn(),
  obligationBulkWrite: vi.fn(),
  obligationDeleteMany: vi.fn(),
  obligationDeleteOne: vi.fn(),
  obligationExists: vi.fn(),
  obligationFind: vi.fn(),
  obligationUpdateOne: vi.fn(),
  runtimePurge: vi.fn(),
}));

vi.mock("@hire/models", () => ({ HireRound: { find: mocks.roundFind } }));
vi.mock("../models", () => ({
  HireMultimodalObservation: {
    updateMany: mocks.observationUpdateMany,
    deleteMany: mocks.observationDeleteMany,
  },
  HireMultimodalObservationIngestionEvent: {
    deleteMany: mocks.eventDeleteMany,
  },
  HireMultimodalAnalysis: {
    updateMany: mocks.analysisUpdateMany,
    deleteMany: mocks.analysisDeleteMany,
  },
  HireMultimodalAnalysisIngestionEvent: {
    deleteMany: mocks.analysisEventDeleteMany,
  },
  HireMultimodalObservationPurgeObligation: {
    bulkWrite: mocks.obligationBulkWrite,
    deleteMany: mocks.obligationDeleteMany,
    deleteOne: mocks.obligationDeleteOne,
    exists: mocks.obligationExists,
    find: mocks.obligationFind,
    updateOne: mocks.obligationUpdateOne,
  },
}));
vi.mock("../services/runtimeObservationPurgeService", () => ({
  purgeRuntimeMultimodalObservationOutbox: (...args: unknown[]) =>
    mocks.runtimePurge(...args),
}));

import {
  cancelFutureHireMultimodalObservationRetention,
  purgeDueHireMultimodalObservationRetention,
  scheduleHireMultimodalObservationRetention,
} from "../services/observationRetentionService";

const IDS = {
  workspaceId: "a".repeat(24),
  applicationId: "b".repeat(24),
  jobId: "c".repeat(24),
  candidateId: "d".repeat(24),
  roundId: "e".repeat(24),
  obligationId: "f".repeat(24),
};
const DUE_AT = new Date("2027-02-28T12:30:00.000Z");

function objectId(value: string) {
  return { toString: () => value };
}

function selectLean<T>(value: T) {
  const chain = {
    select: vi.fn(),
    lean: vi.fn(),
  };
  chain.select.mockReturnValue(chain);
  chain.lean.mockResolvedValue(value);
  return chain;
}

function sortedLean<T>(value: T) {
  const chain = {
    sort: vi.fn(),
    limit: vi.fn(),
    lean: vi.fn(),
  };
  chain.sort.mockReturnValue(chain);
  chain.limit.mockReturnValue(chain);
  chain.lean.mockResolvedValue(value);
  return chain;
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.observationUpdateMany.mockResolvedValue({ modifiedCount: 0 });
  mocks.observationDeleteMany.mockResolvedValue({ deletedCount: 1 });
  mocks.eventDeleteMany.mockResolvedValue({ deletedCount: 1 });
  mocks.analysisUpdateMany.mockResolvedValue({ modifiedCount: 0 });
  mocks.analysisDeleteMany.mockResolvedValue({ deletedCount: 1 });
  mocks.analysisEventDeleteMany.mockResolvedValue({ deletedCount: 1 });
  mocks.obligationBulkWrite.mockResolvedValue({ upsertedCount: 0 });
  mocks.obligationDeleteMany.mockResolvedValue({ deletedCount: 0 });
  mocks.obligationDeleteOne.mockResolvedValue({ deletedCount: 1 });
  mocks.obligationExists.mockResolvedValue({ _id: IDS.obligationId });
  mocks.obligationUpdateOne.mockResolvedValue({ modifiedCount: 1 });
  mocks.runtimePurge.mockResolvedValue("purged");
});

describe("Hire supplemental-observation retention", () => {
  it("creates a runtime purge obligation for every v3 closed-job round even with no control report", async () => {
    const round = {
      _id: objectId(IDS.roundId),
      workspaceId: objectId(IDS.workspaceId),
      applicationId: objectId(IDS.applicationId),
      jobId: objectId(IDS.jobId),
      candidateId: objectId(IDS.candidateId),
    };
    mocks.roundFind.mockReturnValue(selectLean([round]));
    mocks.obligationBulkWrite.mockResolvedValue({ upsertedCount: 1 });

    await expect(
      scheduleHireMultimodalObservationRetention({
        workspaceId: IDS.workspaceId,
        jobId: IDS.jobId,
        purgeEligibleAt: DUE_AT,
      }),
    ).resolves.toEqual({
      scheduledObservations: 0,
      scheduledRuntimePurgeObligations: 1,
    });

    expect(mocks.roundFind).toHaveBeenCalledWith({
      workspaceId: IDS.workspaceId,
      jobId: IDS.jobId,
      kind: "ai",
      consentVersion: {
        $in: [
          HIRE_MULTIMODAL_OBSERVATION_CONSENT_VERSION,
          HIRE_AI_CONSENT_VERSION,
        ],
      },
    });
    expect(mocks.obligationBulkWrite).toHaveBeenCalledWith(
      [
        {
          updateOne: {
            filter: {
              workspaceId: round.workspaceId,
              roundId: round._id,
            },
            update: {
              $setOnInsert: {
                workspaceId: round.workspaceId,
                applicationId: round.applicationId,
                jobId: round.jobId,
                candidateId: round.candidateId,
                roundId: round._id,
                purgeEligibleAt: DUE_AT,
                reason: "job_closed_retention",
              },
            },
            upsert: true,
          },
        },
      ],
      { ordered: false },
    );
  });

  it("rescinds future control and runtime deadlines when a job reopens", async () => {
    mocks.observationUpdateMany.mockResolvedValue({ modifiedCount: 2 });
    mocks.obligationDeleteMany.mockResolvedValue({ deletedCount: 3 });
    const reopenedAt = new Date("2026-10-01T00:00:00.000Z");

    await expect(
      cancelFutureHireMultimodalObservationRetention({
        workspaceId: IDS.workspaceId,
        jobId: IDS.jobId,
        reopenedAt,
      }),
    ).resolves.toBe(5);

    expect(mocks.obligationDeleteMany).toHaveBeenCalledWith({
      workspaceId: IDS.workspaceId,
      jobId: IDS.jobId,
      purgeEligibleAt: { $gt: reopenedAt },
      runtimePurgedAt: { $exists: false },
    });
  });

  it("requires an acknowledged runtime purge before deleting the control report and ledger", async () => {
    const obligation = {
      _id: objectId(IDS.obligationId),
      workspaceId: objectId(IDS.workspaceId),
      applicationId: objectId(IDS.applicationId),
      jobId: objectId(IDS.jobId),
      candidateId: objectId(IDS.candidateId),
      roundId: objectId(IDS.roundId),
      purgeEligibleAt: DUE_AT,
    };
    mocks.obligationFind.mockReturnValue(sortedLean([obligation]));

    await expect(
      purgeDueHireMultimodalObservationRetention({
        workspaceId: IDS.workspaceId,
        now: DUE_AT,
        batchSize: 10,
      }),
    ).resolves.toEqual({
      scanned: 1,
      runtimeAcknowledged: 1,
      controlPurged: 1,
      failed: 0,
    });

    expect(mocks.runtimePurge).toHaveBeenCalledWith({
      purgeId: IDS.obligationId,
      workspaceId: IDS.workspaceId,
      applicationId: IDS.applicationId,
      roundId: IDS.roundId,
      purgeEligibleAt: DUE_AT,
    });
    expect(mocks.eventDeleteMany).toHaveBeenCalledWith({
      workspaceId: obligation.workspaceId,
      applicationId: obligation.applicationId,
      roundId: obligation.roundId,
    });
    expect(mocks.observationDeleteMany).toHaveBeenCalledWith({
      workspaceId: obligation.workspaceId,
      applicationId: obligation.applicationId,
      roundId: obligation.roundId,
      jobId: obligation.jobId,
    });
    expect(mocks.analysisEventDeleteMany).toHaveBeenCalledWith({
      workspaceId: obligation.workspaceId,
      applicationId: obligation.applicationId,
      roundId: obligation.roundId,
    });
    expect(mocks.analysisDeleteMany).toHaveBeenCalledWith({
      workspaceId: obligation.workspaceId,
      applicationId: obligation.applicationId,
      roundId: obligation.roundId,
      jobId: obligation.jobId,
    });
    expect(mocks.runtimePurge.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.eventDeleteMany.mock.invocationCallOrder[0],
    );
    expect(mocks.eventDeleteMany.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.observationDeleteMany.mock.invocationCallOrder[0],
    );
  });

  it("keeps control data when the runtime outbox purge is not acknowledged", async () => {
    mocks.obligationFind.mockReturnValue(
      sortedLean([
        {
          _id: objectId(IDS.obligationId),
          workspaceId: objectId(IDS.workspaceId),
          applicationId: objectId(IDS.applicationId),
          jobId: objectId(IDS.jobId),
          candidateId: objectId(IDS.candidateId),
          roundId: objectId(IDS.roundId),
          purgeEligibleAt: DUE_AT,
        },
      ]),
    );
    mocks.runtimePurge.mockRejectedValue(new Error("runtime unavailable"));

    await expect(
      purgeDueHireMultimodalObservationRetention({
        workspaceId: IDS.workspaceId,
        now: DUE_AT,
        batchSize: 10,
      }),
    ).resolves.toEqual({
      scanned: 1,
      runtimeAcknowledged: 0,
      controlPurged: 0,
      failed: 1,
    });

    expect(mocks.eventDeleteMany).not.toHaveBeenCalled();
    expect(mocks.observationDeleteMany).not.toHaveBeenCalled();
    expect(mocks.obligationUpdateOne).toHaveBeenCalledWith(
      expect.objectContaining({ runtimePurgedAt: { $exists: false } }),
      expect.objectContaining({
        $set: expect.objectContaining({ runtimePurgeFailureCode: "Error" }),
      }),
    );
  });
});
