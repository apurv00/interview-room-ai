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

  it('accepts bounded Hire-only screening defaults without widening the JD builder contract', () => {
    expect(
      CreateStructuredJobSchema.parse({
        ...BUILDER,
        jdText: 'A reviewed description '.repeat(4),
        screeningSettings: { location: 'Bengaluru, India', experienceFloorYears: 3 },
      }),
    ).toMatchObject({
      screeningSettings: { location: 'Bengaluru, India', experienceFloorYears: 3 },
    })
    expect(() =>
      BuildJobDescriptionSchema.parse({
        ...BUILDER,
        screeningSettings: { experienceFloorYears: 3 },
      }),
    ).toThrow()
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

  it('accepts fixed close-email placeholders and rejects header injection or malformed tokens', () => {
    const close = {
      status: 'closed' as const,
      expectedStatus: 'open' as const,
      operationId: '11111111-1111-4111-8111-111111111111',
      closeNote: 'Role filled after panel review.',
    }
    expect(
      UpdateJobStatusSchema.parse({
        ...close,
        closeEmailTemplate: {
          subject: '{workspace_name}: update for {candidate_first_name}',
          body: 'Hi {candidate_first_name},\r\n\r\n{job_title} has closed at {workspace_name}.',
        },
      }),
    ).toMatchObject({
      closeEmailTemplate: {
        subject: '{workspace_name}: update for {candidate_first_name}',
        body: 'Hi {candidate_first_name},\n\n{job_title} has closed at {workspace_name}.',
      },
    })
    expect(() =>
      UpdateJobStatusSchema.parse({
        ...close,
        closeEmailTemplate: {
          subject: 'Update\r\nBcc: attacker@example.com',
          body: 'Hi {candidate_first_name}',
        },
      }),
    ).toThrow(/line breaks/i)
    expect(() =>
      UpdateJobStatusSchema.parse({
        ...close,
        closeEmailTemplate: {
          subject: 'Update for {candidate_name}',
          body: 'Hi {candidate_first_name}',
        },
      }),
    ).toThrow(/Unsupported placeholder/i)
    expect(() =>
      UpdateJobStatusSchema.parse({
        ...close,
        closeEmailTemplate: {
          subject: 'Update for {candidate_first_name',
          body: 'Hi {candidate_first_name}',
        },
      }),
    ).toThrow(/balanced braces/i)
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
