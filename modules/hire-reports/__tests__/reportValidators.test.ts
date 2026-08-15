import { describe, expect, it } from 'vitest'
import {
  CreateHireJobCloseoutReportSchema,
  HireReportExportIdSchema,
  RequestHirePipelineStatusReportSchema,
} from '../validators/hireReports'

describe('Phase-5 report validators', () => {
  const operationId = '11111111-1111-4111-8111-111111111111'
  const jobId = '222222222222222222222222'

  it('accepts only a scoped, opaque pipeline-report request coordinate', () => {
    expect(RequestHirePipelineStatusReportSchema.parse({
      scope: 'workspace',
      format: 'xlsx',
      operationId,
    })).toEqual({ scope: 'workspace', format: 'xlsx', operationId })
    expect(RequestHirePipelineStatusReportSchema.parse({
      scope: 'job',
      jobId,
      format: 'pdf',
      operationId,
    })).toEqual({ scope: 'job', jobId, format: 'pdf', operationId })
  })

  it('rejects scope confusion, report content, lifecycle inputs, and unknown fields', () => {
    expect(RequestHirePipelineStatusReportSchema.safeParse({
      scope: 'job',
      format: 'pdf',
      operationId,
    }).success).toBe(false)
    expect(RequestHirePipelineStatusReportSchema.safeParse({
      scope: 'workspace',
      jobId,
      format: 'pdf',
      operationId,
    }).success).toBe(false)
    expect(RequestHirePipelineStatusReportSchema.safeParse({
      scope: 'workspace',
      format: 'pdf',
      operationId,
      expiresAt: '2099-01-01T00:00:00.000Z',
      snapshot: { candidateEmail: 'ada@example.test' },
    }).success).toBe(false)
  })

  it('keeps closeout generation server-coordinated and export identifiers opaque', () => {
    expect(CreateHireJobCloseoutReportSchema.parse({ jobId, operationId })).toEqual({ jobId, operationId })
    expect(CreateHireJobCloseoutReportSchema.safeParse({
      jobId,
      operationId,
      decisionNote: 'client supplied',
    }).success).toBe(false)
    expect(HireReportExportIdSchema.parse(jobId)).toBe(jobId)
    expect(HireReportExportIdSchema.safeParse('not-an-id').success).toBe(false)
  })
})
