import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import MomentsTabBody, { topFillerWords } from '../MomentsTabBody'
import type { TimelineEvent, ProsodySegment } from '@shared/types/multimodal'

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

    // Codex P3 review on Round 5c — previously `m.signal || 'fused'`
    // silently coerced missing values into 'fused', overcounting that
    // bucket and lying about the channel breakdown.
    it('buckets moments with a missing signal field into "unknown" instead of overcounting fused', () => {
      const moments: TimelineEvent[] = [
        makeMomentWithSignal('audio'),
        makeMomentWithSignal('audio'),
        // Missing signal field — cast bypasses TS, simulates service drift.
        { ...makeMoment(0, 30, 'X'), signal: undefined as unknown as TimelineEvent['signal'] },
      ]
      render(<MomentsTabBody moments={moments} onSeek={vi.fn()} />)
      const line = screen.getByTestId('moments-signal-breakdown').textContent ?? ''
      expect(line).toContain('2 audio')
      expect(line).toContain('1 unknown')
      // Critically: does NOT silently merge missing-signal into 'fused'.
      expect(line).not.toContain('fused')
    })

    it('buckets moments with an unrecognized signal value into "unknown"', () => {
      const moments: TimelineEvent[] = [
        // Off-union signal value — service drift or schema bypass.
        { ...makeMoment(0, 30, 'X'), signal: 'made-up' as unknown as TimelineEvent['signal'] },
      ]
      render(<MomentsTabBody moments={moments} onSeek={vi.fn()} />)
      const line = screen.getByTestId('moments-signal-breakdown').textContent ?? ''
      expect(line).toContain('1 unknown')
      expect(line).not.toContain('made-up')
    })
  })

  // Round 5b feature #11 — per-Q filler lexicon (rendered inside expanded card)
  describe('filler lexicon (Round 5b #11)', () => {
    function makeProsody(filler: Array<{ word: string; timestampSec: number }>): ProsodySegment {
      return {
        startSec: 0,
        endSec: 1000,
        wpm: 140,
        fillerWords: filler,
        pauseDurationSec: 0,
        confidenceMarker: 'high',
      } as ProsodySegment
    }

    it('renders rose pills with top filler words inside the expanded moment window', () => {
      const moments = [makeMoment(10, 30, 'Opening')]
      const prosody = [
        makeProsody([
          { word: 'um', timestampSec: 11 },
          { word: 'um', timestampSec: 14 },
          { word: 'um', timestampSec: 22 },
          { word: 'like', timestampSec: 17 },
          { word: 'you know', timestampSec: 25 },
        ]),
      ]
      render(
        <MomentsTabBody moments={moments} onSeek={vi.fn()} prosodySegments={prosody} />
      )
      const lex = screen.getByTestId('moments-filler-lexicon')
      const text = lex.textContent ?? ''
      expect(text).toContain('um')
      expect(text).toContain('3') // um × 3
      expect(text).toContain('like')
      expect(text).toContain('you know')
    })

    it('omits the lexicon row entirely when the expanded moment has 0 fillers', () => {
      const moments = [makeMoment(10, 30, 'Clean answer')]
      const prosody = [
        makeProsody([{ word: 'um', timestampSec: 100 /* outside window */ }]),
      ]
      render(
        <MomentsTabBody moments={moments} onSeek={vi.fn()} prosodySegments={prosody} />
      )
      expect(screen.queryByTestId('moments-filler-lexicon')).toBeNull()
    })

    it('omits the lexicon row when no prosody data is passed at all', () => {
      render(<MomentsTabBody moments={[makeMoment(0, 30, 'X')]} onSeek={vi.fn()} />)
      expect(screen.queryByTestId('moments-filler-lexicon')).toBeNull()
    })
  })
})

// Pure helper — exercised in isolation so the rolling-window math is testable
// without rendering a component.
describe('topFillerWords (pure helper for Round 5b #11)', () => {
  it('returns empty when prosody is undefined or empty', () => {
    expect(topFillerWords(undefined, 0, 100)).toEqual([])
    expect(topFillerWords([], 0, 100)).toEqual([])
  })

  it('filters by [windowStart, windowEnd) half-open interval', () => {
    const out = topFillerWords(
      [{ startSec: 0, endSec: 100, wpm: 0, fillerWords: [
        { word: 'um', timestampSec: 9.999 }, // out — before window
        { word: 'um', timestampSec: 10 },    // in
        { word: 'um', timestampSec: 19.999 }, // in
        { word: 'um', timestampSec: 20 },    // out — exactly at end
      ], pauseDurationSec: 0, confidenceMarker: 'high' }],
      10, 20,
    )
    expect(out).toEqual([{ word: 'um', count: 2 }])
  })

  it('case-folds and groups (Um, UM, um all collapse)', () => {
    const out = topFillerWords(
      [{ startSec: 0, endSec: 100, wpm: 0, fillerWords: [
        { word: 'Um', timestampSec: 1 },
        { word: 'UM', timestampSec: 2 },
        { word: 'um', timestampSec: 3 },
      ], pauseDurationSec: 0, confidenceMarker: 'high' }],
      0, 100,
    )
    expect(out).toEqual([{ word: 'um', count: 3 }])
  })

  it('sorts by descending count, alphabetic tiebreak', () => {
    const out = topFillerWords(
      [{ startSec: 0, endSec: 100, wpm: 0, fillerWords: [
        { word: 'you know', timestampSec: 1 },
        { word: 'like', timestampSec: 2 },
        { word: 'um', timestampSec: 3 },
        { word: 'um', timestampSec: 4 },
        { word: 'like', timestampSec: 5 },
      ], pauseDurationSec: 0, confidenceMarker: 'high' }],
      0, 100,
    )
    expect(out).toEqual([
      { word: 'like', count: 2 },
      { word: 'um', count: 2 },
      { word: 'you know', count: 1 },
    ])
  })

  it('caps to maxN (default 3)', () => {
    const out = topFillerWords(
      [{ startSec: 0, endSec: 100, wpm: 0, fillerWords: [
        { word: 'a', timestampSec: 1 },
        { word: 'b', timestampSec: 2 },
        { word: 'c', timestampSec: 3 },
        { word: 'd', timestampSec: 4 },
        { word: 'e', timestampSec: 5 },
      ], pauseDurationSec: 0, confidenceMarker: 'high' }],
      0, 100,
    )
    expect(out).toHaveLength(3)
  })

  it('drops non-finite timestamps and empty words', () => {
    const out = topFillerWords(
      [{ startSec: 0, endSec: 100, wpm: 0, fillerWords: [
        { word: 'um', timestampSec: 1 },
        { word: 'um', timestampSec: NaN },
        { word: '', timestampSec: 2 },
        { word: '   ', timestampSec: 3 },
      ], pauseDurationSec: 0, confidenceMarker: 'high' }],
      0, 100,
    )
    expect(out).toEqual([{ word: 'um', count: 1 }])
  })
})
