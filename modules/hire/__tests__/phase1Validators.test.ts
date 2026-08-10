import { describe, expect, it } from 'vitest'
import {
  BuildJobDescriptionSchema,
  CreateStructuredJobSchema,
  MoveStageSchema,
  UpdateJobStatusSchema,
} from '../validators/hire'

const BUILDER = {
  title: 'Backend Engineer',
  level: 'Senior',
  mustHaves: ['Production TypeScript'],
  niceToHaves: ['Kafka'],
  location: 'Bengaluru, India',
  workMode: 'hybrid' as const,
}

describe('Smart-JD validators', () => {
  it('accepts the complete strict builder/create contracts', () => {
    expect(BuildJobDescriptionSchema.parse(BUILDER)).toEqual(BUILDER)
    expect(
      CreateStructuredJobSchema.parse({
        ...BUILDER,
        jdText: 'A reviewed description '.repeat(4),
      }),
    ).toMatchObject(BUILDER)
  })

  it('rejects unknown fields and duplicates across importance groups', () => {
    expect(() => BuildJobDescriptionSchema.parse({ ...BUILDER, surprise: true })).toThrow()
    expect(() =>
      BuildJobDescriptionSchema.parse({
        ...BUILDER,
        niceToHaves: [' production   typescript '],
      }),
    ).toThrow(/Duplicate requirement/)
  })
})

describe('human decision command validators', () => {
  it('requires explicit expected state and an idempotency key', () => {
    expect(() =>
      UpdateJobStatusSchema.parse({ status: 'closed', closeNote: 'Role filled.' }),
    ).toThrow()
    expect(() => MoveStageSchema.parse({ action: 'advance' })).toThrow()
  })

  it('requires close and accepted-offer decision notes', () => {
    expect(() =>
      UpdateJobStatusSchema.parse({
        status: 'closed',
        expectedStatus: 'open',
        operationId: '11111111-1111-4111-8111-111111111111',
      }),
    ).toThrow(/decision note/i)
    expect(() =>
      MoveStageSchema.parse({
        action: 'offer_accepted',
        expectedFrom: 'offer',
        operationId: '11111111-1111-4111-8111-111111111111',
      }),
    ).toThrow(/decision note/i)
  })

  it('accepts every explicit Phase-1 pipeline outcome', () => {
    for (const action of ['advance', 'reject', 'withdraw', 'offer_declined'] as const) {
      expect(() =>
        MoveStageSchema.parse({
          action,
          expectedFrom: action === 'offer_declined' ? 'offer' : 'screened',
          operationId: '11111111-1111-4111-8111-111111111111',
        }),
      ).not.toThrow()
    }
    expect(() =>
      MoveStageSchema.parse({
        action: 'offer_accepted',
        expectedFrom: 'offer',
        operationId: '11111111-1111-4111-8111-111111111111',
        note: 'Candidate accepted after human review.',
      }),
    ).not.toThrow()
  })
})
