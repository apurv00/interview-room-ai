/**
 * Format seconds as MM:SS string.
 */
export function formatTime(s: number): string {
  const m = Math.floor(s / 60)
  const sec = Math.floor(s % 60)
  return `${m}:${sec.toString().padStart(2, '0')}`
}

/**
 * Find the last index in a sorted `offsets` array where offsets[i] <= target.
 * Returns -1 if no such index exists. O(log n).
 */
export function bisectLastLE(offsets: number[], target: number): number {
  let lo = 0
  let hi = offsets.length - 1
  let result = -1
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1
    if (offsets[mid] <= target) {
      result = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return result
}
