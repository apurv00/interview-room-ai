"use client";

import { useEffect, useMemo, useState } from "react";

const OBJECT_ID = /^[a-f0-9]{24}$/i;
const PACKET_CAPABILITY = /^[a-f0-9]{24}\.[a-f0-9]{24}\.[a-f0-9]{64}$/i;
const PACKET_STORAGE_PREFIX = "hire:share-packet:v1:";

type Recommendation = "strong_yes" | "yes" | "no" | "strong_no";

const RECOMMENDATIONS: Array<{ value: Recommendation; label: string }> = [
  { value: "strong_yes", label: "Strong yes" },
  { value: "yes", label: "Yes" },
  { value: "no", label: "No" },
  { value: "strong_no", label: "Strong no" },
];

interface SharePacketSnapshot {
  version: 1;
  candidateBrief?: {
    candidateName: string;
    jobTitle: string;
    location?: string;
    experienceYears?: number;
  };
  aiAssessments?: Array<{
    completedAt: string;
    overallScore: number | null;
    recommendation?: string;
    confidence?: string;
    dimensions: Array<{ key: string; label?: string; score: number | null }>;
  }>;
  humanScorecards?: {
    total: {
      count: number;
      recommendations: Partial<Record<Recommendation, number>>;
    };
    member: {
      count: number;
      recommendations: Partial<Record<Recommendation, number>>;
    };
    kit: {
      count: number;
      recommendations: Partial<Record<Recommendation, number>>;
    };
  };
}

interface SharePacketBootstrap {
  state: "ok";
  snapshot: SharePacketSnapshot;
}

function isPacketCapabilityForId(raw: string, packetId: string): boolean {
  if (!OBJECT_ID.test(packetId) || !PACKET_CAPABILITY.test(raw)) return false;
  const [, capabilityPacketId] = raw.split(".");
  return capabilityPacketId?.toLowerCase() === packetId.toLowerCase();
}

function inactivePacket() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-[#f8fafc] px-4">
      <div className="w-full max-w-md space-y-3 rounded-2xl border border-[#e1e8ed] bg-white p-8 text-center">
        <div className="text-3xl">🔗</div>
        <h1 className="text-lg font-semibold text-[#0f1419]">
          This share packet link is no longer active
        </h1>
        <p className="text-sm leading-relaxed text-[#536471]">
          The link may have expired, been revoked, or already been used to
          submit a verdict. Please contact the person who shared it with you.
        </p>
      </div>
    </main>
  );
}

function recommendationLabel(value: string): string {
  return (
    RECOMMENDATIONS.find((recommendation) => recommendation.value === value)
      ?.label ?? value.replaceAll("_", " ")
  );
}

function verdictCount(
  recommendations: Partial<Record<Recommendation, number>>,
  recommendation: Recommendation,
): number {
  const value = recommendations[recommendation];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * A public share packet is a fragment-only possession link. The raw secret
 * is held in sessionStorage only for tab-recovery, then sent to fixed
 * cookie-free endpoints; the immutable packet snapshot is the sole public
 * response surface.
 */
export default function SharePacketEntry({ packetId }: { packetId: string }) {
  const [capability, setCapability] = useState<string | null>(null);
  const [bootstrap, setBootstrap] = useState<SharePacketBootstrap | null>(null);
  const [invalid, setInvalid] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [comment, setComment] = useState("");
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  const storageKey = useMemo(
    () => `${PACKET_STORAGE_PREFIX}${packetId}`,
    [packetId],
  );

  useEffect(() => {
    const fragment = new URLSearchParams(window.location.hash.slice(1));
    const fragmentCapability = fragment.get("packet")?.trim() ?? "";
    let storedCapability = "";

    try {
      storedCapability =
        window.sessionStorage.getItem(storageKey)?.trim() ?? "";
      if (isPacketCapabilityForId(fragmentCapability, packetId)) {
        window.sessionStorage.setItem(storageKey, fragmentCapability);
      }
    } catch {
      // Storage only makes reload recovery convenient; the fragment itself is
      // sufficient when storage is unavailable.
    }

    const resolvedCapability = isPacketCapabilityForId(
      fragmentCapability,
      packetId,
    )
      ? fragmentCapability
      : isPacketCapabilityForId(storedCapability, packetId)
        ? storedCapability
        : "";

    // Fragments do not cross the network, but remove the secret from browser
    // history before issuing any request or letting another navigation occur.
    window.history.replaceState(
      window.history.state,
      "",
      `${window.location.pathname}${window.location.search}`,
    );

    if (!resolvedCapability) {
      setInvalid(true);
      return;
    }
    setCapability(resolvedCapability);
  }, [packetId, storageKey]);

  useEffect(() => {
    if (!capability || invalid) return;
    let cancelled = false;
    setLoadError(null);

    void fetch(`/api/share-packet/${encodeURIComponent(packetId)}/bootstrap`, {
      method: "POST",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ capability }),
      cache: "no-store",
    })
      .then(async (response) => {
        const payload = (await response
          .json()
          .catch(() => ({}))) as Partial<SharePacketBootstrap>;
        if (cancelled) return;
        if (response.status === 410) {
          setInvalid(true);
          return;
        }
        if (!response.ok || payload.state !== "ok" || !payload.snapshot) {
          setLoadError(
            "We could not open this share packet. Please try again.",
          );
          return;
        }
        setBootstrap(payload as SharePacketBootstrap);
      })
      .catch(() => {
        if (!cancelled) {
          setLoadError(
            "We could not open this share packet. Please try again.",
          );
        }
      });

    return () => {
      cancelled = true;
    };
  }, [capability, invalid, loadAttempt, packetId]);

  async function submitVerdict(recommendation: Recommendation) {
    if (!capability || submitting) return;
    setSubmitError(null);
    setSubmitting(true);
    try {
      const response = await fetch(
        `/api/share-packet/${encodeURIComponent(packetId)}/verdict`,
        {
          method: "POST",
          credentials: "omit",
          referrerPolicy: "no-referrer",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            capability,
            recommendation,
            ...(comment.trim() ? { comment: comment.trim() } : {}),
          }),
          cache: "no-store",
        },
      );
      if (response.status === 410) {
        setInvalid(true);
        return;
      }
      if (!response.ok) {
        setSubmitError("We could not submit your verdict. Please try again.");
        return;
      }
      try {
        window.sessionStorage.removeItem(storageKey);
      } catch {
        // The server-side conditional consume prevents a repeated verdict.
      }
      setSubmitted(true);
    } catch {
      setSubmitError(
        "We could not reach the service. Please check your connection and try again.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  if (invalid) return inactivePacket();

  if (loadError && capability) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-[#f8fafc] px-4">
        <div className="w-full max-w-md space-y-4 rounded-2xl border border-[#e1e8ed] bg-white p-8 text-center">
          <div role="alert">
            <h1 className="text-lg font-semibold text-[#0f1419]">
              We could not open this share packet
            </h1>
            <p className="mt-2 text-sm text-[#536471]">
              The link may still be valid. Check your connection and try again.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setLoadAttempt((attempt) => attempt + 1)}
            className="rounded-xl bg-[#2563eb] px-5 py-2.5 text-sm font-semibold text-white hover:bg-[#1d4ed8] focus:outline-none focus:ring-2 focus:ring-[#2563eb]/40"
          >
            Try again
          </button>
        </div>
      </main>
    );
  }

  if (!bootstrap || !capability) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-[#f8fafc] px-4">
        <p className="text-sm text-[#536471]" role="status">
          Opening your secure share packet…
        </p>
      </main>
    );
  }

  if (submitted) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-[#f8fafc] px-4">
        <div className="w-full max-w-md space-y-3 rounded-2xl border border-[#e1e8ed] bg-white p-8 text-center">
          <div className="text-3xl">✓</div>
          <h1 className="text-lg font-semibold text-[#0f1419]">
            Verdict submitted
          </h1>
          <p className="text-sm leading-relaxed text-[#536471]">
            Thank you. The hiring team has your verdict. You can safely close
            this tab.
          </p>
        </div>
      </main>
    );
  }

  const snapshot = bootstrap.snapshot;
  const candidateBrief = snapshot.candidateBrief;
  return (
    <main className="min-h-screen bg-[#f8fafc] px-4 py-10">
      <div className="mx-auto max-w-3xl space-y-6">
        <header className="space-y-1 text-center">
          <p className="text-xs uppercase tracking-wide text-[#71767b]">
            Candidate share packet
          </p>
          <h1 className="text-2xl font-bold text-[#0f1419]">
            {candidateBrief?.jobTitle ?? "Hiring feedback"}
          </h1>
          <p className="text-sm text-[#536471]">
            Review the shared assessment, then leave one independent verdict.
          </p>
        </header>

        {candidateBrief ? (
          <section
            className="space-y-3 rounded-2xl border border-[#e1e8ed] bg-white p-6"
            aria-labelledby="candidate-brief-heading"
          >
            <h2
              id="candidate-brief-heading"
              className="text-lg font-semibold text-[#0f1419]"
            >
              Candidate brief
            </h2>
            <dl className="grid gap-3 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-[#71767b]">Candidate</dt>
                <dd className="mt-0.5 font-medium text-[#0f1419]">
                  {candidateBrief.candidateName}
                </dd>
              </div>
              <div>
                <dt className="text-[#71767b]">Role</dt>
                <dd className="mt-0.5 font-medium text-[#0f1419]">
                  {candidateBrief.jobTitle}
                </dd>
              </div>
              {candidateBrief.experienceYears !== undefined ? (
                <div>
                  <dt className="text-[#71767b]">Experience</dt>
                  <dd className="mt-0.5 font-medium text-[#0f1419]">
                    {candidateBrief.experienceYears} years
                  </dd>
                </div>
              ) : null}
              {candidateBrief.location ? (
                <div>
                  <dt className="text-[#71767b]">Location</dt>
                  <dd className="mt-0.5 font-medium text-[#0f1419]">
                    {candidateBrief.location}
                  </dd>
                </div>
              ) : null}
            </dl>
          </section>
        ) : null}

        {snapshot.aiAssessments ? (
          <section
            className="space-y-4 rounded-2xl border border-[#e1e8ed] bg-white p-6"
            aria-labelledby="ai-assessments-heading"
          >
            <div>
              <h2
                id="ai-assessments-heading"
                className="text-lg font-semibold text-[#0f1419]"
              >
                AI assessments
              </h2>
              <p className="mt-1 text-sm text-[#536471]">
                These are assessments, not an automatic hiring decision.
              </p>
            </div>
            {snapshot.aiAssessments.length === 0 ? (
              <p className="text-sm text-[#536471]">
                No completed AI assessments were included.
              </p>
            ) : (
              <div className="space-y-4">
                {snapshot.aiAssessments.map((assessment, index) => (
                  <div
                    key={`${assessment.completedAt}-${index}`}
                    className="rounded-xl border border-[#e1e8ed] bg-[#f8fafc] p-4"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                      <p className="font-medium text-[#0f1419]">
                        Assessment {index + 1}
                      </p>
                      <p className="text-[#536471]">
                        Completed{" "}
                        {new Date(assessment.completedAt).toLocaleDateString()}
                      </p>
                    </div>
                    <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-3">
                      <div>
                        <dt className="text-[#71767b]">Overall score</dt>
                        <dd className="mt-0.5 font-medium text-[#0f1419]">
                          {assessment.overallScore ?? "Not scored"}
                        </dd>
                      </div>
                      {assessment.recommendation ? (
                        <div>
                          <dt className="text-[#71767b]">Recommendation</dt>
                          <dd className="mt-0.5 font-medium capitalize text-[#0f1419]">
                            {assessment.recommendation.replaceAll("_", " ")}
                          </dd>
                        </div>
                      ) : null}
                      {assessment.confidence ? (
                        <div>
                          <dt className="text-[#71767b]">Confidence</dt>
                          <dd className="mt-0.5 font-medium capitalize text-[#0f1419]">
                            {assessment.confidence}
                          </dd>
                        </div>
                      ) : null}
                    </dl>
                    {assessment.dimensions.length > 0 ? (
                      <dl className="mt-4 grid gap-2 sm:grid-cols-2">
                        {assessment.dimensions.map((dimension) => (
                          <div
                            key={dimension.key}
                            className="rounded-lg border border-[#e1e8ed] bg-white px-3 py-2 text-sm"
                          >
                            <dt className="text-[#71767b]">
                              {dimension.label ??
                                dimension.key.replaceAll("_", " ")}
                            </dt>
                            <dd className="mt-0.5 font-medium text-[#0f1419]">
                              {dimension.score ?? "Not scored"}
                            </dd>
                          </div>
                        ))}
                      </dl>
                    ) : null}
                  </div>
                ))}
              </div>
            )}
          </section>
        ) : null}

        {snapshot.humanScorecards ? (
          <section
            className="space-y-4 rounded-2xl border border-[#e1e8ed] bg-white p-6"
            aria-labelledby="human-feedback-heading"
          >
            <div>
              <h2
                id="human-feedback-heading"
                className="text-lg font-semibold text-[#0f1419]"
              >
                Human scorecard summary
              </h2>
              <p className="mt-1 text-sm text-[#536471]">
                {snapshot.humanScorecards.total.count} submitted scorecard
                {snapshot.humanScorecards.total.count === 1 ? "" : "s"}{" "}
                included.
              </p>
            </div>
            {(
              [
                ["Member reviewers", snapshot.humanScorecards.member],
                ["Guest interviewers", snapshot.humanScorecards.kit],
              ] as const
            ).map(([label, group]) => (
              <div
                key={label}
                className="rounded-xl border border-[#e1e8ed] bg-[#f8fafc] p-4"
              >
                <p className="text-sm font-medium text-[#0f1419]">
                  {label} · {group.count}
                </p>
                <dl className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
                  {RECOMMENDATIONS.map((recommendation) => (
                    <div
                      key={recommendation.value}
                      className="rounded-lg border border-[#e1e8ed] bg-white px-3 py-2 text-sm"
                    >
                      <dt className="text-[#71767b]">{recommendation.label}</dt>
                      <dd className="mt-0.5 font-medium text-[#0f1419]">
                        {verdictCount(
                          group.recommendations,
                          recommendation.value,
                        )}
                      </dd>
                    </div>
                  ))}
                </dl>
              </div>
            ))}
          </section>
        ) : null}

        <section
          className="space-y-4 rounded-2xl border border-[#e1e8ed] bg-white p-6"
          aria-labelledby="external-verdict-heading"
        >
          <div>
            <h2
              id="external-verdict-heading"
              className="text-lg font-semibold text-[#0f1419]"
            >
              Your verdict
            </h2>
            <p className="mt-1 text-sm text-[#536471]">
              Choose the option that best reflects your independent view. You
              can submit only once.
            </p>
          </div>
          <div>
            <label
              htmlFor="external-verdict-comment"
              className="block text-sm font-medium text-[#0f1419]"
            >
              Optional context
            </label>
            <textarea
              id="external-verdict-comment"
              value={comment}
              onChange={(event) => setComment(event.target.value)}
              maxLength={2000}
              rows={4}
              className="mt-1 w-full rounded-lg border border-[#e1e8ed] bg-white px-3 py-2 text-sm text-[#0f1419] focus:border-[#2563eb] focus:outline-none focus:ring-1 focus:ring-[#2563eb]/20"
              placeholder="Add concise context for the hiring team (optional)."
            />
          </div>
          {submitError ? (
            <p className="text-sm text-[#d92d20]" role="alert">
              {submitError}
            </p>
          ) : null}
          <div className="grid gap-2 sm:grid-cols-2">
            {RECOMMENDATIONS.map((recommendation) => (
              <button
                key={recommendation.value}
                type="button"
                disabled={submitting}
                onClick={() => void submitVerdict(recommendation.value)}
                className="rounded-xl border border-[#cbd5e1] bg-white px-4 py-3 text-sm font-semibold text-[#0f1419] hover:border-[#2563eb] hover:bg-blue-50 focus:outline-none focus:ring-2 focus:ring-[#2563eb]/40 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {submitting
                  ? "Submitting verdict…"
                  : recommendationLabel(recommendation.value)}
              </button>
            ))}
          </div>
        </section>
      </div>
    </main>
  );
}
