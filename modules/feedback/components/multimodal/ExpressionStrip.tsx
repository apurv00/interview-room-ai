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
 *   neutral  → 😐
 *   smile    → 🙂
 *   frown    → 😟
 *   surprise → 😯
 *   focused  → 🤔
 *
 * Three distinct semantic states with distinct visual treatments
 * (Codex P2 review on Round 5b — the previous "everything that isn't a
 * known emotion → 😐 dim" path collapsed actual neutral, unknown class,
 * and missing data into the same glyph, lying about data availability):
 *
 *   `expressive` — known non-neutral class. Full opacity, full emoji.
 *   `neutral`    — known neutral class. 😐 at 35% opacity. The user
 *                  *did* look neutral; we want it quieter than emotional
 *                  reads but still recognizable.
 *   `absent`     — missing data OR unrecognized class. Mono em-dash at
 *                  25% opacity. Visually distinct from both real reads
 *                  so the user can't mistake "we have no signal" for
 *                  "the candidate looked neutral".
 */
const EXPRESSION_EMOJI: Record<string, string> = {
  neutral: '😐',
  smile: '🙂',
  frown: '😟',
  surprise: '😯',
  focused: '🤔',
}

type ExpressionState = 'expressive' | 'neutral' | 'absent'

function emojiForExpression(expr: string | undefined): { glyph: string; state: ExpressionState } {
  if (!expr) return { glyph: '—', state: 'absent' }
  const key = expr.toLowerCase()
  if (!(key in EXPRESSION_EMOJI)) return { glyph: '—', state: 'absent' }
  if (key === 'neutral') return { glyph: '😐', state: 'neutral' }
  return { glyph: EXPRESSION_EMOJI[key], state: 'expressive' }
}

const STATE_OPACITY: Record<ExpressionState, number> = {
  expressive: 1,
  neutral: 0.35,
  absent: 0.25,
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
        const { glyph, state } = emojiForExpression(expr)
        // Honest hover label: "no data" for absent, the actual class otherwise.
        const hoverLabel = state === 'absent' ? 'no data' : (expr ?? 'no data')

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
              opacity: STATE_OPACITY[state],
            }}
            title={`${q.label} · ${hoverLabel}`}
            aria-label={`${q.label}: ${hoverLabel}`}
            data-expression-state={state}
          >
            <span aria-hidden="true">{glyph}</span>
          </button>
        )
      })}
    </div>
  )
}
