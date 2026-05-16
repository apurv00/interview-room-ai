import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import MomentsTabBody from '../MomentsTabBody'
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

describe('MomentsTabBody', () => {
  it('renders the empty-state when no moments are provided', () => {
    render(<MomentsTabBody moments={[]} onSeek={vi.fn()} />)
    expect(screen.getByText(/No key moments captured/i)).toBeInTheDocument()
  })

  it('marks the first moment as expanded by default', () => {
    const moments = [
      makeMoment(0, 30, 'Opening'),
      makeMoment(60, 120, 'Middle'),
      makeMoment(180, 240, 'Closing'),
    ]
    const { container } = render(<MomentsTabBody moments={moments} onSeek={vi.fn()} />)
    const activeCards = container.querySelectorAll('[data-active="true"]')
    expect(activeCards.length).toBe(1)
  })

  it('clicking a collapsed row expands it AND seeks the video, collapsing the prior row', () => {
    const moments = [
      makeMoment(0, 30, 'Opening'),
      makeMoment(60, 120, 'Middle'),
    ]
    const onSeek = vi.fn()
    const { container } = render(<MomentsTabBody moments={moments} onSeek={onSeek} />)
    // Click the "Middle" row by its text
    fireEvent.click(screen.getByText('Middle'))
    expect(onSeek).toHaveBeenCalledWith(60)
    // Only one expanded card now (the Middle one)
    const activeCards = container.querySelectorAll('[data-active="true"]')
    expect(activeCards.length).toBe(1)
  })

  it('renders the expanded card with the full description', () => {
    const moments = [makeMoment(0, 30, 'Opening')]
    render(<MomentsTabBody moments={moments} onSeek={vi.fn()} />)
    expect(screen.getByText('Description for Opening')).toBeInTheDocument()
  })

  it('shows the per-question metric row in the expanded card when prosody data is present', () => {
    const moments = [makeMoment(60, 120, 'Mid')]
    const prosody = [{
      startSec: 0,
      endSec: 60,
      wpm: 0,
      fillerWords: [],
      pauseDurationSec: 0,
      confidenceMarker: 'high' as const,
      questionIndex: 0,
    }, {
      startSec: 60,
      endSec: 120,
      wpm: 145,
      fillerWords: [{ word: 'uh', timestampSec: 65 }],
      pauseDurationSec: 2.3,
      confidenceMarker: 'medium' as const,
      questionIndex: 1,
    }]
    const questions = [
      { label: 'Q1', offsetSeconds: 0 },
      { label: 'Q2', offsetSeconds: 60 },
    ]
    render(
      <MomentsTabBody
        moments={moments}
        onSeek={vi.fn()}
        prosodySegments={prosody}
        questions={questions}
      />
    )
    expect(screen.getByText('WPM')).toBeInTheDocument()
    expect(screen.getByText('145')).toBeInTheDocument()
    expect(screen.getByText('Fillers')).toBeInTheDocument()
  })

  it('shows the "Asked during" label with the resolved question label in the expanded card', () => {
    const moments = [makeMoment(60, 120, 'Late opening')]
    const questions = [
      { label: 'Q1', offsetSeconds: 0 },
      { label: 'Q2', offsetSeconds: 60 },
    ]
    render(
      <MomentsTabBody moments={moments} onSeek={vi.fn()} questions={questions} />
    )
    expect(screen.getByText(/Asked during Q2/i)).toBeInTheDocument()
  })

  // Round 5a feature #9 — signal-source breakdown line
  describe('signal-source breakdown', () => {
    function makeMomentWithSignal(signal: TimelineEvent['signal']): TimelineEvent {
      return { ...makeMoment(0, 30, 'X'), signal }
    }

    it('renders a "{N} moments: ..." line with counts per signal source', () => {
      const moments: TimelineEvent[] = [
        makeMomentWithSignal('audio'),
        makeMomentWithSignal('audio'),
        makeMomentWithSignal('audio'),
        makeMomentWithSignal('facial'),
        makeMomentWithSignal('facial'),
        makeMomentWithSignal('content'),
        makeMomentWithSignal('fused'),
      ]
      render(<MomentsTabBody moments={moments} onSeek={vi.fn()} />)
      const line = screen.getByTestId('moments-signal-breakdown')
      expect(line.textContent).toContain('7 moments')
      expect(line.textContent).toContain('3 audio')
      expect(line.textContent).toContain('2 facial')
      expect(line.textContent).toContain('1 content')
      expect(line.textContent).toContain('1 fused')
    })

    it('renders moments count in singular form when only one moment', () => {
      const moments: TimelineEvent[] = [makeMomentWithSignal('audio')]
      render(<MomentsTabBody moments={moments} onSeek={vi.fn()} />)
      const line = screen.getByTestId('moments-signal-breakdown')
      expect(line.textContent).toContain('1 moment:')
    })

    it('orders the breakdown audio · facial · content · fused regardless of input order', () => {
      const moments: TimelineEvent[] = [
        makeMomentWithSignal('fused'),
        makeMomentWithSignal('content'),
        makeMomentWithSignal('facial'),
        makeMomentWithSignal('audio'),
      ]
      render(<MomentsTabBody moments={moments} onSeek={vi.fn()} />)
      const line = screen.getByTestId('moments-signal-breakdown').textContent ?? ''
      const audioIdx = line.indexOf('audio')
      const facialIdx = line.indexOf('facial')
      const contentIdx = line.indexOf('content')
      const fusedIdx = line.indexOf('fused')
      expect(audioIdx).toBeLessThan(facialIdx)
      expect(facialIdx).toBeLessThan(contentIdx)
      expect(contentIdx).toBeLessThan(fusedIdx)
    })

    it('omits signal kinds with zero moments', () => {
      const moments: TimelineEvent[] = [
        makeMomentWithSignal('audio'),
        makeMomentWithSignal('facial'),
      ]
      render(<MomentsTabBody moments={moments} onSeek={vi.fn()} />)
      const line = screen.getByTestId('moments-signal-breakdown').textContent ?? ''
      expect(line).not.toContain('content')
      expect(line).not.toContain('fused')
    })
  })
})
