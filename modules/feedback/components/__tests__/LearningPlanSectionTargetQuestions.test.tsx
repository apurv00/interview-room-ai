import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import LearningPlanSection from '../LearningPlanSection'
import type { FeedbackData } from '@shared/types'

vi.mock('next/link', () => ({
  default: ({ children, ...rest }: { children: React.ReactNode }) => <a {...rest}>{children}</a>,
}))

function makeFeedback(
  drillOverrides: Partial<NonNullable<FeedbackData['drill_recommendations']>[number]>[]
): FeedbackData {
  return {
    overall_score: 70,
    pass_probability: 'Medium',
    confidence_level: 'Medium',
    confidence_trend: 'stable',
    red_flags: [],
    top_3_improvements: [],
    dimensions: {
      answer_quality: { score: 70, strengths: [], weaknesses: [] },
      communication: { score: 70, wpm: 140, filler_rate: 0.04, pause_score: 70, rambling_index: 0.2 },
      engagement_signals: { score: 70, engagement_score: 70, composure_under_pressure: 70, energy_consistency: 0.8, confidence_trend: 'stable' },
    },
    drill_recommendations: drillOverrides.map((o) => ({
      skillArea: 'Specificity',
      description: 'Practice quoting metrics.',
      practiceQuestions: ['Q1?', 'Q2?'],
      ...o,
    })),
  } as unknown as FeedbackData
}

describe('LearningPlanSection — Phase B targetQuestions preference', () => {
  it('uses structured targetQuestions field when present and non-empty', () => {
    const feedback = makeFeedback([
      {
        skillArea: 'Specificity',
        description: 'Practice quoting metrics.', // no Q-refs in prose
        targetQuestions: [2, 4], // → Q3, Q5
      },
    ])
    render(<LearningPlanSection feedback={feedback} sessionId="session-1" maxQuestionIndex={9} />)
    // Q-chips rendered from structured field, not regex on description.
    expect(screen.getByText('Q3')).toBeInTheDocument()
    expect(screen.getByText('Q5')).toBeInTheDocument()
  })

  it('falls back to regex-parsing description when targetQuestions is missing (old DB rows)', () => {
    const feedback = makeFeedback([
      {
        skillArea: 'Specificity',
        description: 'In Q4 you used "we did X". Practice owning your work.',
        // no targetQuestions field at all (pre-Phase-B data)
      },
    ])
    render(<LearningPlanSection feedback={feedback} sessionId="session-1" maxQuestionIndex={9} />)
    // Q4 appears in BOTH the top-of-card chip row (parsed from prose) AND
    // inline inside the description via TextWithQuestionChips. At least one
    // occurrence proves the fallback path engaged.
    expect(screen.getAllByText('Q4').length).toBeGreaterThanOrEqual(1)
  })

  it('falls back to regex-parsing when targetQuestions is an empty array (cross-cutting drill)', () => {
    const feedback = makeFeedback([
      {
        skillArea: 'General delivery',
        description: 'Slow down throughout — across Q2 and Q5 your WPM exceeded 180.',
        targetQuestions: [], // explicitly empty: cross-cutting drill, regex still finds Q2/Q5
      },
    ])
    render(<LearningPlanSection feedback={feedback} sessionId="session-1" maxQuestionIndex={9} />)
    expect(screen.getAllByText('Q2').length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText('Q5').length).toBeGreaterThanOrEqual(1)
  })
})
