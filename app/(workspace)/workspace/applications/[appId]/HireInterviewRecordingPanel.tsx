"use client";

import { useEffect, useState } from "react";

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
}: Props) {
  const [url, setUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const readyRecording = recording?.status === "ready" ? recording : null;
  const recordingAssetId = readyRecording?.assetId ?? null;

  useEffect(() => {
    setUrl(null);
    setLoading(false);
    setError(null);
  }, [recording?.status, recordingAssetId]);

  if (!recording) return null;

  async function openRecording() {
    if (!readyRecording || loading) return;
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/workspace/applications/${encodeURIComponent(applicationId)}/media/${encodeURIComponent(readyRecording.assetId)}`,
        { cache: "no-store" },
      );
      if (!response.ok) throw new Error("recording unavailable");
      const body = (await response.json()) as { url?: unknown };
      if (typeof body.url !== "string" || !body.url) {
        throw new Error("recording unavailable");
      }
      setUrl(body.url);
    } catch {
      setError(
        "The recording is unavailable right now. Try reloading playback access.",
      );
    } finally {
      setLoading(false);
    }
  }

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
          <p className="mt-1 text-xs text-[#536471]">{status.description}</p>
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
            controls
            preload="metadata"
            src={url}
            className="w-full rounded-lg bg-black"
            onError={() => {
              setUrl(null);
              setError(
                "The temporary playback link expired or could not be loaded. Reload playback access.",
              );
            }}
          >
            Your browser cannot play this private interview recording.
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

      {error && <p className="mt-2 text-xs text-[#b42318]">{error}</p>}
    </section>
  );
}
