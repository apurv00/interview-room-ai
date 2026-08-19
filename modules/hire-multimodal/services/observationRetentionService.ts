import { HIRE_MULTIMODAL_OBSERVATION_CONSENT_VERSION } from "@shared/contracts/hireMultimodalObservationBridge";
import { HIRE_AI_CONSENT_VERSION, HireRound } from "@hire";
import {
  HireMultimodalAnalysis,
  HireMultimodalAnalysisIngestionEvent,
  HireMultimodalObservation,
  HireMultimodalObservationIngestionEvent,
  HireMultimodalObservationPurgeObligation,
} from "../models";
import { purgeRuntimeMultimodalObservationOutbox } from "./runtimeObservationPurgeService";

const RETENTION_BULK_SIZE = 250;

export interface HireMultimodalObservationRetentionScheduleReport {
  scheduledObservations: number;
  scheduledRuntimePurgeObligations: number;
}

export interface HireMultimodalObservationRetentionPurgeReport {
  scanned: number;
  runtimeAcknowledged: number;
  controlPurged: number;
  failed: number;
}

function failureCode(error: unknown): string {
  if (error instanceof Error && error.name) return error.name.slice(0, 160);
  return "RUNTIME_OBSERVATION_PURGE_FAILED";
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let offset = 0; offset < items.length; offset += size) {
    result.push(items.slice(offset, offset + size));
  }
  return result;
}

/**
 * Schedule every derived control record and, independently, every consented
 * Hire multimodal round's runtime outbox purge. The latter deliberately does
 * not depend on whether a runtime publisher ever reached the control plane.
 */
export async function scheduleHireMultimodalObservationRetention(input: {
  workspaceId: string | object;
  jobId: string | object;
  purgeEligibleAt: Date;
}): Promise<HireMultimodalObservationRetentionScheduleReport> {
  const [observations, analyses, rounds] = await Promise.all([
    HireMultimodalObservation.updateMany(
      {
        workspaceId: input.workspaceId,
        jobId: input.jobId,
        $or: [
          { purgeReason: { $exists: false } },
          { purgeReason: "job_closed" },
        ],
      },
      {
        $set: {
          purgeEligibleAt: input.purgeEligibleAt,
          purgeReason: "job_closed",
        },
      },
    ),
    HireMultimodalAnalysis.updateMany(
      {
        workspaceId: input.workspaceId,
        jobId: input.jobId,
        $or: [
          { purgeReason: { $exists: false } },
          { purgeReason: "job_closed" },
        ],
      },
      {
        $set: {
          purgeEligibleAt: input.purgeEligibleAt,
          purgeReason: "job_closed",
        },
      },
    ),
    HireRound.find({
      workspaceId: input.workspaceId,
      jobId: input.jobId,
      kind: "ai",
      consentVersion: {
        $in: [
          HIRE_MULTIMODAL_OBSERVATION_CONSENT_VERSION,
          HIRE_AI_CONSENT_VERSION,
        ],
      },
    })
      .select("_id workspaceId applicationId jobId candidateId")
      .lean(),
  ]);

  let scheduledRuntimePurgeObligations = 0;
  for (const batch of chunks(rounds, RETENTION_BULK_SIZE)) {
    if (!batch.length) continue;
    const result = await HireMultimodalObservationPurgeObligation.bulkWrite(
      batch.map((round) => ({
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
              purgeEligibleAt: input.purgeEligibleAt,
              reason: "job_closed_retention",
            },
          },
          upsert: true,
        },
      })),
      { ordered: false },
    );
    scheduledRuntimePurgeObligations += result.upsertedCount ?? 0;
  }

  return {
    scheduledObservations:
      (observations.modifiedCount ?? 0) + (analyses.modifiedCount ?? 0),
    scheduledRuntimePurgeObligations,
  };
}

/** Reopening before the deadline rescinds only still-future obligations. */
export async function cancelFutureHireMultimodalObservationRetention(input: {
  workspaceId: string | object;
  jobId: string | object;
  reopenedAt: Date;
}): Promise<number> {
  const [observations, analyses, obligations] = await Promise.all([
    HireMultimodalObservation.updateMany(
      {
        workspaceId: input.workspaceId,
        jobId: input.jobId,
        purgeReason: "job_closed",
        purgeEligibleAt: { $gt: input.reopenedAt },
      },
      { $unset: { purgeEligibleAt: 1, purgeReason: 1 } },
    ),
    HireMultimodalAnalysis.updateMany(
      {
        workspaceId: input.workspaceId,
        jobId: input.jobId,
        purgeReason: "job_closed",
        purgeEligibleAt: { $gt: input.reopenedAt },
      },
      { $unset: { purgeEligibleAt: 1, purgeReason: 1 } },
    ),
    HireMultimodalObservationPurgeObligation.deleteMany({
      workspaceId: input.workspaceId,
      jobId: input.jobId,
      purgeEligibleAt: { $gt: input.reopenedAt },
      runtimePurgedAt: { $exists: false },
    }),
  ]);
  return (
    (observations.modifiedCount ?? 0) +
    (analyses.modifiedCount ?? 0) +
    (obligations.deletedCount ?? 0)
  );
}

/**
 * Delivers the runtime outbox tombstone before removing anything in control.
 * Runtime acknowledgement is durable on the obligation, so a crash during
 * control cleanup retries deletion without ever allowing the outbox to
 * republish a just-expired observation.
 */
export async function purgeDueHireMultimodalObservationRetention(input: {
  workspaceId: string;
  now: Date;
  batchSize: number;
}): Promise<HireMultimodalObservationRetentionPurgeReport> {
  const due = await HireMultimodalObservationPurgeObligation.find({
    workspaceId: input.workspaceId,
    purgeEligibleAt: { $lte: input.now },
  })
    .sort({ purgeEligibleAt: 1, _id: 1 })
    .limit(input.batchSize)
    .lean();

  let runtimeAcknowledged = 0;
  let controlPurged = 0;
  let failed = 0;
  for (const obligation of due) {
    try {
      if (!obligation.runtimePurgedAt) {
        await purgeRuntimeMultimodalObservationOutbox({
          purgeId: obligation._id.toString(),
          workspaceId: obligation.workspaceId.toString(),
          applicationId: obligation.applicationId.toString(),
          roundId: obligation.roundId.toString(),
          purgeEligibleAt: obligation.purgeEligibleAt,
        });
        const acknowledged =
          await HireMultimodalObservationPurgeObligation.updateOne(
            {
              _id: obligation._id,
              workspaceId: obligation.workspaceId,
              purgeEligibleAt: { $lte: input.now },
              runtimePurgedAt: { $exists: false },
            },
            {
              $set: {
                runtimePurgeRequestedAt: input.now,
                runtimePurgedAt: input.now,
              },
              $unset: { runtimePurgeFailureCode: 1 },
            },
          );
        if (acknowledged.modifiedCount !== 1) continue;
        runtimeAcknowledged++;
      }

      // Check the durable barrier again immediately before control deletion:
      // a future-deadline reopen can delete an obligation while a worker holds
      // an old query result.
      const barrier = await HireMultimodalObservationPurgeObligation.exists({
        _id: obligation._id,
        workspaceId: obligation.workspaceId,
        applicationId: obligation.applicationId,
        roundId: obligation.roundId,
        purgeEligibleAt: { $lte: input.now },
        runtimePurgedAt: { $exists: true },
      });
      if (!barrier) continue;

      const controlScope = {
        workspaceId: obligation.workspaceId,
        applicationId: obligation.applicationId,
        roundId: obligation.roundId,
      };
      // Delete the idempotency ledger first. If a process dies between these
      // operations, the acknowledged runtime tombstone still blocks a
      // publisher; the next retry completes the remaining control deletion.
      await HireMultimodalObservationIngestionEvent.deleteMany(controlScope);
      await HireMultimodalObservation.deleteMany({
        ...controlScope,
        jobId: obligation.jobId,
      });
      // V4's full recorded-interview analysis uses the same deadline and
      // durable runtime tombstone, but a distinct control model/ledger.
      await HireMultimodalAnalysisIngestionEvent.deleteMany(controlScope);
      await HireMultimodalAnalysis.deleteMany({
        ...controlScope,
        jobId: obligation.jobId,
      });
      await HireMultimodalObservationPurgeObligation.deleteOne({
        _id: obligation._id,
        workspaceId: obligation.workspaceId,
        runtimePurgedAt: { $exists: true },
      });
      controlPurged++;
    } catch (error) {
      failed++;
      await HireMultimodalObservationPurgeObligation.updateOne(
        {
          _id: obligation._id,
          workspaceId: obligation.workspaceId,
          runtimePurgedAt: { $exists: false },
        },
        {
          $set: {
            runtimePurgeRequestedAt: input.now,
            runtimePurgeFailureCode: failureCode(error),
          },
        },
      );
    }
  }
  return { scanned: due.length, runtimeAcknowledged, controlPurged, failed };
}

export const __hireMultimodalObservationRetention = {
  RETENTION_BULK_SIZE,
};
