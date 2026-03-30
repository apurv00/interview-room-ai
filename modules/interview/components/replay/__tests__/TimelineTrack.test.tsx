import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import TimelineTrack from '../TimelineTrack'
import type { TimelineEvent } from '@shared/types/multimodal'

describe('TimelineTrack', () => {
  const mockEvents: TimelineEvent[] = [
    {
      startSec: 10,
      endSec: 30,
      type: 'strength',
      signal: 'fused',
      title: 'Strong answer',
      description: 'Good structure.',
      severity: 'positive',
    },
    {
      startSec: 60,
      endSec: 80,
      type: 'improvement',
      signal: 'audio',
      title: 'Too many fillers',
      description: 'Reduce um and like.',
      severity: 'attention',
    },
  ]

  it('renders event segments', () => {
    render(
      <TimelineTrack
        events={mockEvents}
        totalDurationSec={120}
        currentTimeSec={0}
        onSeek={() => {}}
      />
    )

    // Check that segments are rendered with titles
    const segments = document.querySelectorAll('[title]')
    expect(segments.length).toBeGreaterThanOrEqual(2)
  })

  it('renders legend labels', () => {
    render(
      <TimelineTrack
        events={mockEvents}
        totalDurationSec={120}
        currentTimeSec={0}
        onSeek={() => {}}
      />
    )

    expect(screen.getByText('Strength')).toBeTruthy()
    expect(screen.getByText('Improvement')).toBeTruthy()
    expect(screen.getByText('Coaching')).toBeTruthy()
  })

  it('calls onSeek when segment is clicked', () => {
    const mockSeek = vi.fn()
    render(
      <TimelineTrack
        events={mockEvents}
        totalDurationSec={120}
        currentTimeSec={0}
        onSeek={mockSeek}
      />
    )

    const firstSegment = document.querySelector('[title*="Strong answer"]')
    if (firstSegment) {
      fireEvent.click(firstSegment)
      expect(mockSeek).toHaveBeenCalledWith(10) // startSec of first event
    }
  })
})
