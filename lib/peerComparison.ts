/**
 * Binary search: find insertion index for target in a sorted array.
 * Returns count of elements strictly less than target (bisect-left).
 */
function bisectLeft(sorted: number[], target: number): number {
  let lo = 0
  let hi = sorted.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (sorted[mid] < target) lo = mid + 1
    else hi = mid
  }
  return lo
}

function bisectRight(sorted: number[], target: number): number {
  let lo = 0
  let hi = sorted.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (sorted[mid] <= target) lo = mid + 1
    else hi = mid
  }
  return lo
}

/**
 * Compute percentile using binary search. O(log n) instead of O(n).
 * For ties, uses midpoint of the range (bisectLeft + bisectRight) / 2.
 */
export function computePercentile(sortedScores: number[], userScore: number): number {
  if (sortedScores.length === 0) return 50
  const left = bisectLeft(sortedScores, userScore)
  const right = bisectRight(sortedScores, userScore)
  return Math.round(((left + right) / 2 / sortedScores.length) * 100)
}
