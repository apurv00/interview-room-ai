import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import PhaseProgressCard, {
  PathwayPhaseName,
  PhaseStatusProps,
} from '../components/pathway/PhaseProgressCard'

const base = (overrides: Partial<PhaseStatusProps> = {}): PhaseStatusProps => ({
  currentPhase: 'foundation' as PathwayPhaseName,
  sessionsCompleted: 4,
  sessionsInPhase: 2,
  sessionsUntilNextPhase: 2,
  progressInPhasePct: 50,
  nextPhase: 'building' as PathwayPhaseName,
  ...overrides,
})

describe('PhaseProgressCard', () => {
  it('renders current phase label and position', () => {
    render(<PhaseProgressCard phaseStatus={base()} />)
    expect(screen.getByText(/Phase 2 of 6 · Foundation/)).toBeInTheDocument()
    expect(screen.getByText('Building the fundamentals')).toBeInTheDocument()
  })

  it('shows sessions completed counter', () => {
    render(<PhaseProgressCard phaseStatus={base({ sessionsCompleted: 11 })} />)
    expect(screen.getByText('11')).toBeInTheDocument()
  })

  it('shows "more to reach" hint when nextPhase exists', () => {
    render(<PhaseProgressCard phaseStatus={base({ sessionsUntilNextPhase: 3, nextPhase: 'building' })} />)
    expect(screen.getByText(/3 more to reach/)).toBeInTheDocument()
    // "Building" appears both in the hint and the timeline
    expect(screen.getAllByText('Building').length).toBeGreaterThanOrEqual(2)
  })

  it('shows "Final phase" when no next phase', () => {
    render(
      <PhaseProgressCard
        phaseStatus={base({ currentPhase: 'review', nextPhase: null, sessionsUntilNextPhase: 0 })}
      />,
    )
    expect(screen.getByText('Final phase')).toBeInTheDocument()
  })

  it('renders all six phase labels in timeline', () => {
    render(<PhaseProgressCard phaseStatus={base()} />)
    expect(screen.getByText('Assessment')).toBeInTheDocument()
    expect(screen.getByText('Foundation')).toBeInTheDocument()
    expect(screen.getAllByText('Building').length).toBeGreaterThan(0)
    expect(screen.getByText('Intensity')).toBeInTheDocument()
    expect(screen.getByText('Mastery')).toBeInTheDocument()
    expect(screen.getByText('Review')).toBeInTheDocument()
  })

  it('exposes progress percentage via aria-label', () => {
    const { container } = render(<PhaseProgressCard phaseStatus={base({ progressInPhasePct: 75 })} />)
    const bar = container.querySelector('[aria-label*="75%"]')
    expect(bar).not.toBeNull()
  })
})
