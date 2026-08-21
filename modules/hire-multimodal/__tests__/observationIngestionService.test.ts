import { createHash } from "node:crypto";
import mongoose from "mongoose";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  HIRE_MULTIMODAL_OBSERVATION_LEGACY_POLICY_VERSION,
  HIRE_MULTIMODAL_OBSERVATION_POLICY_VERSION,
  HIRE_MULTIMODAL_OBSERVATION_V2_POLICY_VERSION,
  canonicalHireMultimodalObservationJson,
  hireMultimodalObservationDigestPayload,
  type HireMultimodalObservationIngestion,
} from "@shared/contracts/hireMultimodalObservationBridge";

const CURRENT_CONSENT_VERSION = "hire-ai-v6-2026-08-20";
const V5_CONSENT_VERSION = "hire-ai-v5-2026-08-19";
const DISCLOSURE_DIGEST = "1".repeat(64);

const mocks = vi.hoisted(() => {
  class CandidatePiiTombstoneError extends Error {}
  return {
    CandidatePiiTombstoneError,
    connect: vi.fn(),
    applicationFindOne: vi.fn(),
    roundFindOne: vi.fn(),
    attemptFindOne: vi.fn(),
    jobFindOne: vi.fn(),
    receiptFindOne: vi.fn(),
    recognizedSnapshot: vi.fn(),
    privacyExists: vi.fn(),
    purgeObligationExists: vi.fn(),
    fence: vi.fn(),
    observationFindOne: vi.fn(),
    observationCreate: vi.fn(),
    eventFindOne: vi.fn(),
    eventCreate: vi.fn(),
    eventUpdateOne: vi.fn(),
  };
});

vi.mock("@hire/models", () => ({
  HireApplication: { findOne: mocks.applicationFindOne },
  HireRound: { findOne: mocks.roundFindOne },
  HireInterviewAttempt: { findOne: mocks.attemptFindOne },
  HireJob: { findOne: mocks.jobFindOne },
  HireConsentReceipt: { findOne: mocks.receiptFindOne },
  HirePrivacyRequest: { exists: mocks.privacyExists },
}));
vi.mock("@hire-multimodal-boundary", () => ({
  // Vitest hoists this factory above module constants, so retain the immutable
  // current snapshot literal here rather than closing over the test fixture.
  HIRE_AI_CONSENT_VERSION: "hire-ai-v6-2026-08-20",
  HIRE_AI_V5_CONSENT_VERSION: "hire-ai-v5-2026-08-19",
  isRecognizedHireConsentSnapshot: mocks.recognizedSnapshot,
}));
vi.mock("@hire/services/hireControlBoundary", () => ({
  connectHireControlDB: mocks.connect,
}));
vi.mock("@hire/services/hireCandidatePrivacyWriteFence", () => ({
  claimHireCandidatePiiWriteFence: mocks.fence,
  HireCandidatePiiTombstoneError: mocks.CandidatePiiTombstoneError,
}));
vi.mock("../models", () => ({
  HireMultimodalObservation: {
    findOne: mocks.observationFindOne,
    create: mocks.observationCreate,
  },
  HireMultimodalObservationIngestionEvent: {
    findOne: mocks.eventFindOne,
    create: mocks.eventCreate,
    updateOne: mocks.eventUpdateOne,
  },
  HireMultimodalObservationPurgeObligation: {
    exists: mocks.purgeObligationExists,
  },
}));

import {
  __hireMultimodalObservationIngestion,
  HireMultimodalObservationIngestionError,
  ingestHireMultimodalObservation,
} from "../services/observationIngestionService";

const IDS = {
  workspaceId: "a".repeat(24),
  applicationId: "b".repeat(24),
  roundId: "c".repeat(24),
  runtimeSessionId: "d".repeat(24),
  candidateId: "e".repeat(24),
  jobId: "f".repeat(24),
  attemptId: "1".repeat(24),
};

function objectId(value: string) {
  return { toString: () => value };
}

function query<T>(value: T) {
  const chain = {
    select: vi.fn(),
    session: vi.fn(),
    sort: vi.fn(),
    lean: vi.fn(),
  };
  chain.select.mockReturnValue(chain);
  chain.session.mockReturnValue(chain);
  chain.sort.mockReturnValue(chain);
  chain.lean.mockResolvedValue(value);
  return chain;
}

function existsQuery<T>(value: T) {
  const valuePromise = Promise.resolve(value);
  return {
    session: vi.fn().mockReturnThis(),
    then: valuePromise.then.bind(valuePromise),
    catch: valuePromise.catch.bind(valuePromise),
  };
}

function payload(
  overrides: Partial<
    Omit<HireMultimodalObservationIngestion, "observationDigest">
  > = {},
): HireMultimodalObservationIngestion {
  const draft: Omit<HireMultimodalObservationIngestion, "observationDigest"> = {
    schemaVersion: 2,
    eventId: "2".repeat(64),
    workspaceId: IDS.workspaceId,
    applicationId: IDS.applicationId,
    roundId: IDS.roundId,
    runtimeSessionId: IDS.runtimeSessionId,
    attempt: 1,
    revision: 1,
    consentVersion: CURRENT_CONSENT_VERSION,
    policyVersion: HIRE_MULTIMODAL_OBSERVATION_POLICY_VERSION,
    observedAt: "2026-08-17T12:00:00.000Z",
    report: {
      status: "completed",
      capture: { camera: "captured", browserVisibility: "captured" },
      events: [
        {
          kind: "sustained_camera_away",
          source: "camera",
          startMs: 1_000,
          endMs: 6_000,
        },
      ],
    },
    ...overrides,
  };
  return {
    ...draft,
    observationDigest: createHash("sha256")
      .update(
        canonicalHireMultimodalObservationJson(
          hireMultimodalObservationDigestPayload(draft),
        ),
      )
      .digest("hex"),
  };
}

function setUsualQueries() {
  mocks.applicationFindOne.mockReturnValue(
    query({
      candidateId: objectId(IDS.candidateId),
      jobId: objectId(IDS.jobId),
    }),
  );
  mocks.roundFindOne.mockReturnValue(
    query({
      runtimeSessionId: objectId(IDS.runtimeSessionId),
      consentVersion: CURRENT_CONSENT_VERSION,
    }),
  );
  mocks.attemptFindOne.mockReturnValue(
    query({
      _id: objectId(IDS.attemptId),
      consentReceiptId: objectId("3".repeat(24)),
    }),
  );
  mocks.jobFindOne.mockReturnValue(query({ status: "open" }));
  mocks.receiptFindOne.mockReturnValue(query({
    consentVersion: CURRENT_CONSENT_VERSION,
    disclosureDigest: DISCLOSURE_DIGEST,
  }));
  mocks.privacyExists.mockReturnValue(existsQuery(null));
  mocks.purgeObligationExists.mockReturnValue(existsQuery(null));
  mocks.eventFindOne.mockReturnValue(query(null));
  mocks.observationFindOne.mockReturnValue(query(null));
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.connect.mockResolvedValue(undefined);
  mocks.fence.mockResolvedValue(undefined);
  mocks.observationCreate.mockResolvedValue([{}]);
  mocks.eventCreate.mockResolvedValue([{}]);
  mocks.eventUpdateOne.mockResolvedValue({ matchedCount: 1 });
  mocks.recognizedSnapshot.mockReturnValue(true);
  setUsualQueries();
  const session = {
    withTransaction: vi.fn(async (work: () => Promise<void>) => work()),
    endSession: vi.fn().mockResolvedValue(undefined),
  };
  vi.spyOn(mongoose, "startSession").mockResolvedValue(session as never);
});

describe("Hire supplemental-observation ingestion", () => {
  it("persists a bounded V6 report under the candidate privacy fence", async () => {
    const input = payload();

    await expect(ingestHireMultimodalObservation(input)).resolves.toEqual({
      outcome: "processed",
    });

    expect(mocks.fence).toHaveBeenCalledWith({
      workspaceId: IDS.workspaceId,
      candidateId: IDS.candidateId,
      session: expect.anything(),
    });
    expect(mocks.observationCreate.mock.calls[0][0][0]).toMatchObject({
      workspaceId: IDS.workspaceId,
      applicationId: IDS.applicationId,
      jobId: IDS.jobId,
      candidateId: IDS.candidateId,
      roundId: IDS.roundId,
      attemptId: IDS.attemptId,
      runtimeSessionId: IDS.runtimeSessionId,
      observationDigest: input.observationDigest,
      report: input.report,
    });
    const encoded = JSON.stringify(mocks.observationCreate.mock.calls[0][0][0]);
    expect(encoded).not.toContain("score");
    expect(encoded).not.toContain("landmark");
    expect(mocks.eventUpdateOne).toHaveBeenCalledWith(
      { eventId: input.eventId, status: "received" },
      { $set: { status: "processed", processedAt: expect.any(Date) } },
      { session: expect.anything() },
    );
  });

  it("persists the exact digest-covered recorder clock without recalculation", async () => {
    const base = payload().report;
    const input = payload({
      report: {
        ...base,
        playbackClock: {
          protocolVersion: 1,
          cameraRecorderStartOffsetMs: 320,
        },
      },
    });

    await expect(ingestHireMultimodalObservation(input)).resolves.toEqual({
      outcome: "processed",
    });
    expect(
      mocks.observationCreate.mock.calls[0][0][0].report.playbackClock,
    ).toEqual(input.report.playbackClock);
  });

  it("accepts V6 entire-display validation events under the V3 policy", async () => {
    const input = payload({
      report: {
        status: "completed",
        capture: {
          camera: "captured",
          browserVisibility: "captured",
          displayShare: "captured",
        },
        events: [{
          kind: "screen_share_interrupted",
          source: "display_track",
          startMs: 4_000,
          endMs: 7_000,
        }],
      },
    });

    await expect(ingestHireMultimodalObservation(input)).resolves.toEqual({
      outcome: "processed",
    });
    expect(mocks.observationCreate.mock.calls[0][0][0].report).toEqual(
      input.report,
    );
  });

  it("accepts an immutable V5 snapshot only with its V2 wire policy", async () => {
    const input = payload({
      consentVersion: V5_CONSENT_VERSION,
      policyVersion: HIRE_MULTIMODAL_OBSERVATION_V2_POLICY_VERSION,
    });
    mocks.roundFindOne.mockReturnValueOnce(query({
      runtimeSessionId: objectId(IDS.runtimeSessionId),
      consentVersion: V5_CONSENT_VERSION,
    }));
    mocks.receiptFindOne.mockReturnValueOnce(query({
      consentVersion: V5_CONSENT_VERSION,
      disclosureDigest: DISCLOSURE_DIGEST,
    }));

    await expect(ingestHireMultimodalObservation(input)).resolves.toEqual({
      outcome: "processed",
    });
  });

  it("rejects V6 display-share observations attached to a V5 receipt", async () => {
    const draft = payload({
      consentVersion: V5_CONSENT_VERSION,
      policyVersion: HIRE_MULTIMODAL_OBSERVATION_V2_POLICY_VERSION,
      report: {
        status: "completed",
        capture: {
          camera: "captured",
          browserVisibility: "captured",
          displayShare: "captured",
        },
        events: [{
          kind: "screen_share_interrupted",
          source: "display_track",
          startMs: 1_000,
          endMs: 2_000,
        }],
      },
    });
    mocks.roundFindOne.mockReturnValueOnce(query({
      runtimeSessionId: objectId(IDS.runtimeSessionId),
      consentVersion: V5_CONSENT_VERSION,
    }));
    mocks.receiptFindOne.mockReturnValueOnce(query({
      consentVersion: V5_CONSENT_VERSION,
      disclosureDigest: DISCLOSURE_DIGEST,
    }));

    await expect(ingestHireMultimodalObservation(draft)).resolves.toEqual({
      outcome: "stale",
    });
    expect(mocks.observationCreate).not.toHaveBeenCalled();
  });

  it("returns stale for an unsupported policy before reading candidate data", async () => {
    const input = payload({ policyVersion: "unsupported-policy" });

    await expect(ingestHireMultimodalObservation(input)).resolves.toEqual({
      outcome: "stale",
    });

    expect(mocks.applicationFindOne).not.toHaveBeenCalled();
    expect(mocks.fence).not.toHaveBeenCalled();
    expect(mocks.observationCreate).not.toHaveBeenCalled();
  });

  it("accepts an exact historic receipt pair only with the legacy wire policy", async () => {
    const historicVersion = "hire-ai-v4-2026-08-17";
    const input = payload({
      schemaVersion: 1,
      consentVersion: historicVersion,
      policyVersion: HIRE_MULTIMODAL_OBSERVATION_LEGACY_POLICY_VERSION,
    });
    mocks.roundFindOne.mockReturnValueOnce(query({
      runtimeSessionId: objectId(IDS.runtimeSessionId),
      consentVersion: historicVersion,
    }));
    mocks.receiptFindOne.mockReturnValueOnce(query({
      consentVersion: historicVersion,
      disclosureDigest: DISCLOSURE_DIGEST,
    }));
    mocks.recognizedSnapshot.mockReturnValueOnce(true);

    await expect(ingestHireMultimodalObservation(input)).resolves.toEqual({
      outcome: "processed",
    });
  });

  it("returns stale when the selected attempt has no exact receipt", async () => {
    mocks.receiptFindOne.mockReturnValueOnce(query(null));

    await expect(ingestHireMultimodalObservation(payload())).resolves.toEqual({
      outcome: "stale",
    });

    expect(mocks.fence).not.toHaveBeenCalled();
    expect(mocks.observationCreate).not.toHaveBeenCalled();
  });

  it("requires every immutable acknowledgement on the selected receipt", async () => {
    await expect(ingestHireMultimodalObservation(payload())).resolves.toEqual({
      outcome: "processed",
    });

    expect(mocks.receiptFindOne).toHaveBeenCalledWith(
      expect.objectContaining({
        "accepted.recording": true,
        "accepted.identityPhoto": true,
        "accepted.attentionMonitoring": true,
        "accepted.aiEvaluation": true,
      }),
    );
  });

  it("returns stale until the round has an exact runtime-session binding", async () => {
    mocks.roundFindOne.mockReturnValueOnce(
      query({
        runtimeSessionId: undefined,
        consentVersion: CURRENT_CONSENT_VERSION,
      }),
    );

    await expect(ingestHireMultimodalObservation(payload())).resolves.toEqual({
      outcome: "stale",
    });

    expect(mocks.attemptFindOne).not.toHaveBeenCalled();
    expect(mocks.fence).not.toHaveBeenCalled();
    expect(mocks.observationCreate).not.toHaveBeenCalled();
  });

  it("acknowledges an exact prior event as duplicate without a new write", async () => {
    const input = payload();
    mocks.eventFindOne.mockReturnValue(
      query({
        workspaceId: objectId(IDS.workspaceId),
        applicationId: objectId(IDS.applicationId),
        roundId: objectId(IDS.roundId),
        runtimeSessionId: objectId(IDS.runtimeSessionId),
        attempt: input.attempt,
        revision: input.revision,
        observationDigest: input.observationDigest,
        status: "processed",
      }),
    );

    await expect(ingestHireMultimodalObservation(input)).resolves.toEqual({
      outcome: "duplicate",
    });

    expect(mocks.fence).not.toHaveBeenCalled();
    expect(mocks.observationCreate).not.toHaveBeenCalled();
  });

  it("returns stale when a verified privacy tombstone already exists", async () => {
    mocks.privacyExists.mockReturnValueOnce(existsQuery({ _id: "privacy" }));

    await expect(ingestHireMultimodalObservation(payload())).resolves.toEqual({
      outcome: "stale",
    });

    expect(mocks.fence).not.toHaveBeenCalled();
    expect(mocks.observationCreate).not.toHaveBeenCalled();
  });

  it("returns stale from the first live privacy-request state", async () => {
    mocks.privacyExists.mockReturnValueOnce(existsQuery({ _id: "privacy" }));

    await expect(ingestHireMultimodalObservation(payload())).resolves.toEqual({
      outcome: "stale",
    });

    expect(mocks.privacyExists).toHaveBeenCalledWith({
      workspaceId: IDS.workspaceId,
      candidateId: IDS.candidateId,
      live: true,
    });
    expect(mocks.fence).not.toHaveBeenCalled();
    expect(mocks.observationCreate).not.toHaveBeenCalled();
  });

  it("returns stale when a due runtime-purge obligation already fences the round", async () => {
    mocks.purgeObligationExists.mockReturnValueOnce(
      existsQuery({ _id: "purge" }),
    );

    await expect(ingestHireMultimodalObservation(payload())).resolves.toEqual({
      outcome: "stale",
    });

    expect(mocks.purgeObligationExists).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: IDS.workspaceId,
        applicationId: IDS.applicationId,
        roundId: IDS.roundId,
        reason: "job_closed_retention",
        purgeEligibleAt: { $lte: expect.any(Date) },
      }),
    );
    expect(mocks.fence).not.toHaveBeenCalled();
    expect(mocks.observationCreate).not.toHaveBeenCalled();
  });

  it("rechecks the due runtime-purge fence inside the final write transaction", async () => {
    mocks.purgeObligationExists
      .mockReturnValueOnce(existsQuery(null))
      .mockReturnValueOnce(existsQuery({ _id: "purge" }));

    await expect(ingestHireMultimodalObservation(payload())).resolves.toEqual({
      outcome: "stale",
    });

    expect(mocks.purgeObligationExists).toHaveBeenCalledTimes(2);
    expect(mocks.eventCreate).not.toHaveBeenCalled();
    expect(mocks.observationCreate).not.toHaveBeenCalled();
  });

  it("inherits a closed job's six-calendar-month purge deadline", async () => {
    mocks.jobFindOne.mockReturnValueOnce(
      query({
        status: "closed",
        closedAt: new Date("2026-08-31T12:30:00.000Z"),
      }),
    );

    await expect(ingestHireMultimodalObservation(payload())).resolves.toEqual({
      outcome: "processed",
    });

    expect(mocks.observationCreate.mock.calls[0][0][0]).toMatchObject({
      purgeReason: "job_closed",
      purgeEligibleAt: new Date("2027-02-28T12:30:00.000Z"),
    });
  });

  it("returns stale after a closed job's six-month deadline to prevent recreation", async () => {
    mocks.jobFindOne.mockReturnValueOnce(
      query({
        status: "closed",
        closedAt: new Date("2025-01-31T12:30:00.000Z"),
      }),
    );

    await expect(ingestHireMultimodalObservation(payload())).resolves.toEqual({
      outcome: "stale",
    });

    expect(mocks.receiptFindOne).not.toHaveBeenCalled();
    expect(mocks.fence).not.toHaveBeenCalled();
    expect(mocks.observationCreate).not.toHaveBeenCalled();
  });

  it("returns stale when the deletion fence wins during finalization", async () => {
    mocks.fence.mockRejectedValueOnce(new mocks.CandidatePiiTombstoneError());

    await expect(ingestHireMultimodalObservation(payload())).resolves.toEqual({
      outcome: "stale",
    });

    expect(mocks.observationCreate).not.toHaveBeenCalled();
  });

  it("rejects a tampered digest before any database work", async () => {
    await expect(
      ingestHireMultimodalObservation({
        ...payload(),
        observationDigest: "0".repeat(64),
      }),
    ).rejects.toMatchObject<HireMultimodalObservationIngestionError>({
      code: "digest_mismatch",
      status: 400,
    });
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it("uses the same digest canonicalization as the shared wire contract", () => {
    const input = payload();
    expect(__hireMultimodalObservationIngestion.observationDigest(input)).toBe(
      input.observationDigest,
    );
  });
});
