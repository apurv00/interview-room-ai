import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import ExpressionStrip from '../ExpressionStrip'
import type { FacialSegment } from '@shared/types/multimodal'

function fs(dominantExpression: string, questionIndex?: number): FacialSegment {
  return {
    startSec: 0,
    endSec: 30,
    avgEyeContact: 0.8,
    dominantExpression,
    headStability: 0.9,
    gestureLevel: 'moderate',
    questionIndex,
  } as FacialSegment
}

const QS = [
  { label: 'Q1', offsetSeconds: 0 },
  { label: 'Q2', offsetSeconds: 60 },
  { label: 'Q3', offsetSeconds: 120 },
]

describe('ExpressionStrip (Round 5b #5)', () => {
  it('renders nothing when no questions are provided', () => {
    const { container } = render(
      <ExpressionStrip questions={[]} totalDurationSec={300} onJumpToQuestion={vi.fn()} />
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('renders nothing when totalDurationSec is 0', () => {
    const { container } = render(
      <ExpressionStrip
        questions={QS}
        totalDurationSec={0}
        facialSegments={[fs('smile'), fs('frown'), fs('neutral')]}
        onJumpToQuestion={vi.fn()}
      />
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('renders nothing when facialSegments is missing entirely', () => {
    const { container } = render(
      <ExpressionStrip questions={QS} totalDurationSec={300} onJumpToQuestion={vi.fn()} />
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('renders nothing when every facial segment lacks a dominantExpression (privacy mode)', () => {
    const { container } = render(
      <ExpressionStrip
        questions={QS}
        totalDurationSec={300}
        facialSegments={[undefined, undefined, undefined]}
        onJumpToQuestion={vi.fn()}
      />
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('renders an emoji per question when at least one expression is present', () => {
    render(
      <ExpressionStrip
        questions={QS}
        totalDurationSec={300}
        facialSegments={[fs('smile'), fs('frown'), fs('neutral')]}
        onJumpToQuestion={vi.fn()}
      />
    )
    const strip = screen.getByTestId('expression-strip')
    // 3 question chips → 3 buttons
    expect(strip.querySelectorAll('button')).toHaveLength(3)
    expect(screen.getByText('🙂')).toBeInTheDocument()
    expect(screen.getByText('😟')).toBeInTheDocument()
    expect(screen.getByText('😐')).toBeInTheDocument()
  })

  it('dims neutral and unknown expressions to opacity 0.35; full opacity otherwise', () => {
    render(
      <ExpressionStrip
        questions={QS}
        totalDurationSec={300}
        facialSegments={[fs('smile'), fs('neutral'), fs('made-up-class')]}
        onJumpToQuestion={vi.fn()}
      />
    )
    const buttons = screen.getByTestId('expression-strip').querySelectorAll('button')
    // smile → 1 (full)
    expect(buttons[0].style.opacity).toBe('1')
    // neutral → 0.35
    expect(buttons[1].style.opacity).toBe('0.35')
    // unknown → dims to neutral
    expect(buttons[2].style.opacity).toBe('0.35')
  })

  it('clicking an emoji calls onJumpToQuestion with offsetSeconds+8 lede skip + index', () => {
    const onJump = vi.fn()
    render(
      <ExpressionStrip
        questions={QS}
        totalDurationSec={300}
        facialSegments={[fs('smile'), fs('frown'), fs('focused')]}
        onJumpToQuestion={onJump}
      />
    )
    fireEvent.click(screen.getByText('🤔'))
    expect(onJump).toHaveBeenCalledWith(128, 2) // Q3 = 120 + 8
  })

  it('uses the focused emoji for the "focused" class and surprise for "surprise"', () => {
    render(
      <ExpressionStrip
        questions={QS}
        totalDurationSec={300}
        facialSegments={[fs('focused'), fs('surprise'), fs('smile')]}
        onJumpToQuestion={vi.fn()}
      />
    )
    expect(screen.getByText('🤔')).toBeInTheDocument()
    expect(screen.getByText('😯')).toBeInTheDocument()
    expect(screen.getByText('🙂')).toBeInTheDocument()
  })

  it('handles case-insensitive expression class names', () => {
    render(
      <ExpressionStrip
        questions={[QS[0]]}
        totalDurationSec={300}
        facialSegments={[fs('SMILE')]}
        onJumpToQuestion={vi.fn()}
      />
    )
    expect(screen.getByText('🙂')).toBeInTheDocument()
  })

  it('per-Q title attribute names the expression class for hover discoverability', () => {
    render(
      <ExpressionStrip
        questions={[QS[0], QS[1]]}
        totalDurationSec={300}
        facialSegments={[fs('smile'), undefined]}
        onJumpToQuestion={vi.fn()}
      />
    )
    const buttons = screen.getByTestId('expression-strip').querySelectorAll('button')
    expect(buttons[0].getAttribute('title')).toBe('Q1 · smile')
    // Missing segment → fallback text
    expect(buttons[1].getAttribute('title')).toBe('Q2 · no expression data')
  })
})
