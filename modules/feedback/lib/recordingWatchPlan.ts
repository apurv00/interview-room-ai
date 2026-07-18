/**
 * Recording-watcher plan — how long the feedback page should poll for a
 * late-landing camera upload, and what the video-less Multimodal fallback
 * should say meanwhile.
 *
 * History: the watcher was a flat 15 × 3s (~45s), sized for 10-minute
 * interviews whose ~30-50MB uploads finish fast. A 30-minute interview's
 * ~157MB multipart routinely outlives 45s, so the page showed a definitive
 * "Video wasn't recorded" while the upload quietly completed (2026-07-17
 * staging gate). The naive fix — a longer budget for everyone — would make
 * the optimistic "still uploading…" message LIE for five minutes on every
 * history revisit of privacy-mode, retention-deleted, and never-recorded
 * sessions. So the extended budget requires positive evidence that an upload
 * is plausibly in flight.
 *
 * Pure and injected-fact-based so the matrix is unit-testable; the page
 * supplies `hasQueuedUpload` from the IndexedDB retry queue (zombie records
 * already excluded by hasQueuedReplayUpload).
 */

export type RecordingFallback = 'none' | 'uploading' | 'privacy'

export interface RecordingWatchPlan {
  /** 0 disables the watcher entirely. */
  maxAttempts: number
  fallback: RecordingFallback
}

/** Upload plausibly in flight when the interview ended this recently. */
export const RECENT_COMPLETION_WINDOW_MS = 15 * 60 * 1000

/** Extended budget: 100 × 3s ≈ 5 min — covers a 157MB multipart on slow wifi. */
export const EXTENDED_WATCH_ATTEMPTS = 100

/** Legacy budget: quick pickup of an IDB drain finishing on this very mount. */
export const SHORT_WATCH_ATTEMPTS = 15

export function resolveRecordingWatch(input: {
  privacyMode: boolean
  completedAtMs: number | null
  nowMs: number
  hasQueuedUpload: boolean
}): RecordingWatchPlan {
  if (input.privacyMode) {
    // Camera blob is deliberately never uploaded — polling for it and
    // claiming "uploading" would both be wrong.
    return { maxAttempts: 0, fallback: 'privacy' }
  }
  if (input.hasQueuedUpload) {
    return { maxAttempts: EXTENDED_WATCH_ATTEMPTS, fallback: 'uploading' }
  }
  if (
    input.completedAtMs !== null &&
    input.nowMs - input.completedAtMs < RECENT_COMPLETION_WINDOW_MS
  ) {
    return { maxAttempts: EXTENDED_WATCH_ATTEMPTS, fallback: 'uploading' }
  }
  // Old session, no queued upload: nothing is coming. Keep a short watcher
  // only to pick up a same-mount IDB drain from another recent session shape,
  // and show the definitive message immediately rather than an optimistic lie.
  return { maxAttempts: SHORT_WATCH_ATTEMPTS, fallback: 'none' }
}
