import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import ScoreSummaryHeader from '../ScoreSummaryHeader'
import type { AnswerEvaluation } from '@shared/types'

function makeEval(scores: Partial<AnswerEvaluation>, status?: string): AnswerEvaluation {
  return {
    questionIndex: 0,
    question: 'q',
    answer: 'a',
    relevance: 70,
    structure: 70,
    specificity: 70,
    ownership: 70,
    flags: [],
    ...scores,
    ...(status ? { status } : {}),
  } as unknown as AnswerEvaluation
}

describe('ScoreSummaryHeader', () => {
  it('renders empty state when no evaluations exist', () => {
    render(<ScoreSummaryHeader evaluations={[]} />)
    expect(screen.getByText(/No questions were answered/i)).toBeInTheDocument()
  })

  it('renders empty state when all evaluations failed', () => {
    render(
      <ScoreSummaryHeader
        evaluations={[makeEval({}, 'failed'), makeEval({}, 'failed')]}
      />
    )
    expect(screen.getByText(/No scorable answers/i)).toBeInTheDocument()
  })

  it('shows the dimension averages, the strongest dimension and the weakest dimension', () => {
    const evals: AnswerEvaluation[] = [
      // Specificity is the lowest dimension; Relevance is highest
      makeEval({ relevance: 85, structure: 70, specificity: 40, ownership: 65 }),
      makeEval({ relevance: 90, structure: 75, specificity: 50, ownership: 60 }),
    ]
    render(<ScoreSummaryHeader evaluations={evals} />)

    // Avg of dimension averages: rel 88, str 73, spec 45, own 63 → mean 67
    expect(screen.getByText('67')).toBeInTheDocument()
    expect(screen.getByText(/2 of 2 questions answered/i)).toBeInTheDocument()
    expect(screen.getByText('Strongest')).toBeInTheDocument()
    expect(screen.getByText('Weakest')).toBeInTheDocument()
    expect(screen.getAllByText('Relevance')[0]).toBeInTheDocument()
    expect(screen.getAllByText('Specificity')[0]).toBeInTheDocument()
  })

  it('excludes failed evaluations from the average', () => {
    const evals: AnswerEvaluation[] = [
      // Distinct dimension scores so the avg (75) doesn't collide with any
      // pill numeric in the rendered output.
      makeEval({ relevance: 90, structure: 80, specificity: 70, ownership: 60 }),
      // failed eval with junk fallback scores — should be ignored
      makeEval({ relevance: 50, structure: 50, specificity: 50, ownership: 50 }, 'failed'),
    ]
    render(<ScoreSummaryHeader evaluations={evals} />)
    // Avg of dimension averages: (90+80+70+60)/4 = 75
    expect(screen.getByText('75')).toBeInTheDocument()
    expect(screen.getByText(/1 of 2 questions answered/i)).toBeInTheDocument()
  })
})
