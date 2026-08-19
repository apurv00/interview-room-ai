import { z } from "zod";

/**
 * A deliberately separate, versioned bridge for Hire's supplemental interview
 * observations. It is not part of the assessment-result contract: it carries
 * neither scores nor recommendations, and it never transports raw camera
 * samples, landmarks, audio, transcript text, or recordings.
 */
export const HIRE_MULTIMODAL_OBSERVATION_BRIDGE_SCHEMA_VERSION = 1 as const;
export const HIRE_MULTIMODAL_OBSERVATION_CONSENT_VERSION =
  "hire-ai-v3-2026-08-17";
export const HIRE_MULTIMODAL_OBSERVATION_POLICY_VERSION =
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

export const HIRE_MULTIMODAL_OBSERVATION_EVENT_KINDS = [
  "browser_window_not_visible",
  "sustained_camera_away",
] as const;

export const HireMultimodalObservationEventSchema = z
  .object({
    kind: z.enum(HIRE_MULTIMODAL_OBSERVATION_EVENT_KINDS),
    source: z.enum(["camera", "browser_visibility"]),
    startMs: z
      .number()
      .int()
      .min(0)
      .max(30 * 60 * 1_000),
    endMs: z
      .number()
      .int()
      .min(0)
      .max(30 * 60 * 1_000),
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
    const expectedSource =
      event.kind === "sustained_camera_away" ? "camera" : "browser_visibility";
    if (event.source !== expectedSource) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Observation event source does not match its kind",
        path: ["source"],
      });
    }
  });

export const HireMultimodalObservationReportSchema = z
  .object({
    status: z.enum(["completed", "insufficient_signal"]),
    capture: z
      .object({
        camera: z.enum(HIRE_MULTIMODAL_OBSERVATION_CAPTURE_STATES),
        browserVisibility: z.enum(HIRE_MULTIMODAL_OBSERVATION_CAPTURE_STATES),
      })
      .strict(),
    events: z.array(HireMultimodalObservationEventSchema).max(100),
  })
  .strict();

/**
 * The runtime can only state that collection was unavailable or report bounded
 * neutral intervals. It cannot submit a score, a conclusion, a ranking hint,
 * free text, or a raw biometric payload.
 */
export const HireMultimodalObservationIngestionSchema = z
  .object({
    schemaVersion: z.literal(HIRE_MULTIMODAL_OBSERVATION_BRIDGE_SCHEMA_VERSION),
    eventId: HireMultimodalObservationSha256Schema,
    workspaceId: HireMultimodalObservationObjectIdSchema,
    applicationId: HireMultimodalObservationObjectIdSchema,
    roundId: HireMultimodalObservationObjectIdSchema,
    runtimeSessionId: HireMultimodalObservationObjectIdSchema,
    attempt: z.number().int().min(1).max(10),
    revision: z.number().int().min(1).max(10),
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
export type HireMultimodalObservationReport = z.infer<
  typeof HireMultimodalObservationReportSchema
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
