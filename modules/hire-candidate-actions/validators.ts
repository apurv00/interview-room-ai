import { z } from 'zod'
import { HIRE_STAGES } from '../hire/models/HireApplication'
import {
  HIRE_CANDIDATE_BULK_ACTIONS,
  HIRE_CANDIDATE_BULK_REASON_CODES,
} from './models'

const ObjectIdSchema = z.string().regex(/^[a-f0-9]{24}$/i)

export const CreateHireCandidateBulkOperationSchema = z
  .object({
    selectionId: ObjectIdSchema,
    clientOperationId: z.string().uuid(),
    action: z.enum(HIRE_CANDIDATE_BULK_ACTIONS),
    expectedStage: z.enum(HIRE_STAGES).optional(),
    communication: z.literal('none'),
    reasonCode: z.enum(HIRE_CANDIDATE_BULK_REASON_CODES).optional(),
    confirmed: z.literal(true),
    confirmedCount: z.number().int().min(1).max(5000),
  })
  .strict()
  .superRefine((value, ctx) => {
    const needsReason = value.action === 'reject' || value.action === 'withdraw'
    if (needsReason && !value.reasonCode) {
      ctx.addIssue({
        code: 'custom',
        path: ['reasonCode'],
        message: 'Choose a structured reason for a bulk reject or withdrawal',
      })
    }
    if (!needsReason && value.reasonCode) {
      ctx.addIssue({
        code: 'custom',
        path: ['reasonCode'],
        message: 'Advance does not accept a rejection or withdrawal reason',
      })
    }
    if (
      needsReason &&
      ((value.action === 'withdraw') !== (value.reasonCode === 'candidate_withdrew'))
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['reasonCode'],
        message: 'Choose a reason that matches the requested action',
      })
    }
  })

export type CreateHireCandidateBulkOperationInput = z.infer<
  typeof CreateHireCandidateBulkOperationSchema
>

export const HireCandidateBulkOperationIssueQuerySchema = z
  .object({
    cursor: z.string().min(1).max(2_048).optional(),
    limit: z
      .string()
      .regex(/^\d+$/)
      .transform(Number)
      .pipe(z.number().int().min(1).max(100))
      .default(50),
  })
  .strict()

export type HireCandidateBulkOperationIssueQuery = z.infer<
  typeof HireCandidateBulkOperationIssueQuerySchema
>
