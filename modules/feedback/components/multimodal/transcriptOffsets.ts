/**
 * Helpers for converting transcript timestamps to seconds-from-session-start.
 *
 * Two timestamp regimes observed in production:
 *   (a) `timestamp` is a real epoch ms (e.g. 1747370812345). Subtract a
 *       session-start origin and divide by 1000.
 *   (b) `timestamp` is already seconds-from-start (small number).
 * Heuristic: anything > 1e10 is treated as epoch ms; smaller as seconds.
 *
 * When the caller can supply `sessionStartedAt`, use it as the origin for
 * the epoch-ms regime. When sessionStartedAt is null/missing (older or
 * session-recovered data), Codex P2 on PR #370 caught that the previous
 * behavior of returning 0 for every epoch-ms entry collapsed the whole
 * transcript to `0:00`. Fall back to the first transcript entry's
 * timestamp as the origin instead — preserves relative spacing between
 * lines (which is what the user actually clicks on / sees) at the cost
 * of losing the absolute offset (which we couldn't show anyway without
 * sessionStartedAt).
 */

interface TimestampedEntry {
  timestamp: number
}

/** Threshold above which a numeric timestamp is treated as epoch ms. */
const EPOCH_MS_THRESHOLD = 1e10

/**
 * Pick the origin for epoch-ms timestamps. Prefer the caller-provided
 * `sessionStartedAt`. When absent, scan the transcript for the first
 * epoch-ms entry and use its timestamp.
 */
export function computeTranscriptOrigin(
  transcript: ReadonlyArray<TimestampedEntry>,
  sessionStartedAt: number | null | undefined
): number {
  if (sessionStartedAt && sessionStartedAt > 0) return sessionStartedAt
  for (const e of transcript) {
    if (Number.isFinite(e.timestamp) && e.timestamp > EPOCH_MS_THRESHOLD) {
      return e.timestamp
    }
  }
  return 0
}

/**
 * Convert a single timestamp to seconds-from-start using the given origin.
 * Entries that already look like seconds (small numbers) pass through;
 * entries that look like epoch ms get normalized against `origin`.
 */
export function entrySeconds(timestamp: number, origin: number): number {
  if (!Number.isFinite(timestamp)) return 0
  if (timestamp > EPOCH_MS_THRESHOLD) {
    return Math.max(0, (timestamp - origin) / 1000)
  }
  return Math.max(0, timestamp)
}

/**
 * Convenience: compute the full seconds-from-start array for a transcript
 * in one pass, choosing the right origin automatically.
 */
export function computeTranscriptSeconds(
  transcript: ReadonlyArray<TimestampedEntry>,
  sessionStartedAt: number | null | undefined
): number[] {
  const origin = computeTranscriptOrigin(transcript, sessionStartedAt)
  return transcript.map((e) => entrySeconds(e.timestamp, origin))
}
