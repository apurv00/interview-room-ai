"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Badge from "@shared/ui/Badge";
import Button from "@shared/ui/Button";
import { HireAssessmentReport } from "@hire-decisions/components/HireAssessmentReport";
import type {
  HireDecisionActionContext,
  HireDecisionDimensionAggregate,
  HireDecisionView,
  HireExternalVerdictRecommendation,
  HireHumanDecisionSourceAggregate,
  HireHumanScorecardAggregate,
  HireRecommendationTally,
} from "@hire-decisions/types";

type InboxItemKind =
  | "pending_human_scorecard"
  | "terminal_human_kit_delivery_failure"
  | "external_verdict_submitted";

interface DecisionInboxItem {
  kind: InboxItemKind;
  occurredAt: string;
  summary: string;
  decision: HireDecisionActionContext;
}

interface DecisionInboxPage {
  items: DecisionInboxItem[];
  limit: number;
  nextCursor: string | null;
}

interface CandidateInboxEntry {
  applicationId: string;
  decision: HireDecisionActionContext;
  actions: DecisionInboxItem[];
}

interface ComparisonCandidate {
  applicationId: string;
  candidateName: string;
  candidateEmail?: string;
}

const RECOMMENDATIONS = ["strong_yes", "yes", "no", "strong_no"] as const;
const COMPARISON_CANDIDATE_PAGE_LIMIT = 20;
const COMPARISON_CANDIDATE_HISTORY_MAX_DEPTH = 64;
const DIMENSIONS = [
  "role_capability",
  "problem_solving",
  "communication",
  "collaboration",
] as const;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nullableNumber(value: unknown): number | null | undefined {
  if (value === null) return null;
  return numberValue(value) ?? undefined;
}

function dateValue(value: unknown): { raw: string; value: Date } | null {
  const raw = stringValue(value);
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : { raw, value: parsed };
}

function isRecommendation(
  value: unknown,
): value is HireExternalVerdictRecommendation {
  return (
    typeof value === "string" &&
    RECOMMENDATIONS.includes(value as HireExternalVerdictRecommendation)
  );
}

function recommendationLabel(value: HireExternalVerdictRecommendation): string {
  return {
    strong_yes: "Strong yes",
    yes: "Yes",
    no: "No",
    strong_no: "Strong no",
  }[value];
}

function coordinatesFrom(value: unknown) {
  const source = record(value);
  if (!source) return null;
  const workspaceId = stringValue(source.workspaceId);
  const applicationId = stringValue(source.applicationId);
  const jobId = stringValue(source.jobId);
  const candidateId = stringValue(source.candidateId);
  if (!workspaceId || !applicationId || !jobId || !candidateId) return null;
  return { workspaceId, applicationId, jobId, candidateId };
}

function candidateBriefFrom(value: unknown) {
  const source = record(value);
  if (!source) return null;
  const candidateName = stringValue(source.candidateName);
  const jobTitle = stringValue(source.jobTitle);
  if (!candidateName || !jobTitle) return null;
  const location = source.location;
  const experienceYears = source.experienceYears;
  if (location !== undefined && typeof location !== "string") return null;
  if (experienceYears !== undefined && numberValue(experienceYears) === null)
    return null;
  return {
    candidateName,
    jobTitle,
    ...(typeof location === "string" && location ? { location } : {}),
    ...(experienceYears !== undefined
      ? { experienceYears: numberValue(experienceYears)! }
      : {}),
  };
}

function tallyFrom(value: unknown): HireRecommendationTally | null {
  const source = record(value);
  if (!source) return null;
  const tally = Object.fromEntries(
    RECOMMENDATIONS.map((recommendation) => [
      recommendation,
      numberValue(source[recommendation]),
    ]),
  ) as Record<HireExternalVerdictRecommendation, number | null>;
  if (Object.values(tally).some((count) => count === null)) return null;
  return tally as HireRecommendationTally;
}

function dimensionsFrom(
  value: unknown,
): HireDecisionDimensionAggregate[] | null {
  if (!Array.isArray(value)) return null;
  const dimensions = value.map((raw) => {
    const source = record(raw);
    if (!source) return null;
    const key = stringValue(source.key);
    const count = numberValue(source.count);
    const mean = nullableNumber(source.mean);
    const min = nullableNumber(source.min);
    const max = nullableNumber(source.max);
    const reviewerSpread = nullableNumber(source.reviewerSpread);
    if (
      !key ||
      !DIMENSIONS.includes(key as (typeof DIMENSIONS)[number]) ||
      count === null ||
      mean === undefined ||
      min === undefined ||
      max === undefined ||
      reviewerSpread === undefined
    ) {
      return null;
    }
    return {
      key: key as HireDecisionDimensionAggregate["key"],
      count,
      mean,
      min,
      max,
      reviewerSpread,
    };
  });
  return dimensions.some((dimension) => dimension === null)
    ? null
    : (dimensions as HireDecisionDimensionAggregate[]);
}

function humanSourceFrom(
  value: unknown,
): HireHumanDecisionSourceAggregate | null {
  const source = record(value);
  if (!source) return null;
  const count = numberValue(source.count);
  const recommendations = tallyFrom(source.recommendations);
  const dimensions = dimensionsFrom(source.dimensions);
  return count === null || !recommendations || !dimensions
    ? null
    : { count, recommendations, dimensions };
}

function humanScorecardsFrom(
  value: unknown,
): HireHumanScorecardAggregate | null {
  const source = record(value);
  if (!source) return null;
  const total = humanSourceFrom(source.total);
  const member = humanSourceFrom(source.member);
  const kit = humanSourceFrom(source.kit);
  return total && member && kit ? { total, member, kit } : null;
}

function externalVerdictsFrom(value: unknown) {
  const source = record(value);
  if (!source) return null;
  const count = numberValue(source.count);
  const recommendations = tallyFrom(source.recommendations);
  return count === null || !recommendations ? null : { count, recommendations };
}

function actionContextFrom(value: unknown): HireDecisionActionContext | null {
  const source = record(value);
  if (!source) return null;
  const coordinates = coordinatesFrom(source.coordinates);
  const candidateBrief = candidateBriefFrom(source.candidateBrief);
  const humanScorecards = humanScorecardsFrom(source.humanScorecards);
  const externalVerdicts = externalVerdictsFrom(source.externalVerdicts);
  return coordinates && candidateBrief && humanScorecards && externalVerdicts
    ? { coordinates, candidateBrief, humanScorecards, externalVerdicts }
    : null;
}

function decisionViewFrom(value: unknown): HireDecisionView | null {
  const source = record(value);
  if (!source) return null;
  const context = actionContextFrom(source);
  if (!context || !Array.isArray(source.aiAssessments)) return null;
  const aiAssessments = source.aiAssessments.map((raw) => {
    const assessment = record(raw);
    if (!assessment) return null;
    const completedAt = dateValue(assessment.completedAt);
    const overallScore = nullableNumber(assessment.overallScore);
    if (
      !completedAt ||
      overallScore === undefined ||
      !Array.isArray(assessment.dimensions)
    )
      return null;
    const dimensions = assessment.dimensions.map((rawDimension) => {
      const dimension = record(rawDimension);
      if (!dimension) return null;
      const key = stringValue(dimension.key);
      const label = dimension.label;
      const score = nullableNumber(dimension.score);
      if (
        !key ||
        (label !== undefined && typeof label !== "string") ||
        score === undefined
      ) {
        return null;
      }
      return {
        key,
        ...(typeof label === "string" && label ? { label } : {}),
        score,
      };
    });
    if (dimensions.some((dimension) => dimension === null)) return null;
    const recommendation = assessment.recommendation;
    const confidence = assessment.confidence;
    if (
      (recommendation !== undefined && typeof recommendation !== "string") ||
      (confidence !== undefined && typeof confidence !== "string")
    ) {
      return null;
    }
    return {
      completedAt: completedAt.value,
      overallScore,
      ...(typeof recommendation === "string" && recommendation
        ? { recommendation }
        : {}),
      ...(typeof confidence === "string" && confidence ? { confidence } : {}),
      dimensions: dimensions as Array<{
        key: string;
        label?: string;
        score: number | null;
      }>,
    };
  });
  return aiAssessments.some((assessment) => assessment === null)
    ? null
    : {
        ...context,
        aiAssessments: aiAssessments as HireDecisionView["aiAssessments"],
      };
}

function inboxItemFrom(value: unknown): DecisionInboxItem | null {
  const source = record(value);
  if (!source) return null;
  const occurredAt = dateValue(source.occurredAt);
  const decision = actionContextFrom(source.decision);
  const kind = source.kind;
  if (!occurredAt || !decision || typeof kind !== "string") return null;

  if (kind === "pending_human_scorecard") {
    const mode = source.humanRoundMode;
    if (mode !== "guest_kit" && mode !== "member_room") return null;
    return {
      kind,
      occurredAt: occurredAt.raw,
      decision,
      summary:
        mode === "guest_kit"
          ? "A guest interviewer scorecard is pending."
          : "A member interviewer scorecard is pending.",
    };
  }
  if (kind === "terminal_human_kit_delivery_failure") {
    const attempts = numberValue(source.attempts);
    const purpose = source.deliveryPurpose;
    if (attempts === null || (purpose !== "initial" && purpose !== "reminder"))
      return null;
    return {
      kind,
      occurredAt: occurredAt.raw,
      decision,
      summary: `A ${purpose} guest-kit delivery reached its retry limit after ${attempts} attempts.`,
    };
  }
  if (kind === "external_verdict_submitted") {
    if (!isRecommendation(source.recommendation)) return null;
    return {
      kind,
      occurredAt: occurredAt.raw,
      decision,
      summary: `An external verdict was received: ${recommendationLabel(source.recommendation)}.`,
    };
  }
  return null;
}

function inboxFrom(value: unknown): DecisionInboxPage | null {
  const source = record(value);
  if (!source || !Array.isArray(source.items)) return null;
  const items = source.items.map(inboxItemFrom);
  const limit = numberValue(source.limit);
  const nextCursor = source.nextCursor;
  if (
    items.some((item) => item === null) ||
    limit === null ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 50 ||
    (nextCursor !== null &&
      (typeof nextCursor !== "string" ||
        nextCursor.length === 0 ||
        nextCursor.length > 1_024))
  ) {
    return null;
  }
  return {
    items: items as DecisionInboxItem[],
    limit,
    nextCursor,
  };
}

/**
 * Parse the decision-specific identity-only search envelope. The endpoint
 * cannot return rank, stage, evidence, or scores by contract.
 */
function comparisonCandidatesFrom(
  value: unknown,
): { candidates: ComparisonCandidate[]; nextCursor: string | null } | null {
  const source = record(value);
  if (!source || !Array.isArray(source.candidates)) return null;
  const unique = new Map<string, ComparisonCandidate>();
  for (const rawCandidate of source.candidates.slice(
    0,
    COMPARISON_CANDIDATE_PAGE_LIMIT,
  )) {
    const candidate = record(rawCandidate);
    const applicationId = stringValue(candidate?.applicationId);
    const candidateName = stringValue(candidate?.candidateName);
    const candidateEmail = stringValue(candidate?.candidateEmail);
    if (
      !applicationId ||
      !candidate ||
      !candidateName ||
      !candidateEmail ||
      unique.has(applicationId)
    ) {
      return null;
    }
    unique.set(applicationId, {
      applicationId,
      candidateName,
      candidateEmail,
    });
  }
  const page = record(source.pageInfo);
  if (!page) return null;
  const nextCursor = page.nextCursor;
  if (
    nextCursor !== null &&
    (typeof nextCursor !== "string" ||
      nextCursor.length === 0 ||
      nextCursor.length > 2_048)
  ) {
    return null;
  }
  return { candidates: Array.from(unique.values()), nextCursor };
}

function comparisonFrom(value: unknown): HireDecisionView[] | null {
  const source = record(value);
  if (!source || !Array.isArray(source.applications)) return null;
  const applications = source.applications.map(decisionViewFrom);
  return applications.some((application) => application === null)
    ? null
    : (applications as HireDecisionView[]);
}

function displayDate(raw: string): string {
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(raw));
}

function actionKindLabel(kind: InboxItemKind): string {
  if (kind === "pending_human_scorecard") return "Scorecard action";
  if (kind === "terminal_human_kit_delivery_failure") return "Delivery action";
  return "External verdict";
}

function AssessmentPresentation({ decision }: { decision: HireDecisionView }) {
  return (
    <div className="rounded-2xl border border-[#e1e8ed] bg-white p-5 text-sm text-[#0f1419] shadow-sm [&_article]:space-y-5 [&_header]:border-b [&_header]:border-[#e1e8ed] [&_header]:pb-4 [&_h1]:text-lg [&_h1]:font-semibold [&_h2]:text-sm [&_h2]:font-semibold [&_section]:space-y-3 [&_header>p]:mt-1 [&_header>p]:text-[#536471] [&_dl]:grid [&_dl]:grid-cols-2 [&_dl]:gap-2 [&_dl>div]:rounded-lg [&_dl>div]:border [&_dl>div]:border-[#e1e8ed] [&_dl>div]:bg-[#f8fafc] [&_dl>div]:px-3 [&_dl>div]:py-2 [&_dt]:text-xs [&_dt]:text-[#71767b] [&_dd]:mt-0.5 [&_dd]:font-semibold [&_table]:w-full [&_table]:border-collapse [&_table]:text-left [&_th]:border-b [&_th]:border-[#e1e8ed] [&_th]:px-2 [&_th]:py-2 [&_th]:text-xs [&_th]:font-medium [&_th]:text-[#536471] [&_td]:border-b [&_td]:border-[#f1f5f9] [&_td]:px-2 [&_td]:py-2 [&_ol]:space-y-3 [&_ol>li]:rounded-xl [&_ol>li]:border [&_ol>li]:border-[#e1e8ed] [&_ol>li]:bg-[#f8fafc] [&_ol>li]:p-3 [&_ol>li>div]:flex [&_ol>li>div]:items-center [&_ol>li>div]:justify-between [&_ol>li>div]:gap-2 [&_ol>li>div]:text-xs [&_ol>li>div]:text-[#536471] [&_ol>li>p]:mt-2 [&_ol>li>ul]:mt-2 [&_ol>li>ul]:list-disc [&_ol>li>ul]:space-y-1 [&_ol>li>ul]:pl-5 [&_footer]:border-t [&_footer]:border-[#e1e8ed] [&_footer]:pt-4 [&_footer]:text-xs [&_footer]:text-[#536471]">
      <HireAssessmentReport decision={decision} compact />
    </div>
  );
}

function ActionInboxCard({ entry }: { entry: CandidateInboxEntry }) {
  const { candidateBrief, humanScorecards, externalVerdicts } = entry.decision;
  return (
    <article className="rounded-2xl border border-[#e1e8ed] bg-white p-5 shadow-sm">
      <div className="min-w-0">
        <p className="text-xs font-medium text-[#71767b]">
          {candidateBrief.jobTitle}
        </p>
        <h2 className="mt-1 text-lg font-semibold text-[#0f1419]">
          {candidateBrief.candidateName}
        </h2>
        {(candidateBrief.location ||
          candidateBrief.experienceYears !== undefined) && (
          <p className="mt-1 text-sm text-[#536471]">
            {[
              candidateBrief.location,
              candidateBrief.experienceYears !== undefined
                ? `${candidateBrief.experienceYears} years experience`
                : undefined,
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
        )}
      </div>

      <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-3">
        <div className="rounded-xl bg-[#f8fafc] p-3">
          <dt className="text-xs text-[#71767b]">Human scorecards</dt>
          <dd className="mt-1 font-semibold text-[#0f1419]">
            {humanScorecards.total.count}
          </dd>
        </div>
        <div className="rounded-xl bg-[#f8fafc] p-3">
          <dt className="text-xs text-[#71767b]">Member / guest</dt>
          <dd className="mt-1 font-semibold text-[#0f1419]">
            {humanScorecards.member.count} / {humanScorecards.kit.count}
          </dd>
        </div>
        <div className="rounded-xl bg-[#f8fafc] p-3">
          <dt className="text-xs text-[#71767b]">External verdicts</dt>
          <dd className="mt-1 font-semibold text-[#0f1419]">
            {externalVerdicts.count}
          </dd>
        </div>
      </dl>

      <ul className="mt-4 space-y-2" aria-label="Decision actions">
        {entry.actions.map((action, index) => (
          <li
            key={`${action.kind}-${action.occurredAt}-${index}`}
            className="flex flex-wrap items-center gap-2 text-sm"
          >
            <Badge variant="primary">{actionKindLabel(action.kind)}</Badge>
            <span className="text-[#536471]">{action.summary}</span>
            <time
              className="text-xs text-[#71767b]"
              dateTime={action.occurredAt}
            >
              {displayDate(action.occurredAt)}
            </time>
          </li>
        ))}
      </ul>
    </article>
  );
}

function ComparisonCandidatePicker({
  candidate,
  selectedIndex,
  canAdd,
  onToggle,
}: {
  candidate: ComparisonCandidate;
  selectedIndex: number | undefined;
  canAdd: boolean;
  onToggle: () => void;
}) {
  const selected = selectedIndex !== undefined;
  return (
    <li>
      <button
        type="button"
        className="flex w-full items-center justify-between gap-3 rounded-xl border border-[#e1e8ed] bg-white px-4 py-3 text-left text-sm transition-colors hover:border-indigo-300 focus:outline-none focus:ring-2 focus:ring-indigo-500/30 disabled:cursor-not-allowed disabled:opacity-60"
        disabled={!selected && !canAdd}
        aria-pressed={selected}
        aria-label={
          selected
            ? `Remove ${candidate.candidateName} from comparison`
            : `Add ${candidate.candidateName} to comparison`
        }
        onClick={onToggle}
      >
        <span className="min-w-0">
          <span className="block truncate font-medium text-[#0f1419]">
            {candidate.candidateName}
          </span>
          {candidate.candidateEmail ? (
            <span className="block truncate text-xs text-[#71767b]">
              {candidate.candidateEmail}
            </span>
          ) : null}
        </span>
        <span className="text-xs font-semibold text-indigo-600">
          {selected ? `Selected #${selectedIndex + 1}` : "Add to comparison"}
        </span>
      </button>
    </li>
  );
}

/**
 * A member-only evidence workspace. It renders explicit safe DTO picks only,
 * plus a bounded, asynchronous identity projection from the current-job
 * candidate read model. It never displays a rank, resume contents, private
 * notes, media, or packet secrets.
 */
export default function DecisionWorkspace({
  jobId,
  initialApplicationIds = [],
  initialSelectionError,
}: {
  jobId: string;
  initialApplicationIds?: string[];
  initialSelectionError?: string;
}) {
  const [items, setItems] = useState<DecisionInboxItem[] | null>(null);
  const [inboxNextCursor, setInboxNextCursor] = useState<string | null>(null);
  const [inboxCurrentCursor, setInboxCurrentCursor] = useState<string | null>(
    null,
  );
  const [inboxCursorHistory, setInboxCursorHistory] = useState<
    Array<string | null>
  >([]);
  const [inboxLimit, setInboxLimit] = useState(20);
  const [candidateQuery, setCandidateQuery] = useState("");
  const [comparisonCandidates, setComparisonCandidates] = useState<
    ComparisonCandidate[]
  >([]);
  const [candidateNextCursor, setCandidateNextCursor] = useState<string | null>(
    null,
  );
  const [candidateCurrentCursor, setCandidateCurrentCursor] = useState<
    string | null
  >(null);
  const [candidateCursorHistory, setCandidateCursorHistory] = useState<
    Array<string | null>
  >([]);
  const [selectedCandidates, setSelectedCandidates] = useState<
    ComparisonCandidate[]
  >([]);
  const [comparison, setComparison] = useState<HireDecisionView[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingInboxPage, setLoadingInboxPage] = useState(false);
  const [candidateLoading, setCandidateLoading] = useState(false);
  const [loadingMoreCandidates, setLoadingMoreCandidates] = useState(false);
  const [comparing, setComparing] = useState(false);
  const [inboxError, setInboxError] = useState<string | null>(null);
  const [candidateError, setCandidateError] = useState<string | null>(null);
  const [comparisonError, setComparisonError] = useState<string | null>(null);
  const [initialInboxSettled, setInitialInboxSettled] = useState<string | null>(
    null,
  );
  const initialHandoffStarted = useRef<string | null>(null);
  const inboxPageStatusRef = useRef<HTMLParagraphElement>(null);
  const candidatePageStatusRef = useRef<HTMLParagraphElement>(null);
  const inboxRequestGeneration = useRef(0);
  const candidateRequestGeneration = useRef(0);
  const candidateRequestController = useRef<AbortController | null>(null);
  const comparisonRequestGeneration = useRef(0);
  const comparisonRequestController = useRef<AbortController | null>(null);
  const activeJobId = useRef(jobId);
  const previousJobId = useRef(jobId);
  activeJobId.current = jobId;
  const candidateRequestScope = useRef("");
  candidateRequestScope.current = `${jobId}\0${candidateQuery.trim()}`;

  useEffect(() => {
    if (previousJobId.current === jobId) return;
    previousJobId.current = jobId;
    inboxRequestGeneration.current += 1;
    candidateRequestGeneration.current += 1;
    comparisonRequestGeneration.current += 1;
    candidateRequestController.current?.abort();
    comparisonRequestController.current?.abort();
    candidateRequestController.current = null;
    comparisonRequestController.current = null;
    initialHandoffStarted.current = null;
    setItems(null);
    setInboxNextCursor(null);
    setInboxCurrentCursor(null);
    setInboxCursorHistory([]);
    setInboxLimit(20);
    setCandidateQuery("");
    setComparisonCandidates([]);
    setCandidateNextCursor(null);
    setCandidateCurrentCursor(null);
    setCandidateCursorHistory([]);
    setSelectedCandidates([]);
    setComparison(null);
    setLoading(false);
    setLoadingInboxPage(false);
    setCandidateLoading(false);
    setLoadingMoreCandidates(false);
    setComparing(false);
    setInboxError(null);
    setCandidateError(null);
    setComparisonError(null);
    setInitialInboxSettled(null);
  }, [jobId]);

  useEffect(
    () => () => {
      inboxRequestGeneration.current += 1;
      candidateRequestGeneration.current += 1;
      comparisonRequestGeneration.current += 1;
      candidateRequestController.current?.abort();
      comparisonRequestController.current?.abort();
      candidateRequestController.current = null;
      comparisonRequestController.current = null;
    },
    [],
  );

  const loadDecisionData = useCallback(async () => {
    const requestJobId = jobId;
    const generation = ++inboxRequestGeneration.current;
    setLoading(true);
    setLoadingInboxPage(false);
    setInboxError(null);
    setComparisonError(null);
    try {
      const response = await fetch(
        `/api/workspace/jobs/${encodeURIComponent(jobId)}/decision?limit=20`,
        { cache: "no-store" },
      );
      const inbox = response.ok ? inboxFrom(await response.json()) : null;
      if (
        generation !== inboxRequestGeneration.current ||
        activeJobId.current !== requestJobId
      ) return;
      if (inbox === null) {
        setItems(null);
        setInboxError("Could not load decision actions. Please try again.");
      } else {
        setItems(inbox.items.slice(0, inbox.limit));
        setInboxLimit(inbox.limit);
        setInboxNextCursor(inbox.nextCursor);
        setInboxCurrentCursor(null);
        setInboxCursorHistory([]);
        // A refresh may contain newer scorecards or an external verdict. Never
        // keep a previously assembled comparison beside fresher source data.
        setComparison(null);
      }
    } catch {
      if (
        generation !== inboxRequestGeneration.current ||
        activeJobId.current !== requestJobId
      ) return;
      setItems(null);
      setInboxError("Could not load decision actions. Please try again.");
    } finally {
      if (
        generation === inboxRequestGeneration.current &&
        activeJobId.current === requestJobId
      ) {
        setLoading(false);
        setInitialInboxSettled(requestJobId);
      }
    }
  }, [jobId]);

  useEffect(() => {
    void loadDecisionData();
  }, [loadDecisionData]);

  const loadInboxPage = useCallback(
    async (cursor: string | null, history: Array<string | null>) => {
      if (loading || loadingInboxPage) return;
      const requestJobId = jobId;
      const generation = ++inboxRequestGeneration.current;
      setLoadingInboxPage(true);
      setInboxError(null);
      try {
        const search = new URLSearchParams({ limit: String(inboxLimit) });
        if (cursor) search.set("cursor", cursor);
        const response = await fetch(
          `/api/workspace/jobs/${encodeURIComponent(jobId)}/decision?${search.toString()}`,
          { cache: "no-store" },
        );
        const page = response.ok ? inboxFrom(await response.json()) : null;
        if (
          generation !== inboxRequestGeneration.current ||
          activeJobId.current !== requestJobId
        ) return;
        if (!page) {
          setInboxError(
            "Could not load that decision action page. Please try again.",
          );
          return;
        }
        // Replace the mounted page instead of accumulating the job's action
        // history. The server limit and this defensive slice keep the DOM
        // bounded even if an upstream response accidentally over-delivers.
        setItems(page.items.slice(0, page.limit));
        setInboxLimit(page.limit);
        setInboxNextCursor(page.nextCursor);
        setInboxCurrentCursor(cursor);
        setInboxCursorHistory(history);
        window.requestAnimationFrame(() => {
          if (
            generation === inboxRequestGeneration.current &&
            activeJobId.current === requestJobId
          ) inboxPageStatusRef.current?.focus();
        });
      } catch {
        if (
          generation !== inboxRequestGeneration.current ||
          activeJobId.current !== requestJobId
        ) return;
        setInboxError(
          "Could not load that decision action page. Please try again.",
        );
      } finally {
        if (
          generation === inboxRequestGeneration.current &&
          activeJobId.current === requestJobId
        ) {
          setLoadingInboxPage(false);
        }
      }
    },
    [inboxLimit, jobId, loading, loadingInboxPage],
  );

  const loadNextInboxPage = useCallback(() => {
    if (!inboxNextCursor) return;
    void loadInboxPage(inboxNextCursor, [
      ...inboxCursorHistory,
      inboxCurrentCursor,
    ]);
  }, [
    inboxCurrentCursor,
    inboxCursorHistory,
    inboxNextCursor,
    loadInboxPage,
  ]);

  const loadPreviousInboxPage = useCallback(() => {
    if (inboxCursorHistory.length === 0) return;
    void loadInboxPage(
      inboxCursorHistory[inboxCursorHistory.length - 1] ?? null,
      inboxCursorHistory.slice(0, -1),
    );
  }, [inboxCursorHistory, loadInboxPage]);

  const loadCandidateResults = useCallback(
    async (
      query: string,
      options: {
        cursor?: string | null;
        history?: Array<string | null>;
        pageNavigation?: boolean;
      } = {},
    ) => {
      const normalizedQuery = query.trim();
      if (normalizedQuery.length < 2) return;
      const scope = `${jobId}\0${normalizedQuery}`;
      const generation = ++candidateRequestGeneration.current;
      candidateRequestController.current?.abort();
      const controller = new AbortController();
      candidateRequestController.current = controller;
      options.pageNavigation
        ? setLoadingMoreCandidates(true)
        : setCandidateLoading(true);
      setCandidateError(null);
      try {
        const search = new URLSearchParams({
          q: normalizedQuery,
          limit: "20",
        });
        if (options.cursor) search.set("cursor", options.cursor);
        const response = await fetch(
          `/api/workspace/jobs/${encodeURIComponent(jobId)}/decision/candidates?${search.toString()}`,
          { cache: "no-store", signal: controller.signal },
        );
        if (
          controller.signal.aborted ||
          generation !== candidateRequestGeneration.current ||
          candidateRequestScope.current !== scope
        ) return;
        const page = response.ok
          ? comparisonCandidatesFrom(await response.json())
          : null;
        if (
          controller.signal.aborted ||
          generation !== candidateRequestGeneration.current ||
          candidateRequestScope.current !== scope
        ) return;
        if (!page) {
          setCandidateError("Could not search job candidates. Please try again.");
          return;
        }
        // Keep the mounted result set bounded to one server page. Deliberate
        // selections live independently below, so moving forward never drops
        // a selected chip or accumulates the whole applicant pool in the DOM.
        setComparisonCandidates(page.candidates);
        setCandidateNextCursor(page.nextCursor);
        setCandidateCurrentCursor(options.cursor ?? null);
        setCandidateCursorHistory(options.history ?? []);
        if (options.pageNavigation) {
          window.requestAnimationFrame(() => {
            if (
              generation === candidateRequestGeneration.current &&
              candidateRequestScope.current === scope
            ) candidatePageStatusRef.current?.focus();
          });
        }
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
        if (
          generation !== candidateRequestGeneration.current ||
          candidateRequestScope.current !== scope
        ) return;
        setCandidateError("Could not search job candidates. Please try again.");
      } finally {
        if (
          !controller.signal.aborted &&
          generation === candidateRequestGeneration.current &&
          candidateRequestScope.current === scope
        ) {
          options.pageNavigation
            ? setLoadingMoreCandidates(false)
            : setCandidateLoading(false);
          if (candidateRequestController.current === controller) {
            candidateRequestController.current = null;
          }
        }
      }
    },
    [jobId],
  );

  useEffect(() => {
    const normalizedQuery = candidateQuery.trim();
    candidateRequestGeneration.current += 1;
    candidateRequestController.current?.abort();
    candidateRequestController.current = null;
    setComparisonCandidates([]);
    setCandidateNextCursor(null);
    setCandidateCurrentCursor(null);
    setCandidateCursorHistory([]);
    setCandidateError(null);
    setLoadingMoreCandidates(false);
    if (normalizedQuery.length < 2) {
      setCandidateLoading(false);
      return;
    }

    const timeout = window.setTimeout(() => {
      void loadCandidateResults(normalizedQuery);
    }, 250);
    return () => {
      window.clearTimeout(timeout);
      candidateRequestGeneration.current += 1;
      candidateRequestController.current?.abort();
      candidateRequestController.current = null;
    };
  }, [candidateQuery, loadCandidateResults]);

  const loadNextCandidatePage = useCallback(() => {
    if (!candidateNextCursor || candidateLoading || loadingMoreCandidates) return;
    void loadCandidateResults(candidateQuery, {
      cursor: candidateNextCursor,
      history: [...candidateCursorHistory, candidateCurrentCursor].slice(
        -COMPARISON_CANDIDATE_HISTORY_MAX_DEPTH,
      ),
      pageNavigation: true,
    });
  }, [
    candidateCurrentCursor,
    candidateCursorHistory,
    candidateLoading,
    candidateNextCursor,
    candidateQuery,
    loadCandidateResults,
    loadingMoreCandidates,
  ]);

  const loadPreviousCandidatePage = useCallback(() => {
    if (candidateCursorHistory.length === 0 || candidateLoading || loadingMoreCandidates) return;
    void loadCandidateResults(candidateQuery, {
      cursor: candidateCursorHistory[candidateCursorHistory.length - 1] ?? null,
      history: candidateCursorHistory.slice(0, -1),
      pageNavigation: true,
    });
  }, [
    candidateCursorHistory,
    candidateLoading,
    candidateQuery,
    loadCandidateResults,
    loadingMoreCandidates,
  ]);

  const loadFirstCandidatePage = useCallback(() => {
    if (candidateCursorHistory.length === 0 || candidateLoading || loadingMoreCandidates) return;
    void loadCandidateResults(candidateQuery, {
      cursor: null,
      history: [],
      pageNavigation: true,
    });
  }, [
    candidateCursorHistory.length,
    candidateLoading,
    candidateQuery,
    loadCandidateResults,
    loadingMoreCandidates,
  ]);

  const inboxCandidates = useMemo(() => {
    const byApplication = new Map<string, CandidateInboxEntry>();
    for (const item of items ?? []) {
      const applicationId = item.decision.coordinates.applicationId;
      const existing = byApplication.get(applicationId);
      if (existing) {
        existing.actions.push(item);
      } else {
        byApplication.set(applicationId, {
          applicationId,
          decision: item.decision,
          actions: [item],
        });
      }
    }
    return Array.from(byApplication.values());
  }, [items]);

  const selected = useMemo(
    () => selectedCandidates.map((candidate) => candidate.applicationId),
    [selectedCandidates],
  );

  const toggleCandidate = useCallback(
    (candidate: ComparisonCandidate) => {
      setSelectedCandidates((current) => {
        if (
          current.some(
            (entry) => entry.applicationId === candidate.applicationId,
          )
        ) {
          return current.filter(
            (entry) => entry.applicationId !== candidate.applicationId,
          );
        }
        return current.length >= 3 ? current : [...current, candidate];
      });
      setComparison(null);
      setComparisonError(null);
    },
    [],
  );

  const compareApplications = useCallback(async (
    applicationIds: string[],
    hydrateSelection = false,
  ) => {
    if (applicationIds.length < 2 || applicationIds.length > 3) return;
    const requestJobId = jobId;
    const generation = ++comparisonRequestGeneration.current;
    comparisonRequestController.current?.abort();
    const controller = new AbortController();
    comparisonRequestController.current = controller;
    setComparing(true);
    setComparisonError(null);
    setComparison(null);
    try {
      const response = await fetch(
        `/api/workspace/jobs/${encodeURIComponent(jobId)}/decision/compare`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ applicationIds }),
          cache: "no-store",
          signal: controller.signal,
        },
      );
      if (
        controller.signal.aborted ||
        generation !== comparisonRequestGeneration.current ||
        activeJobId.current !== requestJobId
      ) return;
      if (!response.ok) {
        setComparisonError(
          "Could not compare the selected candidates. Please try again.",
        );
        return;
      }
      const applications = comparisonFrom(await response.json());
      if (
        controller.signal.aborted ||
        generation !== comparisonRequestGeneration.current ||
        activeJobId.current !== requestJobId
      ) return;
      if (
        !applications ||
        applications.length !== applicationIds.length ||
        applications.some(
          (application, index) =>
            application.coordinates.applicationId !== applicationIds[index],
        )
      ) {
        setComparisonError(
          "The comparison response could not be verified. Please try again.",
        );
        return;
      }
      if (hydrateSelection) {
        setSelectedCandidates(
          applications.map((application) => ({
            applicationId: application.coordinates.applicationId,
            candidateName: application.candidateBrief.candidateName,
          })),
        );
      }
      setComparison(applications);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      if (
        generation !== comparisonRequestGeneration.current ||
        activeJobId.current !== requestJobId
      ) return;
      setComparisonError(
        "Could not compare the selected candidates. Please try again.",
      );
    } finally {
      if (
        !controller.signal.aborted &&
        generation === comparisonRequestGeneration.current &&
        activeJobId.current === requestJobId
      ) {
        setComparing(false);
        if (comparisonRequestController.current === controller) {
          comparisonRequestController.current = null;
        }
      }
    }
  }, [jobId]);

  const compareSelected = useCallback(async () => {
    await compareApplications(selected);
  }, [compareApplications, selected]);

  const initialApplicationKey = initialApplicationIds.join(",");
  const initialHandoffKey = `${jobId}\0${initialApplicationKey}`;
  useEffect(() => {
    if (
      initialInboxSettled !== jobId ||
      initialHandoffStarted.current === initialHandoffKey ||
      initialApplicationIds.length === 0
    ) {
      return;
    }
    initialHandoffStarted.current = initialHandoffKey;
    void compareApplications(initialApplicationIds, true);
  }, [
    compareApplications,
    initialApplicationIds,
    initialApplicationKey,
    initialHandoffKey,
    initialInboxSettled,
    jobId,
  ]);

  const comparisonReturnParams = new URLSearchParams();
  for (const decision of comparison ?? []) {
    comparisonReturnParams.append(
      "applicationId",
      decision.coordinates.applicationId,
    );
  }
  const comparisonReturnTo =
    `/workspace/jobs/${encodeURIComponent(jobId)}/decision` +
    (comparisonReturnParams.size > 0
      ? `?${comparisonReturnParams.toString()}`
      : "");
  const candidatePageNumber = candidateCursorHistory.length + 1;
  const candidateRangeStart = comparisonCandidates.length > 0
    ? (candidatePageNumber - 1) * COMPARISON_CANDIDATE_PAGE_LIMIT + 1
    : 0;
  const candidateRangeEnd = comparisonCandidates.length > 0
    ? candidateRangeStart + comparisonCandidates.length - 1
    : 0;

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <Link
            href={`/workspace/jobs/${encodeURIComponent(jobId)}`}
            className="text-xs font-medium text-indigo-600 hover:underline"
          >
            ← Job overview
          </Link>
          <h1 className="mt-2 text-2xl font-bold text-[#0f1419]">
            Decision workspace
          </h1>
          <p className="mt-1 max-w-2xl text-sm leading-relaxed text-[#536471]">
            Review action-facing evidence, then deliberately compare two or
            three candidates. This workspace does not change a candidate stage.
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={loading || loadingInboxPage}
          onClick={() => void loadDecisionData()}
        >
          {loading ? "Refreshing…" : "Refresh evidence"}
        </Button>
      </header>

      {comparisonError ? (
        <p
          className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-[#b42318]"
          role="alert"
        >
          {comparisonError}
        </p>
      ) : null}

      {initialSelectionError ? (
        <p
          className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900"
          role="alert"
        >
          {initialSelectionError}
        </p>
      ) : null}

      <section
        className="space-y-4"
        aria-labelledby="decision-action-inbox-heading"
      >
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2
              id="decision-action-inbox-heading"
              className="text-lg font-semibold text-[#0f1419]"
            >
              Action inbox
            </h2>
            <p className="mt-1 text-sm text-[#536471]">
              Activity is shown newest first. It is not a candidate ranking.
            </p>
          </div>
          {items !== null ? (
            <p
              ref={inboxPageStatusRef}
              className="text-sm text-[#536471]"
              role="status"
              tabIndex={-1}
            >
              Page {inboxCursorHistory.length + 1} · Showing {items.length}{" "}
              action{items.length === 1 ? "" : "s"} · up to {inboxLimit} per
              page
            </p>
          ) : null}
        </div>

        {inboxError ? (
          <p
            className="rounded-2xl border border-red-200 bg-red-50 p-5 text-sm text-[#b42318]"
            role="alert"
          >
            {inboxError}
          </p>
        ) : null}

        {items === null && !inboxError ? (
          <p
            className="rounded-2xl border border-[#e1e8ed] bg-white p-5 text-sm text-[#536471]"
            role="status"
          >
            Loading decision evidence…
          </p>
        ) : items !== null && inboxCandidates.length === 0 ? (
          <p className="rounded-2xl border border-[#e1e8ed] bg-white p-5 text-sm text-[#536471]">
            No decision actions need attention for this job right now.
          </p>
        ) : (
          <div className="space-y-4">
            {inboxCandidates.map((candidate) => (
              <ActionInboxCard
                key={candidate.applicationId}
                entry={candidate}
              />
            ))}
          </div>
        )}

        {items !== null &&
        (inboxCursorHistory.length > 0 || inboxNextCursor) ? (
          <nav
            className="flex flex-wrap items-center gap-2"
            aria-label="Action inbox pages"
            aria-busy={loadingInboxPage}
          >
            {inboxCursorHistory.length > 0 ? (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={loading || loadingInboxPage}
                aria-label="Previous action page"
                onClick={loadPreviousInboxPage}
              >
                {loadingInboxPage ? "Loading page…" : "Previous page"}
              </Button>
            ) : null}
            {inboxNextCursor ? (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={loading || loadingInboxPage}
                aria-label="Next action page"
                onClick={loadNextInboxPage}
              >
                {loadingInboxPage ? "Loading page…" : "Next page"}
              </Button>
            ) : null}
          </nav>
        ) : null}

        {items !== null && items.length > 0 && !inboxNextCursor ? (
          <p className="text-xs text-[#71767b]">
            This is the last page of currently matching decision actions.
          </p>
        ) : null}
      </section>

      <section
        className="space-y-4"
        aria-labelledby="decision-candidate-selection-heading"
      >
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2
              id="decision-candidate-selection-heading"
              className="text-lg font-semibold text-[#0f1419]"
            >
              Candidate selection
            </h2>
            <p className="mt-1 text-sm text-[#536471]">
              Search this job by candidate name or email. Results are bounded,
              paginated, and never ordered by a score or rank.
            </p>
          </div>
          <p className="text-sm text-[#536471]" aria-live="polite">
            {selected.length} of 3 selected
          </p>
        </div>

        <label className="block max-w-xl text-sm font-medium text-[#0f1419]">
          Find a candidate
          <input
            type="search"
            value={candidateQuery}
            onChange={(event) => setCandidateQuery(event.target.value)}
            placeholder="Search name or email"
            autoComplete="off"
            aria-describedby="decision-candidate-search-status"
            className="mt-1 block h-10 w-full rounded-lg border border-[#e1e8ed] bg-white px-3 text-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
          />
        </label>

        <p
          ref={candidatePageStatusRef}
          id="decision-candidate-search-status"
          className="text-sm text-[#536471]"
          role="status"
          tabIndex={-1}
        >
          {candidateQuery.trim().length < 2
            ? "Enter at least two characters to search."
            : candidateLoading
              ? "Searching current job candidates…"
              : loadingMoreCandidates
                ? "Loading candidate result page…"
                : comparisonCandidates.length === 0
                  ? `Page ${candidatePageNumber} · No candidates on this result page · up to ${COMPARISON_CANDIDATE_PAGE_LIMIT} per page.`
                  : `Page ${candidatePageNumber} · Showing ${candidateRangeStart}–${candidateRangeEnd} of matching candidates · up to ${COMPARISON_CANDIDATE_PAGE_LIMIT} per page.`}
        </p>

        {candidateError ? (
          <p
            className="rounded-2xl border border-red-200 bg-red-50 p-5 text-sm text-[#b42318]"
            role="alert"
          >
            {candidateError}
          </p>
        ) : null}

        {candidateQuery.trim().length >= 2 &&
        !candidateLoading &&
        !candidateError &&
        comparisonCandidates.length === 0 ? (
          <p className="rounded-2xl border border-[#e1e8ed] bg-white p-5 text-sm text-[#536471]">
            No current job candidates match this search.
          </p>
        ) : null}

        {comparisonCandidates.length > 0 ? (
          <ul
            className="grid gap-2 sm:grid-cols-2"
            aria-label="Candidate search results"
          >
            {comparisonCandidates.map((candidate) => {
              const selectedIndex = selected.indexOf(candidate.applicationId);
              return (
                <ComparisonCandidatePicker
                  key={candidate.applicationId}
                  candidate={candidate}
                  selectedIndex={selectedIndex >= 0 ? selectedIndex : undefined}
                  canAdd={selected.length < 3}
                  onToggle={() => toggleCandidate(candidate)}
                />
              );
            })}
          </ul>
        ) : null}

        {candidateCursorHistory.length > 0 || candidateNextCursor ? (
          <nav
            className="flex flex-wrap items-center gap-2"
            aria-label="Candidate search result pages"
            aria-busy={candidateLoading || loadingMoreCandidates}
          >
            {candidateCursorHistory.length > 0 ? (
              <>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={candidateLoading || loadingMoreCandidates}
                  aria-label="First candidate result page"
                  onClick={loadFirstCandidatePage}
                >
                  First page
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={candidateLoading || loadingMoreCandidates}
                  aria-label="Previous candidate result page"
                  onClick={loadPreviousCandidatePage}
                >
                  Previous page
                </Button>
              </>
            ) : null}
            {candidateNextCursor ? (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={candidateLoading || loadingMoreCandidates}
                onClick={loadNextCandidatePage}
              >
                {loadingMoreCandidates
                  ? "Loading candidate page…"
                  : "Show next candidate results"}
              </Button>
            ) : null}
          </nav>
        ) : null}
      </section>

      <section
        className="rounded-2xl border border-indigo-200 bg-indigo-50 p-5"
        aria-labelledby="decision-compare-heading"
      >
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2
              id="decision-compare-heading"
              className="text-lg font-semibold text-indigo-950"
            >
              Deliberate comparison
            </h2>
            <p className="mt-1 text-sm text-indigo-900">
              Select two or three current job candidates. Their selected order
              is preserved in the comparison.
            </p>
          </div>
          <Button
            type="button"
            size="sm"
            disabled={selected.length < 2 || comparing}
            onClick={() => void compareSelected()}
          >
            {comparing
              ? "Building comparison…"
              : `Compare ${selected.length || "selected"} candidate${selected.length === 1 ? "" : "s"}`}
          </Button>
        </div>

        {selected.length > 0 ? (
          <ol
            className="mt-4 grid gap-2 text-sm sm:grid-cols-3"
            aria-label="Selected comparison order"
          >
            {selectedCandidates.map((candidate, index) => {
              return (
                <li
                  key={candidate.applicationId}
                  className="flex items-center justify-between gap-2 rounded-xl border border-indigo-200 bg-white px-3 py-2 text-indigo-950"
                >
                  <span className="min-w-0 truncate">
                    <span className="mr-2 text-xs font-semibold text-indigo-600">
                      {index + 1}.
                    </span>
                    {candidate.candidateName}
                  </span>
                  <button
                    type="button"
                    className="shrink-0 rounded px-2 py-1 text-xs font-semibold text-indigo-700 hover:bg-indigo-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
                    aria-label={`Remove ${candidate.candidateName} from comparison`}
                    onClick={() => toggleCandidate(candidate)}
                  >
                    Remove
                  </button>
                </li>
              );
            })}
          </ol>
        ) : null}
      </section>

      {comparison ? (
        <section
          className="space-y-4"
          aria-labelledby="decision-comparison-results-heading"
        >
          <div>
            <h2
              id="decision-comparison-results-heading"
              className="text-lg font-semibold text-[#0f1419]"
            >
              Evidence comparison
            </h2>
            <p className="mt-1 text-sm text-[#536471]">
              Presented in your selected order. No composite rank is calculated.
            </p>
          </div>
          <div className="grid gap-4 xl:grid-cols-3">
            {comparison.map((decision, index) => (
              <div
                key={decision.coordinates.applicationId}
                className="space-y-2"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-xs font-semibold text-[#71767b]">
                    Selection {index + 1}
                  </p>
                  <Link
                    href={
                      `/workspace/applications/${encodeURIComponent(decision.coordinates.applicationId)}` +
                      `?${new URLSearchParams({ returnTo: comparisonReturnTo }).toString()}`
                    }
                    aria-label={`Open decision detail for ${decision.candidateBrief.candidateName}`}
                    className="text-xs font-semibold text-indigo-600 hover:underline"
                  >
                    Open decision detail
                  </Link>
                </div>
                <AssessmentPresentation decision={decision} />
              </div>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
