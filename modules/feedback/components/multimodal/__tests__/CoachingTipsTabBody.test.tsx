import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import CoachingTipsTabBody from '../CoachingTipsTabBody'
import type { FusionSummary } from '@shared/types/multimodal'

function makeFusion(overrides: Partial<FusionSummary> = {}): FusionSummary {
  return {
    overallBodyLanguageScore: 75,
    eyeContactScore: 80,
    confidenceProgression: 'stable',
    topMoments: [],
    improvementMoments: [],
    coachingTips: [],
    ...overrides,
  } as FusionSummary
}

describe('CoachingTipsTabBody — Phase B preference + Phase A fallback', () => {
  it('renders the empty-state when no tips exist', () => {
    render(<CoachingTipsTabBody fusionSummary={makeFusion()} />)
    expect(screen.getByText(/No coaching tips generated/i)).toBeInTheDocument()
  })

  it('uses structured coachingTipsRich (LLM-emitted category) when present', () => {
    const fusion = makeFusion({
      coachingTips: ['x', 'y', 'z'],
      coachingTipsRich: [
        { text: 'Slow your pace.', category: 'Communication', questionIndex: 2 },
        { text: 'Maintain eye contact.', category: 'Behavior', questionIndex: 0 },
        { text: 'Use STAR structure.', category: 'Content' },
      ],
    })
    render(<CoachingTipsTabBody fusionSummary={fusion} />)
    expect(screen.getByText('Communication')).toBeInTheDocument()
    expect(screen.getByText('Behavior')).toBeInTheDocument()
    expect(screen.getByText('Content')).toBeInTheDocument()
    expect(screen.getByText('Slow your pace.')).toBeInTheDocument()
  })

  it('shows the Q-ref pill (top-right of each card) when structured questionIndex exists', () => {
    const fusion = makeFusion({
      coachingTips: ['Slow your pace.'],
      coachingTipsRich: [{ text: 'Slow your pace.', category: 'Communication', questionIndex: 2 }],
    })
    render(<CoachingTipsTabBody fusionSummary={fusion} />)
    expect(screen.getByText('Q3')).toBeInTheDocument()
  })

  it('falls back to heuristic categorization when coachingTipsRich is absent (pre-Phase-B)', () => {
    const fusion = makeFusion({
      coachingTips: ['Reduce filler words like "um".', 'Smile during your intro.'],
    })
    render(<CoachingTipsTabBody fusionSummary={fusion} />)
    expect(screen.getByText('Communication')).toBeInTheDocument()
    expect(screen.getByText('Behavior')).toBeInTheDocument()
  })

  it('renders "Practice this →" when a tip\'s questionIndex matches a drill targetQuestions', () => {
    const fusion = makeFusion({
      coachingTips: ['Open with the decision'],
      coachingTipsRich: [{ text: 'Open with the decision', category: 'Content', questionIndex: 1 }],
    })
    const onPractice = vi.fn()
    render(
      <CoachingTipsTabBody
        fusionSummary={fusion}
        drillRecommendations={[
          {
            skillArea: 'Lede-first answers',
            description: 'Practice opening with the decision.',
            practiceQuestions: ['q?'],
            targetQuestions: [1],
          },
        ]}
        onPracticeClick={onPractice}
      />
    )
    fireEvent.click(screen.getByText('Practice this →'))
    expect(onPractice).toHaveBeenCalledWith(0)
  })

  it('uses Phase A regex Q-overlap fallback when targetQuestions is absent', () => {
    const fusion = makeFusion({
      coachingTips: ['In Q3 you used too many fillers'],
    })
    render(
      <CoachingTipsTabBody
        fusionSummary={fusion}
        drillRecommendations={[
          {
            skillArea: 'Filler reduction',
            description: 'Drill on Q3 to reduce fillers.',
            practiceQuestions: ['q?'],
          },
        ]}
        onPracticeClick={vi.fn()}
      />
    )
    expect(screen.getByText('Practice this →')).toBeInTheDocument()
  })
})
