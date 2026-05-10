import { buildFailedAnswerEvaluation } from '@interview/hooks/useInterviewAPI'

describe('useInterviewAPI fallback evaluations', () => {
  it('marks timeout fallback scores as status="failed"', () => {
    const evaluation = buildFailedAnswerEvaluation('Question?', 'Answer', 2, {
      relevance: 50,
      structure: 50,
      specificity: 50,
      ownership: 50,
    })

    expect(evaluation).toMatchObject({
      questionIndex: 2,
      relevance: 50,
      structure: 50,
      specificity: 50,
      ownership: 50,
      status: 'failed',
      probeDecision: { shouldProbe: false },
    })
  })
})
