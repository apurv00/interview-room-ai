"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import {
  hireRecordingCaptionsToVtt,
  type HireRecordingCaption,
} from "./recordingCaptions";

export type HireRecordingUnavailableReason =
  | "capture_failed"
  | "durable_queue_failed"
  | "upload_rejected"
  | "retry_exhausted"
  | "upload_expired";

export type HireInterviewRecordingView =
  | {
      status: "ready";
      assetId: string;
      capturedAt: string;
      bytes: number;
    }
  | { status: "capturing" | "awaiting_transfer" | "removed" }
  | { status: "unavailable"; reason: HireRecordingUnavailableReason };

interface Props {
  applicationId: string;
  recording: HireInterviewRecordingView | null | undefined;
  playbackRequest?: HireRecordingPlaybackRequest;
  captions?: HireRecordingCaption[];
}

export interface HireRecordingPlaybackRequest {
  id: number;
  startMs: number;
}

function formatBytes(bytes: number): string {
  if (bytes < 1_000_000) return `${Math.max(1, Math.round(bytes / 1_000))} KB`;
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

function unavailableDescription(reason: HireRecordingUnavailableReason): string {
  switch (reason) {
    case "capture_failed":
      return "The recording could not be captured for this interview.";
    case "durable_queue_failed":
      return "The recording could not be retained for delivery.";
    case "upload_rejected":
      return "The recording service could not accept this recording.";
    case "retry_exhausted":
      return "Recording delivery did not complete after bounded retries.";
    case "upload_expired":
      return "The recording upload window expired before transfer completed.";
  }
}

/**
 * The detail endpoint exposes only an opaque asset id. This client component
 * obtains a short-lived playback URL from the existing membership-checked
 * media capability endpoint only after the recruiter elects to play it.
 */
export default function HireInterviewRecordingPanel({
  applicationId,
  recording,
  playbackRequest,
  captions = [],
}: Props) {
  const [url, setUrl] = useState<string | null>(null);
  const [captionsUrl, setCaptionsUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const openingRef = useRef(false);
  const capabilityControllerRef = useRef<AbortController | null>(null);
  const capabilityEpochRef = useRef(0);
  const pendingSeekMsRef = useRef<number | null>(null);
  const handledPlaybackRequestIdRef = useRef<number | null>(null);
  const descriptionId = useId();
  const readyRecording = recording?.status === "ready" ? recording : null;
  const recordingAssetId = readyRecording?.assetId ?? null;
  const captionsVtt = useMemo(
    () => (captions.length > 0 ? hireRecordingCaptionsToVtt(captions) : null),
    [captions],
  );

  useEffect(() => {
    capabilityEpochRef.current += 1;
    capabilityControllerRef.current?.abort();
    capabilityControllerRef.current = null;
    openingRef.current = false;
    setUrl(null);
    setLoading(false);
    setError(null);
    pendingSeekMsRef.current = null;
    return () => {
      capabilityEpochRef.current += 1;
      capabilityControllerRef.current?.abort();
      capabilityControllerRef.current = null;
      openingRef.current = false;
    };
  }, [recording?.status, recordingAssetId]);

  useEffect(() => {
    if (
      !captionsVtt ||
      typeof URL.createObjectURL !== "function" ||
      typeof URL.revokeObjectURL !== "function"
    ) {
      setCaptionsUrl(null);
      return;
    }
    const objectUrl = URL.createObjectURL(
      new Blob([captionsVtt], { type: "text/vtt" }),
    );
    setCaptionsUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [captionsVtt]);

  const applyPendingSeek = useCallback(() => {
    const video = videoRef.current;
    const pendingMs = pendingSeekMsRef.current;
    if (!video || pendingMs === null || video.readyState < 1) return;
    const requestedSeconds = Math.max(0, pendingMs / 1_000);
    video.currentTime = Number.isFinite(video.duration)
      ? Math.min(requestedSeconds, Math.max(0, video.duration))
      : requestedSeconds;
    pendingSeekMsRef.current = null;
    video.focus();
    void video.play().catch(() => undefined);
  }, []);

  const handleLoadedMetadata = useCallback(() => {
    const hadPendingSeek = pendingSeekMsRef.current !== null;
    applyPendingSeek();
    if (!hadPendingSeek) videoRef.current?.focus();
  }, [applyPendingSeek]);

  const openRecording = useCallback(async () => {
    if (!readyRecording || openingRef.current) return;
    const requestEpoch = capabilityEpochRef.current;
    const controller = new AbortController();
    capabilityControllerRef.current = controller;
    openingRef.current = true;
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/workspace/applications/${encodeURIComponent(applicationId)}/media/${encodeURIComponent(readyRecording.assetId)}`,
        { cache: "no-store", signal: controller.signal },
      );
      if (!response.ok) throw new Error("recording unavailable");
      const body = (await response.json()) as { url?: unknown };
      if (typeof body.url !== "string" || !body.url) {
        throw new Error("recording unavailable");
      }
      if (
        controller.signal.aborted ||
        capabilityEpochRef.current !== requestEpoch
      ) {
        return;
      }
      setUrl(body.url);
    } catch (cause) {
      if (
        controller.signal.aborted ||
        capabilityEpochRef.current !== requestEpoch ||
        (cause instanceof DOMException && cause.name === "AbortError")
      ) {
        return;
      }
      setError(
        "The recording is unavailable right now. Try reloading playback access.",
      );
    } finally {
      if (capabilityControllerRef.current === controller) {
        capabilityControllerRef.current = null;
        openingRef.current = false;
        setLoading(false);
      }
    }
  }, [applicationId, readyRecording]);

  useEffect(() => {
    if (
      !playbackRequest ||
      !readyRecording ||
      handledPlaybackRequestIdRef.current === playbackRequest.id
    ) {
      return;
    }
    // Treat a supplemental-observation request as a one-shot command. Parent
    // polling can recreate the surrounding data without seeking an actively
    // playing video again, and a failed capability must not auto-remint until
    // the recruiter explicitly retries.
    handledPlaybackRequestIdRef.current = playbackRequest.id;
    pendingSeekMsRef.current = playbackRequest.startMs;
    if (url) applyPendingSeek();
    else void openRecording();
  }, [applyPendingSeek, openRecording, playbackRequest, readyRecording, url]);

  if (!recording) return null;

  const status = (() => {
    switch (recording.status) {
      case "capturing":
        return {
          label: "Recording in progress",
          description: "The candidate interview is still being recorded.",
        };
      case "awaiting_transfer":
        return {
          label: "Preparing recording",
          description:
            "Waiting for the candidate recording to upload and transfer. If the candidate camera was unavailable, no recording will appear.",
        };
      case "removed":
        return {
          label: "Recording removed",
          description:
            "This interview media was removed under the retention or deletion policy.",
        };
      case "unavailable":
        return {
          label: "Recording unavailable",
          description: unavailableDescription(recording.reason),
        };
      case "ready":
        return {
          label: "Full interview recording",
          description: `Captured ${new Date(recording.capturedAt).toLocaleString()} · ${formatBytes(recording.bytes)}`,
        };
    }
  })();

  return (
    <section
      aria-label="Interview recording"
      className="rounded-xl border border-[#dbe5ef] bg-[#f8fafc] p-4"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-[#0f1419]">{status.label}</p>
          <p id={descriptionId} className="mt-1 text-xs text-[#536471]">
            {status.description}
          </p>
        </div>
        {recording.status === "ready" && !url && (
          <button
            type="button"
            onClick={() => void openRecording()}
            disabled={loading}
            className="rounded-lg bg-[#2563eb] px-3 py-2 text-xs font-semibold text-white disabled:cursor-wait disabled:bg-[#8b98a5]"
          >
            {loading ? "Opening recording…" : "Play full interview"}
          </button>
        )}
      </div>

      {recording.status === "ready" && url && (
        <div className="mt-3 space-y-2">
          <video
            ref={videoRef}
            controls
            tabIndex={0}
            preload="metadata"
            src={url}
            aria-label="Private full interview recording"
            aria-describedby={descriptionId}
            className="w-full rounded-lg bg-black"
            onLoadedMetadata={handleLoadedMetadata}
            onError={() => {
              setUrl(null);
              setError(
                "The temporary playback link expired or could not be loaded. Reload playback access.",
              );
            }}
          >
            {captionsUrl && (
              <track
                kind="captions"
                src={captionsUrl}
                srcLang="en"
                label="English interview transcript"
                default
              />
            )}
            Your browser cannot play this private interview recording.
          </video>
          {captions.length > 0 && (
            <details className="rounded-lg border border-slate-200 bg-white p-2 text-xs">
              <summary className="cursor-pointer font-semibold text-[#0f1419]">
                Read synchronized interview transcript
              </summary>
              <ol className="mt-2 space-y-1 text-[#536471]">
                {captions.map((caption, index) => (
                  <li key={`${caption.startMs}-${caption.endMs}-${index}`}>
                    <span className="font-medium text-[#0f1419]">
                      {Math.floor(caption.startMs / 60_000)}:
                      {String(Math.floor(caption.startMs / 1_000) % 60).padStart(2, "0")}
                    </span>{" "}
                    {caption.text}
                  </li>
                ))}
              </ol>
            </details>
          )}
          <button
            type="button"
            onClick={() => {
              setUrl(null);
              void openRecording();
            }}
            disabled={loading}
            className="text-xs font-semibold text-[#2563eb] underline disabled:text-[#8b98a5]"
          >
            Reload playback access
          </button>
        </div>
      )}

      {error && (
        <p role="alert" className="mt-2 text-xs text-[#b42318]">
          {error}
        </p>
      )}
    </section>
  );
}
