import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import CoachingPanel from '../CoachingPanel'
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

describe('CoachingPanel — Phase B coachingTipsRich preference', () => {
  it('uses structured coachingTipsRich (LLM-emitted category) when present', () => {
    const fusion = makeFusion({
      // Heuristic would categorize "Slow your pace" as Communication; but the
      // LLM's structured emission is authoritative — if it says Behavior, the
      // UI displays Behavior. This test confirms preference.
      coachingTips: ['Slow your pace.', 'Maintain eye contact.', 'Use STAR structure.'],
      coachingTipsRich: [
        { text: 'Slow your pace.', category: 'Communication', questionIndex: 2 },
        { text: 'Maintain eye contact.', category: 'Behavior', questionIndex: 0 },
        { text: 'Use STAR structure.', category: 'Content' },
      ],
    })
    render(
      <CoachingPanel
        fusionSummary={fusion}
        timeline={[]}
        onSeek={vi.fn()}
        hideMoments
      />
    )
    // Each tip renders with its LLM-emitted category badge.
    expect(screen.getByText('Communication')).toBeInTheDocument()
    expect(screen.getByText('Behavior')).toBeInTheDocument()
    expect(screen.getByText('Content')).toBeInTheDocument()
  })

  it('falls back to heuristic categorization when coachingTipsRich is absent (pre-Phase-B data)', () => {
    const fusion = makeFusion({
      coachingTips: ['Reduce filler words like "um".', 'Smile during your intro.'],
      // no coachingTipsRich
    })
    render(
      <CoachingPanel
        fusionSummary={fusion}
        timeline={[]}
        onSeek={vi.fn()}
        hideMoments
      />
    )
    // Heuristic picks Communication for "filler" and Behavior for "smile".
    expect(screen.getByText('Communication')).toBeInTheDocument()
    expect(screen.getByText('Behavior')).toBeInTheDocument()
  })

  it('falls back to heuristic when coachingTipsRich is empty array (model emitted the field but populated nothing)', () => {
    const fusion = makeFusion({
      coachingTips: ['Maintain stronger eye contact.'],
      coachingTipsRich: [],
    })
    render(
      <CoachingPanel
        fusionSummary={fusion}
        timeline={[]}
        onSeek={vi.fn()}
        hideMoments
      />
    )
    // Empty rich array means "use the legacy path"; heuristic categorizes as Behavior.
    expect(screen.getByText('Behavior')).toBeInTheDocument()
  })
})
