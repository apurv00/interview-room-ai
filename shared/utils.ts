/**
 * Format seconds as MM:SS string. Guards against Infinity / NaN / negatives
 * which can come from MediaRecorder WebM files whose duration metadata is
 * not yet available.
 */
export function formatTime(s: number): string {
  if (!Number.isFinite(s) || s < 0) return '0:00'
  const m = Math.floor(s / 60)
  const sec = Math.floor(s % 60)
  return `${m}:${sec.toString().padStart(2, '0')}`
}

/**
 * Robustly extracts JSON from Claude responses that may include preamble text,
 * trailing comments, code fences, or other non-JSON content.
 */
export function extractJSON(raw: string): string {
  const jsonStart = raw.search(/[\[{]/)
  if (jsonStart === -1) return raw

  let depth = 0
  let inString = false
  let escape = false

  for (let i = jsonStart; i < raw.length; i++) {
    const ch = raw[i]
    if (escape) { escape = false; continue }
    if (ch === '\\') { escape = true; continue }
    if (ch === '"') { inString = !inString; continue }
    if (inString) continue
    if (ch === '{' || ch === '[') depth++
    if (ch === '}' || ch === ']') {
      depth--
      if (depth === 0) return raw.slice(jsonStart, i + 1)
    }
  }

  // Fallback if braces aren't balanced (truncated response): strip code fences
  return raw
    .replace(/^[\s\S]*?```(?:json)?\s*\n?/, '')
    .replace(/\n?\s*```[\s\S]*$/, '')
    .trim()
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
