import { z } from 'zod'
import { INDIA_BILLING_STATE_CODES } from './customerBillingProfile'

const NonNegativeSafeIntegerSchema = z
  .number()
  .int()
  .min(0)
  .max(Number.MAX_SAFE_INTEGER)
const PositiveSafeIntegerSchema = NonNegativeSafeIntegerSchema.min(1)
const IsoDateTimeSchema = z.iso.datetime()
const ObjectIdStringSchema = z.string().regex(/^[a-f\d]{24}$/i)

const InterviewTermsSchema = z
  .object({
    includedPerPeriod: NonNegativeSafeIntegerSchema,
    periodOwner: z.enum(['calendar_month', 'razorpay_billing_cycle']),
    maxDurationMinutes: PositiveSafeIntegerSchema,
    supportedDurationsMinutes: z.array(PositiveSafeIntegerSchema),
    analysisAndReplayIncluded: z.literal(true),
  })
  .strip()

const ResumeTermsSchema = z
  .object({
    basicSavedResumeLimit: z.literal(1),
    premiumSavedResumeLimitPerPeriod: NonNegativeSafeIntegerSchema,
  })
  .strip()

function catalogPlanSchema(
  key: 'free' | 'plus' | 'pro',
  displayName: 'Basic' | 'Plus' | 'Pro',
) {
  return z
    .object({
      key: z.literal(key),
      displayName: z.literal(displayName),
      listPricePaise: NonNegativeSafeIntegerSchema,
      billingPeriod: key === 'free' ? z.literal('none') : z.literal('monthly'),
      interview: InterviewTermsSchema,
      resume: ResumeTermsSchema,
    })
    .strip()
}

const SingleInterviewProductSchema = z
  .object({
    key: z.literal('single_interview'),
    displayName: z.string(),
    listPricePaise: NonNegativeSafeIntegerSchema,
    billing: z.literal('one_time'),
    couponEligible: z.literal(false),
    entitlement: z
      .object({
        interviews: z.literal(1),
        maxDurationMinutes: z.literal(30),
        supportedDurationsMinutes: z.array(PositiveSafeIntegerSchema),
        validityDaysBeforeUse: PositiveSafeIntegerSchema,
        analysisAndReplayIncluded: z.literal(true),
      })
      .strip(),
  })
  .strip()

const PremiumResumeProductSchema = z
  .object({
    key: z.literal('premium_resume'),
    displayName: z.string(),
    listPricePaise: NonNegativeSafeIntegerSchema,
    billing: z.literal('one_time'),
    couponEligible: z.literal(false),
    entitlement: z
      .object({
        premiumSavedResumeVersions: z.literal(1),
        revisionWindowDays: PositiveSafeIntegerSchema,
        revisionWindowStartsAt: z.literal('first_successful_render'),
      })
      .strip(),
  })
  .strip()

export const PublicBillingCatalogResponseSchema = z
  .object({
    schemaVersion: z.literal(1),
    catalogVersion: z.string().min(1).max(100),
    effectiveAt: IsoDateTimeSchema,
    currency: z.literal('INR'),
    gstInclusive: z.literal(true),
    gstRatePercent: z.literal(18),
    customerBillingUiReady: z.boolean(),
    checkoutRequiresAuthentication: z.literal(true),
    plans: z
      .object({
        free: catalogPlanSchema('free', 'Basic'),
        plus: catalogPlanSchema('plus', 'Plus'),
        pro: catalogPlanSchema('pro', 'Pro'),
      })
      .strip(),
    oneTimeProducts: z
      .object({
        single_interview: SingleInterviewProductSchema,
        premium_resume: PremiumResumeProductSchema,
      })
      .strip(),
  })
  .strip()

const PlaceOfSupplyResponseSchema = z
  .object({
    stateCode: z.enum(INDIA_BILLING_STATE_CODES),
    countryCode: z.literal('IN'),
  })
  .strip()

const ConfiguredBillingProfileResponseSchema = z
  .object({
    configured: z.literal(true),
    version: PositiveSafeIntegerSchema,
    placeOfSupply: PlaceOfSupplyResponseSchema,
    updatedAt: IsoDateTimeSchema,
  })
  .strip()

const UnconfiguredBillingProfileResponseSchema = z
  .object({
    configured: z.literal(false),
    version: z.literal(0).optional(),
  })
  .strip()

export const CustomerBillingProfileResponseSchema = z.discriminatedUnion(
  'configured',
  [
    ConfiguredBillingProfileResponseSchema,
    UnconfiguredBillingProfileResponseSchema,
  ],
)

const CustomerBillingProfileStatusResponseSchema = z.discriminatedUnion(
  'configured',
  [
    z
      .object({
        configured: z.literal(true),
        version: PositiveSafeIntegerSchema,
      })
      .strip(),
    UnconfiguredBillingProfileResponseSchema,
  ],
)

const ConsumerPlanKeySchema = z.enum(['free', 'plus', 'pro'])
const SubscriptionStatusSchema = z.enum([
  'created',
  'authenticated',
  'activation_pending',
  'active',
  'pending',
  'halted',
  'paused',
  'cancelled',
  'completed',
  'expired',
  'review',
])
export const PlanChangeStatusSchema = z.enum([
  'requested',
  'authorization_pending',
  'old_cancellation_pending',
  'reconciling',
  'scheduled',
  'applying',
  'compensating',
  'applied',
  'cancelled',
  'failed',
  'review',
])

const CurrentSubscriptionCouponIdentityShape = {
  source: z.literal('subscription_checkout'),
  campaignId: ObjectIdStringSchema,
  revision: PositiveSafeIntegerSchema,
  displayText: z.string().trim().min(1).max(300),
  termsText: z.string().trim().min(10).max(2_000),
} as const

const NormalizedCouponCodeSchema = z
  .string()
  .trim()
  .min(3)
  .max(40)
  .regex(/^[A-Z0-9][A-Z0-9_-]*$/)

const CurrentSubscriptionCouponSchema = z.discriminatedUnion('mode', [
  z
    .object({
      ...CurrentSubscriptionCouponIdentityShape,
      mode: z.literal('code'),
      code: NormalizedCouponCodeSchema,
    })
    .strip(),
  z
    .object({
      ...CurrentSubscriptionCouponIdentityShape,
      mode: z.literal('automatic'),
      code: z.never().optional(),
    })
    .strip(),
  z
    .object({
      ...CurrentSubscriptionCouponIdentityShape,
      mode: z.literal('targeted'),
      code: z.never().optional(),
    })
    .strip(),
])

export const CustomerBillingSummaryResponseSchema = z
  .object({
    schemaVersion: z.literal(1),
    environment: z.enum(['test', 'live']),
    customerBillingUiReady: z.boolean(),
    accountState: z.enum(['active', 'deletion_pending']),
    saleAvailability: z.enum([
      'available',
      'unavailable',
      'account_restricted',
    ]),
    entitlement: z
      .object({
        initialized: z.boolean(),
        planKey: ConsumerPlanKeySchema,
        source: z.enum(['free', 'subscription', 'admin_grant']),
        planExpiresAt: IsoDateTimeSchema.optional(),
        usagePeriodKey: z.string(),
        interviewsUsed: NonNegativeSafeIntegerSchema,
        interviewLimit: NonNegativeSafeIntegerSchema,
        interviewsRemaining: NonNegativeSafeIntegerSchema,
        premiumResumesUsed: NonNegativeSafeIntegerSchema,
        premiumResumeLimit: NonNegativeSafeIntegerSchema,
        premiumResumesRemaining: NonNegativeSafeIntegerSchema,
        usageResetAt: IsoDateTimeSchema.optional(),
        hasFreeBasicResume: z.boolean(),
        version: NonNegativeSafeIntegerSchema,
        environmentConsistency: z.enum([
          'verified',
          'mismatch',
          'not_applicable',
        ]),
      })
      .strip(),
    subscription: z
      .object({
        state: z.enum(['none', 'activation_pending', 'current', 'review']),
        billingHealth: z
          .enum([
            'healthy',
            'pending',
            'action_required',
            'ending',
            'ended',
            'review',
          ])
          .optional(),
        planKey: z.enum(['plus', 'pro']).optional(),
        status: SubscriptionStatusSchema.optional(),
        currentPeriodStart: IsoDateTimeSchema.optional(),
        currentPeriodEnd: IsoDateTimeSchema.optional(),
        cancelAtPeriodEnd: z.boolean().optional(),
        discountedCyclesRemaining: NonNegativeSafeIntegerSchema.optional(),
        currentCoupon: CurrentSubscriptionCouponSchema.optional(),
        nextCharge: z
          .object({
            amountPaise: NonNegativeSafeIntegerSchema,
            currency: z.literal('INR'),
            scheduledAt: IsoDateTimeSchema,
          })
          .strip()
          .optional(),
      })
      .strip(),
    scheduledPlanChange: z
      .object({
        planChangeRequestId: ObjectIdStringSchema,
        fromPlanKey: ConsumerPlanKeySchema,
        toPlanKey: ConsumerPlanKeySchema,
        status: PlanChangeStatusSchema,
        requestedAt: IsoDateTimeSchema,
        effectiveAt: IsoDateTimeSchema,
      })
      .strip()
      .optional(),
    interviewUnlocks: z.record(z.string(), NonNegativeSafeIntegerSchema),
    resumeEntitlements: z.record(z.string(), NonNegativeSafeIntegerSchema),
    billingProfile: CustomerBillingProfileStatusResponseSchema,
  })
  .strip()
  .superRefine((summary, context) => {
    const currentCoupon = summary.subscription.currentCoupon
    if (
      currentCoupon &&
      (
        summary.subscription.state !== 'current' ||
        summary.subscription.discountedCyclesRemaining === undefined
      )
    ) {
      context.addIssue({
        code: 'custom',
        path: ['subscription', 'currentCoupon'],
        message: 'Current coupon must belong to the current paid subscription',
      })
    }
    if (
      !currentCoupon &&
      (summary.subscription.discountedCyclesRemaining ?? 0) > 0
    ) {
      context.addIssue({
        code: 'custom',
        path: ['subscription', 'discountedCyclesRemaining'],
        message: 'Discounted cycles require an exact current coupon identity',
      })
    }
  })

const FinancialDocumentBaseSchema = z.object({
  id: ObjectIdStringSchema,
  number: z.string(),
  issuedAt: IsoDateTimeSchema,
  currency: z.literal('INR'),
  grossPaise: NonNegativeSafeIntegerSchema,
  taxablePaise: NonNegativeSafeIntegerSchema,
  gstPaise: NonNegativeSafeIntegerSchema,
  componentAllocation: z.enum(['intra_state', 'inter_state']),
  cgstPaise: NonNegativeSafeIntegerSchema.optional(),
  sgstPaise: NonNegativeSafeIntegerSchema.optional(),
  igstPaise: NonNegativeSafeIntegerSchema.optional(),
  description: z.string(),
  pdfAvailable: z.literal(false),
  testMode: z.boolean(),
})

const CustomerInvoiceSummaryResponseSchema = FinancialDocumentBaseSchema.extend(
  {
    kind: z.literal('invoice'),
    chargeKind: z.enum([
      'subscription_cycle',
      'single_interview',
      'premium_resume',
    ]),
  },
).strip()

const CustomerCreditNoteSummaryResponseSchema =
  FinancialDocumentBaseSchema.extend({
    kind: z.literal('credit_note'),
    invoiceId: ObjectIdStringSchema,
    originalInvoiceNumber: z.string(),
  }).strip()

export const CustomerFinancialDocumentSummaryResponseSchema =
  z.discriminatedUnion('kind', [
    CustomerInvoiceSummaryResponseSchema,
    CustomerCreditNoteSummaryResponseSchema,
  ])

export const CustomerFinancialDocumentPageResponseSchema = z
  .object({
    environment: z.enum(['test', 'live']),
    documents: z.array(CustomerFinancialDocumentSummaryResponseSchema),
    nextCursor: z.string().max(300).nullable(),
  })
  .strip()

export const CustomerInvoiceDetailResponseSchema = z
  .object({
    environment: z.enum(['test', 'live']),
    invoice: CustomerInvoiceSummaryResponseSchema,
    creditNotes: z.array(CustomerCreditNoteSummaryResponseSchema),
    netPaidPaise: NonNegativeSafeIntegerSchema,
    rendering: z
      .object({
        pdfAvailable: z.literal(false),
        reason: z.literal('financial_policy_not_approved'),
      })
      .strip(),
  })
  .strip()
