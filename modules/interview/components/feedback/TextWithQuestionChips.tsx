'use client'

import { Fragment } from 'react'
import { parseQuestionRefSegments } from '@interview/utils/parseQuestionRefs'
import QuestionRefChip from '@interview/components/feedback/QuestionRefChip'

interface TextWithQuestionChipsProps {
  text: string
  /** Click handler invoked with the 0-based questionIndex of the clicked chip. */
  onQuestionClick?: (questionIndex: number) => void
  /** Highest valid question index for chip range validation. */
  maxQuestionIndex?: number
  /** Optional CSS class for the wrapping <span>. */
  className?: string
}

/**
 * Renders a feedback string with any "Q\d+" or "Q3-Q5" tokens turned into
 * clickable QuestionRefChip components. Plain text segments preserve original
 * spacing/punctuation. Used inside top_3_improvements, red_flags, coaching
 * tips, and drill descriptions to give the user a one-click path from a
 * feedback line back to the source question.
 */
export default function TextWithQuestionChips({
  text,
  onQuestionClick,
  maxQuestionIndex,
  className,
}: TextWithQuestionChipsProps) {
  const segments = parseQuestionRefSegments(text)

  if (segments.length === 0) {
    return <span className={className}>{text}</span>
  }

  return (
    <span className={className}>
      {segments.map((seg, i) => {
        if (seg.kind === 'text') {
          return <Fragment key={i}>{seg.text}</Fragment>
        }
        return (
          <QuestionRefChip
            key={i}
            questionIndex={seg.questionIndex}
            rawLabel={seg.raw}
            rangeEndIndex={seg.rangeEndIndex}
            maxQuestionIndex={maxQuestionIndex}
            onClick={onQuestionClick}
          />
        )
      })}
    </span>
  )
}
