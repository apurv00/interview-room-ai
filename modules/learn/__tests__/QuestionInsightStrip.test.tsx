/**
 * Pathway P2 Wave 5 (5B fallback) — QuestionInsightStrip tests.
 *
 * The strip is the fallback when a session's `feedback.ideal_answers`
 * doesn't have an entry for this question (older sessions, generation
 * failure). Locks the rule: render only when a meaningful coach tip
 * can be produced; render nothing when scores are missing or the tip
 * generator falls back to the generic placeholder.
 */

import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import QuestionInsightStrip from '../components/drill/QuestionInsightStrip'

// `deriveCoachingTip` is the real production function; we don't mock
// it because the strip's whole job is to render its output. Verified
// via direct read of coachingTips.ts that it's pure (no Node-only
// dependencies that would break in jsdom).

describe('QuestionInsightStrip', () => {
  it('renders nothing when scores is null', () => {
    const { container } = render(
      <QuestionInsightStrip
        question="Tell me about a time you led a project."
        questionIndex={0}
        scores={null}
        primaryGap={null}
        domain={null}
        interviewType={null}
      />,
    )
    expect(container.firstChild).toBeNull()
  })

  it('renders the coach hint when scores + a meaningful gap are present', () => {
    render(
      <QuestionInsightStrip
        question="Tell me about a time you led a project."
        questionIndex={0}
        // Low specificity → deriveCoachingTip will produce a
        // specificity-focused, NON-generic tip.
        scores={{
          relevance: 70,
          structure: 70,
          specificity: 30,
          ownership: 70,
        }}
        primaryGap="specificity"
        domain="pm"
        interviewType="behavioral"
      />,
    )
    expect(screen.getByTestId('question-insight-strip')).toBeTruthy()
    expect(screen.getByText(/focus on specificity/i)).toBeTruthy()
  })

  it('renders nothing when deriveCoachingTip returns the generic placeholder', () => {
    // All scores are invalid (NaN) → deriveCoachingTip returns GENERIC_TIP
    // ("Keep going — you are doing well.") which the strip suppresses.
    const { container } = render(
      <QuestionInsightStrip
        question="Q"
        questionIndex={0}
        scores={{
          relevance: NaN as unknown as number,
          structure: NaN as unknown as number,
          specificity: NaN as unknown as number,
          ownership: NaN as unknown as number,
        }}
        primaryGap={null}
        domain={null}
        interviewType={null}
      />,
    )
    expect(container.firstChild).toBeNull()
  })

  it('omits the "focus on X" suffix when primaryGap is null', () => {
    render(
      <QuestionInsightStrip
        question="Q"
        questionIndex={0}
        scores={{
          relevance: 30,
          structure: 70,
          specificity: 70,
          ownership: 70,
        }}
        primaryGap={null}
        domain={null}
        interviewType={null}
      />,
    )
    // The label reads "Coach hint" without a trailing ".· focus on …"
    const label = screen.getByText(/^Coach hint\s*$/)
    expect(label).toBeTruthy()
  })
})
