import { describe, it, expect } from 'vitest'
import {
  CreateWizardSessionSchema,
  SubmitStageSchema,
  GenerateFollowUpsSchema,
  ReviewSubmitSchema,
  ExportWizardSchema,
} from '../wizardSchemas'

describe('CreateWizardSessionSchema', () => {
  it('accepts valid segments', () => {
    expect(CreateWizardSessionSchema.parse({ segment: 'fresh_grad' })).toEqual({ segment: 'fresh_grad' })
    expect(CreateWizardSessionSchema.parse({ segment: 'experienced' })).toEqual({ segment: 'experienced' })
  })

  it('rejects invalid segments', () => {
    expect(() => CreateWizardSessionSchema.parse({ segment: 'invalid' })).toThrow()
    expect(() => CreateWizardSessionSchema.parse({})).toThrow()
  })
})

describe('SubmitStageSchema', () => {
  it('validates stage 1 contact info', () => {
    const result = SubmitStageSchema.parse({
      sessionId: 'abc',
      data: {
        stage: 1,
        contactInfo: { fullName: 'Jane', email: 'jane@example.com' },
      },
    })
    expect(result.data.stage).toBe(1)
  })

  it('validates stage 2 roles', () => {
    const result = SubmitStageSchema.parse({
      sessionId: 'abc',
      data: {
        stage: 2,
        roles: [{ id: 'r1', company: 'Acme', title: 'Dev', startDate: 'Jan 2023', rawBullets: ['Did things'] }],
      },
    })
    expect(result.data.stage).toBe(2)
  })

  it('rejects stage 2 with empty roles', () => {
    expect(() => SubmitStageSchema.parse({
      sessionId: 'abc',
      data: { stage: 2, roles: [] },
    })).toThrow()
  })

  it('validates stage 4 skills', () => {
    const result = SubmitStageSchema.parse({
      sessionId: 'abc',
      data: {
        stage: 4,
        skills: { hard: ['Python'], soft: [], technical: [] },
      },
    })
    expect(result.data.stage).toBe(4)
  })

  it('validates stage 5 with optional fields', () => {
    const result = SubmitStageSchema.parse({
      sessionId: 'abc',
      data: { stage: 5 },
    })
    expect(result.data.stage).toBe(5)
  })
})

describe('GenerateFollowUpsSchema', () => {
  it('validates complete input', () => {
    const result = GenerateFollowUpsSchema.parse({
      sessionId: 'abc',
      roleId: 'r1',
      jobTitle: 'Barista',
      rawDescription: 'Made coffee',
    })
    expect(result.jobTitle).toBe('Barista')
  })

  it('rejects missing required fields', () => {
    expect(() => GenerateFollowUpsSchema.parse({
      sessionId: 'abc',
      roleId: 'r1',
    })).toThrow()
  })
})

describe('ReviewSubmitSchema', () => {
  it('validates review decisions', () => {
    const result = ReviewSubmitSchema.parse({
      sessionId: 'abc',
      bulletDecisions: [
        { roleId: 'r1', bulletIndex: 0, decision: 'accept' },
        { roleId: 'r1', bulletIndex: 1, decision: 'edit', editedText: 'Changed text' },
      ],
      summaryDecision: 'accept',
    })
    expect(result.bulletDecisions).toHaveLength(2)
  })

  it('rejects invalid decision type', () => {
    expect(() => ReviewSubmitSchema.parse({
      sessionId: 'abc',
      bulletDecisions: [{ roleId: 'r1', bulletIndex: 0, decision: 'maybe' }],
      summaryDecision: 'accept',
    })).toThrow()
  })
})

describe('ExportWizardSchema', () => {
  it('validates with defaults', () => {
    const result = ExportWizardSchema.parse({ sessionId: 'abc' })
    expect(result.format).toBe('pdf')
  })

  it('accepts explicit template', () => {
    const result = ExportWizardSchema.parse({ sessionId: 'abc', template: 'modern', format: 'pdf' })
    expect(result.template).toBe('modern')
  })
})
