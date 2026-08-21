"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import type {
  HireRecordingPlaybackRequest,
  HireRecordingUnavailableReason,
} from "./HireInterviewRecordingPanel";

export type HireScreenRecordingView =
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
  recording: HireScreenRecordingView | null | undefined;
  playbackRequest?: HireRecordingPlaybackRequest;
}

function formatBytes(bytes: number): string {
  if (bytes < 1_000_000) {
    return `${Math.max(1, Math.round(bytes / 1_000))} KB`;
  }
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

function unavailableDescription(reason: HireRecordingUnavailableReason): string {
  switch (reason) {
    case "capture_failed":
      return "The shared display could not be captured for this interview.";
    case "durable_queue_failed":
      return "The shared display recording could not be retained for delivery.";
    case "upload_rejected":
      return "The recording service could not accept the shared display recording.";
    case "retry_exhausted":
      return "Shared display delivery did not complete after bounded retries.";
    case "upload_expired":
      return "The shared display upload window expired before transfer completed.";
  }
}

/**
 * Display playback remains capability-gated: the detail response contains
 * only an opaque asset id, and the member explicitly mints a short-lived URL.
 */
export default function HireScreenRecordingPanel({
  applicationId,
  recording,
  playbackRequest,
}: Props) {
  const [url, setUrl] = useState<string | null>(null);
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
  const assetId = readyRecording?.assetId ?? null;

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
  }, [recording?.status, assetId]);

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
      if (!response.ok) throw new Error("display recording unavailable");
      const body = (await response.json()) as {
        url?: unknown;
        kind?: unknown;
      };
      if (
        typeof body.url !== "string" ||
        !body.url ||
        body.kind !== "screen_recording"
      ) {
        throw new Error("display recording unavailable");
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
        "The shared display recording is unavailable right now. Try reloading playback access.",
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
    // One observation request may cause one capability mint and seek. A
    // parent refresh or a playback error must not replay that command.
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
          label: "Display recording in progress",
          description: "The candidate’s shared display is still being recorded.",
        };
      case "awaiting_transfer":
        return {
          label: "Preparing display recording",
          description:
            "Waiting for the candidate’s shared display recording to upload and transfer.",
        };
      case "removed":
        return {
          label: "Display recording removed",
          description:
            "This interview media was removed under the retention or deletion policy.",
        };
      case "unavailable":
        return {
          label: "Display recording unavailable",
          description: unavailableDescription(recording.reason),
        };
      case "ready":
        return {
          label: "Shared display recording",
          description: `Captured ${new Date(recording.capturedAt).toLocaleString()} · ${formatBytes(recording.bytes)}`,
        };
    }
  })();

  return (
    <section
      aria-label="Shared display recording"
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
            {loading ? "Opening display…" : "Play shared display"}
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
            aria-label="Private shared display recording"
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
            Your browser cannot play this private shared display recording.
          </video>
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
