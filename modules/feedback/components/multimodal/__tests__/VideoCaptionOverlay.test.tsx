import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import VideoCaptionOverlay from '../VideoCaptionOverlay'
import type { WhisperSegment, WhisperWord } from '@shared/types/multimodal'

function makeLegacySegment(id: number, start: number, end: number, text: string): WhisperSegment {
  return { id, start, end, text, words: [] } as WhisperSegment
}

function makeWord(word: string, start: number, end: number): WhisperWord {
  return { word, start, end, confidence: 1 }
}

function makeSegmentWithWords(
  id: number,
  start: number,
  end: number,
  text: string,
  words: WhisperWord[],
): WhisperSegment {
  return { id, start, end, text, words }
}

describe('VideoCaptionOverlay', () => {
  it('renders nothing when no whisper segments are provided', () => {
    const { container } = render(
      <VideoCaptionOverlay whisperSegments={undefined} currentTimeSec={10} />
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('renders nothing when segments list is empty', () => {
    const { container } = render(
      <VideoCaptionOverlay whisperSegments={[]} currentTimeSec={10} />
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('renders nothing when currentTime is before any spoken word (word-level path)', () => {
    const segs = [
      makeSegmentWithWords(0, 10, 15, 'first line', [
        makeWord('first', 10, 11),
        makeWord('line', 11, 12),
      ]),
    ]
    const { container } = render(
      <VideoCaptionOverlay whisperSegments={segs} currentTimeSec={5} />
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('streams words in word-level mode as currentTime crosses each word.start', () => {
    const segs = [
      makeSegmentWithWords(0, 0, 5, 'hello there how are you', [
        makeWord('hello', 0, 1),
        makeWord('there', 1, 2),
        makeWord('how', 2, 3),
        makeWord('are', 3, 4),
        makeWord('you', 4, 5),
      ]),
    ]
    const { rerender } = render(
      <VideoCaptionOverlay whisperSegments={segs} currentTimeSec={1.5} />
    )
    // At 1.5s, "hello" (start=0) and "there" (start=1) are spoken; "how" (start=2) is not.
    expect(screen.getByRole('status').textContent).toBe('hello there')

    rerender(<VideoCaptionOverlay whisperSegments={segs} currentTimeSec={3.5} />)
    expect(screen.getByRole('status').textContent).toBe('hello there how are')
  })

  it('keeps the most recent N words when stream length exceeds the rolling window', () => {
    // 30 words across one segment; window default is 25 — expect the last 25.
    const words: WhisperWord[] = []
    for (let i = 0; i < 30; i++) {
      words.push(makeWord(`w${i}`, i, i + 1))
    }
    const segs = [makeSegmentWithWords(0, 0, 30, words.map(w => w.word).join(' '), words)]
    render(<VideoCaptionOverlay whisperSegments={segs} currentTimeSec={30} />)
    const text = screen.getByRole('status').textContent ?? ''
    expect(text.startsWith('w5')).toBe(true)   // first kept word is index 5 (30 − 25)
    expect(text.endsWith('w29')).toBe(true)    // last kept word is index 29
    expect(text.includes('w0')).toBe(false)    // first 5 words dropped
  })

  it('falls back to active segment text when `words` array is empty (legacy data)', () => {
    const segs = [
      makeLegacySegment(0, 0, 5, 'line A'),
      makeLegacySegment(1, 5, 10, 'line B'),
      makeLegacySegment(2, 10, 15, 'line C'),
    ]
    render(<VideoCaptionOverlay whisperSegments={segs} currentTimeSec={7} />)
    expect(screen.getByRole('status').textContent).toBe('line B')
  })

  it('renders filler tokens (bracketed) as chips when present in legacy fallback text', () => {
    const segs = [
      makeLegacySegment(0, 0, 5, 'I [uh] meant to say [like] this'),
    ]
    render(<VideoCaptionOverlay whisperSegments={segs} currentTimeSec={1} />)
    expect(screen.getByText('uh')).toBeInTheDocument()
    expect(screen.getByText('like')).toBeInTheDocument()
  })

  it('exposes role="status" + aria-live="polite" for screen readers', () => {
    render(
      <VideoCaptionOverlay
        whisperSegments={[makeLegacySegment(0, 0, 5, 'hello')]}
        currentTimeSec={1}
      />
    )
    const overlay = screen.getByRole('status')
    expect(overlay).toHaveAttribute('aria-live', 'polite')
  })
})
