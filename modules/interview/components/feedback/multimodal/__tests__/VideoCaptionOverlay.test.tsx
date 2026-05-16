import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import VideoCaptionOverlay from '../VideoCaptionOverlay'
import type { WhisperSegment } from '@shared/types/multimodal'

function makeSegment(id: number, start: number, end: number, text: string): WhisperSegment {
  return {
    id,
    start,
    end,
    text,
    words: [],
  } as WhisperSegment
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

  it('shows the first segment as upcoming when currentTime is before any segment', () => {
    render(
      <VideoCaptionOverlay
        whisperSegments={[makeSegment(0, 10, 15, 'first line')]}
        currentTimeSec={5}
      />
    )
    expect(screen.getByText('first line')).toBeInTheDocument()
  })

  it('shows the active segment (latest with start <= currentTime)', () => {
    const segs = [
      makeSegment(0, 0, 5, 'line A'),
      makeSegment(1, 5, 10, 'line B'),
      makeSegment(2, 10, 15, 'line C'),
    ]
    render(<VideoCaptionOverlay whisperSegments={segs} currentTimeSec={7} />)
    expect(screen.getByText('line B')).toBeInTheDocument()
    expect(screen.queryByText('line A')).toBeNull()
    expect(screen.queryByText('line C')).toBeNull()
  })

  it('renders filler tokens (bracketed) as red chips inside the active line', () => {
    const segs = [
      makeSegment(0, 0, 5, 'I [uh] meant to say [like] this'),
    ]
    render(
      <VideoCaptionOverlay whisperSegments={segs} currentTimeSec={1} />
    )
    // The bracketed tokens render as `<span>uh</span>` / `<span>like</span>`
    // with no other text inside — `getByText` finds them.
    expect(screen.getByText('uh')).toBeInTheDocument()
    expect(screen.getByText('like')).toBeInTheDocument()
  })

  it('exposes role="status" + aria-live="polite" for screen readers', () => {
    render(
      <VideoCaptionOverlay
        whisperSegments={[makeSegment(0, 0, 5, 'hello')]}
        currentTimeSec={1}
      />
    )
    const overlay = screen.getByRole('status')
    expect(overlay).toHaveAttribute('aria-live', 'polite')
  })

  it('shows the active segment timestamp in the header', () => {
    render(
      <VideoCaptionOverlay
        whisperSegments={[makeSegment(0, 75, 80, 'after a minute')]}
        currentTimeSec={76}
      />
    )
    // 75s = 1:15
    expect(screen.getByText(/1:15/)).toBeInTheDocument()
  })
})
