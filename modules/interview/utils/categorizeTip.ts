/**
 * Heuristic category badge for a coaching tip string.
 * Phase A: pure keyword matching (no schema field yet).
 * Phase B will add a structured `category` field on coaching tips and this
 * function becomes the fallback for backward-compat with old data.
 */

export type TipCategory = 'Behavior' | 'Communication' | 'Content' | 'General'

const BEHAVIOR_KEYWORDS = [
  'eye contact', 'eye-contact', 'body language', 'gesture', 'posture',
  'smile', 'smiling', 'fidget', 'fidgeting', 'expression', 'facial',
  'head', 'hand', 'shoulders', 'lean', 'sitting', 'looking',
] as const

const COMMUNICATION_KEYWORDS = [
  'pace', 'pacing', 'filler', 'fillers', 'pause', 'pauses', 'pausing',
  'wpm', 'words per minute', 'rambl', 'concise', 'conciseness', 'tone',
  'voice', 'volume', 'speed', 'speak slow', 'speak fast', 'cadence',
  'hesitat', 'um ', 'uh ',
] as const

const CONTENT_KEYWORDS = [
  'structure', 'star', 'specificity', 'specific', 'ownership', 'metric',
  'metrics', 'example', 'examples', 'detail', 'details', 'data',
  'evidence', 'quantif', 'concrete', 'situation', 'task', 'action',
  'result', 'outcome', 'context', 'framework', 'i did', 'we did',
  "i led", "i designed", "i built", "i shipped", 'relevance', 'jd',
] as const

function countKeywords(haystack: string, keywords: readonly string[]): number {
  let n = 0
  for (const k of keywords) {
    // Count distinct occurrences of each keyword (substring), so a tip that
    // mentions "pace" twice counts twice — heavier weight for repeat mentions.
    let from = 0
    while (true) {
      const idx = haystack.indexOf(k, from)
      if (idx < 0) break
      n++
      from = idx + k.length
    }
  }
  return n
}

export function categorizeTip(tip: string): TipCategory {
  if (!tip) return 'General'
  const lc = tip.toLowerCase()
  const scores: Record<Exclude<TipCategory, 'General'>, number> = {
    Behavior: countKeywords(lc, BEHAVIOR_KEYWORDS),
    Communication: countKeywords(lc, COMMUNICATION_KEYWORDS),
    Content: countKeywords(lc, CONTENT_KEYWORDS),
  }
  const winner = (Object.keys(scores) as Array<keyof typeof scores>).reduce(
    (best, k) => (scores[k] > scores[best] ? k : best),
    'Behavior' as keyof typeof scores
  )
  return scores[winner] > 0 ? winner : 'General'
}
