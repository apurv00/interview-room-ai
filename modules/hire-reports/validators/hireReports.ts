import { z } from 'zod'
import { HIRE_REPORT_FORMATS, HIRE_REPORT_SCOPES } from '../types'

const reportObjectIdSchema = z.string().regex(/^[a-f0-9]{24}$/i, 'Invalid id')

/**
 * Authenticated member request only. The service supplies workspace authority,
 * expiry, private coordinates, and the deep-allowlisted snapshot.
 */
export const RequestHirePipelineStatusReportSchema = z
  .object({
    scope: z.enum(HIRE_REPORT_SCOPES),
    jobId: reportObjectIdSchema.optional(),
    format: z.enum(HIRE_REPORT_FORMATS),
    operationId: z.string().uuid(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.scope === 'job' && !value.jobId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['jobId'],
        message: 'A job-scoped pipeline report requires a job id',
      })
    }
    if (value.scope === 'workspace' && value.jobId !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['jobId'],
        message: 'A workspace-scoped pipeline report cannot carry a job id',
      })
    }
  })

/** Server-only close transaction input; no snapshot, candidate, or file key is caller-controlled. */
export const CreateHireJobCloseoutReportSchema = z
  .object({
    jobId: reportObjectIdSchema,
    operationId: z.string().uuid(),
  })
  .strict()

/** Opaque durable identifier used by a future authorized status/download endpoint. */
export const HireReportExportIdSchema = reportObjectIdSchema

export type RequestHirePipelineStatusReportPayload = z.infer<
  typeof RequestHirePipelineStatusReportSchema
>
export type CreateHireJobCloseoutReportPayload = z.infer<
  typeof CreateHireJobCloseoutReportSchema
>
