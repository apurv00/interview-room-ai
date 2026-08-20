import { describe, expect, it } from "vitest";
import {
  HIRE_MULTIMODAL_OBSERVATION_CONSENT_VERSION,
  HIRE_MULTIMODAL_OBSERVATION_MAX_REVISIONS,
  HIRE_MULTIMODAL_OBSERVATION_POLICY_VERSION,
  HireMultimodalObservationIngestionSchema,
  HireMultimodalObservationSpeechVideoSampleSchema,
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

  it("accepts only factual entire-display events with their fixed sources", () => {
    expect(
      HireMultimodalObservationIngestionSchema.parse({
        ...payload(),
        schemaVersion: 2,
        report: {
          status: "completed",
          capture: {
            camera: "captured",
            browserVisibility: "captured",
            displayShare: "captured",
          },
          events: [
            {
              kind: "screen_share_wrong_surface",
              source: "display_surface",
              startMs: 0,
              endMs: 0,
            },
            {
              kind: "screen_share_interrupted",
              source: "display_track",
              startMs: 5_000,
              endMs: 7_000,
            },
            {
              kind: "screen_recording_interrupted",
              source: "display_recorder",
              startMs: 8_000,
              endMs: 8_000,
            },
          ],
        },
      }).report.capture.displayShare,
    ).toBe("captured");

    expect(() =>
      HireMultimodalObservationIngestionSchema.parse({
        ...payload(),
        schemaVersion: 2,
        report: {
          ...payload().report,
          events: [{
            kind: "screen_share_interrupted",
            source: "fullscreen",
            startMs: 5_000,
            endMs: 7_000,
          }],
        },
      }),
    ).toThrow();
  });

  it("allows only a boolean facial-speech proxy, never mouth geometry", () => {
    expect(
      HireMultimodalObservationSpeechVideoSampleSchema.parse({
        atMs: 3_000,
        voiceActive: true,
        facePresent: true,
        facialSpeechActive: false,
      }),
    ).toEqual({
      atMs: 3_000,
      voiceActive: true,
      facePresent: true,
      facialSpeechActive: false,
    });
    expect(() =>
      HireMultimodalObservationSpeechVideoSampleSchema.parse({
        atMs: 3_000,
        voiceActive: true,
        facePresent: true,
        facialSpeechActive: false,
        mouthOpening: 0.12,
      }),
    ).toThrow();
  });

  it("reserves enough immutable revisions for interruption lifecycle snapshots", () => {
    expect(
      HireMultimodalObservationIngestionSchema.parse({
        ...payload(),
        revision: HIRE_MULTIMODAL_OBSERVATION_MAX_REVISIONS,
      }).revision,
    ).toBe(HIRE_MULTIMODAL_OBSERVATION_MAX_REVISIONS);
    expect(() =>
      HireMultimodalObservationIngestionSchema.parse({
        ...payload(),
        revision: HIRE_MULTIMODAL_OBSERVATION_MAX_REVISIONS + 1,
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
