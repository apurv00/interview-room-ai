import { z } from 'zod'
import {
  BILLING_ROLLOUT_ACTIVATABLE_PHASE_IDS,
  BILLING_ROLLOUT_SKUS,
} from '@modules/payment-rollout-control'

const DIGEST_PATTERN = /^[a-f0-9]{64}$/
const CANONICAL_UTC_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

export const BILLING_ROLLOUT_CHECKOUT_AUTHORITY_SCHEMA_VERSION =
  'billing_rollout_checkout_authority_v1' as const

export const BillingRolloutCheckoutAuthoritySchema = z.object({
  schemaVersion:
    z.literal(BILLING_ROLLOUT_CHECKOUT_AUTHORITY_SCHEMA_VERSION),
  decisionDigest: z.string().regex(DIGEST_PATTERN),
  activationId: z.string().regex(DIGEST_PATTERN),
  activationSequence: z.number().int().min(1),
  authorityRevision: z.number().int().min(1),
  stopEpoch: z.number().int().min(0),
  requestDigest: z.string().regex(DIGEST_PATTERN),
  requestedStateHash: z.string().regex(DIGEST_PATTERN),
  catalogVersion: z.string().min(1).max(120)
    .refine(
      (value) => value.trim() === value,
      'catalogVersion must be canonical',
    ),
  catalogHash: z.string().regex(DIGEST_PATTERN),
  providerBindingHash: z.string().regex(DIGEST_PATTERN),
  couponPolicyHash: z.string().regex(DIGEST_PATTERN),
  copyBundleHash: z.string().regex(DIGEST_PATTERN),
  rolloutPolicyHash: z.string().regex(DIGEST_PATTERN),
  phaseId: z.enum(BILLING_ROLLOUT_ACTIVATABLE_PHASE_IDS),
  audience: z.enum(['qa', 'public_treatment']),
  providerMode: z.enum(['test', 'live']),
  rolloutSku: z.enum(BILLING_ROLLOUT_SKUS),
  couponEnabled: z.boolean(),
  boundAt: z.string()
    .regex(CANONICAL_UTC_TIMESTAMP_PATTERN)
    .refine(
      (value) => new Date(value).toISOString() === value,
      'boundAt must be a canonical UTC timestamp',
    ),
}).strict()

export type BillingRolloutCheckoutAuthority = Readonly<z.infer<
  typeof BillingRolloutCheckoutAuthoritySchema
>>
