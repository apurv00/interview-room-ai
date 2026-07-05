import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import SignalTrack from '../SignalTrack'
import type { TimelineEvent } from '@shared/types/multimodal'

function makeEvent(startSec: number, endSec: number, type: TimelineEvent['type']): TimelineEvent {
  return {
    startSec,
    endSec,
    type,
    severity: 'neutral',
    signal: 'fused',
    title: 't',
    description: '',
    questionIndex: 0,
  } as TimelineEvent
}

describe('SignalTrack', () => {
  it('renders the legend with Strength / Improvement / Coaching entries', () => {
    render(
      <SignalTrack timeline={[]} keyMoments={[]} totalDurationSec={300} currentTimeSec={0} />
    )
    expect(screen.getByText('Strength')).toBeInTheDocument()
    expect(screen.getByText('Improvement')).toBeInTheDocument()
    expect(screen.getByText('Coaching')).toBeInTheDocument()
  })

  it('renders nothing when totalDurationSec is 0', () => {
    const { container } = render(
      <SignalTrack timeline={[]} keyMoments={[]} totalDurationSec={0} currentTimeSec={0} />
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('renders only strength/improvement/coaching_tip segments (observation filtered out)', () => {
    const timeline = [
      makeEvent(0, 30, 'strength'),
      makeEvent(30, 60, 'observation'), // should NOT render as segment
      makeEvent(60, 90, 'improvement'),
      makeEvent(90, 120, 'coaching_tip'),
    ]
    const { container } = render(
      <SignalTrack timeline={timeline} keyMoments={[]} totalDurationSec={120} currentTimeSec={0} />
    )
    const track = container.querySelector('.h-\\[22px\\]')!
    const segmentBands = track.querySelectorAll('[title="t"]')
    expect(segmentBands.length).toBe(3)
  })

  it('does NOT render per-question white divider lines (dropped in the timeline declutter)', () => {
    const { container } = render(
      <SignalTrack
        timeline={[makeEvent(0, 30, 'strength')]}
        keyMoments={[]}
        totalDurationSec={300}
        currentTimeSec={0}
      />
    )
    const track = container.querySelector('.h-\\[22px\\]')!
    expect(track.querySelectorAll('.w-px').length).toBe(0)
  })

  it('renders a circle marker per key moment', () => {
    const { container } = render(
      <SignalTrack
        timeline={[]}
        keyMoments={[makeEvent(30, 35, 'strength'), makeEvent(120, 125, 'improvement')]}
        totalDurationSec={300}
        currentTimeSec={0}
      />
    )
    const track = container.querySelector('.h-\\[22px\\]')!
    // Two circles for two key moments
    const circles = track.querySelectorAll('.rounded-full')
    expect(circles.length).toBe(2)
  })

  it('positions playhead at currentTimeSec / totalDurationSec %', () => {
    const { container } = render(
      <SignalTrack timeline={[]} keyMoments={[]} totalDurationSec={200} currentTimeSec={50} />
    )
    const track = container.querySelector('.h-\\[22px\\]')!
    const playhead = track.querySelector('.bg-stone-900') as HTMLElement
    expect(playhead).toBeTruthy()
    expect(playhead.style.left).toBe('25%')
  })
})
