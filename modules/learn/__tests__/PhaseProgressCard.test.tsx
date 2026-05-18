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

  // Wave 5 deferred cleanup — the per-phase row used to render each
  // phase as a `div` with `rounded-lg` + `bg-blue-500/10` highlight
  // that made the current phase look like a tap target. The phases
  // are informational (no per-phase detail view exists to navigate
  // to); these tests lock the "labelled indicator, not interactive
  // button" treatment.
  describe('Phase row is informational, not interactive', () => {
    it('uses an ordered list with role="list" + aria-label', () => {
      render(<PhaseProgressCard phaseStatus={base()} />)
      const list = screen.getByRole('list', { name: /phase progress/i })
      expect(list.tagName.toLowerCase()).toBe('ol')
    })

    it('renders no buttons or links in the phase row', () => {
      const { container } = render(<PhaseProgressCard phaseStatus={base()} />)
      const phaseList = container.querySelector('ol[aria-label*="progress"]')
      expect(phaseList).not.toBeNull()
      expect(phaseList?.querySelectorAll('button').length).toBe(0)
      expect(phaseList?.querySelectorAll('a').length).toBe(0)
    })

    it('marks the current phase with aria-current="step"', () => {
      render(<PhaseProgressCard phaseStatus={base({ currentPhase: 'building' })} />)
      const items = screen.getAllByRole('listitem')
      const current = items.find((el) => el.getAttribute('aria-current') === 'step')
      expect(current).toBeTruthy()
      expect(current?.textContent).toContain('Building')
    })
  })
})
