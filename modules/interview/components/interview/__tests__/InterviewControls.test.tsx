/**
 * InterviewControls — the in-room footer. Live-coaching is set in the lobby
 * (immutable during the interview), so the only control here is End Interview.
 */
import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import InterviewControls from '../InterviewControls'

describe('InterviewControls', () => {
  it('renders the End button', () => {
    render(<InterviewControls onEndInterview={() => {}} isScoring={false} />)
    expect(screen.getByRole('button', { name: /end interview/i })).toBeTruthy()
  })

  it('calls onEndInterview when clicked', () => {
    const onEnd = vi.fn()
    render(<InterviewControls onEndInterview={onEnd} isScoring={false} />)
    fireEvent.click(screen.getByRole('button', { name: /end interview/i }))
    expect(onEnd).toHaveBeenCalledTimes(1)
  })

  it('disables End and shows "Scoring..." while scoring', () => {
    render(<InterviewControls onEndInterview={() => {}} isScoring={true} />)
    const btn = screen.getByRole('button', { name: /end interview/i })
    expect(btn.hasAttribute('disabled')).toBe(true)
    expect(screen.getByText(/scoring/i)).toBeTruthy()
  })
})
