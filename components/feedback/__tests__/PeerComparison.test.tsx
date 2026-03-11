import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import PeerComparison, { type PeerData } from '../PeerComparison'
import type { FeedbackData } from '@/lib/types'

// Minimal mock feedback data
function makeFeedback(overrides: Partial<FeedbackData> = {}): FeedbackData {
  return {
    overall_score: 72,
    pass_probability: 'Medium' as const,
    confidence_level: 'Medium',
    confidence_trend: 'stable' as const,
    red_flags: [],
    top_3_improvements: ['a', 'b', 'c'],
    dimensions: {
      answer_quality: { score: 70, strengths: [], weaknesses: [] },
      communication: {
        score: 68,
        wpm: 140,
        filler_rate: 0.03,
        rambling_index: 0.2,
        pause_score: 70,
      },
      engagement_signals: {
        score: 65,
        engagement_score: 60,
        composure_under_pressure: 70,
        energy_consistency: 0.8,
        confidence_trend: 'stable',
      },
    },
    ...overrides,
  } as FeedbackData
}

const mockPeerData: PeerData = {
  available: true,
  count: 25,
  averages: {
    overall: 68,
    answerQuality: 65,
    communication: 63,
    engagement: 60,
  },
  userScore: 72,
  percentile: 75,
}

describe('PeerComparison', () => {
  it('renders loading state with spinner', () => {
    render(
      <PeerComparison data={null} loading={true} userFeedback={makeFeedback()} />
    )
    expect(screen.getByText('Loading peer comparison...')).toBeInTheDocument()
  })

  it('renders empty state when data is null and not loading', () => {
    render(
      <PeerComparison data={null} loading={false} userFeedback={makeFeedback()} />
    )
    expect(screen.getByText('Not enough data yet — be one of the first!')).toBeInTheDocument()
  })

  it('renders empty state with count when available is false', () => {
    render(
      <PeerComparison
        data={{ available: false, count: 3 }}
        loading={false}
        userFeedback={makeFeedback()}
      />
    )
    expect(screen.getByText(/3\/5 so far/)).toBeInTheDocument()
  })

  it('renders all 4 dimension labels', () => {
    render(
      <PeerComparison data={mockPeerData} loading={false} userFeedback={makeFeedback()} />
    )
    expect(screen.getByText('Overall')).toBeInTheDocument()
    expect(screen.getByText('Answer Quality')).toBeInTheDocument()
    expect(screen.getByText('Communication')).toBeInTheDocument()
    expect(screen.getByText('Engagement')).toBeInTheDocument()
  })

  it('renders percentile badge with high tier for >= 75', () => {
    render(
      <PeerComparison data={mockPeerData} loading={false} userFeedback={makeFeedback()} />
    )
    const badge = screen.getByTestId('percentile-badge')
    expect(badge).toHaveTextContent('Top 25%')
    expect(badge).toHaveAttribute('data-tier', 'high')
  })

  it('renders percentile badge with medium tier for 40-74', () => {
    render(
      <PeerComparison
        data={{ ...mockPeerData, percentile: 55 }}
        loading={false}
        userFeedback={makeFeedback()}
      />
    )
    const badge = screen.getByTestId('percentile-badge')
    expect(badge).toHaveTextContent('Top 45%')
    expect(badge).toHaveAttribute('data-tier', 'medium')
  })

  it('renders percentile badge with low tier for < 40', () => {
    render(
      <PeerComparison
        data={{ ...mockPeerData, percentile: 30 }}
        loading={false}
        userFeedback={makeFeedback()}
      />
    )
    const badge = screen.getByTestId('percentile-badge')
    expect(badge).toHaveTextContent('30th percentile')
    expect(badge).toHaveAttribute('data-tier', 'low')
  })

  it('renders session count', () => {
    render(
      <PeerComparison data={mockPeerData} loading={false} userFeedback={makeFeedback()} />
    )
    expect(screen.getByText('25 sessions in your bucket')).toBeInTheDocument()
  })

  it('handles legacy delivery_signals fallback', () => {
    const legacyFeedback = makeFeedback({
      dimensions: {
        answer_quality: { score: 70, strengths: [], weaknesses: [] },
        communication: {
          score: 68,
          wpm: 140,
          filler_rate: 0.03,
          rambling_index: 0.2,
          pause_score: 70,
        },
        delivery_signals: {
          score: 55,
          gaze_ratio: 0.7,
          head_stability: 0.8,
          affect_variability: 0.6,
          confidence_band: 'Medium' as const,
        },
      },
    })

    render(
      <PeerComparison data={mockPeerData} loading={false} userFeedback={legacyFeedback} />
    )
    // Should render Engagement dimension using delivery_signals.score = 55
    expect(screen.getByText('Engagement')).toBeInTheDocument()
  })

  it('returns null when data is available but averages is missing', () => {
    const { container } = render(
      <PeerComparison
        data={{ available: true, count: 10 }}
        loading={false}
        userFeedback={makeFeedback()}
      />
    )
    expect(container.firstChild).toBeNull()
  })
})
