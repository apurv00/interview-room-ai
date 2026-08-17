import { createHash } from "node:crypto";
import mongoose, { type ClientSession } from "mongoose";
import {
  HIRE_MULTIMODAL_OBSERVATION_CONSENT_VERSION,
  HIRE_MULTIMODAL_OBSERVATION_POLICY_VERSION,
  HireMultimodalObservationIngestionSchema,
  canonicalHireMultimodalObservationJson,
  hireMultimodalObservationDigestPayload,
  type HireMultimodalObservationIngestion,
} from "@shared/contracts/hireMultimodalObservationBridge";
import {
  HireApplication,
  HireConsentReceipt,
  HireInterviewAttempt,
  HireJob,
  HirePrivacyRequest,
  HireRound,
  HIRE_AI_DISCLOSURE_DIGEST,
  connectHireControlDB,
  claimHireCandidatePiiWriteFence,
  HireCandidatePiiTombstoneError,
  addCalendarMonths,
} from "@hire";
import {
  HireMultimodalObservation,
  HireMultimodalObservationIngestionEvent,
  HireMultimodalObservationPurgeObligation,
} from "../models";

export class HireMultimodalObservationIngestionError extends Error {
  constructor(
    message: string,
    readonly code: "not_found" | "conflict" | "digest_mismatch",
    readonly status: number,
  ) {
    super(message);
    this.name = "HireMultimodalObservationIngestionError";
  }
}

export type HireMultimodalObservationIngestionOutcome =
  "processed" | "duplicate" | "stale";

interface ObservationCoordinate {
  workspaceId: string;
  applicationId: string;
  jobId: string;
  candidateId: string;
  roundId: string;
  attemptId: string;
  purgeEligibleAt?: Date;
}

function observationDigest(
  payload: Pick<HireMultimodalObservationIngestion, "observedAt" | "report">,
): string {
  return createHash("sha256")
    .update(
      canonicalHireMultimodalObservationJson(
        hireMultimodalObservationDigestPayload(payload),
      ),
    )
    .digest("hex");
}

function sameEventCoordinate(
  existing: {
    workspaceId: { toString(): string };
    applicationId: { toString(): string };
    roundId: { toString(): string };
    runtimeSessionId: { toString(): string };
    attempt: number;
    revision: number;
    observationDigest: string;
  },
  payload: HireMultimodalObservationIngestion,
): boolean {
  return (
    existing.workspaceId.toString() === payload.workspaceId &&
    existing.applicationId.toString() === payload.applicationId &&
    existing.roundId.toString() === payload.roundId &&
    existing.runtimeSessionId.toString() === payload.runtimeSessionId &&
    existing.attempt === payload.attempt &&
    existing.revision === payload.revision &&
    existing.observationDigest === payload.observationDigest
  );
}

function isDuplicateKeyError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === 11000
  );
}

async function observationCoordinateFor(
  payload: HireMultimodalObservationIngestion,
  session?: ClientSession,
): Promise<ObservationCoordinate | "stale"> {
  // A v2 session is allowed to finish, but must never become an implicit opt-in
  // for the separate v3 supplemental-observation policy.
  if (
    payload.consentVersion !== HIRE_MULTIMODAL_OBSERVATION_CONSENT_VERSION ||
    payload.policyVersion !== HIRE_MULTIMODAL_OBSERVATION_POLICY_VERSION
  ) {
    return "stale";
  }

  const applicationQuery = HireApplication.findOne({
    _id: payload.applicationId,
    workspaceId: payload.workspaceId,
  }).select("candidateId jobId");
  if (session) applicationQuery.session(session);
  const application = await applicationQuery.lean();
  if (!application) {
    throw new HireMultimodalObservationIngestionError(
      "Application not found",
      "not_found",
      404,
    );
  }

  const roundQuery = HireRound.findOne({
    _id: payload.roundId,
    workspaceId: payload.workspaceId,
    applicationId: payload.applicationId,
    candidateId: application.candidateId,
    jobId: application.jobId,
  }).select("runtimeSessionId consentVersion");
  if (session) roundQuery.session(session);
  const round = await roundQuery.lean();
  if (!round) {
    throw new HireMultimodalObservationIngestionError(
      "Round not found",
      "not_found",
      404,
    );
  }
  if (round.consentVersion !== HIRE_MULTIMODAL_OBSERVATION_CONSENT_VERSION) {
    return "stale";
  }
  // The runtime session binding is created by the result-linked round. Do not
  // accept a supplemental report until that binding exists: otherwise a
  // signed retry could attach data to an unbound or later-reused round.
  if (!round.runtimeSessionId) return "stale";
  if (round.runtimeSessionId.toString() !== payload.runtimeSessionId) {
    throw new HireMultimodalObservationIngestionError(
      "Round is already linked to a different runtime session",
      "conflict",
      409,
    );
  }

  const attemptQuery = HireInterviewAttempt.findOne({
    workspaceId: payload.workspaceId,
    applicationId: payload.applicationId,
    jobId: application.jobId,
    candidateId: application.candidateId,
    roundId: payload.roundId,
    sequence: payload.attempt,
  }).select("_id consentReceiptId");
  if (session) attemptQuery.session(session);
  const attempt = await attemptQuery.lean();
  if (!attempt) {
    throw new HireMultimodalObservationIngestionError(
      "Interview attempt not found",
      "not_found",
      404,
    );
  }

  // Mirror the media lifecycle's late-arrival rule. A report arriving after a
  // job is closed inherits that job's immutable six-calendar-month deadline;
  // once the deadline has passed it is stale and cannot recreate deleted data.
  const jobQuery = HireJob.findOne({
    _id: application.jobId,
    workspaceId: payload.workspaceId,
  }).select("status closedAt");
  if (session) jobQuery.session(session);
  const job = await jobQuery.lean();
  if (!job) {
    throw new HireMultimodalObservationIngestionError(
      "Interview job not found",
      "not_found",
      404,
    );
  }
  const purgeEligibleAt =
    job.status === "closed" && job.closedAt
      ? addCalendarMonths(job.closedAt, 6)
      : undefined;
  if (purgeEligibleAt && purgeEligibleAt <= new Date()) return "stale";

  // Use the immutable receipt selected by the attempt, not just any v3 receipt
  // for the candidate/round. This closes the retake and cross-attempt path.
  const receiptQuery = HireConsentReceipt.exists({
    _id: attempt.consentReceiptId,
    workspaceId: payload.workspaceId,
    applicationId: payload.applicationId,
    jobId: application.jobId,
    candidateId: application.candidateId,
    roundId: payload.roundId,
    attemptId: attempt._id,
    consentVersion: HIRE_MULTIMODAL_OBSERVATION_CONSENT_VERSION,
    disclosureDigest: HIRE_AI_DISCLOSURE_DIGEST,
    "accepted.recording": true,
    "accepted.identityPhoto": true,
    "accepted.attentionMonitoring": true,
    "accepted.aiEvaluation": true,
  });
  if (session) receiptQuery.session(session);
  const receipt = await receiptQuery;
  if (!receipt) return "stale";

  return {
    workspaceId: payload.workspaceId,
    applicationId: payload.applicationId,
    jobId: application.jobId.toString(),
    candidateId: application.candidateId.toString(),
    roundId: payload.roundId,
    attemptId: attempt._id.toString(),
    ...(purgeEligibleAt ? { purgeEligibleAt } : {}),
  };
}

async function existingOutcome(
  payload: HireMultimodalObservationIngestion,
  dbSession: ClientSession,
): Promise<HireMultimodalObservationIngestionOutcome | null> {
  const exactEvent = await HireMultimodalObservationIngestionEvent.findOne({
    eventId: payload.eventId,
  })
    .session(dbSession)
    .lean();
  if (exactEvent) {
    if (!sameEventCoordinate(exactEvent, payload)) {
      throw new HireMultimodalObservationIngestionError(
        "An observation event id was reused with different content",
        "conflict",
        409,
      );
    }
    return exactEvent.status === "processed" ? "duplicate" : null;
  }

  const latest = await HireMultimodalObservation.findOne({
    workspaceId: payload.workspaceId,
    applicationId: payload.applicationId,
    roundId: payload.roundId,
    runtimeSessionId: payload.runtimeSessionId,
  })
    .sort({ revision: -1 })
    .session(dbSession)
    .lean();
  if (!latest) return null;
  if (latest.revision > payload.revision) return "stale";
  if (latest.revision < payload.revision) return null;
  if (latest.observationDigest === payload.observationDigest)
    return "duplicate";
  throw new HireMultimodalObservationIngestionError(
    "The same observation revision has different content",
    "conflict",
    409,
  );
}

async function privacyTombstoneExists(
  coordinate: Pick<ObservationCoordinate, "workspaceId" | "candidateId">,
  session?: ClientSession,
): Promise<boolean> {
  const query = HirePrivacyRequest.exists({
    workspaceId: coordinate.workspaceId,
    candidateId: coordinate.candidateId,
    // A live request is the write fence from the instant it is initiated.
    // Waiting for verification or processing would allow a signed runtime
    // retry to add new candidate-linked observations during deletion.
    live: true,
  });
  if (session) query.session(session);
  return Boolean(await query);
}

/**
 * A due control retention obligation is a second, local write fence. It closes
 * the publisher-versus-runtime-tombstone race even if a signed runtime retry
 * crosses the network after the job-close deadline.
 */
async function dueRuntimeObservationPurgeExists(
  coordinate: Pick<
    ObservationCoordinate,
    "workspaceId" | "applicationId" | "roundId"
  >,
  session?: ClientSession,
): Promise<boolean> {
  const query = HireMultimodalObservationPurgeObligation.exists({
    workspaceId: coordinate.workspaceId,
    applicationId: coordinate.applicationId,
    roundId: coordinate.roundId,
    reason: "job_closed_retention",
    purgeEligibleAt: { $lte: new Date() },
  });
  if (session) query.session(session);
  return Boolean(await query);
}

async function recoverDuplicateOutcome(
  payload: HireMultimodalObservationIngestion,
): Promise<HireMultimodalObservationIngestionOutcome> {
  const event = await HireMultimodalObservationIngestionEvent.findOne({
    eventId: payload.eventId,
  }).lean();
  if (event) {
    if (!sameEventCoordinate(event, payload)) {
      throw new HireMultimodalObservationIngestionError(
        "An observation event id was reused with different content",
        "conflict",
        409,
      );
    }
    return event.status === "processed" ? "duplicate" : "stale";
  }
  const exactRevision = await HireMultimodalObservation.findOne({
    workspaceId: payload.workspaceId,
    applicationId: payload.applicationId,
    roundId: payload.roundId,
    runtimeSessionId: payload.runtimeSessionId,
    revision: payload.revision,
  }).lean();
  if (!exactRevision)
    throw new Error("Observation idempotency recovery failed");
  if (exactRevision.observationDigest === payload.observationDigest) {
    return "duplicate";
  }
  throw new HireMultimodalObservationIngestionError(
    "The same observation revision has different content",
    "conflict",
    409,
  );
}

export async function ingestHireMultimodalObservation(
  rawPayload: unknown,
): Promise<{ outcome: HireMultimodalObservationIngestionOutcome }> {
  const payload = HireMultimodalObservationIngestionSchema.parse(rawPayload);
  if (observationDigest(payload) !== payload.observationDigest) {
    throw new HireMultimodalObservationIngestionError(
      "Observation digest does not match the canonical observation payload",
      "digest_mismatch",
      400,
    );
  }
  await connectHireControlDB();
  const coordinate = await observationCoordinateFor(payload);
  if (coordinate === "stale") return { outcome: "stale" };
  if (await dueRuntimeObservationPurgeExists(coordinate))
    return { outcome: "stale" };
  if (await privacyTombstoneExists(coordinate)) return { outcome: "stale" };

  const dbSession = await mongoose.startSession();
  try {
    let outcome: HireMultimodalObservationIngestionOutcome = "processed";
    try {
      await dbSession.withTransaction(async () => {
        if (await dueRuntimeObservationPurgeExists(coordinate, dbSession)) {
          outcome = "stale";
          return;
        }
        const prior = await existingOutcome(payload, dbSession);
        if (prior) {
          outcome = prior;
          return;
        }
        if (await privacyTombstoneExists(coordinate, dbSession)) {
          outcome = "stale";
          return;
        }
        await claimHireCandidatePiiWriteFence({
          workspaceId: coordinate.workspaceId,
          candidateId: coordinate.candidateId,
          session: dbSession,
        });
        await HireMultimodalObservationIngestionEvent.create(
          [
            {
              eventId: payload.eventId,
              workspaceId: coordinate.workspaceId,
              applicationId: coordinate.applicationId,
              candidateId: coordinate.candidateId,
              roundId: coordinate.roundId,
              runtimeSessionId: payload.runtimeSessionId,
              attempt: payload.attempt,
              revision: payload.revision,
              observationDigest: payload.observationDigest,
              status: "received",
            },
          ],
          { session: dbSession },
        );
        await HireMultimodalObservation.create(
          [
            {
              workspaceId: coordinate.workspaceId,
              applicationId: coordinate.applicationId,
              jobId: coordinate.jobId,
              candidateId: coordinate.candidateId,
              roundId: coordinate.roundId,
              attemptId: coordinate.attemptId,
              runtimeSessionId: payload.runtimeSessionId,
              schemaVersion: payload.schemaVersion,
              eventId: payload.eventId,
              revision: payload.revision,
              consentVersion: payload.consentVersion,
              policyVersion: payload.policyVersion,
              observationDigest: payload.observationDigest,
              observedAt: new Date(payload.observedAt),
              report: payload.report,
              ...(coordinate.purgeEligibleAt
                ? {
                    purgeEligibleAt: coordinate.purgeEligibleAt,
                    purgeReason: "job_closed",
                  }
                : {}),
            },
          ],
          { session: dbSession },
        );
        await HireMultimodalObservationIngestionEvent.updateOne(
          { eventId: payload.eventId, status: "received" },
          { $set: { status: "processed", processedAt: new Date() } },
          { session: dbSession },
        );
      });
    } catch (error) {
      if (error instanceof HireCandidatePiiTombstoneError) {
        return { outcome: "stale" };
      }
      if (isDuplicateKeyError(error)) {
        return { outcome: await recoverDuplicateOutcome(payload) };
      }
      throw error;
    }
    return { outcome };
  } finally {
    await dbSession.endSession();
  }
}

export const __hireMultimodalObservationIngestion = {
  observationDigest,
  observationCoordinateFor,
  dueRuntimeObservationPurgeExists,
  sameEventCoordinate,
};
