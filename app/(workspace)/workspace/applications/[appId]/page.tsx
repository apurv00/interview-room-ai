"use client";

/**
 * Candidate card — decision-first (build plan §Dashboard & screens #4).
 * The header leads with human-review readiness and keeps AI output explicitly
 * labelled as supporting evidence. Dimension bars and a per-question
 * breakdown link every number to the answer that produced it. All round/stage
 * actions live here: send AI interview, revoke link, advance / reject. Loading
 * this page triggers server-side reconciliation, so fresh AI results appear
 * the moment the member looks.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import Badge from "@shared/ui/Badge";
import Button from "@shared/ui/Button";
import Accordion from "@shared/ui/Accordion";
import { ScoreBar, scoreBand } from "@shared/ui/ScoreBar";
import StateView from "@shared/ui/StateView";
import HireEvidenceAssessment from "@hire/components/HireEvidenceAssessment";
import HireSupplementalObservationsPanel, {
  type HireObservationRecordingRequest,
  type HireSupplementalObservationView,
} from "./HireSupplementalObservationsPanel";
import HireInterviewRecordingPanel, {
  type HireRecordingPlaybackRequest,
  type HireInterviewRecordingView,
} from "./HireInterviewRecordingPanel";
import HireScreenRecordingPanel, {
  type HireScreenRecordingView,
} from "./HireScreenRecordingPanel";
import HireMultimodalAnalysisPanel, {
  type HireMultimodalAnalysisView,
} from "./HireMultimodalAnalysisPanel";
import HumanRoundsPanel, { type HumanRoundView } from "./HumanRoundsPanel";
import CandidateStatusLinksPanel from "./CandidateStatusLinksPanel";
import SharePacketsPanel from "./SharePacketsPanel";
import AssessmentExportsPanel from "./AssessmentExportsPanel";
import { buildHireRecordingCaptions } from "./recordingCaptions";

// Canonical 75/55 bands (shared/ui/ScoreBar) — a 72 must never be green here
// while amber in the adjacent ScoreBar (Codex on #603, same class as #498).
function scoreBadgeVariant(score: number): "success" | "caution" | "danger" {
  const band = scoreBand(score);
  return band === "strong" ? "success" : band === "ok" ? "caution" : "danger";
}

function safeJobReturnHref(value: string | null, jobId: string): string {
  const base = `/workspace/jobs/${encodeURIComponent(jobId)}`;
  const fallback = `${base}/candidates`;
  if (!value || value.length > 4096 || value.includes("#")) return fallback;
  const path = value.split("?", 1)[0];
  return new Set([
    base,
    `${base}/candidates`,
    `${base}/screening`,
    `${base}/decision`,
    `${base}/performance`,
  ]).has(path) ? value : fallback;
}

interface PerQuestion {
  questionIndex: number;
  question: string;
  answer?: string;
  answerSummary?: string;
  score: number | null;
  relevance?: number | null;
  structure?: number | null;
  specificity?: number | null;
  ownership?: number | null;
  jdAlignment?: number | null;
  flags?: string[];
  evaluationFailed?: boolean;
}

interface RoundResults {
  overallScore: number | null;
  passProbability?: string;
  confidenceLevel?: string;
  answerQualityScore?: number | null;
  communicationScore?: number | null;
  jdMatchScore?: number | null;
  redFlags?: string[];
  topImprovements?: string[];
  answeredCount?: number | null;
  plannedQuestionCount?: number | null;
  endReason?: string | null;
  perQuestion?: PerQuestion[];
  pending?: boolean;
  unscored?: boolean;
  completedAfterRevoke?: boolean;
}

interface Round {
  id: string;
  status: string;
  invitedAt: string;
  inviteExpiresAt: string;
  consentAt: string | null;
  linkedAt: string | null;
  revokedAt: string | null;
  config: { role: string; experience: string; duration: number };
  attemptCount: number | null;
  results: RoundResults | null;
  assessment: {
    overallScore: number | null;
    overallEvidenceIds: string[];
    recommendation?: string;
    confidence?: string;
    dimensions: Array<{
      key: string;
      label: string;
      score: number | null;
      evidenceIds: string[];
    }>;
    findings: Array<{
      kind: "strength" | "gap";
      text: string;
      evidenceIds: string[];
    }>;
    questions: Array<{
      questionId: string;
      index: number;
      prompt: string;
      answer?: string;
      score: number | null;
      evidenceIds: string[];
      questionStartedMs?: number;
      answerStartedMs?: number;
      answerEndedMs?: number;
    }>;
  } | null;
  evidenceIndex: Array<{
    id: string;
    type:
      | "transcript_span"
      | "recording_range"
      | "integrity_observation"
      | "identity_photo";
    questionId?: string;
    startMs?: number;
    endMs?: number;
    mediaAssetId?: string;
    transcriptExcerpt?: string;
  }>;
  identityPhoto: { assetId: string; capturedAt: string } | null;
  interviewRecording: HireInterviewRecordingView | null;
  screenRecording: HireScreenRecordingView | null;
  multimodalAnalysis?: HireMultimodalAnalysisView | null;
  mediaPurged: boolean;
  supplementalObservations?: HireSupplementalObservationView[];
  inviteDelivery: {
    status: "pending" | "sending" | "sent" | "failed";
    attempts: number;
    expiresAt: string;
    sentAt: string | null;
    lastError: string | null;
    inviteUrl: string | null;
    recoverable: boolean;
  } | null;
}

type Stage =
  | "new"
  | "screened"
  | "interviewing"
  | "shortlist"
  | "offer"
  | "hired"
  | "rejected"
  | "withdrawn";
type StageAction =
  "advance" | "reject" | "withdraw" | "offer_accepted" | "offer_declined";
type StageReasonCode =
  | "requirements_mismatch"
  | "position_closed"
  | "duplicate_application"
  | "candidate_withdrew"
  | "role_filled";

const REJECT_REASONS: Array<{ value: StageReasonCode; label: string }> = [
  { value: "requirements_mismatch", label: "Requirements mismatch" },
  { value: "position_closed", label: "Position closed" },
  { value: "duplicate_application", label: "Duplicate application" },
  { value: "role_filled", label: "Role filled" },
];
const WITHDRAWAL_REASON = [{ value: "candidate_withdrew" as const, label: "Candidate withdrew" }];

interface CardData {
  application: {
    id: string;
    jobId: string;
    stage: Stage;
    decisionNote: string | null;
    offerDecision: {
      outcome: "accepted" | "declined";
      actorName: string;
      note: string | null;
      at: string;
    } | null;
    resumeMatch?: {
      score: number | null;
      strengths: string[];
      gaps: string[];
      scoredAt: string;
      stale: boolean;
    } | null;
    /** Append-only public apply-page submissions, newest first. */
    applicantSubmissions?: Array<{
      text: string;
      fileName: string | null;
      submittedAt: string;
      score: number | null;
    }>;
    events: Array<{
      type: string;
      from: string | null;
      to: string | null;
      actorName: string;
      note: string | null;
      at: string;
    }>;
  };
  candidate: {
    id: string;
    name: string;
    email: string;
    phone: string | null;
    /** Workspace pool résumé — what a FIRST-TIME applicant's CV lands in. */
    resumeText?: string | null;
    resumeFileName?: string | null;
  };
  job: { id: string; title: string; status: string };
  rounds: Round[];
  /** Human evidence has its own aggregate; never coerce it into an AI round. */
  humanRounds?: HumanRoundView[];
  activity: Array<{ roundId: string; inProgress: boolean }>;
}

const TERMINAL: readonly Stage[] = ["hired", "rejected", "withdrawn"];
const ACTIVE_INTERVIEW_REFRESH_MS = 15_000;

export default function ApplicationCardPage({
  params,
  searchParams,
}: {
  params: { appId: string };
  searchParams?: { returnTo?: string | string[] };
}) {
  const [data, setData] = useState<CardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showSend, setShowSend] = useState(false);
  const [experience, setExperience] = useState<"0-2" | "3-6" | "7+">("3-6");
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [emailSent, setEmailSent] = useState(true);
  const [inviteCopied, setInviteCopied] = useState(false);
  const [deliveryCopiedFor, setDeliveryCopiedFor] = useState<string | null>(
    null,
  );
  const [needNote, setNeedNote] = useState<{
    expectedFrom: Stage;
    action: "offer_accepted";
  } | null>(null);
  const [note, setNote] = useState("");
  const [needReason, setNeedReason] = useState<{
    expectedFrom: Stage;
    action: "reject" | "withdraw" | "offer_declined";
  } | null>(null);
  const [reasonCode, setReasonCode] = useState<StageReasonCode | "">("");
  const [stageCommand, setStageCommand] = useState<{
    expectedFrom: Stage;
    action: StageAction;
    operationId: string;
  } | null>(null);
  const stageConfirmationTriggerRef = useRef<HTMLButtonElement | null>(null);
  const stageConfirmationFallbackRef = useRef<HTMLHeadingElement | null>(null);
  const [recordingReview, setRecordingReview] = useState<{
    roundId: string;
    kind: HireObservationRecordingRequest["kind"];
    request: HireRecordingPlaybackRequest;
  } | null>(null);

  const reviewRecordingAt = useCallback(
    (roundId: string, request: HireObservationRecordingRequest) => {
      setRecordingReview((current) => ({
        roundId,
        kind: request.kind,
        request: {
          id: (current?.request.id ?? 0) + 1,
          startMs: request.startMs,
        },
      }));
    },
    [],
  );

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch(`/api/workspace/applications/${params.appId}`);
      const body = await res.json();
      if (!res.ok) throw new Error(body.error);
      setData(body);
    } catch {
      setError("Could not load this candidate.");
    }
  }, [params.appId]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Runtime result/media publication is asynchronous. Keep this HR-facing
   * card current while an attempt is live or its detached camera upload is
   * still transferring. The detail endpoint is private and no-store, so this
   * always retrieves the latest linked evidence and recording state.
   */
  const hasActiveInterview =
    data?.activity.some((activity) => activity.inProgress) ?? false;
  const hasPendingRecording =
    data?.rounds.some((round) => {
      const cameraStatus = round.interviewRecording?.status;
      const screenStatus = round.screenRecording?.status;
      return (
        cameraStatus === "capturing" ||
        cameraStatus === "awaiting_transfer" ||
        screenStatus === "capturing" ||
        screenStatus === "awaiting_transfer"
      );
    }) ?? false;
  const hasPendingMultimodalAnalysis =
    data?.rounds.some((round) => {
      const status = round.multimodalAnalysis?.status;
      return status === "pending" || status === "processing";
    }) ?? false;
  useEffect(() => {
    if (
      !hasActiveInterview &&
      !hasPendingRecording &&
      !hasPendingMultimodalAnalysis
    )
      return;

    const interval = window.setInterval(() => {
      void load();
    }, ACTIVE_INTERVIEW_REFRESH_MS);
    return () => window.clearInterval(interval);
  }, [
    hasActiveInterview,
    hasPendingRecording,
    hasPendingMultimodalAnalysis,
    load,
  ]);

  async function sendAiInterview(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setActionError(null);
    try {
      const res = await fetch(
        `/api/workspace/applications/${params.appId}/rounds`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ experience, duration: 15 }),
        },
      );
      const body = await res.json();
      if (!res.ok) {
        setActionError(body.error || "Could not send the AI interview.");
        return;
      }
      setInviteUrl(body.inviteUrl);
      setInviteCopied(false);
      setEmailSent(body.emailSent);
      setShowSend(false);
      await load();
    } catch {
      setActionError("Something went wrong. Check your connection.");
    } finally {
      setBusy(false);
    }
  }

  async function copyInviteLink() {
    if (!inviteUrl) return;
    try {
      await navigator.clipboard.writeText(inviteUrl);
      setInviteCopied(true);
    } catch {
      setActionError(
        "Clipboard access was blocked. Select and copy the link below.",
      );
    }
  }

  async function copyRecoveredInvite(roundId: string, url: string) {
    try {
      await navigator.clipboard.writeText(url);
      setDeliveryCopiedFor(roundId);
    } catch {
      setActionError(
        "Clipboard access was blocked. Select and copy the link below.",
      );
    }
  }

  async function retryInviteDelivery(roundId: string) {
    setBusy(true);
    setActionError(null);
    try {
      const res = await fetch(
        `/api/workspace/rounds/${roundId}/invite-delivery`,
        {
          method: "POST",
        },
      );
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setActionError(body.error || "Could not retry the invitation email.");
        return;
      }
      setInviteUrl(body.delivery?.inviteUrl ?? null);
      setEmailSent(body.emailSent === true);
      await load();
    } catch {
      setActionError("Something went wrong. Check your connection.");
    } finally {
      setBusy(false);
    }
  }

  async function revoke(roundId: string) {
    setBusy(true);
    setActionError(null);
    try {
      const res = await fetch(`/api/workspace/rounds/${roundId}/revoke`, {
        method: "POST",
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setActionError(body.error || "Could not revoke the link.");
        return;
      }
      setInviteUrl(null);
      await load();
    } catch {
      setActionError("Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  async function moveStage(
    expectedFrom: Stage,
    action: StageAction,
    moveNote?: string,
    moveReason?: StageReasonCode,
  ) {
    if (action === "offer_accepted" && !moveNote) {
      setNeedReason(null);
      setNeedNote({ expectedFrom, action });
      return;
    }
    if ((action === "reject" || action === "withdraw" || action === "offer_declined") && !moveReason) {
      setNeedNote(null);
      setNeedReason({ expectedFrom, action });
      setReasonCode(action === "reject" ? "requirements_mismatch" : "candidate_withdrew");
      return;
    }
    setBusy(true);
    setActionError(null);
    try {
      const operationId =
        stageCommand?.expectedFrom === expectedFrom &&
        stageCommand.action === action
          ? stageCommand.operationId
          : crypto.randomUUID();
      setStageCommand({ expectedFrom, action, operationId });
      const res = await fetch(
        `/api/workspace/applications/${params.appId}/stage`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action,
            expectedFrom,
            operationId,
            ...(moveNote ? { note: moveNote } : {}),
            ...(moveReason ? { reasonCode: moveReason } : {}),
          }),
        },
      );
      const body = await res.json();
      if (!res.ok) {
        if (body.code === "DECISION_NOTE_REQUIRED") {
          setNeedNote({ expectedFrom, action: "offer_accepted" });
          return;
        }
        setActionError(body.error || "Could not move the candidate.");
        return;
      }
      setNeedNote(null);
      setNeedReason(null);
      setNote("");
      setReasonCode("");
      setStageCommand(null);
      await load();
      restoreStageConfirmationFocus();
    } catch {
      setActionError("Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  function restoreStageConfirmationFocus() {
    const trigger = stageConfirmationTriggerRef.current;
    stageConfirmationTriggerRef.current = null;
    window.requestAnimationFrame(() => {
      const target = trigger?.isConnected
        ? trigger
        : stageConfirmationFallbackRef.current;
      target?.focus();
    });
  }

  function cancelStageReasonConfirmation() {
    setNeedReason(null);
    setReasonCode("");
    restoreStageConfirmationFocus();
  }

  function cancelOfferConfirmation() {
    setNeedNote(null);
    setNote("");
    restoreStageConfirmationFocus();
  }

  if (error) return <StateView state="error" error={error} onRetry={load} />;
  if (!data) return <StateView state="loading" skeletonLayout="card" />;

  const {
    application,
    candidate,
    job,
    rounds,
    activity,
    humanRounds = [],
  } = data;
  const requestedReturnTo = typeof searchParams?.returnTo === "string"
    ? searchParams.returnTo
    : null;
  const returnHref = safeJobReturnHref(requestedReturnTo, job.id);
  const returnsToCandidates = returnHref.split("?", 1)[0].endsWith("/candidates");
  const latest = rounds[0] ?? null;
  const results = latest?.results ?? null;
  const inProgress = activity.some((a) => a.inProgress);
  const terminal = TERMINAL.includes(application.stage);
  const submittedHumanScorecards = humanRounds.filter(
    (round) => round.status === "completed",
  ).length;
  const pendingHumanScorecards = humanRounds.filter(
    (round) => round.status === "pending_scorecard",
  ).length;
  const revokedHumanReviews = humanRounds.filter(
    (round) => round.status === "revoked",
  ).length;
  const humanReviewSummary =
    submittedHumanScorecards > 0
      ? `${submittedHumanScorecards} human scorecard${submittedHumanScorecards === 1 ? "" : "s"} submitted${pendingHumanScorecards > 0 ? ` · ${pendingHumanScorecards} pending` : ""}`
      : pendingHumanScorecards > 0
        ? `Waiting for ${pendingHumanScorecards} human scorecard${pendingHumanScorecards === 1 ? "" : "s"}`
        : revokedHumanReviews > 0
          ? `${revokedHumanReviews} requested human review${revokedHumanReviews === 1 ? " was" : "s were"} revoked`
          : "No human scorecards requested";
  const aiEvidenceSummary = results?.pending
    ? "Assessment report pending"
    : results?.unscored
      ? "Assessment completed without a score"
      : results?.overallScore != null
        ? `Assessment score: ${results.overallScore} / 100${results.confidenceLevel ? ` · Confidence: ${results.confidenceLevel}` : ""}`
        : "No completed AI assessment";
  const liveRound =
    latest && !latest.revokedAt && latest.status !== "completed"
      ? latest
      : null;

  return (
    <div className="space-y-6">
      {/* Decision-first header */}
      <div className="bg-white border border-[#e1e8ed] rounded-2xl p-6">
        <Link
          href={returnHref}
          className="text-xs text-[#71767b] hover:text-indigo-600"
        >
          ← Back to {job.title}{returnsToCandidates ? " candidates" : " workspace"}
        </Link>
        <div className="mt-1 flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
          <div className="min-w-0 w-full xl:flex-1">
            <h1
              ref={stageConfirmationFallbackRef}
              tabIndex={-1}
              className="break-words text-xl font-bold text-[#0f1419]"
            >
              {candidate.name}
            </h1>
            <p className="break-words text-sm text-[#536471]">
              {candidate.email}
              {candidate.phone ? ` · ${candidate.phone}` : ""}
            </p>
            <div className="flex items-center gap-2 mt-2 flex-wrap">
              <Badge variant="primary">{application.stage}</Badge>
              {inProgress && (
                <Badge variant="primary">Interview in progress</Badge>
              )}
            </div>
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              <section
                aria-labelledby="human-review-readiness-heading"
                className="rounded-xl border border-[#e1e8ed] bg-[#f8fafc] px-3 py-2"
              >
                <h2
                  id="human-review-readiness-heading"
                  className="text-xs font-semibold text-[#536471]"
                >
                  Human review readiness
                </h2>
                <p className="mt-1 text-sm font-medium text-[#0f1419]">
                  {humanReviewSummary}
                </p>
              </section>
              <section
                aria-labelledby="ai-evidence-summary-heading"
                className="rounded-xl border border-[#e1e8ed] bg-[#f8fafc] px-3 py-2"
              >
                <h2
                  id="ai-evidence-summary-heading"
                  className="text-xs font-semibold text-[#536471]"
                >
                  AI evidence
                </h2>
                <p className="mt-1 text-sm font-medium text-[#0f1419]">
                  {aiEvidenceSummary}
                </p>
                <p className="mt-1 text-xs text-[#71767b]">
                  Supporting evidence only; a human makes the hiring decision.
                </p>
              </section>
            </div>
          </div>
          {!terminal && job.status === "open" && (
            <div
              role="group"
              aria-label="Candidate actions"
              className="flex w-full flex-wrap gap-2 xl:w-auto xl:shrink-0 xl:justify-end"
            >
              {/* Visible whenever no round is live — a follow-up AI round
                  after a completed one is a supported flow. */}
              {!liveRound && (
                <Button onClick={() => setShowSend((v) => !v)}>
                  {showSend ? "Cancel" : "Send AI interview"}
                </Button>
              )}
              {application.stage === "offer" ? (
                <>
                  <Button
                    variant="secondary"
                    disabled={busy}
                    onClick={(event) => {
                      stageConfirmationTriggerRef.current = event.currentTarget;
                      setNeedNote({
                        expectedFrom: application.stage,
                        action: "offer_accepted",
                      });
                    }}
                  >
                    Offer accepted
                  </Button>
                  <Button
                    variant="secondary"
                    disabled={busy}
                    onClick={(event) => {
                      stageConfirmationTriggerRef.current = event.currentTarget;
                      void moveStage(application.stage, "offer_declined");
                    }}
                  >
                    Offer declined
                  </Button>
                </>
              ) : (
                <Button
                  variant="secondary"
                  disabled={busy}
                  onClick={() => void moveStage(application.stage, "advance")}
                >
                  Advance
                </Button>
              )}
              {application.stage !== "offer" && (
                <Button
                  variant="secondary"
                  disabled={busy}
                  onClick={(event) => {
                    stageConfirmationTriggerRef.current = event.currentTarget;
                    void moveStage(application.stage, "reject");
                  }}
                >
                  Reject
                </Button>
              )}
              <Button
                variant="secondary"
                disabled={busy}
                onClick={(event) => {
                  stageConfirmationTriggerRef.current = event.currentTarget;
                  void moveStage(application.stage, "withdraw");
                }}
              >
                Withdraw
              </Button>
            </div>
          )}
        </div>
        {application.decisionNote && (
          <p className="mt-3 text-sm text-emerald-700">
            Decision: {application.decisionNote}
          </p>
        )}
        {application.offerDecision && (
          <p className="mt-2 text-xs text-[#536471]">
            Offer {application.offerDecision.outcome} · recorded by{" "}
            {application.offerDecision.actorName} ·{" "}
            {new Date(application.offerDecision.at).toLocaleString()}
          </p>
        )}
        {actionError && (
          <p className="mt-3 text-sm text-[#f4212e]">{actionError}</p>
        )}
        {needReason && (
          <section aria-labelledby="stage-decision-heading" className="mt-3 space-y-3 rounded-xl border border-[#e1e8ed] p-3">
            <div>
              <h2 id="stage-decision-heading" className="text-sm font-semibold">Confirm candidate decision</h2>
              <p className="mt-1 text-xs text-[#536471]">
                {needReason.action === "withdraw"
                  ? "The candidate will move to Withdrawn."
                  : "The candidate will move to Rejected."}
              </p>
            </div>
            <label htmlFor="stage-decision-reason" className="block text-xs text-[#536471]">Structured reason</label>
            <select
              id="stage-decision-reason"
              autoFocus
              value={reasonCode}
              onChange={(event) => setReasonCode(event.target.value as StageReasonCode)}
              className="w-full rounded-xl border border-[#e1e8ed] bg-[#f8fafc] px-3 py-2 text-sm"
            >
              {(needReason.action === "reject" ? REJECT_REASONS : WITHDRAWAL_REASON).map((reason) => (
                <option key={reason.value} value={reason.value}>{reason.label}</option>
              ))}
            </select>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="danger" disabled={busy || !reasonCode}
                onClick={() => void moveStage(needReason.expectedFrom, needReason.action, undefined, reasonCode || undefined)}>
                Confirm decision
              </Button>
              <Button size="sm" variant="secondary" onClick={cancelStageReasonConfirmation}>
                Cancel
              </Button>
            </div>
          </section>
        )}
        {needNote && (
          <div className="mt-3 space-y-2">
            <label
              htmlFor="offer-decision-note"
              className="text-xs text-[#536471]"
            >
              Record why the candidate accepted the offer and should be hired.
            </label>
            <textarea
              id="offer-decision-note"
              autoFocus
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={2}
              maxLength={4000}
              className="w-full px-3 py-2 border border-[#e1e8ed] rounded-xl bg-[#f8fafc] text-sm"
              placeholder="Why this candidate?"
            />
            <div className="flex gap-2">
              <Button
                size="sm"
                disabled={busy || note.trim().length === 0}
                onClick={() =>
                  void moveStage(
                    needNote.expectedFrom,
                    needNote.action,
                    note.trim(),
                  )
                }
              >
                Confirm hire
              </Button>
              <Button
                size="sm"
                variant="secondary"
                onClick={cancelOfferConfirmation}
              >
                Cancel
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* Resume-vs-JD match from intake (Phase 2) — evidence, not verdict */}
      {application.resumeMatch && (
        <div className="bg-white border border-[#e1e8ed] rounded-2xl p-5 space-y-3">
          <div className="flex items-center gap-2">
            <p className="text-sm font-semibold text-[#0f1419]">Résumé match</p>
            {application.resumeMatch.score != null ? (
              <Badge
                variant={scoreBadgeVariant(application.resumeMatch.score)}
                dot
              >
                {application.resumeMatch.score} / 100
              </Badge>
            ) : (
              <Badge>unscored</Badge>
            )}
            {application.resumeMatch.stale && (
              <Badge variant="caution">
                outdated — résumé replaced since scoring
              </Badge>
            )}
          </div>
          {application.resumeMatch.score != null && (
            <ScoreBar
              label="JD match (résumé)"
              score={application.resumeMatch.score}
            />
          )}
          <div className="grid md:grid-cols-2 gap-4 text-sm">
            {application.resumeMatch.strengths.length > 0 && (
              <div>
                <p className="text-xs font-medium text-[#536471] mb-1">
                  Evidence for
                </p>
                <ul className="space-y-1 text-[#0f1419]">
                  {application.resumeMatch.strengths.map((s, i) => (
                    <li key={i}>· {s}</li>
                  ))}
                </ul>
              </div>
            )}
            {application.resumeMatch.gaps.length > 0 && (
              <div>
                <p className="text-xs font-medium text-[#536471] mb-1">
                  No evidence of
                </p>
                <ul className="space-y-1 text-[#0f1419]">
                  {application.resumeMatch.gaps.map((g, i) => (
                    <li key={i}>· {g}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Résumé submitted through the public apply page. Shown whenever it
          exists, because it — not the pool résumé — is what the JD-match
          score above was computed from. */}
      {/* EVERY résumé on file, never one instead of another. The pool copy
          (a first-time applicant's, or a bulk upload's) and each public
          submission are shown together: rendering only the submissions let
          an anonymous caller hide the original simply by appending one of
          their own (Codex P1 on #615). Divergence is called out, because
          two different documents for one person is itself the signal. */}
      {(Boolean(candidate.resumeText) ||
        (application.applicantSubmissions?.length ?? 0) > 0) && (
        <div className="bg-white border border-[#e1e8ed] rounded-2xl p-5 space-y-3">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="text-sm font-semibold text-[#0f1419]">
              Résumés on file
            </p>
            {(application.applicantSubmissions?.length ?? 0) > 0 &&
              candidate.resumeText && (
                <Badge variant="caution">
                  {application.applicantSubmissions!.length} submitted via apply
                  page
                </Badge>
              )}
          </div>

          {(application.applicantSubmissions?.length ?? 0) +
            (candidate.resumeText ? 1 : 0) >
            1 && (
            <p className="text-xs text-[#f4212e]">
              More than one résumé exists for this candidate. Anyone with the
              public link can add a document, so review each before deciding —
              the newest is not automatically the authentic one, and nothing
              here has replaced anything.
            </p>
          )}

          {candidate.resumeText && (
            <details className="text-sm border border-[#e1e8ed] rounded-xl p-3">
              <summary className="cursor-pointer text-xs text-[#536471]">
                {candidate.resumeFileName ?? "On file"} · on the candidate
                record
              </summary>
              <pre className="mt-2 whitespace-pre-wrap text-xs text-[#0f1419] max-h-80 overflow-y-auto bg-[#f8fafc] border border-[#e1e8ed] rounded-xl p-3">
                {candidate.resumeText}
              </pre>
            </details>
          )}

          {application.applicantSubmissions?.map((sub, i) => (
            <details
              key={i}
              className="text-sm border border-[#e1e8ed] rounded-xl p-3"
            >
              <summary className="cursor-pointer text-xs text-[#536471]">
                {sub.fileName ?? "Attached file"} · submitted{" "}
                {new Date(sub.submittedAt).toLocaleString()}
                {sub.score != null ? ` · JD match ${sub.score}` : " · unscored"}
                {i === 0 ? " · newest" : ""}
                {i === application.applicantSubmissions!.length - 1 &&
                application.applicantSubmissions!.length > 1
                  ? " · first received"
                  : ""}
              </summary>
              <pre className="mt-2 whitespace-pre-wrap text-xs text-[#0f1419] max-h-80 overflow-y-auto bg-[#f8fafc] border border-[#e1e8ed] rounded-xl p-3">
                {sub.text}
              </pre>
            </details>
          ))}
        </div>
      )}

      {/* Send AI interview */}
      {showSend && (
        <form
          onSubmit={sendAiInterview}
          className="bg-white border border-[#e1e8ed] rounded-2xl p-5 space-y-3"
        >
          <p className="text-sm font-medium text-[#0f1419]">
            Send a 15-minute AI screening interview for “{job.title}” to{" "}
            {candidate.email}.
          </p>
          <div className="space-y-1.5">
            <label
              htmlFor="hire-candidate-experience"
              className="text-sm text-[#536471] block"
            >
              Candidate&apos;s experience level
            </label>
            <select
              id="hire-candidate-experience"
              value={experience}
              onChange={(e) =>
                setExperience(e.target.value as typeof experience)
              }
              className="px-3 py-2 border border-[#e1e8ed] rounded-xl bg-[#f8fafc] text-sm"
            >
              <option value="0-2">0–2 years</option>
              <option value="3-6">3–6 years</option>
              <option value="7+">7+ years</option>
            </select>
          </div>
          <p className="text-xs text-[#71767b]">
            The candidate sees a recording + AI-analysis disclosure and must
            consent before anything starts. The link expires in 7 days and can
            be revoked.
          </p>
          <Button type="submit" disabled={busy}>
            {busy ? "Sending…" : "Send invite"}
          </Button>
        </form>
      )}

      {inviteUrl && (
        <div className="bg-indigo-50 border border-indigo-200 rounded-2xl p-4 text-sm space-y-3">
          <p className="text-indigo-900 font-medium">
            {emailSent
              ? "Invite emailed."
              : "Email delivery unavailable — share this link directly:"}
          </p>
          <code className="block text-xs break-all text-indigo-800">
            {inviteUrl}
          </code>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => void copyInviteLink()}
          >
            {inviteCopied ? "Copied" : "Copy interview link"}
          </Button>
        </div>
      )}

      <HumanRoundsPanel
        applicationId={application.id}
        humanRounds={humanRounds}
        jobIsOpen={job.status === "open"}
        terminal={terminal}
        onChanged={load}
      />

      <CandidateStatusLinksPanel applicationId={application.id} />

      <SharePacketsPanel
        applicationId={application.id}
        jobIsOpen={job.status === "open"}
        terminal={terminal}
      />

      <AssessmentExportsPanel
        applicationId={application.id}
        jobIsOpen={job.status === "open"}
        terminal={terminal}
      />

      {/* Rounds + evidence */}
      {rounds.map((round) => (
        <div
          key={round.id}
          className="bg-white border border-[#e1e8ed] rounded-2xl p-6 space-y-4"
        >
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div>
              <h2 className="text-sm font-semibold text-[#0f1419]">
                AI interview · {round.config.duration} min ·{" "}
                {round.config.experience} yrs
              </h2>
              <p className="text-xs text-[#71767b]">
                Sent {new Date(round.invitedAt).toLocaleString()}
                {round.consentAt && " · consent recorded"}
                {round.linkedAt &&
                  ` · completed ${new Date(round.linkedAt).toLocaleString()}`}
                {round.revokedAt && " · revoked"}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Badge
                variant={
                  round.status === "completed"
                    ? "success"
                    : round.revokedAt
                      ? "default"
                      : "primary"
                }
              >
                {round.revokedAt ? "revoked" : round.status.replace("_", " ")}
              </Badge>
              {!round.revokedAt && round.status !== "completed" && (
                <div className="text-right">
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={busy}
                    onClick={() => void revoke(round.id)}
                  >
                    Revoke link
                  </Button>
                  <p className="mt-1 max-w-56 text-[11px] text-[#71767b]">
                    The recovery link below remains available to signed-in
                    members until expiry.
                  </p>
                </div>
              )}
            </div>
          </div>

          {round.inviteDelivery?.recoverable &&
            round.inviteDelivery.inviteUrl && (
              <div className="rounded-xl border border-indigo-200 bg-indigo-50 p-3 text-sm space-y-2">
                <p className="font-medium text-indigo-900">
                  {round.inviteDelivery.status === "sent"
                    ? "Invitation email sent · recovery link available"
                    : round.inviteDelivery.status === "failed"
                      ? "Invitation email failed · copy the link or retry"
                      : "Invitation is saved · copy the link or retry delivery"}
                </p>
                <code className="block break-all text-xs text-indigo-800">
                  {round.inviteDelivery.inviteUrl}
                </code>
                {round.inviteDelivery.lastError && (
                  <p className="text-xs text-red-700">
                    {round.inviteDelivery.lastError}
                  </p>
                )}
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() =>
                      void copyRecoveredInvite(
                        round.id,
                        round.inviteDelivery!.inviteUrl!,
                      )
                    }
                  >
                    {deliveryCopiedFor === round.id
                      ? "Copied"
                      : "Copy interview link"}
                  </Button>
                  {round.inviteDelivery.status !== "sent" && (
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={busy}
                      onClick={() => void retryInviteDelivery(round.id)}
                    >
                      {busy ? "Retrying…" : "Retry invitation email"}
                    </Button>
                  )}
                </div>
              </div>
            )}

          {round.results?.pending && (
            <p className="text-sm text-amber-600">
              Interview finished — the full report is still being generated.
              Per-answer scores below are already final.
            </p>
          )}

          {round.results?.unscored && (
            <p className="text-sm text-amber-600">
              The AI declined to score this interview — the candidate
              didn&apos;t answer enough questions. Details are in the flags
              below; per-answer scores (if any) are shown for the answers that
              were given.
            </p>
          )}

          {round.results?.completedAfterRevoke && (
            <p className="text-sm text-red-600">
              This interview was completed{" "}
              <strong>after the link was revoked</strong> — the candidate had
              already started when the link was killed. Results are attached for
              completeness; treat them at your discretion.
            </p>
          )}

          {(round.attemptCount ?? 0) > 1 && (
            <p className="text-sm text-amber-600">
              The candidate started this interview {round.attemptCount} times —
              the scores below are from the first completed run.
            </p>
          )}

          <div
            id={`interview-recording-${round.id}`}
            tabIndex={-1}
            className="grid gap-4 lg:grid-cols-2"
          >
            <HireInterviewRecordingPanel
              applicationId={application.id}
              recording={round.interviewRecording}
              playbackRequest={
                recordingReview?.roundId === round.id &&
                recordingReview.kind === "camera"
                  ? recordingReview.request
                  : undefined
              }
              captions={buildHireRecordingCaptions(
                round.assessment?.questions ?? [],
              )}
            />
            <HireScreenRecordingPanel
              applicationId={application.id}
              recording={round.screenRecording}
              playbackRequest={
                recordingReview?.roundId === round.id &&
                recordingReview.kind === "screen"
                  ? recordingReview.request
                  : undefined
              }
            />
          </div>

          <HireMultimodalAnalysisPanel
            analysis={round.multimodalAnalysis ?? null}
            applicationId={application.id}
            onChanged={load}
          />

          {round.assessment && (
            <HireEvidenceAssessment
              applicationId={application.id}
              assessment={round.assessment}
              evidenceIndex={round.evidenceIndex}
              identityPhoto={round.identityPhoto}
              mediaPurged={round.mediaPurged}
            />
          )}

          <HireSupplementalObservationsPanel
            observations={round.supplementalObservations ?? []}
            recordingAvailability={{
              camera: round.interviewRecording?.status === "ready",
              screen: round.screenRecording?.status === "ready",
            }}
            onReviewRecording={(request) =>
              reviewRecordingAt(round.id, request)
            }
          />

          {!round.assessment && round.results && (
            <>
              <div className="grid md:grid-cols-3 gap-4">
                {/* Never paint a missing score as a red 0 — while the report
                    is pending the "report pending" note above is the truth. */}
                {round.results.overallScore != null && (
                  <ScoreBar
                    label="Overall"
                    score={round.results.overallScore}
                  />
                )}
                {round.results.answerQualityScore != null && (
                  <ScoreBar
                    label="Answer quality"
                    score={round.results.answerQualityScore}
                  />
                )}
                {round.results.jdMatchScore != null && (
                  <ScoreBar
                    label="JD match"
                    score={round.results.jdMatchScore}
                  />
                )}
              </div>
              {(round.results.answeredCount != null ||
                round.results.endReason) && (
                <p className="text-xs text-[#71767b]">
                  {round.results.answeredCount != null &&
                    `Answered ${round.results.answeredCount}${round.results.plannedQuestionCount ? ` of ${round.results.plannedQuestionCount} planned` : ""} questions`}
                  {round.results.endReason &&
                    ` · ended: ${round.results.endReason}`}
                </p>
              )}
              {round.results.redFlags && round.results.redFlags.length > 0 && (
                <div className="flex items-center gap-2 flex-wrap">
                  {round.results.redFlags.map((flag, i) => (
                    <Badge key={i} variant="danger">
                      {flag}
                    </Badge>
                  ))}
                </div>
              )}
              {round.results.perQuestion &&
                round.results.perQuestion.length > 0 && (
                  <Accordion
                    mode="multi"
                    items={round.results.perQuestion.map((q) => ({
                      title: `Q${q.questionIndex + 1} · ${q.score != null ? `${q.score}` : "—"} · ${q.question.slice(0, 80)}${q.question.length > 80 ? "…" : ""}`,
                      content: (
                        <div className="space-y-3 text-sm">
                          <p className="text-[#0f1419] font-medium">
                            {q.question}
                          </p>
                          {q.answer && (
                            <blockquote className="border-l-2 border-[#e1e8ed] pl-3 text-[#536471] whitespace-pre-wrap">
                              {q.answer}
                            </blockquote>
                          )}
                          {q.evaluationFailed && (
                            <p className="text-xs text-amber-600">
                              The AI evaluation of this answer failed — no
                              scores are shown for it. Read the answer above and
                              judge it directly.
                            </p>
                          )}
                          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                            {q.relevance != null && (
                              <ScoreBar label="Relevance" score={q.relevance} />
                            )}
                            {q.structure != null && (
                              <ScoreBar label="Structure" score={q.structure} />
                            )}
                            {q.specificity != null && (
                              <ScoreBar
                                label="Specificity"
                                score={q.specificity}
                              />
                            )}
                            {q.ownership != null && (
                              <ScoreBar label="Ownership" score={q.ownership} />
                            )}
                          </div>
                          {q.flags && q.flags.length > 0 && (
                            <div className="flex gap-2 flex-wrap">
                              {q.flags.map((f, i) => (
                                <Badge key={i} variant="caution">
                                  {f}
                                </Badge>
                              ))}
                            </div>
                          )}
                        </div>
                      ),
                    }))}
                  />
                )}
            </>
          )}
        </div>
      ))}

      {/* Audit timeline */}
      <div className="bg-white border border-[#e1e8ed] rounded-2xl p-6">
        <h2 className="text-sm font-semibold text-[#0f1419] mb-3">History</h2>
        <ul className="space-y-2">
          {[...application.events].reverse().map((ev, i) => (
            <li key={i} className="text-sm text-[#536471]">
              <span className="text-xs text-[#71767b]">
                {new Date(ev.at).toLocaleString()} ·
              </span>{" "}
              <strong className="text-[#0f1419]">{ev.actorName}</strong>{" "}
              {ev.type === "stage_move"
                ? `moved ${ev.from} → ${ev.to}`
                : ev.type.replaceAll("_", " ")}
              {ev.note ? ` — ${ev.note}` : ""}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
