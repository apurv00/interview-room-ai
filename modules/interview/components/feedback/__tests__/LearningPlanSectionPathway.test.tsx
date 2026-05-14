import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { FeedbackData } from '@shared/types'
import LearningPlanSection from '../LearningPlanSection'

vi.mock('next/link', () => ({
  default: ({
    href,
    children,
    ...props
  }: {
    href: string
    children: React.ReactNode
  }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}))

const baseFeedback: FeedbackData = {
  overall_score: 72,
  pass_probability: 'Medium',
  confidence_level: 'Medium',
  dimensions: {
    answer_quality: {
      score: 70,
      strengths: ['Clear examples'],
      weaknesses: ['Needs tighter structure'],
    },
    communication: {
      score: 74,
      wpm: 142,
      filler_rate: 2,
      pause_score: 76,
      rambling_index: 20,
    },
    engagement_signals: {
      eye_contact: 72,
      facial_expression: 70,
      posture: 75,
      confidence: 73,
    },
  },
  red_flags: [],
  top_3_improvements: ['Add sharper metrics'],
  drill_recommendations: [
    {
      skillArea: 'Specificity',
      description: 'Practice using concrete evidence.',
      practiceQuestions: ['Tell me about a time you influenced a roadmap.'],
    },
  ],
}

describe('LearningPlanSection Pathway CTA', () => {
  it('links feedback to the matching Pathway update when a persisted session id exists', () => {
    render(
      <LearningPlanSection
        feedback={{
          ...baseFeedback,
          sideEffectOutcomes: [{ name: 'pathwayPlan', status: 'scheduled' }],
        }}
        sessionId="session-123"
      />,
    )

    expect(screen.getByText('Your pathway update is queued')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Your pathway update is queued/i })).toHaveAttribute(
      'href',
      '/learn/pathway?fromFeedback=session-123',
    )
  })

  it('falls back to the current Pathway for local feedback sessions', () => {
    render(
      <LearningPlanSection
        feedback={{
          ...baseFeedback,
          sideEffectOutcomes: [{ name: 'pathwayPlan', status: 'skipped' }],
        }}
        sessionId="local"
      />,
    )

    expect(screen.getByText('Pathway update unavailable')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Pathway update unavailable/i })).toHaveAttribute(
      'href',
      '/learn/pathway',
    )
  })
})
