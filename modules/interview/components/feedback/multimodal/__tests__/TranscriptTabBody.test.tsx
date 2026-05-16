import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import TranscriptTabBody from '../TranscriptTabBody'
import type { TranscriptEntry } from '@shared/types'

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
})
