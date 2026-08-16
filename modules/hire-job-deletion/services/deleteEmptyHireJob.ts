import mongoose, { type ClientSession } from "mongoose";
import { AppError, ForbiddenError, NotFoundError } from "@shared/errors";
import { HireAssessmentExport } from "../../hire-decisions/models/HireAssessmentExport";
import { HireAssessmentExportCleanup } from "../../hire-decisions/models/HireAssessmentExportCleanup";
import { HireExternalVerdict } from "../../hire-decisions/models/HireExternalVerdict";
import { HireSharePacket } from "../../hire-decisions/models/HireSharePacket";
import { HireReportExport } from "../../hire-reports/models/HireReportExport";
import { HireReportExportCleanup } from "../../hire-reports/models/HireReportExportCleanup";
import { HireCandidateStatusLink } from "../../hire-status/models/HireCandidateStatusLink";
import { HireOnboardingTestDrive } from "../../hire-onboarding/models/HireOnboardingTestDrive";
import { HireAiInviteDelivery } from "../../hire/models/HireAiInviteDelivery";
import { HireApplication } from "../../hire/models/HireApplication";
import { HireConsentReceipt } from "../../hire/models/HireConsentReceipt";
import { HireEmailOutbox } from "../../hire/models/HireEmailOutbox";
import { HireGuestSession } from "../../hire/models/HireGuestSession";
import { HireHumanKitDelivery } from "../../hire/models/HireHumanKitDelivery";
import { HireHumanRound } from "../../hire/models/HireHumanRound";
import { HireHumanScorecard } from "../../hire/models/HireHumanScorecard";
import { HireIntakeTask } from "../../hire/models/HireIntakeTask";
import { HireInterviewAttempt } from "../../hire/models/HireInterviewAttempt";
import { HireInterviewKit } from "../../hire/models/HireInterviewKit";
import { HireInterviewResult } from "../../hire/models/HireInterviewResult";
import { HireInvitationBatch } from "../../hire/models/HireInvitationBatch";
import { HireInvitationBatchItem } from "../../hire/models/HireInvitationBatchItem";
import { HireJob } from "../../hire/models/HireJob";
import { HireJobRequirementVersion } from "../../hire/models/HireJobRequirementVersion";
import { HireMediaAsset } from "../../hire/models/HireMediaAsset";
import { HireRound } from "../../hire/models/HireRound";
import { HireScreeningGate } from "../../hire/models/HireScreeningGate";
import { HireWorkspaceMember } from "../../hire/models/HireWorkspaceMember";
import { withActiveHireWorkspaceWriteTransaction } from "../../hire/services/hireWorkspaceWriteFence";
import type { MembershipContext } from "../../hire/services/workspaceService";
import type { DeleteEmptyHireJobPayload } from "../validators/deleteEmptyHireJob";

const OBJECT_ID = /^[a-f0-9]{24}$/i;

export type DeleteEmptyHireJobResult = {
  jobId: string;
};

function normalizedTitle(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ");
}

function assertWorkspaceAdmin(ctx: MembershipContext): void {
  if (ctx.membership.role !== "admin") {
    throw new ForbiddenError(
      "Only the workspace admin can delete an empty job",
    );
  }
}

function asJobId(jobId: string): mongoose.Types.ObjectId {
  if (!OBJECT_ID.test(jobId)) {
    throw new AppError("Invalid job id", 400, "INVALID_JOB_ID");
  }
  return new mongoose.Types.ObjectId(jobId);
}

/**
 * A job can be permanently removed only before it has created any hiring
 * activity. Keep the checks serial: MongoDB does not support parallel model
 * operations on one transaction session.
 */
async function assertNoJobActivity(
  workspaceId: mongoose.Types.ObjectId,
  jobId: mongoose.Types.ObjectId,
  session: ClientSession,
): Promise<void> {
  const scope = { workspaceId, jobId };
  const checks = [
    () => HireOnboardingTestDrive.exists(scope).session(session),
    () => HireIntakeTask.exists(scope).session(session),
    () => HireApplication.exists(scope).session(session),
    () => HireScreeningGate.exists(scope).session(session),
    () => HireInvitationBatch.exists(scope).session(session),
    () => HireInvitationBatchItem.exists(scope).session(session),
    () => HireRound.exists(scope).session(session),
    () => HireInterviewAttempt.exists(scope).session(session),
    () => HireInterviewResult.exists(scope).session(session),
    () => HireGuestSession.exists(scope).session(session),
    () => HireConsentReceipt.exists(scope).session(session),
    () => HireAiInviteDelivery.exists(scope).session(session),
    () => HireHumanRound.exists(scope).session(session),
    () => HireInterviewKit.exists(scope).session(session),
    () => HireHumanKitDelivery.exists(scope).session(session),
    () => HireHumanScorecard.exists(scope).session(session),
    () => HireEmailOutbox.exists(scope).session(session),
    () => HireCandidateStatusLink.exists(scope).session(session),
    () => HireSharePacket.exists(scope).session(session),
    () => HireExternalVerdict.exists(scope).session(session),
    () => HireMediaAsset.exists(scope).session(session),
    () => HireAssessmentExport.exists(scope).session(session),
    () => HireAssessmentExportCleanup.exists(scope).session(session),
    () => HireReportExport.exists(scope).session(session),
    () => HireReportExportCleanup.exists(scope).session(session),
  ];

  for (const check of checks) {
    if (await check()) {
      throw new AppError(
        "This job has hiring activity and cannot be deleted. Close the job instead.",
        409,
        "JOB_HAS_ACTIVITY",
      );
    }
  }
}

/**
 * Permanently removes only a pristine, non-terminal requisition and its
 * immutable scoring-contract revisions. It never cascades into candidates,
 * interviews, exports, media, or runtime-owned records.
 */
export async function deleteEmptyHireJob(
  ctx: MembershipContext,
  jobId: string,
  input: DeleteEmptyHireJobPayload,
): Promise<DeleteEmptyHireJobResult> {
  assertWorkspaceAdmin(ctx);
  const parsedJobId = asJobId(jobId);

  return withActiveHireWorkspaceWriteTransaction(
    ctx.workspace._id,
    ctx.membership._id,
    async (session) => {
      // The outer fence proves that the membership is active, but an admin
      // transfer can commit before this transaction retries. Recheck the
      // destructive authority in the transaction itself.
      const currentAdmin = await HireWorkspaceMember.exists({
        _id: ctx.membership._id,
        workspaceId: ctx.workspace._id,
        authState: "active",
        role: "admin",
      }).session(session);
      if (!currentAdmin) {
        throw new ForbiddenError(
          "Only the workspace admin can delete an empty job",
        );
      }

      const job = await HireJob.findOne({
        _id: parsedJobId,
        workspaceId: ctx.workspace._id,
      }).session(session);
      if (!job) throw new NotFoundError("Job");

      if (job.status === "closed") {
        throw new AppError(
          "Closed jobs are retained for their decision and retention history",
          409,
          "JOB_DELETE_CLOSED",
        );
      }
      if (job.applyPageEnabled || job.applyTokenHash) {
        throw new AppError(
          "Turn off the public apply link before deleting this job",
          409,
          "JOB_DELETE_APPLY_LINK_ACTIVE",
        );
      }
      if (
        normalizedTitle(input.confirmationTitle) !== normalizedTitle(job.title)
      ) {
        throw new AppError(
          "Type the current job title to confirm deletion",
          400,
          "JOB_DELETE_CONFIRMATION_MISMATCH",
        );
      }

      await assertNoJobActivity(ctx.workspace._id, job._id, session);

      await HireJobRequirementVersion.deleteMany(
        { workspaceId: ctx.workspace._id, jobId: job._id },
        { session },
      );
      const removed = await HireJob.deleteOne(
        { _id: job._id, workspaceId: ctx.workspace._id, status: job.status },
        { session },
      );
      if (removed.deletedCount !== 1) {
        throw new AppError(
          "The job changed while it was being deleted",
          409,
          "JOB_DELETE_RACE",
        );
      }

      return { jobId: job._id.toString() };
    },
  );
}
