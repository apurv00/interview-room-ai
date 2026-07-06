import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import IdealAnswerComparisonCard from '../IdealAnswerComparisonCard'
import type { AnswerEvaluation } from '@shared/types'

const ideal = { questionIndex: 0, strongAnswer: 'A strong answer.', keyElements: ['point'] }

function makeEval(scores: Partial<AnswerEvaluation>): AnswerEvaluation {
  return {
    questionIndex: 0,
    question: 'q',
    answer: 'a',
    relevance: 70,
    structure: 20, // weak → drives the "why it scored low" line
    specificity: 70,
    ownership: 70,
    flags: [],
    ...scores,
  } as unknown as AnswerEvaluation
}

describe('IdealAnswerComparisonCard — domain-aware labels + prose', () => {
  it('behavioral: labels the weak slot "Structure (STAR)" and uses STAR prose', () => {
    render(
      <IdealAnswerComparisonCard
        ideal={ideal}
        originalQuestion="Q"
        userAnswer="my answer"
        evaluation={makeEval({})}
      />
    )
    expect(screen.getAllByText('Structure (STAR)').length).toBeGreaterThan(0)
    expect(screen.getByText(/STAR framework not followed/i)).toBeInTheDocument()
  })

  it('coding: labels the same slot "Code Quality" and drops the STAR prose (no contradiction)', () => {
    render(
      <IdealAnswerComparisonCard
        ideal={ideal}
        originalQuestion="Q"
        userAnswer="my answer"
        evaluation={makeEval({})}
        interviewType="coding"
      />
    )
    expect(screen.getAllByText('Code Quality').length).toBeGreaterThan(0)
    expect(screen.queryByText(/STAR framework/i)).not.toBeInTheDocument()
    expect(screen.queryByText('Structure (STAR)')).not.toBeInTheDocument()
  })

  // Per-row academics rule (#496): Q0/Q1 warm-ups are scored behavioral, so their
  // labels/prose must be behavioral even in an academics session.
  it('academics warm-up (Q0): behavioral labels + STAR prose, NOT academic', () => {
    render(
      <IdealAnswerComparisonCard
        ideal={{ questionIndex: 0, strongAnswer: 'x', keyElements: ['p'] }}
        originalQuestion="Q"
        userAnswer="a"
        evaluation={makeEval({ questionIndex: 0 })}
        interviewType="academics"
      />
    )
    expect(screen.getAllByText('Structure (STAR)').length).toBeGreaterThan(0)
    expect(screen.getByText(/STAR framework not followed/i)).toBeInTheDocument()
    expect(screen.queryByText('Conceptual Depth')).not.toBeInTheDocument()
  })

  it('academics real probe (Q2): academic labels, no STAR prose', () => {
    render(
      <IdealAnswerComparisonCard
        ideal={{ questionIndex: 2, strongAnswer: 'x', keyElements: ['p'] }}
        originalQuestion="Q"
        userAnswer="a"
        evaluation={makeEval({ questionIndex: 2 })}
        interviewType="academics"
      />
    )
    expect(screen.getAllByText('Conceptual Depth').length).toBeGreaterThan(0)
    expect(screen.queryByText(/STAR framework/i)).not.toBeInTheDocument()
  })
})
