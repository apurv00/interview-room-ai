import { createHash } from 'node:crypto'
import { z } from 'zod'
export const PAYMENT_COMMERCIAL_ANALYTICS_EVENT_WRITES_READY =
  false as const
export const PAYMENT_COMMERCIAL_ANALYTICS_CMS_READ_READY =
  false as const
export const COMMERCIAL_ANALYTICS_SCHEMA_VERSION =
  'payment_commercial_analytics_event_v1' as const
export const COMMERCIAL_ANALYTICS_EVENT_NAMES = [
  'pricing_viewed',
  'coupon_exposed',
  'coupon_code_entered',
  'coupon_validated',
  'coupon_rejected',
  'plan_selected',
  'paywall_viewed',
  'checkout_intent_created',
  'checkout_opened',
  'mandate_started',
  'checkout_dismissed',
  'payment_failed',
  'payment_captured',
  'activation_pending',
  'entitlement_activated',
  'first_paid_interview_started',
  'single_interview_purchased',
  'single_interview_consumed',
  'premium_resume_purchased',
  'premium_resume_rendered',
  'subscription_change_scheduled',
  'subscription_cancel_requested',
  'subscription_cancelled',
  'subscription_renewed',
  'subscription_pending',
  'subscription_halted',
  'refund_created',
  'dispute_created',
  'admin_entitlement_granted',
] as const
export type CommercialAnalyticsEventName =
  (typeof COMMERCIAL_ANALYTICS_EVENT_NAMES)[number]
export const COMMERCIAL_ANALYTICS_SERVER_SOURCES = [
  'server_pricing_decision',
  'verified_client_observation',
  'checkout_intent_transaction',
  'payment_verification',
  'signed_webhook',
  'reconciliation',
  'entitlement_transaction',
  'interview_transaction',
  'resume_transaction',
  'subscription_transaction',
  'refund_transaction',
  'dispute_webhook',
  'cms_admin_transaction',
] as const
const DIGEST = /^[a-f0-9]{64}$/
const OBJECT_ID = /^[a-f0-9]{24}$/
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/
const nonNegativePaise = z.number()
  .int()
  .min(0)
  .max(Number.MAX_SAFE_INTEGER)
const canonicalTimestamp = z.string().datetime({
  offset: false,
  precision: 3,
}).refine(
  (value) => new Date(value).toISOString() === value,
  'Timestamp must be canonical UTC',
)
const boundedToken = z.string()
  .min(1)
  .max(120)
  .refine(
    (value) => value === value.trim() && !CONTROL.test(value),
    'Token must be trimmed and contain no control characters',
  )
export const CommercialAnalyticsAmountsSchema = z.object({
  listPricePaise: nonNegativePaise,
  discountPaise: nonNegativePaise,
  payablePaise: nonNegativePaise,
  renewalPricePaise: nonNegativePaise.nullable(),
  eventAmountPaise: nonNegativePaise,
  allocatedVariableCostPaise: nonNegativePaise,
}).strict().superRefine((value, context) => {
  if (
    value.discountPaise > value.listPricePaise ||
    value.payablePaise !==
      value.listPricePaise - value.discountPaise
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Payable amount must equal list price minus discount',
    })
  }
})
export const CommercialAnalyticsDimensionsSchema = z.object({
  surface: z.enum([
    'pricing',
    'checkout',
    'interview_setup',
    'interview_paywall',
    'feedback',
    'resume',
    'settings',
    'cms',
  ]).nullable(),
  paywallReason: z.enum([
    'interview_limit',
    'duration_limit',
    'premium_resume_required',
    'subscription_inactive',
  ]).nullable(),
  catalogVersion: boundedToken.nullable(),
  pricingVariant: boundedToken.nullable(),
  productKey: z.enum([
    'free',
    'plus',
    'pro',
    'single_interview',
    'premium_resume',
  ]).nullable(),
  couponCampaignId: z.string()
    .regex(OBJECT_ID)
    .nullable(),
  couponCampaignDigest: z.string().regex(DIGEST).optional(),
  couponResult: z.enum(['applied', 'invalid', 'ineligible', 'not_better_than_automatic', 'system_unavailable']).nullable().optional(),
  couponMode: z.enum([
    'automatic',
    'code',
    'targeted',
  ]).nullable(),
  eligibilitySegment: z.enum([
    'waitlist',
    'student',
    'winback',
    'partner',
    'all',
  ]).nullable(),
  userState: z.enum([
    'new',
    'legacy',
    'grandfathered',
  ]).nullable(),
  eligiblePaywall: z.boolean(),
  codeLength: z.number().int().min(1).max(64).nullable(),
  interviewsRemaining: z.number()
    .int()
    .min(0)
    .max(Number.MAX_SAFE_INTEGER)
    .nullable(),
  premiumResumesRemaining: z.number()
    .int()
    .min(0)
    .max(Number.MAX_SAFE_INTEGER)
    .nullable(),
  durationMinutes: z.union([
    z.literal(10),
    z.literal(20),
    z.literal(30),
  ]).nullable(),
  accessEndsAt: canonicalTimestamp.nullable(),
  firstPaidUseWithin24Hours: z.boolean().nullable(),
  activationKind: z.enum([
    'initial_subscription',
    'renewal',
    'one_time',
    'admin',
  ]).nullable(),
  lifecycleStage: z.enum([
    'checkout_intent', 'one_time_payment', 'subscription_payment',
    'subscription_mandate', 'subscription_activation',
  ]).optional(),
  lifecycleReason: z.enum([
    'intent_created', 'customer_action_required', 'instrument_declined',
    'insufficient_funds', 'provider_risk', 'provider_error',
    'unknown_provider_failure', 'awaiting_capture', 'awaiting_mandate',
    'awaiting_entitlement',
  ]).optional(),
  adminGrantReason: z.enum(
    ['grant_interview', 'grant_premium_resume', 'grant_comp_period'],
  ).optional(),
  adminGrantQuantity: z.literal(1).optional(),
}).strict()
export const CommercialAnalyticsEventInputSchema = z.object({
  schemaVersion: z.literal(COMMERCIAL_ANALYTICS_SCHEMA_VERSION),
  eventName: z.enum(COMMERCIAL_ANALYTICS_EVENT_NAMES),
  authority: z.literal('server'),
  source: z.enum(COMMERCIAL_ANALYTICS_SERVER_SOURCES),
  sourceEvidenceDigest: z.string().regex(DIGEST),
  correlationDigest: z.string().regex(DIGEST),
  subjectDigest: z.string().regex(DIGEST).nullable(),
  providerMode: z.enum(['test', 'live']),
  occurredAt: canonicalTimestamp,
  dimensions: CommercialAnalyticsDimensionsSchema,
  amounts: CommercialAnalyticsAmountsSchema,
}).strict().superRefine((value, context) => {
  const subjectRequired = [
    'checkout_intent_created',
    'payment_failed',
    'activation_pending',
    'payment_captured',
    'entitlement_activated',
    'first_paid_interview_started',
    'single_interview_purchased',
    'single_interview_consumed',
    'premium_resume_purchased',
    'premium_resume_rendered',
    'subscription_change_scheduled',
    'subscription_cancel_requested',
    'subscription_cancelled',
    'subscription_renewed',
    'subscription_pending',
    'subscription_halted',
    'refund_created',
    'dispute_created',
    'admin_entitlement_granted',
  ].includes(value.eventName)
  if (subjectRequired && value.subjectDigest === null) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['subjectDigest'],
      message: 'This event requires a keyed, pseudonymous subject digest',
    })
  }
  if (
    value.eventName === 'paywall_viewed' &&
    (
      !value.dimensions.eligiblePaywall ||
      value.dimensions.paywallReason === null
    )
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['dimensions'],
      message: 'Paywall evidence must identify an eligible paywall reason',
    })
  }
  if (
    value.eventName === 'coupon_code_entered' &&
    value.dimensions.codeLength === null
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['dimensions', 'codeLength'],
      message: 'Coupon entry stores only the code length, never the code',
    })
  }
  if (
    [
      'payment_captured',
      'subscription_renewed',
      'single_interview_purchased',
      'premium_resume_purchased',
    ].includes(value.eventName) &&
    value.amounts.eventAmountPaise <= 0
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['amounts', 'eventAmountPaise'],
      message: 'Captured commercial events require a positive event amount',
    })
  }
  if (
    ['refund_created', 'dispute_created'].includes(value.eventName) &&
    value.amounts.eventAmountPaise <= 0
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['amounts', 'eventAmountPaise'],
      message: 'Refund and dispute evidence requires a positive amount',
    })
  }
  if (
    value.amounts.allocatedVariableCostPaise > 0 &&
    ![
      'first_paid_interview_started',
      'single_interview_consumed',
      'premium_resume_rendered',
    ].includes(value.eventName)
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['amounts', 'allocatedVariableCostPaise'],
      message: 'Variable cost belongs only to a committed product-use event',
    })
  }
  if (
    [
      'subscription_change_scheduled',
      'subscription_cancel_requested',
      'subscription_cancelled',
      'subscription_renewed',
      'subscription_pending',
      'subscription_halted',
    ].includes(value.eventName) &&
    (
      value.dimensions.productKey !== 'plus' &&
      value.dimensions.productKey !== 'pro'
    )
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['dimensions', 'productKey'],
      message: 'Subscription evidence requires a paid plan',
    })
  }
  if (
    value.eventName === 'entitlement_activated' &&
    value.dimensions.activationKind === null
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['dimensions', 'activationKind'],
      message: 'Entitlement activation requires its lifecycle kind',
    })
  }
  if (
    value.eventName === 'entitlement_activated' &&
    (
      value.dimensions.productKey === 'plus' ||
      value.dimensions.productKey === 'pro'
    ) &&
    value.dimensions.accessEndsAt === null
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['dimensions', 'accessEndsAt'],
      message: 'Paid plan activation requires its exact access end',
    })
  }
  if (
    value.eventName === 'first_paid_interview_started' &&
    value.dimensions.firstPaidUseWithin24Hours === null
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['dimensions', 'firstPaidUseWithin24Hours'],
      message: 'First paid use requires its authoritative 24-hour result',
    })
  }
  if (
    value.eventName === 'admin_entitlement_granted' &&
    (
      value.dimensions.adminGrantReason === undefined ||
      value.dimensions.adminGrantQuantity !== 1 ||
      value.dimensions.activationKind !== 'admin' ||
      value.dimensions.accessEndsAt === null ||
      ![
        'plus', 'pro', 'single_interview', 'premium_resume',
      ].includes(String(value.dimensions.productKey))
    )
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom, path: ['dimensions'],
      message: 'Admin grants require finite reason, quantity, product, and access',
    })
  }
})
export type CommercialAnalyticsEventInput =
  z.infer<typeof CommercialAnalyticsEventInputSchema>
export interface CommercialAnalyticsEventRecord
  extends CommercialAnalyticsEventInput {
  readonly eventId: string
  readonly eventDigest: string
}
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`
  }
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(record[key])}`
  ).join(',')}}`
}
function digest(domain: string, value: unknown): string {
  return createHash('sha256')
    .update(domain)
    .update('\n')
    .update(canonicalJson(value))
    .digest('hex')
}
export function composeCommercialAnalyticsEventRecord(
  input: CommercialAnalyticsEventInput,
): CommercialAnalyticsEventRecord {
  const parsed = CommercialAnalyticsEventInputSchema.parse(input)
  const eventId = `cae_${digest(
    'interviewprepguru/commercial-analytics/event-id/v1',
    {
      eventName: parsed.eventName,
      sourceEvidenceDigest: parsed.sourceEvidenceDigest,
    },
  )}`
  const eventDigest = digest(
    'interviewprepguru/commercial-analytics/event-content/v1',
    parsed,
  )
  return Object.freeze({
    ...parsed,
    dimensions: Object.freeze({ ...parsed.dimensions }),
    amounts: Object.freeze({ ...parsed.amounts }),
    eventId,
    eventDigest,
  })
}
