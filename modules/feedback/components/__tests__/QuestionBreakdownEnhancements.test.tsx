import { describe, it, expect } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import QuestionBreakdown from '../QuestionBreakdown'
import type { AnswerEvaluation, TranscriptEntry } from '@shared/types'

function makeEval(i: number, scores: Partial<AnswerEvaluation>): AnswerEvaluation {
  return {
    questionIndex: i,
    question: `Question ${i + 1}`,
    answer: `Answer ${i + 1}`,
    relevance: 70,
    structure: 70,
    specificity: 70,
    ownership: 70,
    flags: [],
    ...scores,
  } as unknown as AnswerEvaluation
}

const transcript: TranscriptEntry[] = []

describe('QuestionBreakdown — sortOrder + dimension strip + controlled expansion', () => {
  it('renders questions in interview order by default', () => {
    const evals = [
      makeEval(0, { relevance: 30, structure: 30, specificity: 30, ownership: 30 }), // avg 30
      makeEval(1, { relevance: 90, structure: 90, specificity: 90, ownership: 90 }), // avg 90
      makeEval(2, { relevance: 60, structure: 60, specificity: 60, ownership: 60 }), // avg 60
    ]
    const { container } = render(
      <QuestionBreakdown transcript={transcript} evaluations={evals} />
    )
    const rows = container.querySelectorAll('[data-question-idx]')
    expect(rows[0].getAttribute('data-question-idx')).toBe('0')
    expect(rows[1].getAttribute('data-question-idx')).toBe('1')
    expect(rows[2].getAttribute('data-question-idx')).toBe('2')
  })

  it('reorders questions by ascending score when sortOrder="asc"', () => {
    const evals = [
      makeEval(0, { relevance: 30, structure: 30, specificity: 30, ownership: 30 }),
      makeEval(1, { relevance: 90, structure: 90, specificity: 90, ownership: 90 }),
      makeEval(2, { relevance: 60, structure: 60, specificity: 60, ownership: 60 }),
    ]
    const { container } = render(
      <QuestionBreakdown transcript={transcript} evaluations={evals} sortOrder="asc" />
    )
    const rows = container.querySelectorAll('[data-question-idx]')
    expect(rows[0].getAttribute('data-question-idx')).toBe('0') // 30
    expect(rows[1].getAttribute('data-question-idx')).toBe('2') // 60
    expect(rows[2].getAttribute('data-question-idx')).toBe('1') // 90
  })

  it('reorders questions by descending score when sortOrder="desc"', () => {
    const evals = [
      makeEval(0, { relevance: 30, structure: 30, specificity: 30, ownership: 30 }),
      makeEval(1, { relevance: 90, structure: 90, specificity: 90, ownership: 90 }),
      makeEval(2, { relevance: 60, structure: 60, specificity: 60, ownership: 60 }),
    ]
    const { container } = render(
      <QuestionBreakdown transcript={transcript} evaluations={evals} sortOrder="desc" />
    )
    const rows = container.querySelectorAll('[data-question-idx]')
    expect(rows[0].getAttribute('data-question-idx')).toBe('1')
    expect(rows[1].getAttribute('data-question-idx')).toBe('2')
    expect(rows[2].getAttribute('data-question-idx')).toBe('0')
  })

  it('renders the mini dimension strip with one bar per dimension on collapsed rows', () => {
    const evals = [
      makeEval(0, { relevance: 80, structure: 60, specificity: 40, ownership: 90 }),
    ]
    const { container } = render(
      <QuestionBreakdown transcript={transcript} evaluations={evals} />
    )
    const stripContainer = container.querySelector('[aria-label="Per-dimension scores"]')
    expect(stripContainer).toBeTruthy()
    expect(stripContainer?.children.length).toBe(4)
    // Confirm tooltip text exposes per-dimension scores
    const titles = Array.from(stripContainer?.querySelectorAll('[title]') ?? []).map(
      (el) => el.getAttribute('title')
    )
    expect(titles).toContain('Relevance: 80')
    expect(titles).toContain('Specificity: 40')
  })

  it('omits the dimension strip on failed evaluations', () => {
    const evals = [
      makeEval(0, { relevance: 50, structure: 50, specificity: 50, ownership: 50 }),
    ]
    ;(evals[0] as unknown as { status: string }).status = 'failed'
    const { container } = render(
      <QuestionBreakdown transcript={transcript} evaluations={evals} />
    )
    expect(container.querySelector('[aria-label="Per-dimension scores"]')).toBeNull()
  })

  it('renders 5 bars when jdAlignment is present', () => {
    const evals = [
      makeEval(0, { relevance: 80, structure: 60, specificity: 40, ownership: 90, jdAlignment: 70 }),
    ]
    const { container } = render(
      <QuestionBreakdown transcript={transcript} evaluations={evals} />
    )
    const stripContainer = container.querySelector('[aria-label="Per-dimension scores"]')
    expect(stripContainer?.children.length).toBe(5)
  })

  it('honors controlled expandedIdx — parent can expand a specific row', () => {
    const evals = [
      makeEval(0, { relevance: 80, structure: 80, specificity: 80, ownership: 80 }),
      makeEval(1, { relevance: 60, structure: 60, specificity: 60, ownership: 60 }),
    ]
    // Mount directly with row 1 controlled-expanded; assert Score Breakdown is visible there
    const { container } = render(
      <QuestionBreakdown
        transcript={transcript}
        evaluations={evals}
        expandedIdx={1}
        onExpandedChange={() => {}}
      />
    )
    const row1 = container.querySelector('[data-question-idx="1"]')!
    expect(within(row1 as HTMLElement).getByText('Score Breakdown')).toBeInTheDocument()
    // Row 0 must remain collapsed
    const row0 = container.querySelector('[data-question-idx="0"]')!
    expect(within(row0 as HTMLElement).queryByText('Score Breakdown')).toBeNull()
  })

  it('honors controlled expandedIdx=null — no row is expanded', () => {
    const evals = [
      makeEval(0, { relevance: 80, structure: 80, specificity: 80, ownership: 80 }),
      makeEval(1, { relevance: 60, structure: 60, specificity: 60, ownership: 60 }),
    ]
    render(
      <QuestionBreakdown
        transcript={transcript}
        evaluations={evals}
        expandedIdx={null}
        onExpandedChange={() => {}}
      />
    )
    expect(screen.queryByText('Score Breakdown')).toBeNull()
  })
})

describe('QuestionBreakdown — per-row eval-depth family (academics warm-ups, Codex P2 on #496)', () => {
  it('labels academics warm-ups (Q0/Q1) with the behavioral rubric, real probes with the academic rubric', () => {
    const evals = [
      makeEval(0, { relevance: 40, structure: 30, specificity: 40, ownership: 40 }), // warm-up → scored behavioral
      makeEval(2, { relevance: 40, structure: 30, specificity: 40, ownership: 40 }), // real viva → scored academic
    ]
    const { container, rerender } = render(
      <QuestionBreakdown
        transcript={transcript}
        evaluations={evals}
        interviewType="academics"
        expandedIdx={0}
      />
    )
    // Row 0 = questionIndex 0 warm-up → behavioral labels, NOT academic ones.
    const warmup = container.querySelector('[data-question-idx="0"]')! as HTMLElement
    expect(within(warmup).getByText('Structure (STAR)')).toBeInTheDocument()
    expect(within(warmup).queryByText('Conceptual Depth')).toBeNull()

    // Row 1 (array index 1) = questionIndex 2 real viva → academic labels.
    rerender(
      <QuestionBreakdown
        transcript={transcript}
        evaluations={evals}
        interviewType="academics"
        expandedIdx={1}
      />
    )
    const viva = container.querySelector('[data-question-idx="1"]')! as HTMLElement
    expect(within(viva).getByText('Conceptual Depth')).toBeInTheDocument()
    expect(within(viva).queryByText('Structure (STAR)')).toBeNull()
  })
})
