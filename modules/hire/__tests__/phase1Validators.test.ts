import { describe, expect, it } from 'vitest'
import {
  BuildJobDescriptionSchema,
  CreateStructuredJobSchema,
  DuplicateJobSchema,
  MoveStageSchema,
  UpdateJobDepartmentSchema,
  UpdateJobStatusSchema,
} from '../validators/hire'

const BUILDER = {
  title: 'Backend Engineer',
  level: 'manager',
  targetExperienceRange: { minYears: 3, maxYears: 8 },
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
        departmentId: '111111111111111111111111',
        jdText: 'A reviewed description '.repeat(4),
      }),
    ).toMatchObject(BUILDER)
  })

  it('accepts bounded Hire-only screening defaults without widening the JD builder contract', () => {
    expect(
      CreateStructuredJobSchema.parse({
        ...BUILDER,
        departmentId: '111111111111111111111111',
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

  it('keeps level and experience range separate, and rejects a per-job company override', () => {
    expect(() =>
      BuildJobDescriptionSchema.parse({ ...BUILDER, level: 'Senior · 3–8 years' }),
    ).toThrow()
    expect(() =>
      BuildJobDescriptionSchema.parse({
        ...BUILDER,
        targetExperienceRange: { minYears: 8, maxYears: 3 },
      }),
    ).toThrow(/Minimum experience/)
    expect(() =>
      CreateStructuredJobSchema.parse({
        ...BUILDER,
        departmentId: '111111111111111111111111',
        jdText: 'A reviewed description '.repeat(4),
        companyBlurb: 'A client must not override workspace company context.',
      }),
    ).toThrow()
    expect(() =>
      BuildJobDescriptionSchema.parse({
        ...BUILDER,
        companyBlurb: 'A client must not override workspace company context.',
      }),
    ).toThrow()
  })

  it('requires a department only for the persisted job command, not Smart-JD generation', () => {
    expect(() =>
      CreateStructuredJobSchema.parse({
        ...BUILDER,
        jdText: 'A reviewed description '.repeat(4),
      }),
    ).toThrow()
    expect(BuildJobDescriptionSchema.parse(BUILDER)).toEqual(BUILDER)
    expect(DuplicateJobSchema.parse({ departmentId: '111111111111111111111111' })).toEqual({
      departmentId: '111111111111111111111111',
    })
    expect(UpdateJobDepartmentSchema.parse({ departmentId: '111111111111111111111111' })).toEqual({
      departmentId: '111111111111111111111111',
    })
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
