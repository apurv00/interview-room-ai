'use client'

import { FONT_MONO } from './tokens'

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
}

/**
 * Tiny "Q1 Q2 Q3 …" chapter buttons positioned above the scrubber. Each
 * button is absolutely positioned at `left: q.offsetSeconds / total * 100%`.
 *
 * The +8s offset on click mirrors the prototype — jumping to exactly `q.start`
 * often lands on a black-frame interviewer-question moment with no signal;
 * the lede content begins shortly after. Match the prototype's behavior.
 */
export default function QuestionChapterRow({
  questions,
  totalDurationSec,
  activeIndex,
  onJumpToQuestion,
}: QuestionChapterRowProps) {
  if (!questions.length || totalDurationSec <= 0) return null

  return (
    <div className="relative h-[18px] mx-10 mr-[100px]">
      {questions.map((q, i) => {
        const left = (q.offsetSeconds / totalDurationSec) * 100
        const isActive = i === activeIndex
        return (
          <button
            key={i}
            type="button"
            onClick={() => onJumpToQuestion(q.offsetSeconds + 8, i)}
            className={`absolute top-0 px-[7px] py-px rounded text-[10px] font-semibold leading-[1.4] tracking-[0.04em] cursor-pointer transition-colors ${
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
            title={`Jump to ${q.label}`}
          >
            {q.label}
          </button>
        )
      })}
    </div>
  )
}
