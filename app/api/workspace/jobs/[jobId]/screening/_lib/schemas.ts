import { z } from 'zod'
import { HIRE_SCREENING_GATE_MAX_EXCEPTIONS } from '@hire'

const objectId = z.string().regex(/^[a-f0-9]{24}$/i, 'Invalid id')

const knockoutSettings = z
  .object({
    location: z.string().trim().min(1).max(160).optional(),
    experienceFloorYears: z.number().finite().min(0).max(50).optional(),
  })
  .strict()

export const screeningRuleSchema = z
  .object({
    mode: z.enum(['top_n', 'above_threshold']),
    topN: z.number().int().min(1).max(5000).optional(),
    scoreThreshold: z.number().finite().min(0).max(100).optional(),
    knockoutSettings: knockoutSettings.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.mode === 'top_n' && value.topN === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['topN'],
        message: 'topN is required for a top-N screening gate',
      })
    }
    if (value.mode === 'top_n' && value.scoreThreshold !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['scoreThreshold'],
        message: 'scoreThreshold is only valid for an above-threshold gate',
      })
    }
    if (value.mode === 'above_threshold' && value.scoreThreshold === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['scoreThreshold'],
        message: 'scoreThreshold is required for an above-threshold gate',
      })
    }
    if (value.mode === 'above_threshold' && value.topN !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['topN'],
        message: 'topN is only valid for a top-N gate',
      })
    }
  })

export const screeningExceptionSchema = z
  .object({
    applicationId: objectId,
    action: z.enum(['include', 'exclude']),
    note: z.string().trim().min(1).max(4000),
  })
  .strict()

const screeningExceptionsSchema = z
  .array(screeningExceptionSchema)
  .max(HIRE_SCREENING_GATE_MAX_EXCEPTIONS)
  .superRefine((exceptions, ctx) => {
    const seen = new Set<string>()
    exceptions.forEach((exception, index) => {
      if (seen.has(exception.applicationId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index, 'applicationId'],
          message: 'Only one explicit exception is allowed per application',
        })
      }
      seen.add(exception.applicationId)
    })
  })

export const screeningPreviewRequestSchema = z
  .object({
    rule: screeningRuleSchema,
    exceptions: screeningExceptionsSchema.optional(),
    selectionSnapshotId: objectId.optional(),
    selectionNote: z.string().trim().min(1).max(4000).optional(),
    page: z
      .object({
        scope: z.enum(['selected', 'evaluated', 'attention', 'knockouts']),
        cursor: z.string().min(1).max(2048).optional(),
        expectedFingerprint: z
          .string()
          .regex(/^[a-f0-9]{64}$/i, 'Invalid screening preview proof'),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (Boolean(value.selectionSnapshotId) !== Boolean(value.selectionNote)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: value.selectionSnapshotId
          ? ['selectionNote']
          : ['selectionSnapshotId'],
        message:
          'A selection snapshot and its documented inclusion rationale are required together',
      })
    }
  })

export const screeningConfirmRequestSchema = z
  .object({
    rule: screeningRuleSchema,
    exceptions: screeningExceptionsSchema.optional(),
    selectionSnapshotId: objectId.optional(),
    selectionNote: z.string().trim().min(1).max(4000).optional(),
    previewFingerprint: z
      .string()
      .regex(/^[a-f0-9]{64}$/i, 'Invalid screening preview proof'),
    sendAfter: z.string().datetime({ offset: true }).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (Boolean(value.selectionSnapshotId) !== Boolean(value.selectionNote)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: value.selectionSnapshotId
          ? ['selectionNote']
          : ['selectionSnapshotId'],
        message:
          'A selection snapshot and its documented inclusion rationale are required together',
      })
    }
  })

/** Explicit, bounded HR command; the server chooses only eligible remainder. */
export const screeningWaterfallRequestSchema = z
  .object({
    count: z.number().int().min(1).max(100),
    sendAfter: z.string().datetime({ offset: true }).optional(),
  })
  .strict()

/** A deliberately bodyless, explicit recruiter retry command. */
export const screeningRetryFailedBatchRequestSchema = z.object({}).strict()

export type ScreeningPreviewRouteBody = z.infer<typeof screeningPreviewRequestSchema>
export type ScreeningConfirmRouteBody = z.infer<typeof screeningConfirmRequestSchema>
export type ScreeningWaterfallRouteBody = z.infer<typeof screeningWaterfallRequestSchema>
export type ScreeningRetryFailedBatchRouteBody = z.infer<typeof screeningRetryFailedBatchRequestSchema>
