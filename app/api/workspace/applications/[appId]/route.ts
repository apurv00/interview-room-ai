import { NextResponse } from "next/server";
import {
  HireInterviewAttempt,
  HireInterviewResult,
  HireMediaAsset,
  requireMembership,
  getApplicationDetail,
  getAiInviteDeliveryViews,
} from "@hire";
import { HireMultimodalObservation } from "@modules/hire-multimodal/models/HireMultimodalObservation";
import { getHireMultimodalAnalysisViews } from "@modules/hire-multimodal/services/analysisPresenter";
import {
  serializeApplication,
  serializeCandidate,
  serializeHumanRoundDetail,
  serializeJob,
  serializeRound,
  resumeHashOf,
} from "../../_lib/serialize";
import { composeHireApiRoute } from "../../_lib/composeHireApiRoute";

export const dynamic = "force-dynamic";

/** Candidate card reads only workspace-owned Hire projections and media ids. */
export const GET = composeHireApiRoute({
  rateLimit: { windowMs: 60_000, maxRequests: 60, keyPrefix: "rl:hire-app" },
  async handler(_req, { user, params }) {
    const ctx = await requireMembership({ userId: user.id, email: user.email });
    const detail = await getApplicationDetail(ctx, params.appId);
    const roundIds = detail.rounds.map((round) => round._id);
    const now = new Date();
    const scope = {
      workspaceId: ctx.workspace._id,
      applicationId: detail.application._id,
      roundId: { $in: roundIds },
    };
    const [
      results,
      media,
      attempts,
      inviteDeliveryByRound,
      supplementalObservations,
      multimodalAnalyses,
    ] = await Promise.all([
      HireInterviewResult.find(scope)
        .select(
          "roundId attemptId numericSummary projection evidenceIndex completedAt piiPurgedAt",
        )
        .lean(),
      HireMediaAsset.find({
        ...scope,
        kind: { $in: ["identity_photo", "camera_recording"] },
        state: "ready",
        active: true,
        // A delayed retention worker must not make expired media discoverable
        // through the detail shape before the capability endpoint rejects it.
        $or: [
          { purgeEligibleAt: { $exists: false } },
          { purgeEligibleAt: { $gt: now } },
        ],
      })
        .select("_id kind roundId attemptId capturedAt bytes")
        .lean(),
      HireInterviewAttempt.find(scope)
        .select("roundId status startedAt completedAt sequence")
        .lean(),
      getAiInviteDeliveryViews(ctx, detail.rounds),
      HireMultimodalObservation.find({
        workspaceId: ctx.workspace._id,
        applicationId: detail.application._id,
        roundId: { $in: roundIds },
        // Retention delivery is asynchronous. Treat an elapsed deadline as a
        // read fence so a delayed worker retry can never make an expired
        // supplemental observation recruiter-visible.
        $or: [
          { purgeEligibleAt: { $exists: false } },
          { purgeEligibleAt: { $gt: now } },
        ],
      })
        .select("roundId observedAt report")
        .sort({ observedAt: -1, _id: -1 })
        .lean(),
      getHireMultimodalAnalysisViews({
        workspaceId: ctx.workspace._id.toString(),
        applicationId: detail.application._id.toString(),
      }),
    ]);
    const resultByRound = new Map(
      results.map((result) => [result.roundId.toString(), result]),
    );
    const photoByRound = new Map<string, (typeof media)[number]>();
    const recordingByRoundAttempt = new Map<string, (typeof media)[number]>();
    for (const asset of media) {
      if (asset.kind === "identity_photo") {
        photoByRound.set(asset.roundId.toString(), asset);
        continue;
      }
      if (asset.kind !== "camera_recording") continue;
      const key = `${asset.roundId.toString()}:${asset.attemptId.toString()}`;
      const existing = recordingByRoundAttempt.get(key);
      if (
        !existing ||
        existing.capturedAt.getTime() < asset.capturedAt.getTime()
      ) {
        recordingByRoundAttempt.set(key, asset);
      }
    }
    const latestAttemptByRound = new Map<string, (typeof attempts)[number]>();
    for (const attempt of attempts) {
      const key = attempt.roundId.toString();
      const current = latestAttemptByRound.get(key);
      if (!current || attempt.sequence > current.sequence) {
        latestAttemptByRound.set(key, attempt);
      }
    }
    const observationsByRound = new Map<
      string,
      Array<{
        observedAt: Date;
        report: {
          status: "completed" | "insufficient_signal";
          capture: {
            camera: "captured" | "unavailable" | "insufficient_signal";
            browserVisibility:
              "captured" | "unavailable" | "insufficient_signal";
          };
          events: Array<{
            kind: "browser_window_not_visible" | "sustained_camera_away";
            source: "camera" | "browser_visibility";
            startMs: number;
            endMs: number;
          }>;
        };
      }>
    >();
    for (const observation of supplementalObservations) {
      const key = observation.roundId.toString();
      const current = observationsByRound.get(key) ?? [];
      current.push({
        observedAt: observation.observedAt,
        report: observation.report,
      });
      observationsByRound.set(key, current);
    }
    const multimodalAnalysisByRound = new Map(
      multimodalAnalyses.map((analysis) => [analysis.roundId, analysis]),
    );

    return NextResponse.json(
      {
        application: serializeApplication(detail.application, {
          candidateResumeHash: resumeHashOf(detail.candidate.resumeText),
          includeApplicantResume: true,
        }),
        candidate: serializeCandidate(detail.candidate, {
          includeResume: true,
        }),
        job: serializeJob(detail.job, { includeJd: true }),
        rounds: detail.rounds.map((round) => {
          const serialized = serializeRound(round);
          const roundId = round._id.toString();
          const result = resultByRound.get(roundId);
          const photo = photoByRound.get(roundId);
          const recording = result
            ? recordingByRoundAttempt.get(
                `${roundId}:${result.attemptId.toString()}`,
              )
            : undefined;
          const latestAttempt = latestAttemptByRound.get(roundId);
          const interviewRecording = recording
            ? {
                status: "ready" as const,
                assetId: recording._id.toString(),
                capturedAt: recording.capturedAt,
                bytes: recording.bytes,
              }
            : result?.piiPurgedAt
              ? { status: "removed" as const }
              : latestAttempt?.status === "in_progress"
                ? { status: "capturing" as const }
                : result ||
                    latestAttempt?.status === "processing" ||
                    latestAttempt?.status === "completed" ||
                    round.status === "completed"
                  ? { status: "awaiting_transfer" as const }
                  : null;
          return {
            ...serialized,
            inviteDelivery:
              inviteDeliveryByRound.get(round._id.toString()) ?? null,
            assessment: result?.projection ?? null,
            evidenceIndex: result?.evidenceIndex ?? [],
            identityPhoto: photo
              ? { assetId: photo._id.toString(), capturedAt: photo.capturedAt }
              : null,
            // Only opaque control-plane metadata is exposed here. The private
            // signed playback URL is minted separately after membership and the
            // complete media coordinate are re-validated server-side.
            interviewRecording,
            multimodalAnalysis: multimodalAnalysisByRound.get(roundId) ?? null,
            mediaPurged: Boolean(result?.piiPurgedAt),
            supplementalObservations:
              observationsByRound.get(round._id.toString()) ?? [],
          };
        }),
        // Human rounds use a separate aggregate from engine-backed `rounds`.
        // The detail serializer intentionally excludes kits, capability hashes,
        // recovery envelopes, recipient data, and provider errors.
        humanRounds: detail.humanRounds.map(serializeHumanRoundDetail),
        activity: attempts.map((attempt) => ({
          roundId: attempt.roundId.toString(),
          inProgress:
            attempt.status === "in_progress" || attempt.status === "processing",
          status: attempt.status,
        })),
      },
      {
        headers: { "Cache-Control": "private, no-store" },
      },
    );
  },
});
