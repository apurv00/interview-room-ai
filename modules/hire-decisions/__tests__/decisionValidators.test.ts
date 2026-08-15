import { describe, expect, it } from 'vitest'
import {
  CompareHireDecisionApplicationsSchema,
  CreateSharePacketSchema,
  ReadHireDecisionActionInboxSchema,
  RequestHireAssessmentExportSchema,
  SharePacketCapabilitySchema,
  SubmitExternalVerdictSchema,
} from '../validators/hireDecisions'

describe('Phase-4 decision validators', () => {
  it('accepts a bounded, unique packet section selection and operation id', () => {
    expect(CreateSharePacketSchema.parse({
      allowedSections: ['candidate_brief', 'ai_assessments'],
      operationId: 'b6c65a8d-b8b0-4982-b9e7-7571bd60b1f8',
    })).toEqual({
      allowedSections: ['candidate_brief', 'ai_assessments'],
      operationId: 'b6c65a8d-b8b0-4982-b9e7-7571bd60b1f8',
    })
    expect(CreateSharePacketSchema.safeParse({
      allowedSections: ['candidate_brief', 'candidate_brief'],
      operationId: 'b6c65a8d-b8b0-4982-b9e7-7571bd60b1f8',
    }).success).toBe(false)
  })

  it('requires a three-coordinate capability with a 32-byte raw secret', () => {
    const capability = `${'1'.repeat(24)}.${'2'.repeat(24)}.${'ab'.repeat(32)}`
    expect(SharePacketCapabilitySchema.parse(capability)).toBe(capability)
    expect(SharePacketCapabilitySchema.safeParse(`${'1'.repeat(24)}.${'2'.repeat(24)}.short`).success).toBe(false)
  })

  it('accepts only one bounded external recommendation/comment and rejects scorecard payloads', () => {
    expect(SubmitExternalVerdictSchema.parse({
      recommendation: 'strong_yes',
      comment: 'The scoped evidence supports a clear next step.',
    })).toEqual({
      recommendation: 'strong_yes',
      comment: 'The scoped evidence supports a clear next step.',
    })
    expect(SubmitExternalVerdictSchema.safeParse({
      recommendation: 'yes',
      dimensions: [{ key: 'communication', rating: 5 }],
    }).success).toBe(false)
    expect(SubmitExternalVerdictSchema.safeParse({
      recommendation: 'yes',
      comment: 'x'.repeat(2_001),
    }).success).toBe(false)
  })

  it('validates scoped read-only inbox and same-job compare selections', () => {
    const workspaceId = '1'.repeat(24)
    const jobId = '2'.repeat(24)
    const appA = '3'.repeat(24)
    const appB = '4'.repeat(24)
    expect(ReadHireDecisionActionInboxSchema.parse({
      workspaceId,
      jobId,
      applicationId: appA,
      limit: 50,
      externalVerdictsSince: '2026-08-14T10:00:00.000Z',
    })).toMatchObject({ workspaceId, jobId, applicationId: appA, limit: 50 })
    expect(CompareHireDecisionApplicationsSchema.parse({
      workspaceId,
      jobId,
      applicationIds: [appB, appA],
    })).toEqual({ workspaceId, jobId, applicationIds: [appB, appA] })
    expect(CompareHireDecisionApplicationsSchema.safeParse({
      workspaceId,
      jobId,
      applicationIds: [appA, appA],
    }).success).toBe(false)
  })

  it('accepts only an opaque member export request coordinate and UUID operation', () => {
    const applicationId = '3'.repeat(24)
    expect(RequestHireAssessmentExportSchema.parse({
      applicationId,
      operationId: '11111111-1111-4111-8111-111111111111',
    })).toEqual({
      applicationId,
      operationId: '11111111-1111-4111-8111-111111111111',
    })
    expect(RequestHireAssessmentExportSchema.safeParse({
      applicationId,
      operationId: 'not-an-operation-id',
      expiresAt: '2099-01-01T00:00:00.000Z',
    }).success).toBe(false)
  })
})
