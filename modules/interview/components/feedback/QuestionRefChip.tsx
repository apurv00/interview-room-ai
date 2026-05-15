'use client'

import { type MouseEvent } from 'react'

interface QuestionRefChipProps {
  /** 0-based question index */
  questionIndex: number
  /** When set, renders the original raw token text (e.g. "Q3-Q5") instead of computing the label. */
  rawLabel?: string
  /** End of a range, 0-based. When set, label renders as e.g. "Q3-Q5". */
  rangeEndIndex?: number
  /** Highest valid question index — chip refuses to render (returns plain text) when out of range. */
  maxQuestionIndex?: number
  onClick?: (questionIndex: number) => void
  /** Tone — defaults to "subtle"; "accent" highlights the chip when it's the current row's primary reference. */
  tone?: 'subtle' | 'accent'
}

function buildLabel(
  questionIndex: number,
  rangeEndIndex: number | undefined,
  rawLabel: string | undefined
): string {
  if (rawLabel) return rawLabel
  if (rangeEndIndex != null && rangeEndIndex !== questionIndex) {
    return `Q${questionIndex + 1}–Q${rangeEndIndex + 1}`
  }
  return `Q${questionIndex + 1}`
}

export default function QuestionRefChip({
  questionIndex,
  rawLabel,
  rangeEndIndex,
  maxQuestionIndex,
  onClick,
  tone = 'subtle',
}: QuestionRefChipProps) {
  const label = buildLabel(questionIndex, rangeEndIndex, rawLabel)

  // Out-of-range guard — degrade to plain text so we don't render a dead chip
  // when a stale prompt mentions Q11 but the session only had 8 questions.
  if (maxQuestionIndex != null && questionIndex > maxQuestionIndex) {
    return <span className="font-mono text-[#71767b]">{label}</span>
  }

  const baseStyles =
    tone === 'accent'
      ? 'bg-brand-500/15 border-brand-500/40 text-brand-500 hover:bg-brand-500/25'
      : 'bg-[#f1f5f9] border-[#e1e8ed] text-[#0f1419] hover:bg-white hover:border-[#cfd9de]'

  const handleClick = (e: MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation() // chips often live inside other clickable surfaces (e.g. Moment cards)
    if (onClick) onClick(questionIndex)
  }

  if (!onClick) {
    // Inert chip — just a styled label
    return (
      <span
        className={`inline-flex items-center px-1.5 py-0.5 mx-0.5 rounded-md border text-[11px] font-mono leading-none align-baseline ${baseStyles}`}
      >
        {label}
      </span>
    )
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      className={`inline-flex items-center px-1.5 py-0.5 mx-0.5 rounded-md border text-[11px] font-mono leading-none align-baseline transition cursor-pointer ${baseStyles}`}
      aria-label={`Jump to ${label}`}
      title={`Jump to ${label}`}
    >
      {label}
    </button>
  )
}
