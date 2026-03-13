/**
 * Compute the offset in seconds of a transcript entry relative to the session start.
 * Returns 0 if startedAt is null (e.g., localStorage fallback without timing data).
 * Clamps negative offsets (clock skew) to 0.
 */
export function computeOffsetSeconds(timestamp: number, startedAt: number | null): number {
  if (!startedAt) return 0
  return Math.max(0, (timestamp - startedAt) / 1000)
}
