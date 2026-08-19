import {
  HIRE_MULTIMODAL_OBSERVATION_RUNTIME_PURGE_SCHEMA_VERSION,
  HireMultimodalObservationRuntimePurgeAckSchema,
  HireMultimodalObservationRuntimePurgeSchema,
  type HireMultimodalObservationRuntimePurgeAck,
} from "@shared/contracts/hireMultimodalObservationBridge";
import { createInternalServiceHeaders } from "@shared/services/internalServiceAuth";

export const HIRE_MULTIMODAL_OBSERVATION_RUNTIME_PURGE_PATH =
  "/api/internal/hire-engine/multimodal-observations/purge";
export const HIRE_MULTIMODAL_OBSERVATION_RUNTIME_PURGE_TIMEOUT_MS = 15_000;

export class HireMultimodalObservationRuntimePurgeError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "HireMultimodalObservationRuntimePurgeError";
  }
}

function runtimeBaseUrl(): string {
  const raw = process.env.HIRE_ENGINE_RUNTIME_URL;
  if (!raw) {
    throw new HireMultimodalObservationRuntimePurgeError(
      "Hire runtime URL is not configured",
      true,
    );
  }
  const url = new URL(raw);
  if (process.env.NODE_ENV === "production" && url.protocol !== "https:") {
    throw new HireMultimodalObservationRuntimePurgeError(
      "Hire runtime URL must use HTTPS",
      false,
    );
  }
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

/**
 * The only runtime-visible retention payload. A successful acknowledgement is
 * a hard barrier: callers must not delete the control-plane observation until
 * this request has completed with one of the typed idempotent outcomes.
 */
export async function purgeRuntimeMultimodalObservationOutbox(input: {
  purgeId: string;
  workspaceId: string;
  applicationId: string;
  roundId: string;
  purgeEligibleAt: Date;
}): Promise<HireMultimodalObservationRuntimePurgeAck["outcome"]> {
  const payload = HireMultimodalObservationRuntimePurgeSchema.parse({
    schemaVersion: HIRE_MULTIMODAL_OBSERVATION_RUNTIME_PURGE_SCHEMA_VERSION,
    purgeId: input.purgeId,
    workspaceId: input.workspaceId,
    applicationId: input.applicationId,
    roundId: input.roundId,
    purgeEligibleAt: input.purgeEligibleAt.toISOString(),
    reason: "job_closed_retention",
  });
  const body = JSON.stringify(payload);
  let response: Response;
  try {
    response = await fetch(
      new URL(HIRE_MULTIMODAL_OBSERVATION_RUNTIME_PURGE_PATH, runtimeBaseUrl()),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...createInternalServiceHeaders({
            method: "POST",
            path: HIRE_MULTIMODAL_OBSERVATION_RUNTIME_PURGE_PATH,
            body,
          }),
        },
        body,
        cache: "no-store",
        signal: AbortSignal.timeout(
          HIRE_MULTIMODAL_OBSERVATION_RUNTIME_PURGE_TIMEOUT_MS,
        ),
      },
    );
  } catch (error) {
    throw new HireMultimodalObservationRuntimePurgeError(
      error instanceof Error
        ? error.message
        : "Hire runtime purge request failed",
      true,
    );
  }
  if (!response.ok) {
    throw new HireMultimodalObservationRuntimePurgeError(
      `Hire runtime observation purge returned ${response.status}`,
      response.status === 429 || response.status >= 500,
    );
  }
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    throw new HireMultimodalObservationRuntimePurgeError(
      "Hire runtime observation purge returned invalid JSON",
      true,
    );
  }
  try {
    return HireMultimodalObservationRuntimePurgeAckSchema.parse(parsed).outcome;
  } catch {
    throw new HireMultimodalObservationRuntimePurgeError(
      "Hire runtime observation purge returned an invalid acknowledgement",
      true,
    );
  }
}
