import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import TranscriptTabBody from '../TranscriptTabBody'
import type { TranscriptEntry } from '@shared/types'
import type { WhisperSegment } from '@shared/types/multimodal'

function makeLine(timestampSec: number, text: string, speaker: 'interviewer' | 'candidate' = 'candidate'): TranscriptEntry {
  return {
    speaker,
    text,
    timestamp: timestampSec, // seconds-from-start (small number — code recognizes this)
    questionIndex: 0,
  } as TranscriptEntry
}

beforeEach(() => {
  // jsdom doesn't implement scrollIntoView; stub it.
  Element.prototype.scrollIntoView = vi.fn()
})

describe('TranscriptTabBody', () => {
  it('renders the empty-state when transcript is empty', () => {
    render(<TranscriptTabBody transcript={[]} currentTimeSec={0} onSeek={vi.fn()} />)
    expect(screen.getByText(/Transcript not available/i)).toBeInTheDocument()
  })

  it('renders every transcript line with its timestamp', () => {
    const lines = [
      makeLine(0, 'first'),
      makeLine(30, 'second'),
      makeLine(75, 'third'),
    ]
    render(<TranscriptTabBody transcript={lines} currentTimeSec={0} onSeek={vi.fn()} />)
    expect(screen.getByText('0:00')).toBeInTheDocument()
    expect(screen.getByText('0:30')).toBeInTheDocument()
    expect(screen.getByText('1:15')).toBeInTheDocument()
    expect(screen.getByText('first')).toBeInTheDocument()
    expect(screen.getByText('second')).toBeInTheDocument()
    expect(screen.getByText('third')).toBeInTheDocument()
  })

  it('marks the active line (latest with start <= currentTime) with data-active="true"', () => {
    const lines = [makeLine(0, 'A'), makeLine(30, 'B'), makeLine(60, 'C')]
    const { container } = render(
      <TranscriptTabBody transcript={lines} currentTimeSec={45} onSeek={vi.fn()} />
    )
    const active = container.querySelectorAll('[data-active="true"]')
    expect(active.length).toBe(1)
    expect(active[0].getAttribute('data-line-idx')).toBe('1')
  })

  it('clicking a timestamp seeks to that line\'s start', () => {
    const lines = [makeLine(0, 'A'), makeLine(45, 'B')]
    const onSeek = vi.fn()
    render(<TranscriptTabBody transcript={lines} currentTimeSec={0} onSeek={onSeek} />)
    fireEvent.click(screen.getByText('0:45'))
    expect(onSeek).toHaveBeenCalledWith(45)
  })

  it('renders bracketed filler tokens as inline red chips', () => {
    const lines = [makeLine(0, 'I [uh] meant [like] this')]
    render(<TranscriptTabBody transcript={lines} currentTimeSec={0} onSeek={vi.fn()} />)
    // The bracketed tokens render as `<span>uh</span>` / `<span>like</span>`
    // with no other text inside — `getByText` finds them.
    expect(screen.getByText('uh')).toBeInTheDocument()
    expect(screen.getByText('like')).toBeInTheDocument()
  })

  it('converts epoch-ms timestamps to seconds-from-start when sessionStartedAt is given', () => {
    const start = 1747370800000
    const lines: TranscriptEntry[] = [
      { speaker: 'candidate', text: 'Hello', timestamp: start, questionIndex: 0 },
      { speaker: 'candidate', text: 'World', timestamp: start + 90_000, questionIndex: 0 },
    ]
    render(
      <TranscriptTabBody
        transcript={lines}
        currentTimeSec={0}
        sessionStartedAt={start}
        onSeek={vi.fn()}
      />
    )
    expect(screen.getByText('0:00')).toBeInTheDocument()
    expect(screen.getByText('1:30')).toBeInTheDocument()
  })

  // Round 5b feature #4 — clarity highlights
  describe('clarity highlights', () => {
    function wseg(start: number, words: Array<{ w: string; t: number; c: number }>): WhisperSegment {
      return {
        id: 0,
        start,
        end: start + 10,
        text: words.map((x) => x.w).join(' '),
        words: words.map((x) => ({ word: x.w, start: x.t, end: x.t + 0.4, confidence: x.c })),
      }
    }

    it('renders unstyled words when no whisperSegments are provided', () => {
      const lines = [makeLine(0, 'plain text')]
      const { container } = render(
        <TranscriptTabBody transcript={lines} currentTimeSec={0} onSeek={vi.fn()} />
      )
      expect(container.querySelectorAll('[data-clarity="low"]').length).toBe(0)
      expect(screen.queryByTestId('transcript-clarity-legend')).toBeNull()
    })

    it('fades words whose whisper confidence is below 0.8', () => {
      const lines = [makeLine(0, 'Hi mumbled here')]
      const whisper = [
        wseg(0, [
          { w: 'Hi', t: 0, c: 0.95 },
          { w: 'mumbled', t: 1, c: 0.5 }, // low
          { w: 'here', t: 2, c: 0.4 },   // low
        ]),
      ]
      const { container } = render(
        <TranscriptTabBody
          transcript={lines}
          currentTimeSec={0}
          onSeek={vi.fn()}
          whisperSegments={whisper}
        />
      )
      const faded = container.querySelectorAll('[data-clarity="low"]')
      expect(faded.length).toBe(2)
      const fadedTexts = Array.from(faded).map((el) => el.textContent)
      expect(fadedTexts).toContain('mumbled')
      expect(fadedTexts).toContain('here')
    })

    it('renders the legend exactly once when ≥1 word is faded', () => {
      const lines = [makeLine(0, 'mumbled')]
      const whisper = [wseg(0, [{ w: 'mumbled', t: 0, c: 0.4 }])]
      render(
        <TranscriptTabBody
          transcript={lines}
          currentTimeSec={0}
          onSeek={vi.fn()}
          whisperSegments={whisper}
        />
      )
      expect(screen.getByTestId('transcript-clarity-legend')).toBeInTheDocument()
    })

    it('hides the legend when whisperSegments exist but every word is high-confidence', () => {
      const lines = [makeLine(0, 'crystal clear answer')]
      const whisper = [
        wseg(0, [
          { w: 'crystal', t: 0, c: 0.99 },
          { w: 'clear', t: 1, c: 0.98 },
          { w: 'answer', t: 2, c: 0.97 },
        ]),
      ]
      render(
        <TranscriptTabBody
          transcript={lines}
          currentTimeSec={0}
          onSeek={vi.fn()}
          whisperSegments={whisper}
        />
      )
      expect(screen.queryByTestId('transcript-clarity-legend')).toBeNull()
    })

    it('does not fade interviewer lines even when whisper data exists for the same time range', () => {
      const lines = [
        makeLine(0, 'Tell me about a tradeoff', 'interviewer'),
        makeLine(5, 'mumbled answer', 'candidate'),
      ]
      // Whisper data covers both windows but interviewer lines never get
      // word-level clarity treatment (candidate-only ASR).
      const whisper = [
        wseg(0, [
          { w: 'Tell', t: 0, c: 0.3 },
          { w: 'me', t: 0.5, c: 0.3 },
          { w: 'mumbled', t: 5, c: 0.3 },
          { w: 'answer', t: 6, c: 0.3 },
        ]),
      ]
      const { container } = render(
        <TranscriptTabBody
          transcript={lines}
          currentTimeSec={0}
          onSeek={vi.fn()}
          whisperSegments={whisper}
        />
      )
      // Only the candidate's 2 words are faded — interviewer line is untouched.
      expect(container.querySelectorAll('[data-clarity="low"]').length).toBe(2)
    })
  })
})
