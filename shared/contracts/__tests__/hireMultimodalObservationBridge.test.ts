import { describe, expect, it } from "vitest";
import {
  HIRE_MULTIMODAL_OBSERVATION_CONSENT_VERSION,
  HIRE_MULTIMODAL_OBSERVATION_POLICY_VERSION,
  HireMultimodalObservationIngestionSchema,
  HireMultimodalObservationRuntimePurgeAckSchema,
  HireMultimodalObservationRuntimePurgeSchema,
  canonicalHireMultimodalObservationJson,
  hireMultimodalObservationDigestPayload,
} from "../hireMultimodalObservationBridge";

const IDS = {
  workspaceId: "a".repeat(24),
  applicationId: "b".repeat(24),
  roundId: "c".repeat(24),
  runtimeSessionId: "d".repeat(24),
};

function payload() {
  return {
    schemaVersion: 1,
    eventId: "e".repeat(64),
    ...IDS,
    attempt: 1,
    revision: 1,
    consentVersion: HIRE_MULTIMODAL_OBSERVATION_CONSENT_VERSION,
    policyVersion: HIRE_MULTIMODAL_OBSERVATION_POLICY_VERSION,
    observationDigest: "f".repeat(64),
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
  };
}

describe("Hire supplemental-observation bridge contract", () => {
  it("accepts only a bounded, non-scoring report", () => {
    expect(
      HireMultimodalObservationIngestionSchema.parse(payload()),
    ).toMatchObject({
      consentVersion: HIRE_MULTIMODAL_OBSERVATION_CONSENT_VERSION,
      policyVersion: HIRE_MULTIMODAL_OBSERVATION_POLICY_VERSION,
    });
  });

  it("rejects raw and decision-bearing payload fields", () => {
    for (const field of ["score", "recommendation", "ranking", "landmarks"]) {
      expect(() =>
        HireMultimodalObservationIngestionSchema.parse({
          ...payload(),
          [field]: field === "landmarks" ? [] : 1,
        }),
      ).toThrow();
    }
  });

  it("rejects an event whose source or interval does not match the policy", () => {
    expect(() =>
      HireMultimodalObservationIngestionSchema.parse({
        ...payload(),
        report: {
          ...payload().report,
          events: [
            {
              kind: "sustained_camera_away",
              source: "browser_visibility",
              startMs: 6_000,
              endMs: 1_000,
            },
          ],
        },
      }),
    ).toThrow();
  });

  it("has a stable digest representation limited to the report and timestamp", () => {
    const parsed = HireMultimodalObservationIngestionSchema.parse(payload());
    expect(
      canonicalHireMultimodalObservationJson(
        hireMultimodalObservationDigestPayload(parsed),
      ),
    ).toBe(
      '{"observedAt":"2026-08-17T12:00:00.000Z","report":{"capture":{"browserVisibility":"captured","camera":"captured"},"events":[{"endMs":6000,"kind":"sustained_camera_away","source":"camera","startMs":1000}],"status":"completed"}}',
    );
  });

  it("keeps the runtime retention-purge bridge opaque and idempotent", () => {
    expect(
      HireMultimodalObservationRuntimePurgeSchema.parse({
        schemaVersion: 1,
        purgeId: "1".repeat(24),
        workspaceId: IDS.workspaceId,
        applicationId: IDS.applicationId,
        roundId: IDS.roundId,
        purgeEligibleAt: "2027-02-28T12:30:00.000Z",
        reason: "job_closed_retention",
      }),
    ).not.toHaveProperty("candidateId");
    expect(
      HireMultimodalObservationRuntimePurgeAckSchema.parse({
        ok: true,
        outcome: "already_purged",
      }),
    ).toEqual({ ok: true, outcome: "already_purged" });
    expect(() =>
      HireMultimodalObservationRuntimePurgeSchema.parse({
        schemaVersion: 1,
        purgeId: "1".repeat(24),
        workspaceId: IDS.workspaceId,
        applicationId: IDS.applicationId,
        roundId: IDS.roundId,
        purgeEligibleAt: "2027-02-28T12:30:00.000Z",
        reason: "job_closed_retention",
        candidateId: "2".repeat(24),
      }),
    ).toThrow();
  });
});
