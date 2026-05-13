import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import ReplayTranscript from '../ReplayTranscript'
import type { WhisperSegment } from '@shared/types/multimodal'
import type { TranscriptEntry } from '@shared/types'

const whisperSegments: WhisperSegment[] = [
  {
    id: 1,
    start: 0,
    end: 2,
    text: 'Hello world',
    words: [
      { word: 'Hello', start: 0.1, end: 0.8, confidence: 0.98 },
      { word: 'world', start: 1.0, end: 1.8, confidence: 0.97 },
    ],
  },
]

const transcript: TranscriptEntry[] = [
  {
    speaker: 'candidate',
    text: 'Hello world',
    timestamp: 0,
  },
]

function rect(top: number, height = 20): DOMRect {
  return {
    x: 0,
    y: top,
    width: 100,
    height,
    top,
    right: 100,
    bottom: top + height,
    left: 0,
    toJSON: () => ({}),
  } as DOMRect
}

function renderTranscript(
  currentTimeSec: number,
  onWordClick = vi.fn(),
  className = 'max-h-[60vh]'
) {
  return render(
    <ReplayTranscript
      whisperSegments={whisperSegments}
      transcript={transcript}
      currentTimeSec={currentTimeSec}
      onWordClick={onWordClick}
      className={className}
    />
  )
}

describe('ReplayTranscript', () => {
  let scrollIntoViewSpy: ReturnType<typeof vi.fn>

  beforeEach(() => {
    scrollIntoViewSpy = vi.fn()
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoViewSpy,
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('scrolls only its local transcript container when the active word changes', () => {
    const { rerender } = renderTranscript(0.2)
    const container = screen.getByTestId('replay-transcript-scroll') as HTMLDivElement
    const world = screen.getByText('world')

    Object.defineProperty(container, 'clientHeight', {
      configurable: true,
      value: 100,
    })
    container.scrollTop = 10
    vi.spyOn(container, 'getBoundingClientRect').mockReturnValue(rect(0, 100))
    vi.spyOn(world, 'getBoundingClientRect').mockReturnValue(rect(210, 20))

    rerender(
      <ReplayTranscript
        whisperSegments={whisperSegments}
        transcript={transcript}
        currentTimeSec={1.2}
        onWordClick={vi.fn()}
        className="max-h-[60vh]"
      />
    )

    expect(scrollIntoViewSpy).not.toHaveBeenCalled()
    expect(container.scrollTop).toBe(180)
  })

  it('applies the caller-provided height class to the scroll container', () => {
    renderTranscript(0.2, vi.fn(), 'max-h-[340px]')

    const container = screen.getByTestId('replay-transcript-scroll')
    expect(container.className).toContain('max-h-[340px]')
    expect(container.className).toContain('overflow-y-auto')
  })

  it('calls onWordClick when a transcript word is clicked', () => {
    const onWordClick = vi.fn()
    renderTranscript(0.2, onWordClick)

    fireEvent.click(screen.getByText('Hello'))

    expect(onWordClick).toHaveBeenCalledWith(0.1)
  })

  it('temporarily suspends auto-follow after the user scrolls the transcript', () => {
    const { rerender } = renderTranscript(0.2)
    const container = screen.getByTestId('replay-transcript-scroll') as HTMLDivElement
    const world = screen.getByText('world')

    Object.defineProperty(container, 'clientHeight', {
      configurable: true,
      value: 100,
    })
    container.scrollTop = 10
    vi.spyOn(container, 'getBoundingClientRect').mockReturnValue(rect(0, 100))
    vi.spyOn(world, 'getBoundingClientRect').mockReturnValue(rect(210, 20))
    vi.spyOn(Date, 'now').mockReturnValue(9_000_000_000_000)

    fireEvent.scroll(container)
    rerender(
      <ReplayTranscript
        whisperSegments={whisperSegments}
        transcript={transcript}
        currentTimeSec={1.2}
        onWordClick={vi.fn()}
        className="max-h-[60vh]"
      />
    )

    expect(container.scrollTop).toBe(10)
  })
})
