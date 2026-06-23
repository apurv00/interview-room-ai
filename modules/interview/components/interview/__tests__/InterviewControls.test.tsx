/**
 * Feedback #1 — the in-room live-coaching toggle lives in InterviewControls.
 *
 * Contract:
 *   - The toggle only appears when an onToggleLiveCoaching handler is passed
 *     (backward-compatible: existing callers without it see just the End button).
 *   - It is an accessible switch: role="switch" + aria-checked reflects state.
 *   - Clicking it invokes the handler (page.tsx flips + persists the flag).
 *   - The End button still works and disables while scoring.
 */
import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import InterviewControls from '../InterviewControls'

describe('InterviewControls — live-coaching toggle', () => {
  it('hides the toggle when no handler is provided', () => {
    render(<InterviewControls onEndInterview={() => {}} isScoring={false} />)
    expect(screen.queryByRole('switch')).toBeNull()
    expect(screen.getByRole('button', { name: /end interview/i })).toBeTruthy()
  })

  it('renders an accessible switch reflecting the ON state', () => {
    render(
      <InterviewControls
        onEndInterview={() => {}}
        isScoring={false}
        liveCoachingEnabled={true}
        onToggleLiveCoaching={() => {}}
      />,
    )
    const toggle = screen.getByRole('switch')
    expect(toggle.getAttribute('aria-checked')).toBe('true')
    expect(toggle.getAttribute('aria-label')).toMatch(/turn off/i)
    expect(screen.getByText(/coaching on/i)).toBeTruthy()
  })

  it('reflects the OFF state', () => {
    render(
      <InterviewControls
        onEndInterview={() => {}}
        isScoring={false}
        liveCoachingEnabled={false}
        onToggleLiveCoaching={() => {}}
      />,
    )
    const toggle = screen.getByRole('switch')
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    expect(toggle.getAttribute('aria-label')).toMatch(/turn on/i)
    expect(screen.getByText(/coaching off/i)).toBeTruthy()
  })

  it('invokes the handler on click', () => {
    const onToggle = vi.fn()
    render(
      <InterviewControls
        onEndInterview={() => {}}
        isScoring={false}
        liveCoachingEnabled={true}
        onToggleLiveCoaching={onToggle}
      />,
    )
    fireEvent.click(screen.getByRole('switch'))
    expect(onToggle).toHaveBeenCalledTimes(1)
  })

  it('still ends the interview, and disables End while scoring', () => {
    const onEnd = vi.fn()
    const { rerender } = render(
      <InterviewControls onEndInterview={onEnd} isScoring={false} onToggleLiveCoaching={() => {}} />,
    )
    fireEvent.click(screen.getByRole('button', { name: /end interview/i }))
    expect(onEnd).toHaveBeenCalledTimes(1)

    rerender(
      <InterviewControls onEndInterview={onEnd} isScoring={true} onToggleLiveCoaching={() => {}} />,
    )
    // aria-label stays "End interview" while the visible text reads "Scoring...".
    const endBtn = screen.getByRole('button', { name: /end interview/i })
    expect(endBtn.hasAttribute('disabled')).toBe(true)
    expect(screen.getByText(/scoring/i)).toBeTruthy()
  })
})
