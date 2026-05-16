import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import DeliveryContentMatrix from '../DeliveryContentMatrix'
import type { AnswerEvaluation } from '@shared/types'
import type { ProsodySegment, FacialSegment } from '@shared/types/multimodal'

function evaln(qIdx: number, score: number): AnswerEvaluation {
  return {
    questionIndex: qIdx,
    question: `Q${qIdx + 1}?`,
    answer: '...',
    relevance: score,
    structure: score,
    specificity: score,
    ownership: score,
  } as AnswerEvaluation
}

function prosody(qIdx: number, marker: ProsodySegment['confidenceMarker']): ProsodySegment {
  return {
    startSec: 0, endSec: 30, wpm: 140, fillerWords: [],
    pauseDurationSec: 0, confidenceMarker: marker, questionIndex: qIdx,
  } as ProsodySegment
}

function facial(qIdx: number, eye: number, stab: number): FacialSegment {
  return {
    startSec: 0, endSec: 30, avgEyeContact: eye, dominantExpression: 'neutral',
    headStability: stab, gestureLevel: 'moderate', questionIndex: qIdx,
  } as FacialSegment
}

const QS = [
  { label: 'Q1', offsetSeconds: 0 },
  { label: 'Q2', offsetSeconds: 60 },
  { label: 'Q3', offsetSeconds: 120 },
]

describe('DeliveryContentMatrix (Round 5d #1)', () => {
  it('renders an empty-state when there are no questions', () => {
    render(<DeliveryContentMatrix questions={[]} />)
    expect(screen.getByText(/No questions in this session/i)).toBeInTheDocument()
  })

  it('renders the "not enough data" message when no Q has both content + facial', () => {
    render(
      <DeliveryContentMatrix
        evaluations={[evaln(0, 80)]}
        prosodySegments={[prosody(0, 'high')]}
        facialSegments={[]} // facial missing → excluded
        questions={[QS[0]]}
      />
    )
    expect(screen.getByText(/Not enough data/i)).toBeInTheDocument()
    expect(screen.getByTestId('matrix-footnote')).toBeInTheDocument()
  })

  it('renders the matrix with one dot per plottable Q', () => {
    render(
      <DeliveryContentMatrix
        evaluations={[evaln(0, 90), evaln(1, 20)]}
        prosodySegments={[prosody(0, 'high'), prosody(1, 'low')]}
        facialSegments={[facial(0, 0.9, 0.9), facial(1, 0.1, 0.1)]}
        questions={[QS[0], QS[1]]}
      />
    )
    expect(screen.getByTestId('delivery-content-matrix')).toBeInTheDocument()
    expect(screen.getByTestId('matrix-dot-Q1')).toBeInTheDocument()
    expect(screen.getByTestId('matrix-dot-Q2')).toBeInTheDocument()
    expect(screen.getByTestId('matrix-dot-Q1').getAttribute('data-quadrant')).toBe('nailed-it')
    expect(screen.getByTestId('matrix-dot-Q2').getAttribute('data-quadrant')).toBe('off-on-both')
  })

  it('renders all 4 quadrant labels (user-confirmed sharp copy)', () => {
    render(
      <DeliveryContentMatrix
        evaluations={[evaln(0, 90)]}
        prosodySegments={[prosody(0, 'high')]}
        facialSegments={[facial(0, 0.9, 0.9)]}
        questions={[QS[0]]}
      />
    )
    expect(screen.getByTestId('quadrant-label-nailed-it').textContent).toBe('Nailed it')
    expect(screen.getByTestId('quadrant-label-bluffed-confidently').textContent).toBe('Bluffed confidently')
    expect(screen.getByTestId('quadrant-label-knew-but-mumbled').textContent).toBe('Knew but mumbled')
    expect(screen.getByTestId('quadrant-label-off-on-both').textContent).toBe('Off on both')
  })

  it('renders the per-quadrant population summary (only nonzero quadrants)', () => {
    render(
      <DeliveryContentMatrix
        evaluations={[evaln(0, 90), evaln(1, 90)]}
        prosodySegments={[prosody(0, 'high'), prosody(1, 'high')]}
        facialSegments={[facial(0, 0.9, 0.9), facial(1, 0.9, 0.9)]}
        questions={[QS[0], QS[1]]}
      />
    )
    const summary = screen.getByTestId('matrix-quadrant-summary').textContent ?? ''
    expect(summary).toContain('2 Nailed it')
    expect(summary).not.toContain('Bluffed confidently')
    expect(summary).not.toContain('Off on both')
  })

  it('renders the footnote when one or more Qs are excluded', () => {
    render(
      <DeliveryContentMatrix
        evaluations={[evaln(0, 80), evaln(1, 80), evaln(2, 80)]}
        prosodySegments={[prosody(0, 'high'), prosody(1, 'high'), prosody(2, 'high')]}
        // Q2 has no facial data
        facialSegments={[facial(0, 0.9, 0.9), facial(2, 0.9, 0.9)]}
        questions={QS}
      />
    )
    const footnote = screen.getByTestId('matrix-footnote')
    expect(footnote.textContent).toMatch(/Q2/)
    expect(footnote.textContent).toMatch(/no facial signal/i)
  })

  it('clicking a dot calls onSeek with offsetSeconds + 8 lede skip', () => {
    const onSeek = vi.fn()
    render(
      <DeliveryContentMatrix
        evaluations={[evaln(0, 80), evaln(1, 80)]}
        prosodySegments={[prosody(0, 'high'), prosody(1, 'high')]}
        facialSegments={[facial(0, 0.9, 0.9), facial(1, 0.9, 0.9)]}
        questions={[QS[0], QS[1]]}
        onSeek={onSeek}
      />
    )
    fireEvent.click(screen.getByTestId('matrix-dot-Q2'))
    expect(onSeek).toHaveBeenCalledWith(68) // 60 + 8 lede skip
  })

  it('clicking the SVG background (not a dot) is a safe no-op', () => {
    const onSeek = vi.fn()
    render(
      <DeliveryContentMatrix
        evaluations={[evaln(0, 80)]}
        prosodySegments={[prosody(0, 'high')]}
        facialSegments={[facial(0, 0.9, 0.9)]}
        questions={[QS[0]]}
        onSeek={onSeek}
      />
    )
    const svg = screen.getByRole('img')
    fireEvent.click(svg) // hits SVG itself, not a [data-q] element
    expect(onSeek).not.toHaveBeenCalled()
  })

  it('does not throw when onSeek is omitted', () => {
    render(
      <DeliveryContentMatrix
        evaluations={[evaln(0, 80)]}
        prosodySegments={[prosody(0, 'high')]}
        facialSegments={[facial(0, 0.9, 0.9)]}
        questions={[QS[0]]}
      />
    )
    expect(() => fireEvent.click(screen.getByTestId('matrix-dot-Q1'))).not.toThrow()
  })

  it('exposes a hover <title> per dot naming Q + quadrant + numeric scores', () => {
    render(
      <DeliveryContentMatrix
        evaluations={[evaln(0, 90)]}
        prosodySegments={[prosody(0, 'high')]}
        facialSegments={[facial(0, 0.9, 0.9)]}
        questions={[QS[0]]}
      />
    )
    const titleEl = screen.getByTestId('matrix-dot-Q1').querySelector('title')
    expect(titleEl?.textContent).toContain('Q1')
    expect(titleEl?.textContent).toContain('Nailed it')
    expect(titleEl?.textContent).toMatch(/content \d+/)
    expect(titleEl?.textContent).toMatch(/delivery \d+/)
  })

  // Codex P2 a11y precedent from Round 5c — N dots must not be N tab stops.
  describe('accessibility', () => {
    it('does NOT render <button> elements per dot', () => {
      const { container } = render(
        <DeliveryContentMatrix
          evaluations={[evaln(0, 90), evaln(1, 90), evaln(2, 90)]}
          prosodySegments={[prosody(0, 'high'), prosody(1, 'high'), prosody(2, 'high')]}
          facialSegments={[facial(0, 0.9, 0.9), facial(1, 0.9, 0.9), facial(2, 0.9, 0.9)]}
          questions={QS}
          onSeek={vi.fn()}
        />
      )
      expect(container.querySelectorAll('button').length).toBe(0)
    })

    it('exposes a single role="img" wrapper with an aria-label naming the chart', () => {
      render(
        <DeliveryContentMatrix
          evaluations={[evaln(0, 90)]}
          prosodySegments={[prosody(0, 'high')]}
          facialSegments={[facial(0, 0.9, 0.9)]}
          questions={[QS[0]]}
        />
      )
      const svg = screen.getByRole('img')
      expect(svg.getAttribute('aria-label')).toMatch(/delivery.*content/i)
    })
  })
})
