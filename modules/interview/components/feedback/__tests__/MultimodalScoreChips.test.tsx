import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import MultimodalScoreChips from '../MultimodalScoreChips'
import type { FusionSummary } from '@shared/types/multimodal'
import type { SpeechMetrics } from '@shared/types'

function makeFusion(overrides: Partial<FusionSummary> = {}): FusionSummary {
  return {
    overallBodyLanguageScore: 78,
    eyeContactScore: 82,
    confidenceProgression: 'steady',
    topMoments: [],
    improvementMoments: [],
    coachingTips: ['tip1'],
    ...overrides,
  } as FusionSummary
}

function makeMetrics(overrides: Partial<SpeechMetrics>[] = []): SpeechMetrics[] {
  return overrides.map((o) => ({
    wpm: 140,
    fillerRate: 0.04,
    pauseScore: 70,
    totalWords: 100,
    ...o,
  })) as SpeechMetrics[]
}

describe('MultimodalScoreChips', () => {
  it('renders all four chips with numeric values when full data is available', () => {
    render(
      <MultimodalScoreChips
        fusionSummary={makeFusion()}
        speechMetrics={makeMetrics([{ wpm: 140, fillerRate: 0.03, totalWords: 200 }])}
      />
    )
    expect(screen.getByText('Eye Contact')).toBeInTheDocument()
    expect(screen.getByText('82/100')).toBeInTheDocument()
    expect(screen.getByText('Body Language')).toBeInTheDocument()
    expect(screen.getByText('78/100')).toBeInTheDocument()
    expect(screen.getByText('Filler Rate')).toBeInTheDocument()
    expect(screen.getByText('3%')).toBeInTheDocument()
    expect(screen.getByText('Speaking Pace')).toBeInTheDocument()
    expect(screen.getByText('140 wpm')).toBeInTheDocument()
  })

  it('shows N/A for facial scores when no facial data was captured', () => {
    render(
      <MultimodalScoreChips
        fusionSummary={makeFusion({ eyeContactScore: null, overallBodyLanguageScore: null })}
        speechMetrics={makeMetrics([{ wpm: 130, fillerRate: 0.05, totalWords: 100 }])}
      />
    )
    expect(screen.getAllByText('N/A')).toHaveLength(2)
  })

  it('shows N/A for speech chips when no speech metrics were captured', () => {
    render(<MultimodalScoreChips fusionSummary={makeFusion()} speechMetrics={[]} />)
    // Eye contact + body language render normally; filler + pace show N/A
    expect(screen.getByText('82/100')).toBeInTheDocument()
    expect(screen.getAllByText('N/A')).toHaveLength(2)
  })

  it('aggregates filler rate weighted by total words across questions', () => {
    render(
      <MultimodalScoreChips
        fusionSummary={makeFusion()}
        speechMetrics={makeMetrics([
          { wpm: 140, fillerRate: 0.02, totalWords: 100 },
          { wpm: 140, fillerRate: 0.10, totalWords: 100 },
        ])}
      />
    )
    // Weighted avg: (0.02*100 + 0.10*100) / 200 = 0.06 → 6%
    expect(screen.getByText('6%')).toBeInTheDocument()
  })
})
