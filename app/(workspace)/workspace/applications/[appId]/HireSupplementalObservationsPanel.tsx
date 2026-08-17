interface SupplementalObservationEvent {
  kind: "browser_window_not_visible" | "sustained_camera_away";
  source: "camera" | "browser_visibility";
  startMs: number;
  endMs: number;
}

export interface HireSupplementalObservationView {
  observedAt: string;
  report: {
    status: "completed" | "insufficient_signal";
    capture: {
      camera: "captured" | "unavailable" | "insufficient_signal";
      browserVisibility: "captured" | "unavailable" | "insufficient_signal";
    };
    events: SupplementalObservationEvent[];
  };
}

function formatElapsed(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function eventLabel(event: SupplementalObservationEvent): string {
  return event.kind === "browser_window_not_visible"
    ? "Browser window was not visible"
    : "Sustained camera-away interval";
}

function captureLabel(
  state: HireSupplementalObservationView["report"]["capture"]["camera"],
): string {
  return state === "captured"
    ? "captured"
    : state === "unavailable"
      ? "unavailable"
      : "insufficient signal";
}

/**
 * Deliberately independent from the full recording and the separate Hire
 * multimodal analysis. These bounded system observations are neither scores
 * nor input to hiring decisions.
 */
export default function HireSupplementalObservationsPanel({
  observations,
}: {
  observations: HireSupplementalObservationView[];
}) {
  if (observations.length === 0) return null;

  return (
    <section
      aria-label="Supplemental interview observations"
      className="rounded-xl border border-slate-200 bg-slate-50 p-4 space-y-3"
    >
      <div>
        <h3 className="text-sm font-semibold text-[#0f1419]">
          Supplemental interview observations
        </h3>
        <p className="mt-1 text-xs leading-relaxed text-[#536471]">
          These neutral system observations are not interview scores and did not
          affect a hiring decision, stage, ranking, recommendation, or export.
          The full recording and complete multimodal analysis are shown
          separately for this interview.
        </p>
      </div>

      {observations.map((observation) => (
        <div
          key={`${observation.observedAt}-${observation.report.events.length}`}
          className="rounded-lg border border-slate-200 bg-white p-3 space-y-2"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs font-medium text-[#0f1419]">
              Captured {new Date(observation.observedAt).toLocaleString()}
            </p>
            <p className="text-xs text-[#536471]">
              Camera: {captureLabel(observation.report.capture.camera)} ·
              Browser visibility:{" "}
              {captureLabel(observation.report.capture.browserVisibility)}
            </p>
          </div>

          {observation.report.status === "insufficient_signal" ? (
            <p className="text-xs text-[#536471]">
              There was not enough supplemental signal to record an interval.
            </p>
          ) : observation.report.events.length === 0 ? (
            <p className="text-xs text-[#536471]">
              No reportable supplemental interval was recorded.
            </p>
          ) : (
            <ul className="space-y-1 text-xs text-[#0f1419]">
              {observation.report.events.map((event, index) => (
                <li
                  key={`${event.kind}-${event.startMs}-${event.endMs}-${index}`}
                >
                  {eventLabel(event)} · {formatElapsed(event.startMs)}–
                  {formatElapsed(event.endMs)}
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
    </section>
  );
}

export const __hireSupplementalObservationsPanel = {
  formatElapsed,
  eventLabel,
};
