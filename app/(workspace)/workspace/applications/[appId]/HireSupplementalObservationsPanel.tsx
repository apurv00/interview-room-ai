import type {
  HireMultimodalObservationEvent,
  HireMultimodalObservationPlaybackClock,
  HireMultimodalObservationReport,
} from "@shared/contracts/hireMultimodalObservationBridge";

export interface HireSupplementalObservationView {
  observedAt: string;
  report: HireMultimodalObservationReport;
}

export type HireObservationRecordingKind = "camera" | "screen";

export interface HireObservationRecordingRequest {
  kind: HireObservationRecordingKind;
  startMs: number;
}

interface RecordingAvailability {
  camera: boolean;
  screen: boolean;
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

function preferredRecordingKind(
  source: HireMultimodalObservationEvent["source"],
): HireObservationRecordingKind {
  switch (source) {
    case "fullscreen":
    case "browser_visibility":
    case "browser_focus":
    case "display_surface":
    case "display_track":
    case "display_recorder":
      return "screen";
    case "camera_track":
    case "microphone_track":
    case "speech_video_corroboration":
    case "camera":
      return "camera";
  }
}

function availableRecordingKind(
  source: HireMultimodalObservationEvent["source"],
  availability: RecordingAvailability,
): HireObservationRecordingKind | null {
  const preferred = preferredRecordingKind(source);
  if (availability[preferred]) return preferred;
  const fallback = preferred === "camera" ? "screen" : "camera";
  return availability[fallback] ? fallback : null;
}

function recorderStartOffset(
  clock: HireMultimodalObservationPlaybackClock | undefined,
  kind: HireObservationRecordingKind,
): number | null {
  if (!clock || clock.protocolVersion !== 1) return null;
  const offset =
    kind === "camera"
      ? clock.cameraRecorderStartOffsetMs
      : clock.screenRecorderStartOffsetMs;
  return Number.isInteger(offset) && (offset as number) >= 0
    ? (offset as number)
    : null;
}

function availableRecordingTarget(
  event: HireMultimodalObservationEvent,
  availability: RecordingAvailability,
  clock: HireMultimodalObservationPlaybackClock | undefined,
): HireObservationRecordingRequest | null {
  const cameraOffset = recorderStartOffset(clock, "camera");
  const screenOffset = recorderStartOffset(clock, "screen");
  const exactAvailability: RecordingAvailability = {
    camera:
      availability.camera &&
      cameraOffset !== null &&
      event.startMs >= cameraOffset,
    screen:
      availability.screen &&
      screenOffset !== null &&
      event.startMs >= screenOffset,
  };
  const kind = availableRecordingKind(event.source, exactAvailability);
  if (!kind) return null;
  const offset = recorderStartOffset(clock, kind);
  if (offset === null) return null;
  return { kind, startMs: event.startMs - offset };
}

/**
 * Deliberately independent from the full recording and the separate Hire
 * multimodal analysis. These bounded system observations are not scores and
 * do not automatically determine downstream hiring outcomes.
 */
export default function HireSupplementalObservationsPanel({
  observations,
  recordingAvailability = { camera: false, screen: false },
  onReviewRecording,
}: {
  observations: HireSupplementalObservationView[];
  recordingAvailability?: RecordingAvailability;
  onReviewRecording?: (request: HireObservationRecordingRequest) => void;
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
          recommendation, or export. Recording review links appear only when
          an exact recorder clock was captured.
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
              {observation.report.events.map((event, index) => {
                const recordingTarget = availableRecordingTarget(
                  event,
                  recordingAvailability,
                  observation.report.playbackClock,
                );
                const elapsed = formatElapsed(event.startMs);
                return (
                  <li
                    key={`${event.kind}-${event.startMs}-${event.endMs}-${index}`}
                    className="rounded border border-slate-100 bg-slate-50 px-2 py-1.5"
                  >
                    <p>
                      {eventLabel(event)} · {elapsed}–
                      {formatElapsed(event.endMs)}
                    </p>
                    <p className="mt-0.5 text-[#536471]">
                      Signal: {sourceLabel(event.source)}
                      {recordingTarget && onReviewRecording ? (
                        <>
                          {" · "}
                          <button
                            type="button"
                            onClick={() =>
                              onReviewRecording({
                                ...recordingTarget,
                              })
                            }
                            aria-label={`Review ${recordingTarget.kind === "screen" ? "shared display" : "interview"} recording for event at ${elapsed}`}
                            className="font-semibold text-[#2563eb] underline"
                          >
                            Review recording
                          </button>
                        </>
                      ) : onReviewRecording &&
                        (recordingAvailability.camera ||
                          recordingAvailability.screen) ? (
                        <>
                          {" · "}
                          <span>Exact recording time unavailable for this capture.</span>
                        </>
                      ) : null}
                    </p>
                  </li>
                );
              })}
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
  preferredRecordingKind,
  availableRecordingKind,
  recorderStartOffset,
  availableRecordingTarget,
};
