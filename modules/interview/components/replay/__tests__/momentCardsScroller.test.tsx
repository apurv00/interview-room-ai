import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import MomentCards, { findActiveIndex } from '../MomentCards'
import type { TimelineEvent } from '@shared/types/multimodal'

function makeMoment(
  startSec: number,
  endSec: number,
  title: string,
  type: TimelineEvent['type'] = 'strength'
): TimelineEvent {
  return {
    startSec,
    endSec,
    type,
    severity: type === 'strength' ? 'positive' : type === 'improvement' ? 'attention' : 'neutral',
    signal: 'fused',
    title,
    description: `Description for ${title}`,
    questionIndex: 0,
  } as TimelineEvent
}

beforeEach(() => {
  // jsdom doesn't implement scrollIntoView; stub it so the auto-scroll effect
  // doesn't crash.
  Element.prototype.scrollIntoView = vi.fn()
})

describe('findActiveIndex', () => {
  const moments = [
    makeMoment(0, 30, 'a'),
    makeMoment(60, 120, 'b'),
    makeMoment(120, 180, 'c'),
  ]

  it('returns null when current time is before any moment', () => {
    expect(findActiveIndex(moments, -5)).toBeNull()
  })

  it('returns null when current time is between moments', () => {
    expect(findActiveIndex(moments, 45)).toBeNull()
  })

  it('returns the moment whose range contains the current time', () => {
    expect(findActiveIndex(moments, 15)).toBe(0)
    expect(findActiveIndex(moments, 90)).toBe(1)
    expect(findActiveIndex(moments, 150)).toBe(2)
  })

  it('returns the LATER moment when ranges overlap (most-recent wins)', () => {
    const overlapping = [
      makeMoment(60, 130, 'first'),
      makeMoment(120, 180, 'second'),
    ]
    // Time 125 is in both ranges → second (later) wins.
    expect(findActiveIndex(overlapping, 125)).toBe(1)
  })

  it('falls back to startSec + 5 when endSec is missing', () => {
    const noEnd = [{ ...makeMoment(60, 0, 'short'), endSec: 0 } as TimelineEvent]
    // currentTime 63 is within [60, 65] (startSec + 5 fallback).
    expect(findActiveIndex(noEnd, 63)).toBe(0)
    expect(findActiveIndex(noEnd, 70)).toBeNull()
  })
})

describe('MomentCards — horizontal scroller', () => {
  const moments = [
    makeMoment(0, 30, 'Strong opening'),
    makeMoment(60, 120, 'Filler spike'),
    makeMoment(120, 180, 'Recovery'),
  ]

  it('renders all moments as listitems', () => {
    render(<MomentCards moments={moments} onSeek={() => {}} currentTimeSec={0} />)
    expect(screen.getAllByRole('listitem')).toHaveLength(3)
  })

  it('clicking a card calls onSeek with that card.startSec', () => {
    const onSeek = vi.fn()
    render(<MomentCards moments={moments} onSeek={onSeek} currentTimeSec={0} />)
    // Click the second card by its accessible label.
    fireEvent.click(screen.getByRole('button', { name: /Filler spike/i }))
    expect(onSeek).toHaveBeenCalledWith(60)
  })

  it('renders NO "Watch" button (regression — the separate CTA was removed in Round 3)', () => {
    render(<MomentCards moments={moments} onSeek={() => {}} currentTimeSec={90} />)
    expect(screen.queryByRole('button', { name: /^Watch/i })).toBeNull()
  })

  it('marks the active card with data-active="true" based on currentTimeSec', () => {
    const { container, rerender } = render(
      <MomentCards moments={moments} onSeek={() => {}} currentTimeSec={0} />
    )
    // currentTimeSec=0 is inside moment 0
    const cards = () => container.querySelectorAll('[data-moment-idx]')
    expect(cards()[0].getAttribute('data-active')).toBe('true')
    expect(cards()[1].getAttribute('data-active')).toBe('false')
    expect(cards()[2].getAttribute('data-active')).toBe('false')

    // Advance time into moment 1's range
    rerender(<MomentCards moments={moments} onSeek={() => {}} currentTimeSec={90} />)
    expect(cards()[0].getAttribute('data-active')).toBe('false')
    expect(cards()[1].getAttribute('data-active')).toBe('true')
  })

  it('only the active card renders the expanded body (description shown twice would mean 2 cards expanded)', () => {
    const { container } = render(
      <MomentCards
        moments={moments}
        onSeek={() => {}}
        currentTimeSec={90}
      />
    )
    // The expanded body shows the full description in a separate <p>. Count
    // occurrences of the active moment's description text — must be exactly 1.
    expect(screen.getAllByText('Description for Filler spike')).toHaveLength(1)
    // The other cards do NOT show their full description (they show truncated
    // line-clamp-2 in the collapsed view, which is the same text — so checking
    // active-card-only via the data-active attribute is more reliable).
    const activeCards = container.querySelectorAll('[data-active="true"]')
    expect(activeCards).toHaveLength(1)
  })

  it('renders nothing when moments is empty', () => {
    const { container } = render(<MomentCards moments={[]} onSeek={() => {}} currentTimeSec={0} />)
    expect(container).toBeEmptyDOMElement()
  })
})
