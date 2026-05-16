'use client'

import type { FacialSegment } from '@shared/types/multimodal'

interface QuestionMarker {
  label: string
  offsetSeconds: number
}

interface ExpressionStripProps {
  questions: QuestionMarker[]
  totalDurationSec: number
  /** Per-question dominant expression from `analysis.facialSegments[i].dominantExpression`.
   *  Length must align by index with `questions`. Missing entries render no emoji
   *  for that Q (the slot stays blank to preserve column alignment with QChapterRow). */
  facialSegments?: ReadonlyArray<FacialSegment | undefined>
  /** Same click contract as QuestionChapterRow — receives (offsetSeconds+8, index). */
  onJumpToQuestion: (sec: number, index: number) => void
}

/**
 * Maps the 5 MediaPipe expression classes to single-glyph emojis. Per the
 * user's explicit sign-off in Round 5b planning:
 *   neutral  → 😐  (rendered at low opacity so it doesn't compete visually)
 *   smile    → 🙂
 *   frown    → 😟
 *   surprise → 😯
 *   focused  → 🤔
 *
 * Any unknown class falls back to the neutral glyph (dim) — same honest-data
 * principle as composureScore: don't fabricate a vibe we don't have.
 */
const EXPRESSION_EMOJI: Record<string, string> = {
  neutral: '😐',
  smile: '🙂',
  frown: '😟',
  surprise: '😯',
  focused: '🤔',
}

function emojiForExpression(expr: string | undefined): { glyph: string; isNeutral: boolean } {
  if (!expr) return { glyph: '😐', isNeutral: true }
  const key = expr.toLowerCase()
  const glyph = EXPRESSION_EMOJI[key] ?? '😐'
  return { glyph, isNeutral: key === 'neutral' || !(key in EXPRESSION_EMOJI) }
}

/**
 * Per-question expression annotation strip. Sits directly below
 * QuestionChapterRow — same horizontal positioning math so each emoji
 * stacks under the Q chip it annotates (Gestalt common-region; the user
 * reads them as paired without instruction).
 *
 * Round 5b feature #5. Pre-attentive coding (Treisman) — emojis bypass
 * language parsing, recognized in <250ms. The dim neutral treatment
 * preserves visual rhythm so non-neutral glyphs pop via contrast
 * without breaking the column alignment.
 *
 * Hidden entirely when no facial data is available (privacy mode,
 * camera off, pre-MediaPipe sessions) — honest-data rule: don't render
 * a row of placeholder/neutral emojis when we have nothing to say.
 */
export default function ExpressionStrip({
  questions,
  totalDurationSec,
  facialSegments,
  onJumpToQuestion,
}: ExpressionStripProps) {
  if (!questions.length || totalDurationSec <= 0) return null

  // Hide the entire strip when no facial data exists at all (every entry
  // missing or undefined). If at least one Q has data, we keep the strip
  // and dim the others — preserves column alignment.
  const hasAnyData = facialSegments?.some((s) => s && s.dominantExpression) ?? false
  if (!hasAnyData) return null

  return (
    <div
      className="relative h-[20px] mx-10 mr-[100px]"
      data-testid="expression-strip"
      aria-label="Per-question dominant expression"
    >
      {questions.map((q, i) => {
        const left = (q.offsetSeconds / totalDurationSec) * 100
        const seg = facialSegments?.[i]
        const expr = seg?.dominantExpression
        const { glyph, isNeutral } = emojiForExpression(expr)

        return (
          <button
            key={i}
            type="button"
            onClick={() => onJumpToQuestion(q.offsetSeconds + 8, i)}
            className="absolute top-0 grid place-items-center w-6 h-5 cursor-pointer hover:scale-110 transition-transform bg-transparent border-0 p-0"
            style={{
              left: `${left}%`,
              transform: 'translateX(0)',
              fontSize: '14px',
              lineHeight: 1,
              opacity: isNeutral ? 0.35 : 1,
            }}
            title={`${q.label} · ${expr || 'no expression data'}`}
            aria-label={`${q.label}: ${expr || 'no expression data'}`}
          >
            <span aria-hidden="true">{glyph}</span>
          </button>
        )
      })}
    </div>
  )
}
