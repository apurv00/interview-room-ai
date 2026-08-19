"use client";

export interface HireMultimodalTimelineEventView {
  startMs: number;
  endMs: number;
  type: "strength" | "attention" | "observation";
  signal: "audio" | "facial" | "content" | "fused";
  title: string;
  description: string;
  severity: "positive" | "neutral" | "attention";
  questionIndex?: number;
}

interface ProsodySegmentView {
  startSec: number;
  endSec: number;
  wpm: number;
  fillerWords: Array<{ word: string; timestampSec: number }>;
  pauseDurationSec: number;
  confidenceMarker: "high" | "medium" | "low";
  questionIndex?: number;
}

interface FacialSegmentView {
  startSec: number;
  endSec: number;
  avgEyeContact: number;
  dominantExpression?: string;
  headStability: number;
  gestureLevel: "minimal" | "moderate" | "expressive";
  questionIndex?: number;
  meanBlendshapes?: Record<string, number>;
  maxBlendshapes?: Record<string, number>;
}

export interface HireMultimodalAnalysisView {
  id: string;
  roundId: string;
  attemptId: string;
  status: "pending" | "processing" | "completed" | "failed" | "stale";
  capturedAt: string;
  completedAt?: string;
  durationMs: number;
  facialFrameCount: number | null;
  retryAt?: string;
  retryAttemptCount?: number;
  report?: {
    metrics: {
      bodyLanguageScore: number | null;
      eyeContactScore: number | null;
      facialFrameCount: number | null;
    };
    prosodySegments: ProsodySegmentView[];
    facialSegments: FacialSegmentView[];
    facialTimeseries: FacialSegmentView[];
    timeline: HireMultimodalTimelineEventView[];
    summary: {
      bodyLanguageScore: number | null;
      eyeContactScore: number | null;
      deliverySummary: string;
      reviewerNotes: string[];
      topMoments: HireMultimodalTimelineEventView[];
      attentionMoments: HireMultimodalTimelineEventView[];
    };
  };
}

function formatElapsed(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function formatScore(score: number | null): string {
  return score == null ? "Not available" : `${Math.round(score)}/100`;
}

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}/100`;
}

function statusCopy(status: HireMultimodalAnalysisView["status"]): {
  title: string;
  description: string;
} {
  switch (status) {
    case "pending":
      return {
        title: "Interview analysis queued",
        description: "The recorded interview is ready to be analysed.",
      };
    case "processing":
      return {
        title: "Interview analysis in progress",
        description:
          "The full Hire analysis is being prepared for this recording.",
      };
    case "failed":
      return {
        title: "Interview analysis unavailable",
        description: "The recording remains available for recruiter review.",
      };
    case "stale":
      return {
        title: "Interview analysis no longer current",
        description:
          "A newer interview or analysis state superseded this report.",
      };
    case "completed":
      return {
        title: "Full interview analysis",
        description:
          "Complete recorded-interview analysis for recruiter review.",
      };
  }
}

function severityClass(
  severity: HireMultimodalTimelineEventView["severity"],
): string {
  switch (severity) {
    case "positive":
      return "border-emerald-200 bg-emerald-50 text-emerald-900";
    case "attention":
      return "border-amber-200 bg-amber-50 text-amber-900";
    case "neutral":
      return "border-slate-200 bg-white text-[#0f1419]";
  }
}

function SegmentList({
  title,
  segments,
  kind,
}: {
  title: string;
  segments: ProsodySegmentView[] | FacialSegmentView[];
  kind: "prosody" | "facial";
}) {
  return (
    <details className="rounded-lg border border-slate-200 bg-white p-3">
      <summary className="cursor-pointer text-sm font-semibold text-[#0f1419]">
        {title} ({segments.length})
      </summary>
      {segments.length === 0 ? (
        <p className="mt-2 text-xs text-[#536471]">
          No segments were produced.
        </p>
      ) : (
        <ol className="mt-3 space-y-2 text-xs text-[#0f1419]">
          {segments.map((segment, index) => {
            const startMs = segment.startSec * 1_000;
            const endMs = segment.endSec * 1_000;
            if (kind === "prosody") {
              const prosody = segment as ProsodySegmentView;
              return (
                <li
                  key={`${prosody.startSec}-${prosody.endSec}-${index}`}
                  className="rounded border border-slate-100 p-2"
                >
                  <p className="font-medium">
                    {formatElapsed(startMs)}–{formatElapsed(endMs)} ·{" "}
                    {Math.round(prosody.wpm)} WPM ·{" "}
                    {prosody.pauseDurationSec.toFixed(1)}s pauses
                  </p>
                  <p className="mt-1 text-[#536471]">
                    Confidence: {prosody.confidenceMarker}
                    {prosody.questionIndex == null
                      ? ""
                      : ` · Question ${prosody.questionIndex + 1}`}
                    {prosody.fillerWords.length === 0
                      ? " · No filler words recorded"
                      : ` · Fillers: ${prosody.fillerWords.map((word) => `${word.word} (${formatElapsed(word.timestampSec * 1_000)})`).join(", ")}`}
                  </p>
                </li>
              );
            }
            const facial = segment as FacialSegmentView;
            const blendshapeEntries = [
              ...Object.entries(facial.meanBlendshapes ?? {}).map(
                ([key, value]) => `mean ${key}: ${value.toFixed(3)}`,
              ),
              ...Object.entries(facial.maxBlendshapes ?? {}).map(
                ([key, value]) => `max ${key}: ${value.toFixed(3)}`,
              ),
            ];
            return (
              <li
                key={`${facial.startSec}-${facial.endSec}-${index}`}
                className="rounded border border-slate-100 p-2"
              >
                <p className="font-medium">
                  {formatElapsed(startMs)}–{formatElapsed(endMs)} · Camera
                  engagement {formatPercent(facial.avgEyeContact)} · Head
                  stability {formatPercent(facial.headStability)}
                </p>
                <p className="mt-1 text-[#536471]">
                  Gesture: {facial.gestureLevel}
                  {facial.dominantExpression
                    ? ` · Dominant expression: ${facial.dominantExpression}`
                    : ""}
                  {facial.questionIndex == null
                    ? ""
                    : ` · Question ${facial.questionIndex + 1}`}
                </p>
                {blendshapeEntries.length > 0 && (
                  <p className="mt-1 break-words text-[#536471]">
                    {blendshapeEntries.join(" · ")}
                  </p>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </details>
  );
}

function MomentList({
  title,
  moments,
}: {
  title: string;
  moments: HireMultimodalTimelineEventView[];
}) {
  return (
    <details className="rounded-lg border border-violet-100 bg-white p-3">
      <summary className="cursor-pointer text-sm font-semibold text-[#0f1419]">
        {title} ({moments.length})
      </summary>
      {moments.length === 0 ? (
        <p className="mt-2 text-xs text-[#536471]">
          No moments were marked in this report.
        </p>
      ) : (
        <ol className="mt-3 space-y-2 text-xs text-[#0f1419]">
          {moments.map((moment, index) => (
            <li
              key={`${moment.startMs}-${moment.endMs}-${moment.title}-${index}`}
              className={`rounded border p-2 ${severityClass(moment.severity)}`}
            >
              <p className="font-semibold">
                {formatElapsed(moment.startMs)}–{formatElapsed(moment.endMs)} ·{" "}
                {moment.title}
              </p>
              <p className="mt-1 leading-relaxed">{moment.description}</p>
            </li>
          ))}
        </ol>
      )}
    </details>
  );
}

/**
 * Shows the full persisted Hire-native analysis for the round. It does not
 * create or alter a candidate score; it makes all report sections available
 * alongside the full interview recording for recruiter review.
 */
export default function HireMultimodalAnalysisPanel({
  analysis,
}: {
  analysis: HireMultimodalAnalysisView | null | undefined;
}) {
  if (!analysis) return null;

  const copy = statusCopy(analysis.status);
  const report = analysis.report;
  const failedRetryScheduled =
    analysis.status === "failed" && typeof analysis.retryAt === "string";

  return (
    <section
      aria-label="Full interview analysis"
      className="rounded-xl border border-violet-200 bg-violet-50/40 p-4 space-y-4"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-[#0f1419]">{copy.title}</h3>
          <p className="mt-1 text-xs leading-relaxed text-[#536471]">
            {copy.description}
          </p>
        </div>
        <p className="text-xs text-[#536471]">
          Captured {new Date(analysis.capturedAt).toLocaleString()} ·{" "}
          {formatElapsed(analysis.durationMs)}
        </p>
      </div>

      {!report ? (
        <div className="space-y-1 text-xs text-[#536471]">
          <p>
            {analysis.status === "completed"
              ? "No report fields were generated for this recording."
              : analysis.status === "failed"
                ? failedRetryScheduled
                  ? `Analysis becomes eligible for the next system recovery sweep after ${new Date(analysis.retryAt!).toLocaleString()}${analysis.retryAttemptCount == null ? "." : ` (retry ${analysis.retryAttemptCount} of 3).`}`
                  : "No automatic retry remains for this analysis. The recording is still available for review."
                : "This card refreshes automatically while analysis is pending."}
          </p>
        </div>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="rounded-lg border border-violet-100 bg-white p-3">
              <p className="text-xs text-[#536471]">Body-language signal</p>
              <p className="mt-1 text-lg font-semibold text-[#0f1419]">
                {formatScore(report.metrics.bodyLanguageScore)}
              </p>
            </div>
            <div className="rounded-lg border border-violet-100 bg-white p-3">
              <p className="text-xs text-[#536471]">Camera-engagement signal</p>
              <p className="mt-1 text-lg font-semibold text-[#0f1419]">
                {formatScore(report.metrics.eyeContactScore)}
              </p>
            </div>
            <div className="rounded-lg border border-violet-100 bg-white p-3">
              <p className="text-xs text-[#536471]">Facial frames analysed</p>
              <p className="mt-1 text-lg font-semibold text-[#0f1419]">
                {report.metrics.facialFrameCount ?? "Not available"}
              </p>
            </div>
          </div>

          <div className="rounded-lg border border-violet-100 bg-white p-3">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-[#536471]">
              Delivery summary
            </h4>
            <p className="mt-2 text-sm leading-relaxed text-[#0f1419]">
              {report.summary.deliverySummary}
            </p>
            {report.summary.reviewerNotes.length > 0 && (
              <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-[#0f1419]">
                {report.summary.reviewerNotes.map((note, index) => (
                  <li key={`${note}-${index}`}>{note}</li>
                ))}
              </ul>
            )}
          </div>

          <div className="grid gap-3 lg:grid-cols-2">
            <MomentList
              title="Highlighted strengths"
              moments={report.summary.topMoments}
            />
            <MomentList
              title="Attention moments"
              moments={report.summary.attentionMoments}
            />
          </div>

          <details
            open
            className="rounded-lg border border-violet-100 bg-white p-3"
          >
            <summary className="cursor-pointer text-sm font-semibold text-[#0f1419]">
              Complete timeline ({report.timeline.length})
            </summary>
            {report.timeline.length === 0 ? (
              <p className="mt-2 text-xs text-[#536471]">
                No time-aligned timeline events were generated.
              </p>
            ) : (
              <ol className="mt-3 space-y-2 text-sm">
                {report.timeline.map((event, index) => (
                  <li
                    key={`${event.startMs}-${event.endMs}-${event.title}-${index}`}
                    className={`rounded border p-3 ${severityClass(event.severity)}`}
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="font-semibold">{event.title}</p>
                      <p className="text-xs">
                        {formatElapsed(event.startMs)}–
                        {formatElapsed(event.endMs)} · {event.signal}
                      </p>
                    </div>
                    <p className="mt-1 text-xs leading-relaxed">
                      {event.description}
                    </p>
                    {event.questionIndex != null && (
                      <p className="mt-1 text-xs">
                        Question {event.questionIndex + 1}
                      </p>
                    )}
                  </li>
                ))}
              </ol>
            )}
          </details>

          <div className="grid gap-3 lg:grid-cols-2">
            <SegmentList
              title="Speech delivery segments"
              segments={report.prosodySegments}
              kind="prosody"
            />
            <SegmentList
              title="Facial analysis segments"
              segments={report.facialSegments}
              kind="facial"
            />
          </div>
          <SegmentList
            title="Facial analysis time series"
            segments={report.facialTimeseries}
            kind="facial"
          />
        </>
      )}
    </section>
  );
}

export const __hireMultimodalAnalysisPanel = {
  formatElapsed,
  formatScore,
  formatPercent,
  statusCopy,
};
