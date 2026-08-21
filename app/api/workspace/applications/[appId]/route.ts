import { NextResponse } from "next/server";
import {
  HireInterviewAttempt,
  HireInterviewResult,
  HireEngineIngestionEvent,
  HireMediaAsset,
  requireMembership,
  getApplicationDetail,
  getAiInviteDeliveryViews,
} from "@hire";
import { HireMultimodalObservation } from "@modules/hire-multimodal/models/HireMultimodalObservation";
import { getHireMultimodalAnalysisViews } from "@modules/hire-multimodal/services/analysisPresenter";
import { supportsHireDisplayCapture } from "@hire-multimodal-boundary";
import type { HireMultimodalObservationReport } from "@shared/contracts/hireMultimodalObservationBridge";
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
      ingestionEvents,
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
        kind: {
          $in: ["identity_photo", "camera_recording", "screen_recording"],
        },
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
      HireEngineIngestionEvent.find({
        ...scope,
        status: "processed",
        terminalOutcome: "processed",
      })
        .select("roundId attempt revision mediaCompletion")
        .sort({ attempt: -1, revision: -1, processedAt: -1, _id: -1 })
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
        .select("roundId runtimeSessionId revision observedAt report")
        .sort({ observedAt: -1, _id: -1 })
        .lean(),
      getHireMultimodalAnalysisViews({
        workspaceId: ctx.workspace._id.toString(),
        applicationId: detail.application._id.toString(),
      }),
    ]);
    const resultByRoundAttempt = new Map(
      results.map((result) => [
        `${result.roundId.toString()}:${result.attemptId.toString()}`,
        result,
      ]),
    );
    const photoByRound = new Map<string, (typeof media)[number]>();
    const recordingByRoundAttempt = new Map<string, (typeof media)[number]>();
    const screenRecordingByRoundAttempt = new Map<
      string,
      (typeof media)[number]
    >();
    for (const asset of media) {
      if (asset.kind === "identity_photo") {
        photoByRound.set(asset.roundId.toString(), asset);
        continue;
      }
      const key = `${asset.roundId.toString()}:${asset.attemptId.toString()}`;
      const byAttempt =
        asset.kind === "camera_recording"
          ? recordingByRoundAttempt
          : asset.kind === "screen_recording"
            ? screenRecordingByRoundAttempt
            : null;
      if (!byAttempt) continue;
      const existing = byAttempt.get(key);
      if (
        !existing ||
        existing.capturedAt.getTime() < asset.capturedAt.getTime()
      ) {
        byAttempt.set(key, asset);
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
    const mediaCompletionByRound = new Map<
      string,
      {
        attempt: number;
        completion: NonNullable<
          (typeof ingestionEvents)[number]["mediaCompletion"]
        >;
      }
    >();
    for (const event of ingestionEvents) {
      const roundId = event.roundId.toString();
      if (!event.mediaCompletion || mediaCompletionByRound.has(roundId)) continue;
      mediaCompletionByRound.set(roundId, {
        attempt: event.attempt,
        completion: event.mediaCompletion,
      });
    }
    const latestObservationByRuntimeSession = new Map<
      string,
      (typeof supplementalObservations)[number]
    >();
    for (const observation of supplementalObservations) {
      // Reporter revisions are cumulative full snapshots. Only surface the
      // newest successfully bridged snapshot for a given runtime session;
      // otherwise every earlier event is repeated on the recruiter timeline.
      const sessionKey = `${observation.roundId.toString()}:${observation.runtimeSessionId.toString()}`;
      const previous = latestObservationByRuntimeSession.get(sessionKey);
      if (
        !previous ||
        observation.revision > previous.revision ||
        (observation.revision === previous.revision &&
          observation.observedAt > previous.observedAt)
      ) {
        latestObservationByRuntimeSession.set(sessionKey, observation);
      }
    }
    const observationsByRound = new Map<
      string,
      Array<{
        observedAt: Date;
        report: HireMultimodalObservationReport;
      }>
    >();
    for (const observation of Array.from(
      latestObservationByRuntimeSession.values(),
    )) {
      const key = observation.roundId.toString();
      const current = observationsByRound.get(key) ?? [];
      current.push({ observedAt: observation.observedAt, report: observation.report });
      observationsByRound.set(key, current);
    }
    for (const observations of Array.from(observationsByRound.values())) {
      observations.sort(
        (left, right) => right.observedAt.getTime() - left.observedAt.getTime(),
      );
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
          const latestAttempt = latestAttemptByRound.get(roundId);
          const attemptKey = latestAttempt
            ? `${roundId}:${latestAttempt._id.toString()}`
            : null;
          const result = attemptKey
            ? resultByRoundAttempt.get(attemptKey)
            : undefined;
          const photo = photoByRound.get(roundId);
          const recording = attemptKey
            ? recordingByRoundAttempt.get(attemptKey)
            : undefined;
          const screenRecordingAsset = attemptKey
            ? screenRecordingByRoundAttempt.get(attemptKey)
            : undefined;
          const latestMediaCompletion = mediaCompletionByRound.get(roundId);
          // A terminal status belongs to one exact engine attempt. Do not let
          // an older attempt's unavailable result end polling for a newer
          // in-progress/completed attempt on the same round.
          const mediaCompletion =
            latestAttempt &&
            latestMediaCompletion?.attempt === latestAttempt.sequence
              ? latestMediaCompletion.completion
              : undefined;
          const interviewRecording = recording
            ? {
                status: "ready" as const,
                assetId: recording._id.toString(),
                capturedAt: recording.capturedAt,
                bytes: recording.bytes,
              }
            : result?.piiPurgedAt
              ? { status: "removed" as const }
              : mediaCompletion?.camera.status === "unavailable"
                ? {
                    status: "unavailable" as const,
                    reason: mediaCompletion.camera.reason,
                  }
              : latestAttempt?.status === "in_progress"
                ? { status: "capturing" as const }
                : result ||
                    latestAttempt?.status === "processing" ||
                    latestAttempt?.status === "completed" ||
                    round.status === "completed"
                  ? { status: "awaiting_transfer" as const }
                  : null;
          const expectsScreenRecording = supportsHireDisplayCapture(
            round.consentVersion,
          );
          const screenRecording = screenRecordingAsset
            ? {
                status: "ready" as const,
                assetId: screenRecordingAsset._id.toString(),
                capturedAt: screenRecordingAsset.capturedAt,
                bytes: screenRecordingAsset.bytes,
              }
            : !expectsScreenRecording
              ? null
              : result?.piiPurgedAt
                ? { status: "removed" as const }
                : mediaCompletion?.screen.status === "unavailable"
                  ? {
                      status: "unavailable" as const,
                      reason: mediaCompletion.screen.reason,
                    }
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
            screenRecording,
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
