import { describe, expect, it } from 'vitest'
import {
  CreateHumanRoundSchema,
  SubmitHumanRoundScorecardSchema,
} from '../validators/hire'

const OPERATION_ID = '11111111-1111-4111-8111-111111111111'

const scorecard = {
  dimensions: [
    { key: 'role_capability', rating: 4, evidence: 'Explained the core platform trade-offs.' },
    { key: 'problem_solving', rating: 4, evidence: 'Worked through a production incident methodically.' },
    { key: 'communication', rating: 5, evidence: 'Made assumptions explicit and checked understanding.' },
    { key: 'collaboration', rating: 4, evidence: 'Described constructive cross-functional conflict handling.' },
  ],
  recommendation: 'yes' as const,
  overallComment: 'Solid evidence across the required rubric.',
}

describe('Phase 3 human-round validators', () => {
  it('accepts either explicit HR-owned human-round mode without engine fields', () => {
    expect(
      CreateHumanRoundSchema.parse({
        mode: 'guest_kit',
        interviewerName: 'Hiring Manager',
        interviewerEmail: 'manager@example.com',
        operationId: OPERATION_ID,
      }),
    ).toMatchObject({ mode: 'guest_kit' })
    expect(
      CreateHumanRoundSchema.parse({ mode: 'member_room', operationId: OPERATION_ID }),
    ).toEqual({ mode: 'member_room', operationId: OPERATION_ID })
    expect(() =>
      CreateHumanRoundSchema.parse({
        mode: 'member_room',
        interviewerEmail: 'not-permitted@example.com',
        operationId: OPERATION_ID,
      }),
    ).toThrow()
  })

  it('requires the exact canonical four-dimension scorecard order and bounded evidence', () => {
    expect(SubmitHumanRoundScorecardSchema.parse(scorecard)).toEqual(scorecard)
    expect(() =>
      SubmitHumanRoundScorecardSchema.parse({
        ...scorecard,
        dimensions: [...scorecard.dimensions].reverse(),
      }),
    ).toThrow(/Expected role_capability/)
    expect(() =>
      SubmitHumanRoundScorecardSchema.parse({
        ...scorecard,
        dimensions: scorecard.dimensions.map((dimension, index) =>
          index === 0 ? { ...dimension, rating: 6 } : dimension,
        ),
      }),
    ).toThrow()
  })
})
