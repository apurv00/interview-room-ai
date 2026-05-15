/**
 * Parse "Q\d+" tokens (and ranges like "Q3-Q5" / "Q3–5") out of feedback strings
 * so the UI can render them as clickable QuestionRefChip components.
 *
 * Returns 0-based question indices (Q1 → 0). Output is deduplicated and
 * preserves first-appearance order.
 *
 * Used by:
 *  - parseQuestionRefSegments() below — for inline rendering inside flowing text
 *  - LearningPlanSection drill cards — for top-of-card chip rows when no
 *    structured `targetQuestions` field exists yet (Phase B will add that)
 */

// Word-boundary-anchored Q\d+ token. Captures the number, and optionally a
// range partner separated by hyphen / en-dash / em-dash, with or without a
// leading "Q" on the partner ("Q3-Q5", "Q3-5", "Q3–Q5", "Q3—5" all work).
const Q_REF_PATTERN = /\bQ(\d+)(?:\s*[-–—]\s*Q?(\d+))?\b/gi

export interface QuestionRefMatch {
  /** 0-based question index (Q1 → 0) */
  questionIndex: number
  /** Original token text as it appeared, e.g. "Q3" or "Q3-Q5" — for chip label fallback */
  raw: string
}

/**
 * Returns the unique 0-based question indices referenced anywhere in the text,
 * in first-appearance order. Ranges expand: "Q3-Q5" yields [2, 3, 4].
 */
export function parseQuestionRefs(text: string): number[] {
  if (!text) return []
  const seen = new Set<number>()
  const out: number[] = []
  for (const match of Array.from(text.matchAll(Q_REF_PATTERN))) {
    const start = parseInt(match[1], 10) - 1
    const end = match[2] ? parseInt(match[2], 10) - 1 : start
    if (Number.isNaN(start)) continue
    const lo = Math.min(start, end)
    const hi = Math.max(start, end)
    for (let i = lo; i <= hi; i++) {
      if (i < 0) continue
      if (!seen.has(i)) {
        seen.add(i)
        out.push(i)
      }
    }
  }
  return out
}

/**
 * Tokenize a feedback string into alternating text/chip segments so the UI can
 * render Q-tokens as <QuestionRefChip> and the rest as plain <span>.
 *
 * Ranges "Q3-Q5" become a single chip token (the chip itself can decide whether
 * to expand the range visually or render the original raw text).
 */
export type QuestionRefSegment =
  | { kind: 'text'; text: string }
  | { kind: 'chip'; questionIndex: number; raw: string; rangeEndIndex?: number }

export function parseQuestionRefSegments(text: string): QuestionRefSegment[] {
  if (!text) return []
  const segments: QuestionRefSegment[] = []
  let cursor = 0
  for (const match of Array.from(text.matchAll(Q_REF_PATTERN))) {
    const start = match.index ?? 0
    const startNum = parseInt(match[1], 10) - 1
    if (Number.isNaN(startNum) || startNum < 0) continue
    if (start > cursor) {
      segments.push({ kind: 'text', text: text.slice(cursor, start) })
    }
    const endNum = match[2] ? parseInt(match[2], 10) - 1 : undefined
    segments.push({
      kind: 'chip',
      questionIndex: startNum,
      raw: match[0],
      rangeEndIndex: endNum != null && endNum !== startNum ? endNum : undefined,
    })
    cursor = start + match[0].length
  }
  if (cursor < text.length) {
    segments.push({ kind: 'text', text: text.slice(cursor) })
  }
  return segments
}
