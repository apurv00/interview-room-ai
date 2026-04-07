import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import CoachingNudge from '../components/interview/CoachingNudge'
import type { CoachingNudge as NudgeType } from '../config/coachingNudges'

describe('CoachingNudge component', () => {
  it('renders nothing when nudge is null', () => {
    const { container } = render(<CoachingNudge nudge={null} />)
    expect(container.querySelector('[data-testid="coaching-nudge"]')).toBeNull()
  })

  it('renders an info nudge with its message', () => {
    const nudge: NudgeType = {
      id: 'pace-info',
      type: 'pace',
      severity: 'info',
      message: 'Try slowing down a touch.',
    }
    render(<CoachingNudge nudge={nudge} />)
    const el = screen.getByTestId('coaching-nudge')
    expect(el.getAttribute('data-severity')).toBe('info')
    expect(screen.getByText('Try slowing down a touch.')).toBeTruthy()
  })

  it('renders a warning nudge with elevated styling hooks', () => {
    const nudge: NudgeType = {
      id: 'filler-warn',
      type: 'filler',
      severity: 'warning',
      message: 'Watch the filler words.',
    }
    render(<CoachingNudge nudge={nudge} />)
    const el = screen.getByTestId('coaching-nudge')
    expect(el.getAttribute('data-severity')).toBe('warning')
    expect(el.className).toContain('amber')
  })
})
