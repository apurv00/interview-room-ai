import { z } from "zod";

/**
 * A deliberately separate, versioned bridge for Hire's supplemental interview
 * observations. It is not part of the assessment-result contract: it carries
 * neither scores nor recommendations, and it never transports raw camera
 * samples, landmarks, audio, transcript text, or recordings.
 */
/**
 * V2 adds bounded interview-integrity event snapshots. The ingestion schema
 * intentionally remains able to read V1 payloads queued by the prior runtime
 * so a rollout never strands an already-consented observation in an outbox.
 */
export const HIRE_MULTIMODAL_OBSERVATION_BRIDGE_SCHEMA_VERSION = 2 as const;
export const HIRE_MULTIMODAL_OBSERVATION_LEGACY_BRIDGE_SCHEMA_VERSION =
  1 as const;
export const HIRE_MULTIMODAL_OBSERVATION_SUPPORTED_BRIDGE_SCHEMA_VERSIONS = [
  HIRE_MULTIMODAL_OBSERVATION_LEGACY_BRIDGE_SCHEMA_VERSION,
  HIRE_MULTIMODAL_OBSERVATION_BRIDGE_SCHEMA_VERSION,
] as const;
/**
 * Retained as the immutable V3 compatibility value. New runtime writes use
 * the current consent policy export; this bridge deliberately does not own
 * the current consent version because that would create a circular policy
 * dependency and make historic receipt validation brittle.
 */
export const HIRE_MULTIMODAL_OBSERVATION_CONSENT_VERSION =
  "hire-ai-v3-2026-08-17";
/** V3 adds the explicitly consented entire-display validation signals. */
export const HIRE_MULTIMODAL_OBSERVATION_POLICY_VERSION =
  "hire-supplemental-observations-v3";
/** Immutable policy used by V5 interview-integrity snapshots. */
export const HIRE_MULTIMODAL_OBSERVATION_V2_POLICY_VERSION =
  "hire-supplemental-observations-v2";
export const HIRE_MULTIMODAL_OBSERVATION_LEGACY_POLICY_VERSION =
  "hire-supplemental-observations-v1";
/** Signed control → runtime retention-purge request for the isolated outbox. */
export const HIRE_MULTIMODAL_OBSERVATION_RUNTIME_PURGE_SCHEMA_VERSION =
  1 as const;

export const HireMultimodalObservationObjectIdSchema = z
  .string()
  .regex(/^[a-f0-9]{24}$/i)
  .transform((value) => value.toLowerCase());

export const HireMultimodalObservationSha256Schema = z
  .string()
  .regex(/^[a-f0-9]{64}$/i)
  .transform((value) => value.toLowerCase());

export const HireMultimodalObservationIsoDateTimeSchema = z
  .string()
  .datetime({ offset: true });

export const HIRE_MULTIMODAL_OBSERVATION_CAPTURE_STATES = [
  "captured",
  "unavailable",
  "insufficient_signal",
] as const;

export const HIRE_MULTIMODAL_OBSERVATION_MAX_DURATION_MS = 30 * 60 * 1_000;
export const HIRE_MULTIMODAL_OBSERVATION_MAX_EVENTS = 100;
/**
 * A full interview may persist both the immediate detection and the closed
 * duration for each of the 100 bounded validation events, then flush a final
 * camera/visibility capture and a teardown retry. Keep explicit headroom so
 * immutable snapshots never reuse a revision.
 */
export const HIRE_MULTIMODAL_OBSERVATION_MAX_REVISIONS = 256;
/**
 * This is a compact VAD/face-presence proxy, not audio, video, landmarks,
 * biometric embeddings, transcription text, or a speaker-identity claim.
 */
export const HIRE_MULTIMODAL_OBSERVATION_MAX_SPEECH_VIDEO_SAMPLES = 600;

export const HIRE_MULTIMODAL_OBSERVATION_EVENT_KINDS = [
  "browser_window_not_visible",
  "browser_window_focus_lost",
  "fullscreen_exited",
  "camera_interrupted",
  "microphone_interrupted",
  "screen_share_wrong_surface",
  "screen_share_interrupted",
  "screen_recording_interrupted",
  "sustained_camera_away",
  "speech_video_unverified",
] as const;

/** Events that may originate in the browser's platform APIs. Server-only
 * derivations (camera-away and speech/video corroboration) cannot be forged
 * by supplying a finished label from the browser. */
export const HIRE_MULTIMODAL_OBSERVATION_CLIENT_EVENT_KINDS = [
  "browser_window_not_visible",
  "browser_window_focus_lost",
  "fullscreen_exited",
  "camera_interrupted",
  "microphone_interrupted",
  "screen_share_wrong_surface",
  "screen_share_interrupted",
  "screen_recording_interrupted",
] as const;

export const HIRE_MULTIMODAL_OBSERVATION_EVENT_SOURCES = [
  "camera",
  "browser_visibility",
  "browser_focus",
  "fullscreen",
  "camera_track",
  "microphone_track",
  "display_surface",
  "display_track",
  "display_recorder",
  "speech_video_corroboration",
] as const;

export const HireMultimodalObservationEventSchema = z
  .object({
    kind: z.enum(HIRE_MULTIMODAL_OBSERVATION_EVENT_KINDS),
    source: z.enum(HIRE_MULTIMODAL_OBSERVATION_EVENT_SOURCES),
    startMs: z
      .number()
      .int()
      .min(0)
      .max(HIRE_MULTIMODAL_OBSERVATION_MAX_DURATION_MS),
    endMs: z
      .number()
      .int()
      .min(0)
      .max(HIRE_MULTIMODAL_OBSERVATION_MAX_DURATION_MS),
  })
  .strict()
  .superRefine((event, context) => {
    if (event.endMs < event.startMs) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Observation event must not end before it starts",
        path: ["endMs"],
      });
    }
    const expectedSource = {
      browser_window_not_visible: "browser_visibility",
      browser_window_focus_lost: "browser_focus",
      fullscreen_exited: "fullscreen",
      camera_interrupted: "camera_track",
      microphone_interrupted: "microphone_track",
      screen_share_wrong_surface: "display_surface",
      screen_share_interrupted: "display_track",
      screen_recording_interrupted: "display_recorder",
      sustained_camera_away: "camera",
      speech_video_unverified: "speech_video_corroboration",
    }[event.kind];
    if (event.source !== expectedSource) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Observation event source does not match its kind",
        path: ["source"],
      });
    }
  });

export const HireMultimodalObservationClientEventSchema =
  HireMultimodalObservationEventSchema.refine(
    (event) =>
      HIRE_MULTIMODAL_OBSERVATION_CLIENT_EVENT_KINDS.includes(
        event.kind as (typeof HIRE_MULTIMODAL_OBSERVATION_CLIENT_EVENT_KINDS)[number],
      ),
    "Derived observation event kinds are owned by the runtime",
  );

export const HireMultimodalObservationSpeechVideoSampleSchema = z
  .object({
    atMs: z
      .number()
      .int()
      .min(0)
      .max(HIRE_MULTIMODAL_OBSERVATION_MAX_DURATION_MS),
    /** Coarse local VAD state only; no waveform, level, or transcript. */
    voiceActive: z.boolean(),
    /** Whether the local camera pipeline had a face in its current frame. */
    facePresent: z.boolean(),
    /**
     * Optional local mouth-motion corroboration from the current face frame.
     * Omission means that geometry was unavailable; it is never interpreted
     * as a negative signal so V2 snapshots from before this field remain valid.
     */
    facialSpeechActive: z.boolean().optional(),
  })
  .strict();

export const HireMultimodalObservationSpeechVideoCorroborationSchema = z
  .object({
    available: z.boolean(),
    samples: z
      .array(HireMultimodalObservationSpeechVideoSampleSchema)
      .max(HIRE_MULTIMODAL_OBSERVATION_MAX_SPEECH_VIDEO_SAMPLES),
  })
  .strict();

export const HireMultimodalObservationReportSchema = z
  .object({
    status: z.enum(["completed", "insufficient_signal"]),
    capture: z
      .object({
        camera: z.enum(HIRE_MULTIMODAL_OBSERVATION_CAPTURE_STATES),
        browserVisibility: z.enum(HIRE_MULTIMODAL_OBSERVATION_CAPTURE_STATES),
        /** Added in bridge V2; optional so an already-staged V1 report stays valid. */
        browserFocus: z
          .enum(HIRE_MULTIMODAL_OBSERVATION_CAPTURE_STATES)
          .optional(),
        fullscreen: z
          .enum(HIRE_MULTIMODAL_OBSERVATION_CAPTURE_STATES)
          .optional(),
        cameraTrack: z
          .enum(HIRE_MULTIMODAL_OBSERVATION_CAPTURE_STATES)
          .optional(),
        microphoneTrack: z
          .enum(HIRE_MULTIMODAL_OBSERVATION_CAPTURE_STATES)
          .optional(),
        displayShare: z
          .enum(HIRE_MULTIMODAL_OBSERVATION_CAPTURE_STATES)
          .optional(),
        speechVideoCorroboration: z
          .enum(HIRE_MULTIMODAL_OBSERVATION_CAPTURE_STATES)
          .optional(),
      })
      .strict(),
    events: z
      .array(HireMultimodalObservationEventSchema)
      .max(HIRE_MULTIMODAL_OBSERVATION_MAX_EVENTS),
  })
  .strict();

/**
 * The runtime can only state that collection was unavailable or report bounded
 * neutral intervals. It cannot submit a score, a conclusion, a ranking hint,
 * free text, or a raw biometric payload.
 */
export const HireMultimodalObservationIngestionSchema = z
  .object({
    schemaVersion: z.union([
      z.literal(HIRE_MULTIMODAL_OBSERVATION_LEGACY_BRIDGE_SCHEMA_VERSION),
      z.literal(HIRE_MULTIMODAL_OBSERVATION_BRIDGE_SCHEMA_VERSION),
    ]),
    eventId: HireMultimodalObservationSha256Schema,
    workspaceId: HireMultimodalObservationObjectIdSchema,
    applicationId: HireMultimodalObservationObjectIdSchema,
    roundId: HireMultimodalObservationObjectIdSchema,
    runtimeSessionId: HireMultimodalObservationObjectIdSchema,
    attempt: z.number().int().min(1).max(10),
    revision: z
      .number()
      .int()
      .min(1)
      .max(HIRE_MULTIMODAL_OBSERVATION_MAX_REVISIONS),
    consentVersion: z.string().trim().min(1).max(80),
    policyVersion: z.string().trim().min(1).max(80),
    observationDigest: HireMultimodalObservationSha256Schema,
    observedAt: HireMultimodalObservationIsoDateTimeSchema,
    report: HireMultimodalObservationReportSchema,
  })
  .strict();

export type HireMultimodalObservationEvent = z.infer<
  typeof HireMultimodalObservationEventSchema
>;
export type HireMultimodalObservationClientEvent = z.infer<
  typeof HireMultimodalObservationClientEventSchema
>;
export type HireMultimodalObservationReport = z.infer<
  typeof HireMultimodalObservationReportSchema
>;
export type HireMultimodalObservationSpeechVideoSample = z.infer<
  typeof HireMultimodalObservationSpeechVideoSampleSchema
>;
export type HireMultimodalObservationSpeechVideoCorroboration = z.infer<
  typeof HireMultimodalObservationSpeechVideoCorroborationSchema
>;
export type HireMultimodalObservationIngestion = z.infer<
  typeof HireMultimodalObservationIngestionSchema
>;

/**
 * This bridge never carries a candidate, job, result, or report. The runtime
 * only receives opaque round coordinates plus the durable control obligation
 * id needed to make the outbox purge idempotent.
 */
export const HireMultimodalObservationRuntimePurgeSchema = z
  .object({
    schemaVersion: z.literal(
      HIRE_MULTIMODAL_OBSERVATION_RUNTIME_PURGE_SCHEMA_VERSION,
    ),
    purgeId: HireMultimodalObservationObjectIdSchema,
    workspaceId: HireMultimodalObservationObjectIdSchema,
    applicationId: HireMultimodalObservationObjectIdSchema,
    roundId: HireMultimodalObservationObjectIdSchema,
    purgeEligibleAt: HireMultimodalObservationIsoDateTimeSchema,
    reason: z.literal("job_closed_retention"),
  })
  .strict();

export const HireMultimodalObservationRuntimePurgeAckSchema = z
  .object({
    ok: z.literal(true),
    outcome: z.enum(["purged", "already_purged", "not_provisioned"]),
  })
  .strict();

export type HireMultimodalObservationRuntimePurge = z.infer<
  typeof HireMultimodalObservationRuntimePurgeSchema
>;
export type HireMultimodalObservationRuntimePurgeAck = z.infer<
  typeof HireMultimodalObservationRuntimePurgeAckSchema
>;

/** Stable JSON representation used before hashing an observation payload. */
export function canonicalHireMultimodalObservationJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value
      .map((entry) => canonicalHireMultimodalObservationJson(entry))
      .join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${canonicalHireMultimodalObservationJson(
          record[key],
        )}`,
    )
    .join(",")}}`;
}

/**
 * Only the immutable, non-identifying report and its timestamp are covered by
 * this digest. Coordinates and policy/consent are separately authenticated by
 * the signed bridge request and checked against the control-plane records.
 */
export function hireMultimodalObservationDigestPayload(
  input: Pick<HireMultimodalObservationIngestion, "observedAt" | "report">,
): { observedAt: string; report: HireMultimodalObservationReport } {
  return {
    observedAt: input.observedAt,
    report: input.report,
  };
}
