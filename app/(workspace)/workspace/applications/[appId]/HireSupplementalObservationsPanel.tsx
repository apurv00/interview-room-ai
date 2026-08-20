import type {
  HireMultimodalObservationEvent,
  HireMultimodalObservationReport,
} from "@shared/contracts/hireMultimodalObservationBridge";

export interface HireSupplementalObservationView {
  observedAt: string;
  report: HireMultimodalObservationReport;
}

function formatElapsed(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function eventLabel(event: HireMultimodalObservationEvent): string {
  switch (event.kind) {
    case "fullscreen_exited":
      return "Full-screen mode was exited";
    case "browser_window_not_visible":
      return "Assessment window was not visible";
    case "browser_window_focus_lost":
      return "Assessment window lost focus";
    case "camera_interrupted":
      return "Camera capture was interrupted";
    case "microphone_interrupted":
      return "Microphone capture was interrupted";
    case "screen_share_wrong_surface":
      return "The required entire display was not shared";
    case "screen_share_interrupted":
      return "Entire-display sharing was interrupted";
    case "screen_recording_interrupted":
      return "Shared-display recording was interrupted";
    case "speech_video_unverified":
      return "Spoken audio could not be verified against the visible candidate";
    case "sustained_camera_away":
      return "Sustained camera-away interval";
  }
}

function sourceLabel(source: HireMultimodalObservationEvent["source"]): string {
  switch (source) {
    case "fullscreen":
      return "full-screen";
    case "browser_visibility":
      return "window visibility";
    case "browser_focus":
      return "window focus";
    case "camera_track":
      return "camera capture";
    case "microphone_track":
      return "microphone capture";
    case "display_surface":
      return "display surface";
    case "display_track":
      return "display capture";
    case "display_recorder":
      return "display recording";
    case "speech_video_corroboration":
      return "audio-video corroboration";
    case "camera":
      return "camera attention";
  }
}

function captureLabel(
  state: HireMultimodalObservationReport["capture"]["camera"],
): string {
  return state === "captured"
    ? "captured"
    : state === "unavailable"
      ? "unavailable"
      : "insufficient signal";
}

/**
 * Deliberately independent from the full recording and the separate Hire
 * multimodal analysis. These bounded system observations are not scores and
 * do not automatically determine downstream hiring outcomes.
 */
export default function HireSupplementalObservationsPanel({
  observations,
  recordingTargetId,
}: {
  observations: HireSupplementalObservationView[];
  recordingTargetId?: string;
}) {
  if (observations.length === 0) return null;

  return (
    <section
      aria-label="Interview validation timeline"
      className="rounded-xl border border-slate-200 bg-slate-50 p-4 space-y-3"
    >
      <div>
        <h3 className="text-sm font-semibold text-[#0f1419]">
          Interview validation timeline
        </h3>
        <p className="mt-1 text-xs leading-relaxed text-[#536471]">
          These neutral system signals are available for human review beside the
          full interview recording. They are not interview scores and do not
          automatically determine a hiring decision, stage, ranking,
          recommendation, or export.
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
            <ul className="space-y-2 text-xs text-[#0f1419]">
              {observation.report.events.map((event, index) => (
                <li
                  key={`${event.kind}-${event.startMs}-${event.endMs}-${index}`}
                  className="rounded border border-slate-100 bg-slate-50 px-2 py-1.5"
                >
                  <p>
                    {eventLabel(event)} · {formatElapsed(event.startMs)}–
                    {formatElapsed(event.endMs)}
                  </p>
                  <p className="mt-0.5 text-[#536471]">
                    Signal: {sourceLabel(event.source)}
                    {recordingTargetId ? (
                      <>
                        {" · "}
                        <a
                          href={`#${recordingTargetId}`}
                          className="font-semibold text-[#2563eb] underline"
                        >
                          Review recording
                        </a>
                      </>
                    ) : null}
                  </p>
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
  sourceLabel,
};
