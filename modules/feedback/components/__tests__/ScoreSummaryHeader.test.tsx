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

  it('anchors to the OVERALL score (not a separate average) + shows strongest/weakest', () => {
    const evals: AnswerEvaluation[] = [
      // Specificity is the lowest dimension; Relevance is highest
      makeEval({ relevance: 85, structure: 70, specificity: 40, ownership: 65 }),
      makeEval({ relevance: 90, structure: 75, specificity: 50, ownership: 60 }),
    ]
    // overall is passed in (same value as the hero ring), NOT recomputed here
    render(<ScoreSummaryHeader evaluations={evals} overallScore={47} />)

    expect(screen.getByText('47')).toBeInTheDocument()
    expect(screen.getByText('Overall')).toBeInTheDocument()
    // the old client "Avg score" of the dimensions (67) is gone
    expect(screen.queryByText('67')).not.toBeInTheDocument()
    expect(screen.getByText(/2 of 2 questions answered/i)).toBeInTheDocument()
    expect(screen.getByText('Strongest')).toBeInTheDocument()
    expect(screen.getByText('Weakest')).toBeInTheDocument()
    expect(screen.getAllByText('Relevance')[0]).toBeInTheDocument()
    expect(screen.getAllByText('Specificity')[0]).toBeInTheDocument()
  })

  it('excludes failed evaluations from the dimension diagnosis + completion', () => {
    const evals: AnswerEvaluation[] = [
      makeEval({ relevance: 90, structure: 80, specificity: 70, ownership: 60 }),
      // failed eval with junk fallback scores — should be ignored
      makeEval({ relevance: 50, structure: 50, specificity: 50, ownership: 50 }, 'failed'),
    ]
    render(<ScoreSummaryHeader evaluations={evals} overallScore={61} />)
    expect(screen.getByText('61')).toBeInTheDocument()
    expect(screen.getByText(/1 of 2 questions answered/i)).toBeInTheDocument()
  })

  it('labels the Strongest/Weakest pills per interview family (coding → Code Quality, not Structure)', () => {
    const evals: AnswerEvaluation[] = [
      makeEval({ relevance: 80, structure: 20, specificity: 70, ownership: 65 }),
    ]
    render(<ScoreSummaryHeader evaluations={evals} overallScore={47} interviewType="coding" />)
    // structure slot is weakest → labelled "Code Quality"; relevance slot → "Correctness"
    expect(screen.getByText('Code Quality')).toBeInTheDocument()
    expect(screen.getByText('Correctness')).toBeInTheDocument()
    expect(screen.queryByText('Structure')).not.toBeInTheDocument()
  })

  it('renders without an anchor number when no overall is provided (still shows diagnosis)', () => {
    const evals: AnswerEvaluation[] = [makeEval({ relevance: 85, structure: 70, specificity: 40, ownership: 65 })]
    render(<ScoreSummaryHeader evaluations={evals} />)
    expect(screen.queryByText('Overall')).not.toBeInTheDocument()
    expect(screen.getByText(/1 of 1 questions answered/i)).toBeInTheDocument()
    expect(screen.getByText('Strongest')).toBeInTheDocument()
  })
})
