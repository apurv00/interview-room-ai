'use client'

import { FONT_MONO } from './tokens'
import type { ComposureLevel } from './composureScore'

interface QuestionMarker {
  label: string
  offsetSeconds: number
}

interface QuestionChapterRowProps {
  questions: QuestionMarker[]
  /** Total session duration (denominator for left-percent positioning). */
  totalDurationSec: number
  /** Index of the currently active question; -1 for none. */
  activeIndex: number
  /** Click handler — called with the question's offsetSeconds + 8 (small lede skip per prototype). */
  onJumpToQuestion: (sec: number, index: number) => void
  /**
   * Round 5b feature #8 — per-question composure level (1/2/3 or null when
   * the underlying audio + facial signals are both missing). Renders as a
   * 3-dot indicator under the Q label. `null` entries render no dots.
   */
  composureLevels?: ReadonlyArray<ComposureLevel>
}

/**
 * Renders the 3-dot composure indicator. Filled vs hollow by level.
 * Color shifts with chip active state so it stays legible on both
 * white-on-black (active) and transparent (inactive) chip backgrounds.
 *
 * Monochrome by design (no red/amber/green) — the chip already encodes
 * active state via color, and stacking a second color channel here would
 * exceed Stevens' law thresholds for chip-scale glyphs (too much encoded
 * in too little ink).
 */
function ComposureDots({ level, active }: { level: ComposureLevel; active: boolean }) {
  if (level == null) return null
  const filled = active ? 'bg-white' : 'bg-stone-600'
  const hollow = active ? 'bg-white/30' : 'bg-stone-300'
  return (
    <span
      className="flex items-center gap-[1.5px] mt-[2px]"
      aria-label={`Composure ${level} of 3`}
      data-testid="composure-dots"
      data-level={level}
    >
      {[1, 2, 3].map((n) => (
        <span
          key={n}
          className={`w-[3px] h-[3px] rounded-full ${n <= level ? filled : hollow}`}
        />
      ))}
    </span>
  )
}

/**
 * Tiny "Q1 Q2 Q3 …" chapter buttons positioned above the scrubber. Each
 * button is absolutely positioned at `left: q.offsetSeconds / total * 100%`.
 *
 * The +8s offset on click mirrors the prototype — jumping to exactly `q.start`
 * often lands on a black-frame interviewer-question moment with no signal;
 * the lede content begins shortly after. Match the prototype's behavior.
 *
 * Each chip is a flex column so the optional 3-dot composure indicator
 * (Round 5b #8) renders directly beneath the Q label without disturbing
 * horizontal positioning.
 */
export default function QuestionChapterRow({
  questions,
  totalDurationSec,
  activeIndex,
  onJumpToQuestion,
  composureLevels,
}: QuestionChapterRowProps) {
  if (!questions.length || totalDurationSec <= 0) return null

  return (
    <div className="relative h-[26px] mx-10 mr-[100px]">
      {questions.map((q, i) => {
        const left = (q.offsetSeconds / totalDurationSec) * 100
        const isActive = i === activeIndex
        const level = composureLevels?.[i] ?? null
        return (
          <button
            key={i}
            type="button"
            onClick={() => onJumpToQuestion(q.offsetSeconds + 8, i)}
            className={`absolute top-0 px-[7px] py-px rounded text-[10px] font-semibold leading-[1.4] tracking-[0.04em] cursor-pointer transition-colors flex flex-col items-center ${
              isActive
                ? 'bg-stone-900 text-white border border-stone-900'
                : 'bg-transparent text-stone-600 border border-stone-200 hover:border-stone-300'
            }`}
            style={{
              left: `${left}%`,
              transform: 'translateX(0)',
              fontFamily: FONT_MONO,
            }}
            aria-pressed={isActive}
            title={`Jump to ${q.label}${level != null ? ` · composure ${level}/3` : ''}`}
          >
            {q.label}
            <ComposureDots level={level} active={isActive} />
          </button>
        )
      })}
    </div>
  )
}
