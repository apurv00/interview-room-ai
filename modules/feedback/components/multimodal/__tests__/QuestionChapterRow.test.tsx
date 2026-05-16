import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import QuestionChapterRow from '../QuestionChapterRow'

const QS = [
  { label: 'Q1', offsetSeconds: 0 },
  { label: 'Q2', offsetSeconds: 60 },
  { label: 'Q3', offsetSeconds: 120 },
]

describe('QuestionChapterRow', () => {
  it('renders nothing when no questions are provided', () => {
    const { container } = render(
      <QuestionChapterRow questions={[]} totalDurationSec={300} activeIndex={-1} onJumpToQuestion={vi.fn()} />
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('renders nothing when totalDurationSec is 0 (would div by zero)', () => {
    const { container } = render(
      <QuestionChapterRow questions={QS} totalDurationSec={0} activeIndex={-1} onJumpToQuestion={vi.fn()} />
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('renders one labeled chip per question', () => {
    render(
      <QuestionChapterRow questions={QS} totalDurationSec={300} activeIndex={-1} onJumpToQuestion={vi.fn()} />
    )
    expect(screen.getByText('Q1')).toBeInTheDocument()
    expect(screen.getByText('Q2')).toBeInTheDocument()
    expect(screen.getByText('Q3')).toBeInTheDocument()
  })

  it('marks the active chip via aria-pressed', () => {
    render(
      <QuestionChapterRow questions={QS} totalDurationSec={300} activeIndex={1} onJumpToQuestion={vi.fn()} />
    )
    const q2 = screen.getByText('Q2').closest('button')!
    expect(q2.getAttribute('aria-pressed')).toBe('true')
    const q1 = screen.getByText('Q1').closest('button')!
    expect(q1.getAttribute('aria-pressed')).toBe('false')
  })

  it('click calls onJumpToQuestion with offsetSeconds+8 lede skip + index', () => {
    const onJump = vi.fn()
    render(
      <QuestionChapterRow questions={QS} totalDurationSec={300} activeIndex={-1} onJumpToQuestion={onJump} />
    )
    fireEvent.click(screen.getByText('Q2'))
    expect(onJump).toHaveBeenCalledWith(68, 1) // 60 + 8 lede skip
  })

  // Round 5b feature #8 — composure dots
  describe('composure dots', () => {
    it('renders 3 dots per chip when composureLevels are provided', () => {
      render(
        <QuestionChapterRow
          questions={QS}
          totalDurationSec={300}
          activeIndex={-1}
          onJumpToQuestion={vi.fn()}
          composureLevels={[3, 2, 1]}
        />
      )
      const dotGroups = screen.getAllByTestId('composure-dots')
      expect(dotGroups).toHaveLength(3)
      // Each group has 3 dot spans
      expect(dotGroups[0].children).toHaveLength(3)
    })

    it('exposes data-level matching the input level for screen-reader testing', () => {
      render(
        <QuestionChapterRow
          questions={QS}
          totalDurationSec={300}
          activeIndex={-1}
          onJumpToQuestion={vi.fn()}
          composureLevels={[3, 2, 1]}
        />
      )
      const groups = screen.getAllByTestId('composure-dots')
      expect(groups[0].getAttribute('data-level')).toBe('3')
      expect(groups[1].getAttribute('data-level')).toBe('2')
      expect(groups[2].getAttribute('data-level')).toBe('1')
    })

    it('skips the dot group entirely when a level is null (missing data)', () => {
      render(
        <QuestionChapterRow
          questions={QS}
          totalDurationSec={300}
          activeIndex={-1}
          onJumpToQuestion={vi.fn()}
          composureLevels={[3, null, 1]}
        />
      )
      // Only 2 chips have dots — Q2 is omitted
      expect(screen.getAllByTestId('composure-dots')).toHaveLength(2)
    })

    it('omits all dot groups when composureLevels is undefined (legacy callers)', () => {
      render(
        <QuestionChapterRow questions={QS} totalDurationSec={300} activeIndex={-1} onJumpToQuestion={vi.fn()} />
      )
      expect(screen.queryAllByTestId('composure-dots')).toHaveLength(0)
    })

    it('includes the composure level in the chip title attribute for hover discoverability', () => {
      render(
        <QuestionChapterRow
          questions={QS}
          totalDurationSec={300}
          activeIndex={-1}
          onJumpToQuestion={vi.fn()}
          composureLevels={[3, null, 1]}
        />
      )
      const q1 = screen.getByText('Q1').closest('button')!
      const q2 = screen.getByText('Q2').closest('button')!
      expect(q1.getAttribute('title')).toContain('composure 3/3')
      // Q2 has no level → no composure suffix in title
      expect(q2.getAttribute('title')).toBe('Jump to Q2')
    })
  })
})
