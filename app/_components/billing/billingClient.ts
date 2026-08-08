import { z } from 'zod'
import {
  CustomerBillingProfileResponseSchema,
  CustomerBillingSummaryResponseSchema,
  CustomerFinancialDocumentPageResponseSchema,
  PublicBillingCatalogResponseSchema,
} from '@payments/validators/customerBillingResponses'

const ObjectIdSchema = z.string().regex(/^[a-f\d]{24}$/i)
const SafePaiseSchema = z.number().int().nonnegative().safe()
const IsoDateTimeSchema = z.iso.datetime()

function razorpayKeyMatchesMode(
  mode: 'test' | 'live',
  keyId: string,
): boolean {
  return keyId.startsWith(
    mode === 'test' ? 'rzp_test_' : 'rzp_live_',
  )
}

export const CheckoutObservationAuthoritySchema = z.object({
  schemaVersion: z.literal('commercial_checkout_observation_v1'),
  authorization: z.string().trim().min(1).max(4_096),
  csrf: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  expiresAt: IsoDateTimeSchema,
  endpoint: z.literal(
    '/api/billing/analytics/checkout-observation',
  ),
}).strict()

const BillingDisclosureSchema = z.object({
  summary: z.string().min(1),
  why: z.string().min(1),
  terms: z.string().min(1).optional(),
  gst: z.literal('GST included.'),
  cancellation: z.literal('Auto-renews until cancelled.').optional(),
}).strip()

const CouponIdentityShape = {
  campaignId: ObjectIdSchema,
  revision: z.number().int().positive().safe(),
  displayText: z.string().min(1),
  termsText: z.string().trim().min(10).max(2_000),
} as const

const NormalizedCouponCodeSchema = z.string()
  .trim()
  .min(3)
  .max(40)
  .regex(/^[A-Z0-9][A-Z0-9_-]*$/)

const QuoteCouponSchema = z.discriminatedUnion('mode', [
  z.object({
    ...CouponIdentityShape,
    mode: z.literal('code'),
    code: NormalizedCouponCodeSchema,
    whyApplied: z.string().min(1),
  }).strip(),
  z.object({
    ...CouponIdentityShape,
    mode: z.literal('automatic'),
    code: z.never().optional(),
    whyApplied: z.string().min(1),
  }).strip(),
  z.object({
    ...CouponIdentityShape,
    mode: z.literal('targeted'),
    code: z.never().optional(),
    whyApplied: z.string().min(1),
  }).strip(),
])

const CheckoutCouponSchema = z.discriminatedUnion('mode', [
  z.object({
    ...CouponIdentityShape,
    mode: z.literal('code'),
    code: NormalizedCouponCodeSchema,
  }).strip(),
  z.object({
    ...CouponIdentityShape,
    mode: z.literal('automatic'),
    code: z.never().optional(),
  }).strip(),
  z.object({
    ...CouponIdentityShape,
    mode: z.literal('targeted'),
    code: z.never().optional(),
  }).strip(),
])

const RenewalScheduleSchema = z.object({
  cadence: z.literal('monthly'),
  status: z.literal('pending_authorization'),
  scheduledAt: z.null(),
}).strip()

const SupportedInterviewDurationSchema = z.union([
  z.literal(10),
  z.literal(20),
  z.literal(30),
])

const SubscriptionEntitlementSummarySchema = z.object({
  kind: z.literal('subscription'),
  displayName: z.enum(['Plus', 'Pro']),
  billingPeriod: z.literal('monthly'),
  interview: z.object({
    includedPerPeriod: z.number().int().positive().safe(),
    periodOwner: z.literal('razorpay_billing_cycle'),
    maxDurationMinutes: SupportedInterviewDurationSchema,
    supportedDurationsMinutes: z.array(
      SupportedInterviewDurationSchema,
    ).min(1).max(3),
    analysisAndReplayIncluded: z.literal(true),
  }).strict(),
  resume: z.object({
    basicSavedResumeLimit: z.literal(1),
    premiumSavedResumeLimitPerPeriod: z.number().int().nonnegative().safe(),
  }).strict(),
}).strict().superRefine((entitlement, context) => {
  const durations = entitlement.interview.supportedDurationsMinutes
  if (
    new Set(durations).size !== durations.length ||
    !durations.includes(entitlement.interview.maxDurationMinutes) ||
    durations.some(
      (duration) => duration > entitlement.interview.maxDurationMinutes,
    )
  ) {
    context.addIssue({
      code: 'custom',
      path: ['interview', 'supportedDurationsMinutes'],
      message: 'Checkout interview durations are inconsistent',
    })
  }
})

const CheckoutQuoteSchema = z.object({
  catalogVersion: z.string().min(1).max(100),
  planKey: z.enum(['plus', 'pro']),
  currency: z.literal('INR'),
  gstInclusive: z.literal(true),
  gstRatePercent: z.literal(18),
  listPricePaise: SafePaiseSchema,
  discountPaise: SafePaiseSchema,
  payablePaise: SafePaiseSchema,
  nextChargePaise: SafePaiseSchema,
  renewalPricePaise: SafePaiseSchema,
  discountedBillingCycles: z.number().int().positive().safe().optional(),
  coupon: CheckoutCouponSchema.optional(),
  renewalSchedule: RenewalScheduleSchema,
  disclosure: BillingDisclosureSchema.extend({
    cancellation: z.literal('Auto-renews until cancelled.'),
  }),
  entitlementSummary: SubscriptionEntitlementSummarySchema,
}).strip().superRefine((quote, context) => {
  if (quote.payablePaise !== quote.listPricePaise - quote.discountPaise) {
    context.addIssue({
      code: 'custom',
      path: ['payablePaise'],
      message: 'Checkout arithmetic is inconsistent',
    })
  }
  if (quote.renewalPricePaise !== quote.listPricePaise) {
    context.addIssue({
      code: 'custom',
      path: ['renewalPricePaise'],
      message: 'Checkout renewal price is inconsistent',
    })
  }
  const discounted = quote.discountPaise > 0
  if (
    discounted !== Boolean(quote.coupon) ||
    discounted !== (quote.discountedBillingCycles !== undefined)
  ) {
    context.addIssue({
      code: 'custom',
      path: ['coupon'],
      message: 'Checkout coupon tuple is inconsistent',
    })
  }
  if (
    quote.coupon &&
    quote.disclosure.terms !== quote.coupon.termsText
  ) {
    context.addIssue({
      code: 'custom',
      path: ['disclosure', 'terms'],
      message: 'Checkout coupon terms are inconsistent',
    })
  }
  if (!quote.coupon && quote.disclosure.terms !== undefined) {
    context.addIssue({
      code: 'custom',
      path: ['disclosure', 'terms'],
      message: 'Checkout contains unrelated coupon terms',
    })
  }
  const expectedNextCharge =
    (quote.discountedBillingCycles ?? 0) > 1
      ? quote.payablePaise
      : quote.renewalPricePaise
  if (quote.nextChargePaise !== expectedNextCharge) {
    context.addIssue({
      code: 'custom',
      path: ['nextChargePaise'],
      message: 'Checkout next charge is inconsistent',
    })
  }
  const expectedDisplayName = quote.planKey === 'plus' ? 'Plus' : 'Pro'
  if (quote.entitlementSummary.displayName !== expectedDisplayName) {
    context.addIssue({
      code: 'custom',
      path: ['entitlementSummary', 'displayName'],
      message: 'Checkout plan entitlement is inconsistent',
    })
  }
})

export const CustomerBillingQuoteResponseSchema = z.object({
  quoteId: z.uuid(),
  expiresAt: IsoDateTimeSchema,
  catalogVersion: z.string().min(1).max(100),
  currency: z.literal('INR'),
  gstInclusive: z.literal(true),
  gstRatePercent: z.literal(18),
  listPricePaise: SafePaiseSchema,
  discountPaise: SafePaiseSchema,
  payablePaise: SafePaiseSchema,
  nextChargePaise: SafePaiseSchema.optional(),
  planKey: z.enum(['plus', 'pro']).optional(),
  sku: z.enum(['single_interview', 'premium_resume']).optional(),
  coupon: QuoteCouponSchema.optional(),
  manualCodeResult: z.enum([
    'applied',
    'invalid',
    'ineligible',
    'not_better_than_automatic',
    'system_unavailable',
  ]).optional(),
  discountedBillingCycles: z.number().int().positive().safe().optional(),
  renewalPricePaise: SafePaiseSchema.optional(),
  disclosure: BillingDisclosureSchema,
  entitlementSummary: z.record(z.string(), z.unknown()),
}).strip().superRefine((quote, context) => {
  if (quote.payablePaise !== quote.listPricePaise - quote.discountPaise) {
    context.addIssue({
      code: 'custom',
      path: ['payablePaise'],
      message: 'Quote arithmetic is inconsistent',
    })
  }
  if (Number(quote.planKey !== undefined) + Number(quote.sku !== undefined) !== 1) {
    context.addIssue({
      code: 'custom',
      path: ['planKey'],
      message: 'Quote must identify exactly one product',
    })
  }
})

export const SubscriptionCheckoutResponseSchema = z.object({
  intentId: ObjectIdSchema,
  providerMode: z.enum(['test', 'live']),
  intentStatus: z.literal('remote_created'),
  reused: z.boolean(),
  checkout: z.object({
    keyId: z.string().regex(/^rzp_(?:test|live)_[A-Za-z0-9]+$/),
    subscriptionId: z.string().regex(/^sub_[A-Za-z0-9]+$/),
  }).strip(),
  quote: CheckoutQuoteSchema,
  analyticsObservation:
    CheckoutObservationAuthoritySchema.optional(),
}).strip().superRefine((checkout, context) => {
  if (!razorpayKeyMatchesMode(
    checkout.providerMode,
    checkout.checkout.keyId,
  )) {
    context.addIssue({
      code: 'custom',
      path: ['checkout', 'keyId'],
      message: 'Razorpay key mode is inconsistent',
    })
  }
})

const FutureCheckoutQuoteSchema = z.object({
  ...CheckoutQuoteSchema.shape,
  mandateAuthorization: z.object({
    amountPaise: z.literal(500),
    currency: z.literal('INR'),
    captured: z.literal(false),
    entitlementEffect: z.literal('none'),
    disposition: z.literal('razorpay_auto_refund'),
  }).strict(),
  firstPaidCycle: z.object({
    amountPaise: SafePaiseSchema,
    scheduledAt: IsoDateTimeSchema,
  }).strict(),
  renewalSchedule: z.object({
    cadence: z.literal('monthly'),
    status: z.literal('pending_authorization'),
    scheduledAt: IsoDateTimeSchema,
  }).strict(),
}).strip().superRefine((quote, context) => {
  const commonQuote = CheckoutQuoteSchema.safeParse({
    ...quote,
    renewalSchedule: {
      cadence: quote.renewalSchedule.cadence,
      status: quote.renewalSchedule.status,
      scheduledAt: null,
    },
  })
  if (!commonQuote.success) {
    for (const issue of commonQuote.error.issues) {
      context.addIssue({ ...issue })
    }
  }
  if (
    quote.firstPaidCycle.amountPaise !== quote.payablePaise ||
    quote.firstPaidCycle.scheduledAt !== quote.renewalSchedule.scheduledAt
  ) {
    context.addIssue({
      code: 'custom',
      path: ['firstPaidCycle'],
      message: 'Future subscription schedule is inconsistent',
    })
  }
  if (
    quote.discountPaise !== 0 ||
    quote.coupon !== undefined ||
    quote.discountedBillingCycles !== undefined
  ) {
    context.addIssue({
      code: 'custom',
      path: ['coupon'],
      message: 'Future subscription changes cannot include a coupon',
    })
  }
})

export const FutureSubscriptionCheckoutResponseSchema =
  z.object({
    ...SubscriptionCheckoutResponseSchema.shape,
    quote: FutureCheckoutQuoteSchema,
  }).strip().superRefine((checkout, context) => {
    if (!razorpayKeyMatchesMode(
      checkout.providerMode,
      checkout.checkout.keyId,
    )) {
      context.addIssue({
        code: 'custom',
        path: ['checkout', 'keyId'],
        message: 'Razorpay key mode is inconsistent',
      })
    }
  })

export const FuturePlanChangeSubmissionResponseSchema = z.object({
  planChangeRequestId: ObjectIdSchema,
  effectiveAt: IsoDateTimeSchema,
  checkout: FutureSubscriptionCheckoutResponseSchema,
  reused: z.boolean(),
}).strip()

export const ScheduledPlanChangeCancellationResponseSchema = z.object({
  planChangeRequestId: ObjectIdSchema,
  status: z.enum(['cancelled', 'reconciling', 'review']),
  effectiveAt: IsoDateTimeSchema,
  reused: z.boolean(),
  pollAfterMs: z.number().int().min(1_000).max(600_000).optional(),
}).strip()

export const FutureSubscriptionAuthorizationResponseSchema = z.object({
  intentId: ObjectIdSchema,
  planChangeRequestId: ObjectIdSchema,
  status: z.enum([
    'authorization_pending',
    'authorized',
    'scheduled',
    'reconciling',
    'manual_review',
  ]),
  pollAfterMs: z.number().int().min(1_000).max(600_000).optional(),
  reused: z.boolean(),
}).strip()

export const BillingIntentStatusResponseSchema = z.object({
  intentId: ObjectIdSchema,
  kind: z.enum(['subscription', 'single_interview', 'premium_resume']),
  status: z.enum([
    'preparing',
    'awaiting_payment',
    'processing',
    'completed',
    'expired',
    'failed',
    'cancelled',
    'manual_review',
  ]),
  terminal: z.boolean(),
  pollAfterMs: z.number().int().min(1_000).max(30_000).optional(),
  updatedAt: IsoDateTimeSchema,
}).strip()

export const SubscriptionVerificationResponseSchema = z.discriminatedUnion(
  'status',
  [
    z.object({
      intentId: ObjectIdSchema,
      paymentStatus: z.literal('captured'),
      status: z.literal('completed'),
    }).strip(),
    z.object({
      intentId: ObjectIdSchema,
      paymentStatus: z.literal('captured'),
      status: z.literal('manual_review'),
    }).strip(),
    z.object({
      intentId: ObjectIdSchema,
      paymentStatus: z.literal('captured'),
      status: z.literal('processing'),
      pollAfterMs: z.number().int().min(1_000).max(30_000),
    }).strip(),
    z.object({
      paymentStatus: z.literal('pending'),
      status: z.literal('awaiting_capture'),
      pollAfterMs: z.number().int().min(1_000).max(30_000),
    }).strip(),
  ],
)

export type PublicBillingCatalog = z.infer<
  typeof PublicBillingCatalogResponseSchema
>
export type CustomerBillingQuote = z.infer<
  typeof CustomerBillingQuoteResponseSchema
>
export type SubscriptionCheckout = z.infer<
  typeof SubscriptionCheckoutResponseSchema
>
export type FutureSubscriptionCheckout = z.infer<
  typeof FutureSubscriptionCheckoutResponseSchema
>
export type FuturePlanChangeSubmission = z.infer<
  typeof FuturePlanChangeSubmissionResponseSchema
>
export type ScheduledPlanChangeCancellation = z.infer<
  typeof ScheduledPlanChangeCancellationResponseSchema
>
export type FutureSubscriptionAuthorization = z.infer<
  typeof FutureSubscriptionAuthorizationResponseSchema
>
export type CheckoutObservationAuthority = z.infer<
  typeof CheckoutObservationAuthoritySchema
>
export type CheckoutObservationEventName =
  | 'checkout_opened'
  | 'checkout_dismissed'
export type BillingIntentStatus = z.infer<
  typeof BillingIntentStatusResponseSchema
>
export type CustomerBillingProfile = z.infer<
  typeof CustomerBillingProfileResponseSchema
>
export type CustomerBillingSummary = z.infer<
  typeof CustomerBillingSummaryResponseSchema
>
export type CustomerFinancialDocumentPage = z.infer<
  typeof CustomerFinancialDocumentPageResponseSchema
>
export type PaidBillingPlanKey = 'plus' | 'pro'

export const billingResponseSchemas = {
  catalog: PublicBillingCatalogResponseSchema,
  quote: CustomerBillingQuoteResponseSchema,
  checkout: SubscriptionCheckoutResponseSchema,
  futureCheckout: FutureSubscriptionCheckoutResponseSchema,
  futurePlanChange: FuturePlanChangeSubmissionResponseSchema,
  scheduledPlanChangeCancellation:
    ScheduledPlanChangeCancellationResponseSchema,
  futureAuthorization: FutureSubscriptionAuthorizationResponseSchema,
  profile: CustomerBillingProfileResponseSchema,
  summary: CustomerBillingSummaryResponseSchema,
  documents: CustomerFinancialDocumentPageResponseSchema,
  status: BillingIntentStatusResponseSchema,
  verification: SubscriptionVerificationResponseSchema,
} as const

export class BillingClientError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message)
    this.name = 'BillingClientError'
  }
}

export async function recordCheckoutObservation(input: {
  authority: CheckoutObservationAuthority
  eventName: CheckoutObservationEventName
}): Promise<void> {
  await fetch(input.authority.endpoint, {
    method: 'POST',
    credentials: 'same-origin',
    keepalive: true,
    headers: {
      'Content-Type': 'application/json',
      'X-Commercial-Observation-CSRF': input.authority.csrf,
    },
    body: JSON.stringify({
      eventName: input.eventName,
      authorization: input.authority.authorization,
    }),
  }).then(() => undefined).catch(() => undefined)
}

function safeErrorMessage(
  body: unknown,
  fallback: string,
): string {
  if (
    body &&
    typeof body === 'object' &&
    'error' in body &&
    typeof body.error === 'string' &&
    body.error.length <= 200
  ) {
    return body.error
  }
  return fallback
}

export async function parseBillingResponse<T>(
  response: Response,
  schema: z.ZodType<T>,
  fallbackError: string,
): Promise<T> {
  const body = await response.json().catch(() => null)
  if (!response.ok) {
    const rawRetry = response.headers.get('retry-after')
    const retryAfter = rawRetry && /^\d+$/.test(rawRetry)
      ? Number(rawRetry)
      : undefined
    throw new BillingClientError(
      response.status,
      safeErrorMessage(body, fallbackError),
      retryAfter,
    )
  }
  const parsed = schema.safeParse(body)
  if (!parsed.success) {
    throw new BillingClientError(
      502,
      'Billing returned an unexpected response. Please try again.',
    )
  }
  return parsed.data
}

export function formatInr(paise: number): string {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    minimumFractionDigits: paise % 100 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(paise / 100)
}

export function quoteChangedAtCheckout(
  preview: CustomerBillingQuote,
  checkout: SubscriptionCheckout,
): boolean {
  const finalQuote = checkout.quote
  return (
    preview.catalogVersion !== finalQuote.catalogVersion ||
    preview.planKey !== finalQuote.planKey ||
    preview.listPricePaise !== finalQuote.listPricePaise ||
    preview.discountPaise !== finalQuote.discountPaise ||
    preview.payablePaise !== finalQuote.payablePaise ||
    preview.renewalPricePaise !== finalQuote.renewalPricePaise ||
    preview.discountedBillingCycles !== finalQuote.discountedBillingCycles ||
    preview.coupon?.campaignId !== finalQuote.coupon?.campaignId ||
    preview.coupon?.revision !== finalQuote.coupon?.revision ||
    preview.coupon?.mode !== finalQuote.coupon?.mode ||
    preview.coupon?.code !== finalQuote.coupon?.code ||
    preview.coupon?.displayText !== finalQuote.coupon?.displayText ||
    preview.coupon?.termsText !== finalQuote.coupon?.termsText
  )
}

export function checkoutChangeRequiresConfirmation(
  preview: CustomerBillingQuote,
  checkout: SubscriptionCheckout,
  expectedManualCouponCode?: string,
): boolean {
  const finalQuote = checkout.quote
  const expectedCode = expectedManualCouponCode?.trim().toUpperCase()
  if (
    expectedCode &&
    (
      finalQuote.coupon?.mode !== 'code' ||
      finalQuote.coupon.code?.trim().toUpperCase() !== expectedCode
    )
  ) return true

  if (!quoteChangedAtCheckout(preview, checkout)) return false

  const previewRenewal = preview.renewalPricePaise ?? preview.listPricePaise
  const finalRenewal = finalQuote.renewalPricePaise
  const previewNextCharge = preview.nextChargePaise ?? previewRenewal
  const previewDiscountedCycles = preview.discountedBillingCycles ?? 0
  const finalDiscountedCycles = finalQuote.discountedBillingCycles ?? 0
  const strictlyBetterNow =
    finalQuote.payablePaise < preview.payablePaise &&
    finalQuote.discountPaise > preview.discountPaise
  const commitmentsUnchangedOrBetter =
    finalQuote.planKey === preview.planKey &&
    finalQuote.catalogVersion === preview.catalogVersion &&
    finalQuote.listPricePaise === preview.listPricePaise &&
    finalRenewal === previewRenewal &&
    finalQuote.nextChargePaise <= previewNextCharge &&
    finalDiscountedCycles >= previewDiscountedCycles

  return !(strictlyBetterNow && commitmentsUnchangedOrBetter)
}
