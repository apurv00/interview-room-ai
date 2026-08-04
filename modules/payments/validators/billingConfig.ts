import { z } from 'zod'

const OBJECT_ID_PATTERN = /^[a-f\d]{24}$/i
const CATALOG_VERSION_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,119}$/
const ROLLOUT_SEED_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{2,127}$/
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000

const CanonicalUtcTimestampSchema = z.string().refine((value) => {
  const parsed = new Date(value)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value
}, 'Must be a canonical UTC timestamp')

const InertRolloutSurfacesSchema = z.object({
  selling: z.literal(false),
  enforcement: z.literal(false),
  copy: z.literal(false),
  analytics: z.literal(false),
  communications: z.literal(false),
}).strict()

export const BillingRolloutPolicyStagingSchema = z.object({
  version: z.literal(1),
  algorithm: z.literal('sha256-v1'),
  seedId: z.string().regex(ROLLOUT_SEED_ID_PATTERN),
  surfaces: InertRolloutSurfacesSchema,
}).strict()

export const BillingConfigPatchSchema = z.object({
  mutationId: z.string().min(1).max(200),
  correlationId: z.string().min(1).max(200),
  expectedRevision: z.number().int().min(0),
  reason: z.string().trim().min(10).max(2000),
  confirmation: z.literal('UPDATE BILLING CONFIG'),
  patch: z.object({
    sellingMode: z.literal('off').optional(),
    enforcementMode: z.literal('off').optional(),
    couponMode: z.literal('off').optional(),
    qaUserIds: z.array(z.string().regex(OBJECT_ID_PATTERN)).max(500).optional(),
    newUserRolloutPercent: z.number().int().min(0).max(100).optional(),
    enforcementStartedAt: CanonicalUtcTimestampSchema.optional(),
    legacyGrandfatherEndsAt: CanonicalUtcTimestampSchema.optional(),
    activeCatalogVersion:
      z.string().regex(CATALOG_VERSION_PATTERN).optional(),
    rolloutPolicy: BillingRolloutPolicyStagingSchema.optional(),
    autoCouponRequired: z.literal(true).optional(),
    webhookProcessingEnabled: z.literal(false).optional(),
    reconciliationEnabled: z.literal(false).optional(),
  }).strict().refine((patch) => Object.keys(patch).length > 0, {
    message: 'At least one preparatory setting is required',
  }).superRefine((patch, context) => {
    if (
      patch.qaUserIds &&
      new Set(patch.qaUserIds.map((id) => id.toLowerCase())).size !==
        patch.qaUserIds.length
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['qaUserIds'],
        message: 'QA user IDs must be unique',
      })
    }
    if (
      patch.enforcementStartedAt !== undefined &&
      patch.legacyGrandfatherEndsAt !== undefined &&
      new Date(patch.legacyGrandfatherEndsAt).getTime() -
        new Date(patch.enforcementStartedAt).getTime() !== THIRTY_DAYS_MS
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['legacyGrandfatherEndsAt'],
        message: 'The grandfather boundary must be exactly 30 days after T0',
      })
    }
  }),
}).strict()

export type BillingConfigPatchInput = z.infer<typeof BillingConfigPatchSchema>
export type BillingRolloutPolicyStagingInput = z.infer<
  typeof BillingRolloutPolicyStagingSchema
>
