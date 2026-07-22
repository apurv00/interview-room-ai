import { describe, expect, it } from 'vitest'
import {
  codeEvaluationToAnswerEvaluation,
  designEvaluationToAnswerEvaluation,
} from '../services/eval/answerEvaluationAdapters'

describe('server/client answer-evaluation adapters', () => {
  it('normalizes coding scores and trusts the server-selected question index', () => {
    expect(codeEvaluationToAnswerEvaluation(
      {
        questionIndex: 7,
        correctness: 91.4,
        code_quality: 84.6,
        efficiency: 77.2,
        edge_cases: 65.8,
        feedback: 'Clear solution.',
        flags: ['one issue'],
      },
      { title: 'Queue', description: 'Implement a bounded queue.' },
      { code: 'class Queue {}', language: 'typescript' },
    )).toMatchObject({
      questionIndex: 7,
      relevance: 91,
      structure: 85,
      specificity: 77,
      ownership: 66,
      status: 'ok',
      answer: 'class Queue {}',
    })
  })

  it('normalizes design evidence from the same structural shape used by the route', () => {
    expect(designEvaluationToAnswerEvaluation(
      {
        questionIndex: 3,
        requirements_clarity: 80,
        architecture: 75,
        scalability: 70,
        tradeoffs: 65,
      },
      { title: 'Payments', description: 'Design a payment service.' },
      {
        components: [{ label: 'API' }, { label: 'Database' }],
        connections: [{ from: 'api', to: 'db' }],
        questionIndex: 3,
      },
    )).toMatchObject({
      questionIndex: 3,
      relevance: 80,
      structure: 75,
      specificity: 70,
      ownership: 65,
      status: 'ok',
      answer: expect.stringContaining('2 components and 1 connections: API, Database'),
    })
  })
})
