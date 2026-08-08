import { z } from 'zod'
import { InrPaiseSchema, inrPaise } from '../lib/money'
import {
  PROVIDER_MODES,
  type ProviderMode,
} from '../types/catalog'

const SafeNonNegativeIntegerSchema = z.number()
  .refine(Number.isSafeInteger, 'Value must be a safe integer')
  .refine((value) => value >= 0, 'Value cannot be negative')
const PositiveSafeIntegerSchema = SafeNonNegativeIntegerSchema
  .refine((value) => value > 0, 'Value must be positive')
const EpochSecondsSchema = SafeNonNegativeIntegerSchema
const SafeIntegerLikeSchema = z.union([
  SafeNonNegativeIntegerSchema,
  z.string()
    .regex(/^(0|[1-9]\d*)$/, 'Value must be an unsigned base-10 integer')
    .transform(Number)
    .refine(Number.isSafeInteger, 'Value must be a safe integer'),
])

const OrderIdSchema = z.string().trim()
  .regex(/^order_[A-Za-z0-9]+$/)
  .max(128)
const PaymentIdSchema = z.string().trim()
  .regex(/^pay_[A-Za-z0-9]+$/)
  .max(128)
const PlanIdSchema = z.string().trim()
  .regex(/^plan_[A-Za-z0-9]+$/)
  .max(128)
const OfferIdSchema = z.string().trim()
  .regex(/^offer_[A-Za-z0-9]+$/)
  .max(128)
const SubscriptionIdSchema = z.string().trim()
  .regex(/^sub_[A-Za-z0-9]+$/)
  .max(128)
const CustomerIdSchema = z.string().trim()
  .regex(/^cust_[A-Za-z0-9]+$/)
  .max(128)
const InvoiceIdSchema = z.string().trim()
  .regex(/^inv_[A-Za-z0-9]+$/)
  .max(128)
const CanonicalSubscriptionIdSchema = z.string()
  .regex(/^sub_[A-Za-z0-9]+$/)
  .max(128)
const CanonicalInvoiceIdSchema = z.string()
  .regex(/^inv_[A-Za-z0-9]+$/)
  .max(128)
const RefundIdSchema = z.string().trim()
  .regex(/^rfnd_[A-Za-z0-9]{14}$/)
const DisputeIdSchema = z.string().trim()
  .regex(/^disp_[A-Za-z0-9]{14}$/)
const PositiveInrPaiseSchema = InrPaiseSchema
  .refine((value) => value > 0, 'Amount must be positive')

const RazorpayNoteKeySchema = z.string().trim().min(1).max(256)
const RazorpayNoteValueSchema = z.union([
  z.string().max(256),
  z.number().finite(),
])
export const RazorpayNotesSchema = z.record(
  RazorpayNoteKeySchema,
  RazorpayNoteValueSchema,
).superRefine((notes, context) => {
  if (Object.keys(notes).length > 15) {
    context.addIssue({
      code: 'custom',
      message: 'Razorpay supports at most 15 note entries',
    })
  }
})
export type RazorpayNotes = z.output<typeof RazorpayNotesSchema>

const ReceiptSchema = z.string().trim().min(1).max(40)

export const RAZORPAY_RECOVERY_MAX_PAGE_SIZE = 100 as const
// The official SDK documents 100 as the maximum page size. Two thousand
// invoices covers multi-decade monthly subscriptions with ample headroom while
// bounding reconciliation to at most 21 read-only provider requests, including
// the one-record overflow probe.
export const RAZORPAY_SUBSCRIPTION_INVOICE_PAGE_SIZE = 100 as const
export const RAZORPAY_SUBSCRIPTION_INVOICE_HARD_CAP = 2_000 as const
export const RAZORPAY_SUBSCRIPTION_RECOVERY_DEFAULT_MAX_PAGES = 3 as const
export const RAZORPAY_SUBSCRIPTION_RECOVERY_HARD_MAX_PAGES = 10 as const
export const RAZORPAY_SUBSCRIPTION_RECOVERY_MAX_WINDOW_SECONDS =
  72 * 60 * 60

export const FindRazorpaySubscriptionByReceiptInputSchema = z.object({
  checkoutReceipt: ReceiptSchema,
  expectedPlanId: PlanIdSchema,
  fromEpochSeconds: EpochSecondsSchema,
  toEpochSeconds: EpochSecondsSchema,
  pageSize: z.number()
    .int()
    .min(1)
    .max(RAZORPAY_RECOVERY_MAX_PAGE_SIZE)
    .default(RAZORPAY_RECOVERY_MAX_PAGE_SIZE),
  maxPages: z.number()
    .int()
    .min(1)
    .max(RAZORPAY_SUBSCRIPTION_RECOVERY_HARD_MAX_PAGES)
    .default(RAZORPAY_SUBSCRIPTION_RECOVERY_DEFAULT_MAX_PAGES),
}).strict().superRefine((input, context) => {
  if (input.toEpochSeconds <= input.fromEpochSeconds) {
    context.addIssue({
      code: 'custom',
      path: ['toEpochSeconds'],
      message: 'Subscription recovery window end must be after its start',
    })
    return
  }
  if (
    input.toEpochSeconds - input.fromEpochSeconds >
    RAZORPAY_SUBSCRIPTION_RECOVERY_MAX_WINDOW_SECONDS
  ) {
    context.addIssue({
      code: 'custom',
      path: ['fromEpochSeconds'],
      message: 'Subscription recovery window cannot exceed 72 hours',
    })
  }
})
export type FindRazorpaySubscriptionByReceiptInput =
  z.input<typeof FindRazorpaySubscriptionByReceiptInputSchema>

export const CreateRazorpayOrderInputSchema = z.object({
  amountPaise: InrPaiseSchema,
  currency: z.literal('INR'),
  receipt: ReceiptSchema,
  notes: RazorpayNotesSchema.default({}),
}).strict()
export type CreateRazorpayOrderInput =
  z.input<typeof CreateRazorpayOrderInputSchema>

export const CreateRazorpayPlanInputSchema = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().min(1).max(500).optional(),
  amountPaise: InrPaiseSchema,
  currency: z.literal('INR'),
  period: z.enum(['daily', 'weekly', 'monthly', 'yearly']),
  interval: PositiveSafeIntegerSchema,
  notes: RazorpayNotesSchema.default({}),
}).strict()
export type CreateRazorpayPlanInput =
  z.input<typeof CreateRazorpayPlanInputSchema>

export const CreateRazorpaySubscriptionInputSchema = z.object({
  planId: PlanIdSchema,
  totalCount: PositiveSafeIntegerSchema,
  quantity: PositiveSafeIntegerSchema.optional(),
  offerId: OfferIdSchema.optional(),
  upfrontItem: z.object({
    name: z.string().trim().min(1).max(100),
    amountPaise: PositiveInrPaiseSchema,
    currency: z.literal('INR'),
  }).strict().optional(),
  startAtEpochSeconds: PositiveSafeIntegerSchema.optional(),
  authorizationExpiresAtEpochSeconds:
    PositiveSafeIntegerSchema.optional(),
  // Provider communication remains dark until the product owner explicitly
  // approves customer messaging.
  customerNotify: z.literal(false),
  receipt: ReceiptSchema,
  notes: RazorpayNotesSchema.default({}),
}).strict().superRefine((subscription, context) => {
  if (
    subscription.upfrontItem !== undefined &&
    subscription.offerId !== undefined
  ) {
    context.addIssue({
      code: 'custom',
      path: ['offerId'],
      message: 'Upfront subscription items cannot be combined with an Offer',
    })
  }
  if (
    subscription.startAtEpochSeconds !== undefined &&
    subscription.authorizationExpiresAtEpochSeconds === undefined
  ) {
    context.addIssue({
      code: 'custom',
      path: ['authorizationExpiresAtEpochSeconds'],
      message: 'Future-start subscriptions require an authorization deadline',
    })
  }
  if (
    subscription.startAtEpochSeconds !== undefined &&
    subscription.authorizationExpiresAtEpochSeconds !== undefined &&
    subscription.authorizationExpiresAtEpochSeconds >=
      subscription.startAtEpochSeconds
  ) {
    context.addIssue({
      code: 'custom',
      path: ['authorizationExpiresAtEpochSeconds'],
      message: 'Authorization deadline must precede subscription start',
    })
  }
})
export type CreateRazorpaySubscriptionInput =
  z.input<typeof CreateRazorpaySubscriptionInputSchema>

export const CreateRazorpayCustomerInputSchema = z.object({
  name: z.string().trim().min(3).max(50),
  email: z.email().max(64).optional(),
  contact: z.string().trim().regex(/^\+?\d{8,15}$/).optional(),
  gstin: z.string()
    .trim()
    .toUpperCase()
    .regex(/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/)
    .optional(),
  failExisting: z.boolean().default(true),
  notes: RazorpayNotesSchema.default({}),
}).strict().refine(
  (input) => input.email !== undefined || input.contact !== undefined,
  {
    message: 'A Razorpay customer requires email or contact',
    path: ['email'],
  },
)
export type CreateRazorpayCustomerInput =
  z.input<typeof CreateRazorpayCustomerInputSchema>

export const RazorpayOrderDtoSchema = z.object({
  providerMode: z.enum(PROVIDER_MODES),
  id: OrderIdSchema,
  amountPaise: InrPaiseSchema,
  amountPaidPaise: InrPaiseSchema,
  amountDuePaise: InrPaiseSchema,
  currency: z.literal('INR'),
  receipt: ReceiptSchema,
  status: z.enum(['created', 'attempted', 'paid']),
  attempts: SafeNonNegativeIntegerSchema,
  offerId: OfferIdSchema.optional(),
  notes: RazorpayNotesSchema,
  createdAtEpochSeconds: EpochSecondsSchema,
}).strict()
export type RazorpayOrderDto = z.output<typeof RazorpayOrderDtoSchema>

/**
 * Additive provider fields used when a caller must distinguish an omitted
 * Razorpay payment field from an explicit zero/null value. The legacy
 * `amountRefundedPaise` field remains on the payment DTO for existing
 * acquisition and reconciliation consumers.
 */
export const RazorpayPaymentProviderEvidenceSchema = z.object({
  amountRefundedPaise: InrPaiseSchema.optional(),
  refundStatus: z.enum(['partial', 'full']).nullable().optional(),
  amountCapturedPaise: InrPaiseSchema.optional(),
}).strict()
export type RazorpayPaymentProviderEvidence =
  z.output<typeof RazorpayPaymentProviderEvidenceSchema>

export const RazorpayPaymentDtoSchema = z.object({
  providerMode: z.enum(PROVIDER_MODES),
  id: PaymentIdSchema,
  orderId: OrderIdSchema.optional(),
  subscriptionId: SubscriptionIdSchema.optional(),
  invoiceId: InvoiceIdSchema.optional(),
  amountPaise: InrPaiseSchema,
  amountRefundedPaise: InrPaiseSchema,
  currency: z.literal('INR'),
  status: z.enum([
    'created',
    'authorized',
    'captured',
    'refunded',
    'failed',
  ]),
  captured: z.boolean(),
  method: z.string().trim().min(1).max(100),
  notes: RazorpayNotesSchema,
  providerEvidence: RazorpayPaymentProviderEvidenceSchema.optional(),
  error: z.object({
    code: z.string().max(200).optional(),
    description: z.string().max(2000).optional(),
    source: z.string().max(200).optional(),
    step: z.string().max(200).optional(),
    reason: z.string().max(200).optional(),
  }).strict().optional(),
  createdAtEpochSeconds: EpochSecondsSchema,
}).strict()
export type RazorpayPaymentDto = z.output<typeof RazorpayPaymentDtoSchema>

export const RazorpayInvoiceDtoSchema = z.object({
  providerMode: z.enum(PROVIDER_MODES),
  id: InvoiceIdSchema,
  subscriptionId: SubscriptionIdSchema.optional(),
  paymentId: PaymentIdSchema.optional(),
  orderId: OrderIdSchema.optional(),
  status: z.enum([
    'draft',
    'issued',
    'partially_paid',
    'paid',
    'cancelled',
    'expired',
    'deleted',
  ]),
  amountPaise: InrPaiseSchema,
  amountPaidPaise: InrPaiseSchema,
  amountDuePaise: InrPaiseSchema,
  currency: z.literal('INR'),
  partialPayment: z.boolean(),
  billingStartEpochSeconds: EpochSecondsSchema.optional(),
  billingEndEpochSeconds: EpochSecondsSchema.optional(),
  issuedAtEpochSeconds: EpochSecondsSchema.optional(),
  paidAtEpochSeconds: EpochSecondsSchema.optional(),
  createdAtEpochSeconds: EpochSecondsSchema,
}).strict().superRefine((invoice, context) => {
  const hasBillingStart = invoice.billingStartEpochSeconds !== undefined
  const hasBillingEnd = invoice.billingEndEpochSeconds !== undefined
  if (hasBillingStart !== hasBillingEnd) {
    context.addIssue({
      code: 'custom',
      path: ['billingEndEpochSeconds'],
      message: 'Invoice billing boundaries must be recorded together',
    })
  } else if (
    invoice.billingStartEpochSeconds !== undefined &&
    invoice.billingEndEpochSeconds !== undefined &&
    invoice.billingEndEpochSeconds <= invoice.billingStartEpochSeconds
  ) {
    context.addIssue({
      code: 'custom',
      path: ['billingEndEpochSeconds'],
      message: 'Invoice billing end must be after billing start',
    })
  }
})
export type RazorpayInvoiceDto = z.output<typeof RazorpayInvoiceDtoSchema>

export const RazorpayRefundDtoSchema = z.object({
  providerMode: z.enum(PROVIDER_MODES),
  id: RefundIdSchema,
  paymentId: PaymentIdSchema,
  amountPaise: PositiveInrPaiseSchema,
  currency: z.literal('INR'),
  status: z.enum(['pending', 'processed', 'failed']),
  createdAtEpochSeconds: EpochSecondsSchema,
}).strict()
export type RazorpayRefundDto = z.output<typeof RazorpayRefundDtoSchema>

export const RazorpayDisputeDtoSchema = z.object({
  providerMode: z.enum(PROVIDER_MODES),
  id: DisputeIdSchema,
  paymentId: PaymentIdSchema,
  amountPaise: PositiveInrPaiseSchema,
  amountDeductedPaise: InrPaiseSchema,
  currency: z.literal('INR'),
  reasonCode: z.string().trim().min(1).max(200),
  respondByEpochSeconds: EpochSecondsSchema,
  status: z.enum(['open', 'under_review', 'won', 'lost', 'closed']),
  phase: z.enum([
    'fraud',
    'retrieval',
    'chargeback',
    'pre_arbitration',
    'arbitration',
  ]),
  createdAtEpochSeconds: EpochSecondsSchema,
}).strict()
export type RazorpayDisputeDto =
  z.output<typeof RazorpayDisputeDtoSchema>

export const RazorpayPlanDtoSchema = z.object({
  providerMode: z.enum(PROVIDER_MODES),
  id: PlanIdSchema,
  period: z.enum(['daily', 'weekly', 'monthly', 'yearly']),
  interval: PositiveSafeIntegerSchema,
  item: z.object({
    id: z.string().trim().min(1).max(128).optional(),
    name: z.string().trim().min(1).max(200),
    description: z.string().max(2000).optional(),
    amountPaise: InrPaiseSchema,
    currency: z.literal('INR'),
    active: z.boolean(),
  }).strict(),
  notes: RazorpayNotesSchema,
  createdAtEpochSeconds: EpochSecondsSchema,
}).strict()
export type RazorpayPlanDto = z.output<typeof RazorpayPlanDtoSchema>

/**
 * Normalized contract for a future account-approved Offer reader. The official
 * Node SDK does not expose an Offers resource in 2.9.8, so the default client
 * factory fails closed for this method instead of guessing an HTTP endpoint.
 */
export const RazorpayOfferTermsSchema = z.object({
  id: OfferIdSchema,
  active: z.boolean(),
  discountAmountPaise: InrPaiseSchema,
  applicablePlanIds: z.array(PlanIdSchema).min(1),
  discountedBillingCycles: PositiveSafeIntegerSchema,
  startsAtEpochSeconds: EpochSecondsSchema.optional(),
  endsAtEpochSeconds: EpochSecondsSchema.optional(),
}).strict().superRefine((offer, context) => {
  if (
    offer.startsAtEpochSeconds !== undefined &&
    offer.endsAtEpochSeconds !== undefined &&
    offer.endsAtEpochSeconds <= offer.startsAtEpochSeconds
  ) {
    context.addIssue({
      code: 'custom',
      path: ['endsAtEpochSeconds'],
      message: 'Offer end must be after its start',
    })
  }
})

export const RazorpayOfferDtoSchema = RazorpayOfferTermsSchema.extend({
  providerMode: z.enum(PROVIDER_MODES),
}).strict()
export type RazorpayOfferDto = z.output<typeof RazorpayOfferDtoSchema>

export const RazorpaySubscriptionDtoSchema = z.object({
  providerMode: z.enum(PROVIDER_MODES),
  id: SubscriptionIdSchema,
  planId: PlanIdSchema,
  offerId: OfferIdSchema.optional(),
  customerId: CustomerIdSchema.optional(),
  status: z.enum([
    'created',
    'authenticated',
    'active',
    'pending',
    'halted',
    'paused',
    'cancelled',
    'completed',
    'expired',
  ]),
  totalCount: PositiveSafeIntegerSchema,
  paidCount: SafeNonNegativeIntegerSchema,
  remainingCount: SafeNonNegativeIntegerSchema,
  currentStartEpochSeconds: EpochSecondsSchema.optional(),
  currentEndEpochSeconds: EpochSecondsSchema.optional(),
  startAtEpochSeconds: EpochSecondsSchema.optional(),
  endAtEpochSeconds: EpochSecondsSchema.optional(),
  chargeAtEpochSeconds: EpochSecondsSchema.optional(),
  authorizationExpiresAtEpochSeconds: EpochSecondsSchema.optional(),
  endedAtEpochSeconds: EpochSecondsSchema.optional(),
  hasScheduledChanges: z.boolean().optional(),
  scheduledChangeAtEpochSeconds: EpochSecondsSchema.optional(),
  notes: RazorpayNotesSchema,
  createdAtEpochSeconds: EpochSecondsSchema,
}).strict().superRefine((subscription, context) => {
  const orderedBoundaries = [
    {
      start: subscription.currentStartEpochSeconds,
      end: subscription.currentEndEpochSeconds,
      path: 'currentEndEpochSeconds',
      message: 'Current cycle end must not precede its start',
    },
    {
      start: subscription.startAtEpochSeconds,
      end: subscription.endAtEpochSeconds,
      path: 'endAtEpochSeconds',
      message: 'Subscription end must not precede its start',
    },
  ] as const
  for (const boundary of orderedBoundaries) {
    if (
      boundary.start !== undefined &&
      boundary.end !== undefined &&
      boundary.end < boundary.start
    ) {
      context.addIssue({
        code: 'custom',
        path: [boundary.path],
        message: boundary.message,
      })
    }
  }
  if (
    subscription.authorizationExpiresAtEpochSeconds !== undefined &&
    subscription.startAtEpochSeconds !== undefined &&
    subscription.authorizationExpiresAtEpochSeconds >=
      subscription.startAtEpochSeconds
  ) {
    context.addIssue({
      code: 'custom',
      path: ['authorizationExpiresAtEpochSeconds'],
      message: 'Authorization deadline must precede subscription start',
    })
  }
  if (
    subscription.scheduledChangeAtEpochSeconds !== undefined &&
    subscription.hasScheduledChanges !== true
  ) {
    context.addIssue({
      code: 'custom',
      path: ['scheduledChangeAtEpochSeconds'],
      message: 'Scheduled-change time requires provider schedule evidence',
    })
  }
})
export type RazorpaySubscriptionDto =
  z.output<typeof RazorpaySubscriptionDtoSchema>

export const RazorpayCustomerDtoSchema = z.object({
  providerMode: z.enum(PROVIDER_MODES),
  id: CustomerIdSchema,
  name: z.string().max(50).optional(),
  email: z.string().max(64).optional(),
  contact: z.string().max(15).optional(),
  gstin: z.string()
    .regex(/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/)
    .optional(),
  notes: RazorpayNotesSchema,
  createdAtEpochSeconds: EpochSecondsSchema,
}).strict()
export type RazorpayCustomerDto = z.output<typeof RazorpayCustomerDtoSchema>

const RawRazorpayOrderSchema = z.object({
  id: OrderIdSchema,
  entity: z.literal('order'),
  amount: InrPaiseSchema,
  amount_paid: InrPaiseSchema,
  amount_due: InrPaiseSchema,
  currency: z.literal('INR'),
  receipt: ReceiptSchema,
  status: z.enum(['created', 'attempted', 'paid']),
  attempts: SafeNonNegativeIntegerSchema,
  offer_id: OfferIdSchema.nullish(),
  notes: z.unknown().optional(),
  created_at: EpochSecondsSchema,
}).passthrough()

const RawRazorpayPaymentSchema = z.object({
  id: PaymentIdSchema,
  entity: z.literal('payment'),
  order_id: OrderIdSchema.nullish(),
  subscription_id: SubscriptionIdSchema.nullish(),
  invoice_id: InvoiceIdSchema.nullish(),
  amount: InrPaiseSchema,
  amount_refunded: InrPaiseSchema.optional(),
  refund_status: z.union([
    z.literal('partial'),
    z.literal('full'),
    z.literal('null'),
    z.null(),
  ]).optional(),
  amount_captured: InrPaiseSchema.optional(),
  currency: z.literal('INR'),
  status: z.enum([
    'created',
    'authorized',
    'captured',
    'refunded',
    'failed',
  ]),
  captured: z.boolean(),
  method: z.string().trim().min(1).max(100),
  notes: z.unknown().optional(),
  error_code: z.string().nullish(),
  error_description: z.string().nullish(),
  error_source: z.string().nullish(),
  error_step: z.string().nullish(),
  error_reason: z.string().nullish(),
  created_at: EpochSecondsSchema,
}).passthrough()

const RawRazorpayPaymentCollectionSchema = z.object({
  entity: z.literal('collection'),
  count: SafeNonNegativeIntegerSchema,
  items: z.array(RawRazorpayPaymentSchema),
}).passthrough()

const RawRazorpayInvoiceSchema = z.object({
  id: InvoiceIdSchema,
  entity: z.literal('invoice'),
  type: z.literal('invoice'),
  subscription_id: SubscriptionIdSchema.nullish(),
  payment_id: PaymentIdSchema.nullish(),
  order_id: OrderIdSchema.nullish(),
  status: z.enum([
    'draft',
    'issued',
    'partially_paid',
    'paid',
    'cancelled',
    'expired',
    'deleted',
  ]),
  amount: InrPaiseSchema,
  amount_paid: InrPaiseSchema,
  amount_due: InrPaiseSchema,
  currency: z.literal('INR'),
  partial_payment: z.boolean(),
  billing_start: EpochSecondsSchema.nullish(),
  billing_end: EpochSecondsSchema.nullish(),
  issued_at: EpochSecondsSchema.nullish(),
  paid_at: EpochSecondsSchema.nullish(),
  created_at: EpochSecondsSchema,
}).passthrough()

const RawRazorpaySubscriptionInvoiceSchema = RawRazorpayInvoiceSchema.extend({
  id: CanonicalInvoiceIdSchema,
  subscription_id: CanonicalSubscriptionIdSchema,
  providerMode: z.enum(PROVIDER_MODES).optional(),
  provider_mode: z.enum(PROVIDER_MODES).optional(),
}).passthrough()

const RawRazorpayInvoiceCollectionSchema = z.object({
  entity: z.literal('collection'),
  count: SafeNonNegativeIntegerSchema
    .refine(
      (count) => count <= RAZORPAY_SUBSCRIPTION_INVOICE_PAGE_SIZE,
      'Subscription invoice page exceeds the maximum size',
    ),
  items: z.array(RawRazorpaySubscriptionInvoiceSchema)
    .max(RAZORPAY_SUBSCRIPTION_INVOICE_PAGE_SIZE),
}).strict().superRefine((collection, context) => {
  if (collection.count !== collection.items.length) {
    context.addIssue({
      code: 'custom',
      path: ['count'],
      message: 'Invoice collection count must equal returned item count',
    })
  }
})

const RawRazorpayRefundSchema = z.object({
  id: RefundIdSchema,
  entity: z.literal('refund'),
  payment_id: PaymentIdSchema,
  amount: PositiveInrPaiseSchema,
  currency: z.literal('INR'),
  status: z.enum(['pending', 'processed', 'failed']),
  created_at: EpochSecondsSchema,
}).passthrough()

const RawRazorpayDisputeSchema = z.object({
  id: DisputeIdSchema,
  entity: z.literal('dispute'),
  payment_id: PaymentIdSchema,
  amount: PositiveInrPaiseSchema,
  amount_deducted: InrPaiseSchema,
  currency: z.literal('INR'),
  reason_code: z.string().trim().min(1).max(200),
  respond_by: EpochSecondsSchema,
  status: z.enum(['open', 'under_review', 'won', 'lost', 'closed']),
  phase: z.enum([
    'fraud',
    'retrieval',
    'chargeback',
    'pre_arbitration',
    'arbitration',
  ]),
  created_at: EpochSecondsSchema,
}).passthrough()

const RawRazorpayPlanSchema = z.object({
  id: PlanIdSchema,
  entity: z.literal('plan'),
  period: z.enum(['daily', 'weekly', 'monthly', 'yearly']),
  interval: PositiveSafeIntegerSchema,
  item: z.object({
    id: z.string().trim().min(1).max(128).optional(),
    name: z.string().trim().min(1).max(200),
    description: z.string().max(2000).optional(),
    amount: InrPaiseSchema,
    currency: z.literal('INR'),
    active: z.boolean(),
  }).passthrough(),
  notes: z.unknown().optional(),
  created_at: EpochSecondsSchema,
}).passthrough()

const RawRazorpaySubscriptionSchema = z.object({
  id: SubscriptionIdSchema,
  entity: z.literal('subscription'),
  plan_id: PlanIdSchema,
  offer_id: OfferIdSchema.nullish(),
  customer_id: CustomerIdSchema.nullish(),
  status: z.enum([
    'created',
    'authenticated',
    'active',
    'pending',
    'halted',
    'paused',
    'cancelled',
    'completed',
    'expired',
  ]),
  total_count: SafeIntegerLikeSchema,
  paid_count: SafeIntegerLikeSchema,
  remaining_count: SafeIntegerLikeSchema,
  current_start: EpochSecondsSchema.nullish(),
  current_end: EpochSecondsSchema.nullish(),
  start_at: EpochSecondsSchema.nullish(),
  end_at: EpochSecondsSchema.nullish(),
  charge_at: EpochSecondsSchema.nullish(),
  expire_by: EpochSecondsSchema.nullish(),
  ended_at: EpochSecondsSchema.nullish(),
  has_scheduled_changes: z.boolean().nullish(),
  change_scheduled_at: EpochSecondsSchema.nullish(),
  notes: z.unknown().optional(),
  created_at: EpochSecondsSchema,
}).passthrough()

const RawRazorpayOrderCollectionSchema = z.object({
  entity: z.literal('collection'),
  count: SafeNonNegativeIntegerSchema
    .refine(
      (count) => count <= RAZORPAY_RECOVERY_MAX_PAGE_SIZE,
      'Order recovery page exceeds the maximum size',
    ),
  items: z.array(RawRazorpayOrderSchema)
    .max(RAZORPAY_RECOVERY_MAX_PAGE_SIZE),
}).strict().superRefine((collection, context) => {
  if (collection.count !== collection.items.length) {
    context.addIssue({
      code: 'custom',
      path: ['count'],
      message: 'Order collection count must equal returned item count',
    })
  }
})

const RawRazorpaySubscriptionCollectionSchema = z.object({
  entity: z.literal('collection'),
  count: SafeNonNegativeIntegerSchema
    .refine(
      (count) => count <= RAZORPAY_RECOVERY_MAX_PAGE_SIZE,
      'Subscription recovery page exceeds the maximum size',
    ),
  items: z.array(RawRazorpaySubscriptionSchema)
    .max(RAZORPAY_RECOVERY_MAX_PAGE_SIZE),
}).strict().superRefine((collection, context) => {
  if (collection.count !== collection.items.length) {
    context.addIssue({
      code: 'custom',
      path: ['count'],
      message: 'Subscription collection count must equal returned item count',
    })
  }
})

const RawRazorpayCustomerSchema = z.object({
  id: CustomerIdSchema,
  entity: z.literal('customer'),
  name: z.string().max(50).optional(),
  email: z.string().max(64).optional(),
  contact: z.union([z.string(), z.number()]).optional(),
  gstin: z.string()
    .regex(/^[0-9]{2}[A-Za-z]{5}[0-9]{4}[A-Za-z][1-9A-Za-z]Z[0-9A-Za-z]$/)
    .nullish(),
  notes: z.unknown().optional(),
  created_at: EpochSecondsSchema,
}).passthrough()

export interface RazorpayOrderCreatePayload {
  amount: number
  currency: 'INR'
  receipt: string
  notes: RazorpayNotes
}

export interface RazorpayOrderListPayload {
  receipt: string
  count: number
  skip: number
}

export interface RazorpayPlanCreatePayload {
  period: 'daily' | 'weekly' | 'monthly' | 'yearly'
  interval: number
  item: {
    name: string
    amount: number
    currency: 'INR'
    description?: string
  }
  notes: RazorpayNotes
}

export interface RazorpaySubscriptionCreatePayload {
  plan_id: string
  total_count: number
  customer_notify: boolean
  quantity?: number
  offer_id?: string
  addons?: Array<{
    item: {
      name: string
      amount: number
      currency: 'INR'
    }
  }>
  start_at?: number
  expire_by?: number
  notes: RazorpayNotes
}

export interface RazorpaySubscriptionListPayload {
  plan_id: string
  from: number
  to: number
  count: number
  skip: number
}

export interface RazorpayInvoiceListPayload {
  subscription_id: string
  count: number
  skip: number
}

export interface RazorpayCustomerCreatePayload {
  name: string
  email?: string
  contact?: string
  gstin?: string
  fail_existing: boolean
  notes: RazorpayNotes
}

export interface RazorpaySdkPort {
  orders: {
    create(input: RazorpayOrderCreatePayload): Promise<unknown>
    all(input: RazorpayOrderListPayload): Promise<unknown>
    fetch(orderId: string): Promise<unknown>
    fetchPayments(orderId: string): Promise<unknown>
  }
  payments: {
    fetch(paymentId: string): Promise<unknown>
  }
  invoices: {
    fetch(invoiceId: string): Promise<unknown>
    all?(input: RazorpayInvoiceListPayload): Promise<unknown>
  }
  refunds?: {
    fetch(refundId: string): Promise<unknown>
  }
  disputes?: {
    fetch(disputeId: string): Promise<unknown>
  }
  plans: {
    create(input: RazorpayPlanCreatePayload): Promise<unknown>
    fetch(planId: string): Promise<unknown>
  }
  subscriptions: {
    create(input: RazorpaySubscriptionCreatePayload): Promise<unknown>
    all(input: RazorpaySubscriptionListPayload): Promise<unknown>
    fetch(subscriptionId: string): Promise<unknown>
    cancel?(
      subscriptionId: string,
      cancelAtCycleEnd: boolean,
    ): Promise<unknown>
  }
  customers: {
    create(input: RazorpayCustomerCreatePayload): Promise<unknown>
    fetch(customerId: string): Promise<unknown>
  }
}

export interface RazorpayOfferReader {
  fetchOffer(input: {
    providerMode: ProviderMode
    offerId: string
  }): Promise<unknown>
}

export class RazorpaySdkCapabilityError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RazorpaySdkCapabilityError'
  }
}

export class RazorpayProviderEntityMismatchError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RazorpayProviderEntityMismatchError'
  }
}

export class RazorpayReconciliationConflictError extends Error {
  readonly entityType: 'order' | 'subscription'

  constructor(entityType: 'order' | 'subscription') {
    super(`Multiple Razorpay ${entityType} records match the recovery key`)
    this.name = 'RazorpayReconciliationConflictError'
    this.entityType = entityType
  }
}

export class RazorpayRecoveryScanLimitError extends Error {
  readonly entityType: 'order' | 'subscription'

  constructor(entityType: 'order' | 'subscription') {
    super(`Razorpay ${entityType} recovery scan reached its configured limit`)
    this.name = 'RazorpayRecoveryScanLimitError'
    this.entityType = entityType
  }
}

export class RazorpaySubscriptionInvoiceCollectionError extends Error {
  readonly reason: 'duplicate_invoice' | 'unexpected_page_size'

  constructor(
    reason: 'duplicate_invoice' | 'unexpected_page_size',
  ) {
    const message = reason === 'duplicate_invoice'
      ? 'Razorpay returned a duplicate invoice during subscription reconciliation'
      : 'Razorpay returned more subscription invoices than requested'
    super(message)
    this.name = 'RazorpaySubscriptionInvoiceCollectionError'
    this.reason = reason
  }
}

export class RazorpaySubscriptionInvoiceScanLimitError extends Error {
  readonly maxInvoices = RAZORPAY_SUBSCRIPTION_INVOICE_HARD_CAP

  constructor() {
    super(
      'Razorpay subscription invoice reconciliation exceeded the safe scan limit',
    )
    this.name = 'RazorpaySubscriptionInvoiceScanLimitError'
  }
}

export interface RazorpayServerAdapter {
  readonly providerMode: ProviderMode
  createOrder(input: CreateRazorpayOrderInput): Promise<RazorpayOrderDto>
  findOrderByReceipt(receipt: string): Promise<RazorpayOrderDto | null>
  fetchOrder(orderId: string): Promise<RazorpayOrderDto>
  fetchOrderPaymentAttempts(orderId: string): Promise<RazorpayPaymentDto[]>
  fetchPayment(paymentId: string): Promise<RazorpayPaymentDto>
  fetchInvoice(invoiceId: string): Promise<RazorpayInvoiceDto>
  fetchSubscriptionInvoices(
    subscriptionId: string,
  ): Promise<RazorpayInvoiceDto[]>
  fetchRefund(refundId: string): Promise<RazorpayRefundDto>
  fetchDispute(disputeId: string): Promise<RazorpayDisputeDto>
  createPlan(input: CreateRazorpayPlanInput): Promise<RazorpayPlanDto>
  fetchPlan(planId: string): Promise<RazorpayPlanDto>
  fetchOffer(offerId: string): Promise<RazorpayOfferDto>
  createSubscription(
    input: CreateRazorpaySubscriptionInput,
  ): Promise<RazorpaySubscriptionDto>
  findSubscriptionByCheckoutReceipt(
    input: FindRazorpaySubscriptionByReceiptInput,
  ): Promise<RazorpaySubscriptionDto | null>
  fetchSubscription(
    subscriptionId: string,
  ): Promise<RazorpaySubscriptionDto>
  createCustomer(
    input: CreateRazorpayCustomerInput,
  ): Promise<RazorpayCustomerDto>
  fetchCustomer(customerId: string): Promise<RazorpayCustomerDto>
}

function parseNotes(value: unknown): RazorpayNotes {
  if (value === undefined || (Array.isArray(value) && value.length === 0)) {
    return {}
  }
  return RazorpayNotesSchema.parse(value)
}

function normalizeOrder(
  providerMode: ProviderMode,
  value: unknown,
): RazorpayOrderDto {
  const order = RawRazorpayOrderSchema.parse(value)
  return RazorpayOrderDtoSchema.parse({
    providerMode,
    id: order.id,
    amountPaise: order.amount,
    amountPaidPaise: order.amount_paid,
    amountDuePaise: order.amount_due,
    currency: order.currency,
    receipt: order.receipt,
    status: order.status,
    attempts: order.attempts,
    offerId: order.offer_id ?? undefined,
    notes: parseNotes(order.notes),
    createdAtEpochSeconds: order.created_at,
  })
}

function paymentError(
  payment: z.output<typeof RawRazorpayPaymentSchema>,
): RazorpayPaymentDto['error'] {
  const error = {
    code: payment.error_code ?? undefined,
    description: payment.error_description ?? undefined,
    source: payment.error_source ?? undefined,
    step: payment.error_step ?? undefined,
    reason: payment.error_reason ?? undefined,
  }
  return Object.values(error).some((value) => value !== undefined)
    ? error
    : undefined
}

function normalizePayment(
  providerMode: ProviderMode,
  value: unknown,
): RazorpayPaymentDto {
  const payment = RawRazorpayPaymentSchema.parse(value)
  const providerEvidence = RazorpayPaymentProviderEvidenceSchema.parse({
    ...(payment.amount_refunded !== undefined
      ? { amountRefundedPaise: payment.amount_refunded }
      : {}),
    ...(payment.refund_status !== undefined
      ? {
          refundStatus: payment.refund_status === 'null'
            ? null
            : payment.refund_status,
        }
      : {}),
    ...(payment.amount_captured !== undefined
      ? { amountCapturedPaise: payment.amount_captured }
      : {}),
  })
  return RazorpayPaymentDtoSchema.parse({
    providerMode,
    id: payment.id,
    orderId: payment.order_id ?? undefined,
    subscriptionId: payment.subscription_id ?? undefined,
    invoiceId: payment.invoice_id ?? undefined,
    amountPaise: payment.amount,
    amountRefundedPaise: payment.amount_refunded ?? inrPaise(0),
    currency: payment.currency,
    status: payment.status,
    captured: payment.captured,
    method: payment.method,
    notes: parseNotes(payment.notes),
    providerEvidence,
    error: paymentError(payment),
    createdAtEpochSeconds: payment.created_at,
  })
}

function normalizeInvoice(
  providerMode: ProviderMode,
  value: unknown,
): RazorpayInvoiceDto {
  const invoice = RawRazorpayInvoiceSchema.parse(value)
  return RazorpayInvoiceDtoSchema.parse({
    providerMode,
    id: invoice.id,
    subscriptionId: invoice.subscription_id ?? undefined,
    paymentId: invoice.payment_id ?? undefined,
    orderId: invoice.order_id ?? undefined,
    status: invoice.status,
    amountPaise: invoice.amount,
    amountPaidPaise: invoice.amount_paid,
    amountDuePaise: invoice.amount_due,
    currency: invoice.currency,
    partialPayment: invoice.partial_payment,
    billingStartEpochSeconds: invoice.billing_start ?? undefined,
    billingEndEpochSeconds: invoice.billing_end ?? undefined,
    issuedAtEpochSeconds: invoice.issued_at ?? undefined,
    paidAtEpochSeconds: invoice.paid_at ?? undefined,
    createdAtEpochSeconds: invoice.created_at,
  })
}

function compareSubscriptionInvoices(
  left: RazorpayInvoiceDto,
  right: RazorpayInvoiceDto,
): number {
  const leftCycleStart = left.billingStartEpochSeconds
    ?? left.issuedAtEpochSeconds
    ?? left.createdAtEpochSeconds
  const rightCycleStart = right.billingStartEpochSeconds
    ?? right.issuedAtEpochSeconds
    ?? right.createdAtEpochSeconds
  const chronologicalOrder = leftCycleStart - rightCycleStart
    || left.createdAtEpochSeconds - right.createdAtEpochSeconds
  if (chronologicalOrder !== 0) return chronologicalOrder
  if (left.id === right.id) return 0
  return left.id < right.id ? -1 : 1
}

function normalizeRefund(
  providerMode: ProviderMode,
  value: unknown,
): RazorpayRefundDto {
  const refund = RawRazorpayRefundSchema.parse(value)
  return RazorpayRefundDtoSchema.parse({
    providerMode,
    id: refund.id,
    paymentId: refund.payment_id,
    amountPaise: refund.amount,
    currency: refund.currency,
    status: refund.status,
    createdAtEpochSeconds: refund.created_at,
  })
}

function normalizeDispute(
  providerMode: ProviderMode,
  value: unknown,
): RazorpayDisputeDto {
  const dispute = RawRazorpayDisputeSchema.parse(value)
  return RazorpayDisputeDtoSchema.parse({
    providerMode,
    id: dispute.id,
    paymentId: dispute.payment_id,
    amountPaise: dispute.amount,
    amountDeductedPaise: dispute.amount_deducted,
    currency: dispute.currency,
    reasonCode: dispute.reason_code,
    respondByEpochSeconds: dispute.respond_by,
    status: dispute.status,
    phase: dispute.phase,
    createdAtEpochSeconds: dispute.created_at,
  })
}

function normalizePlan(
  providerMode: ProviderMode,
  value: unknown,
): RazorpayPlanDto {
  const plan = RawRazorpayPlanSchema.parse(value)
  return RazorpayPlanDtoSchema.parse({
    providerMode,
    id: plan.id,
    period: plan.period,
    interval: plan.interval,
    item: {
      id: plan.item.id,
      name: plan.item.name,
      description: plan.item.description,
      amountPaise: plan.item.amount,
      currency: plan.item.currency,
      active: plan.item.active,
    },
    notes: parseNotes(plan.notes),
    createdAtEpochSeconds: plan.created_at,
  })
}

function normalizeSubscription(
  providerMode: ProviderMode,
  value: unknown,
): RazorpaySubscriptionDto {
  const subscription = RawRazorpaySubscriptionSchema.parse(value)
  return RazorpaySubscriptionDtoSchema.parse({
    providerMode,
    id: subscription.id,
    planId: subscription.plan_id,
    offerId: subscription.offer_id ?? undefined,
    customerId: subscription.customer_id ?? undefined,
    status: subscription.status,
    totalCount: subscription.total_count,
    paidCount: subscription.paid_count,
    remainingCount: subscription.remaining_count,
    currentStartEpochSeconds: subscription.current_start ?? undefined,
    currentEndEpochSeconds: subscription.current_end ?? undefined,
    startAtEpochSeconds: subscription.start_at ?? undefined,
    endAtEpochSeconds: subscription.end_at ?? undefined,
    chargeAtEpochSeconds: subscription.charge_at ?? undefined,
    authorizationExpiresAtEpochSeconds:
      subscription.expire_by ?? undefined,
    endedAtEpochSeconds: subscription.ended_at ?? undefined,
    hasScheduledChanges:
      subscription.has_scheduled_changes ?? undefined,
    scheduledChangeAtEpochSeconds:
      subscription.change_scheduled_at ?? undefined,
    notes: parseNotes(subscription.notes),
    createdAtEpochSeconds: subscription.created_at,
  })
}

function singleRecoveryMatch<T extends { id: string }>(
  matchesById: ReadonlyMap<string, T>,
  entityType: 'order' | 'subscription',
): T | null {
  if (matchesById.size > 1) {
    throw new RazorpayReconciliationConflictError(entityType)
  }
  return matchesById.values().next().value ?? null
}

function normalizeCustomer(
  providerMode: ProviderMode,
  value: unknown,
): RazorpayCustomerDto {
  const customer = RawRazorpayCustomerSchema.parse(value)
  return RazorpayCustomerDtoSchema.parse({
    providerMode,
    id: customer.id,
    name: customer.name,
    email: customer.email,
    contact: customer.contact === undefined
      ? undefined
      : String(customer.contact),
    gstin: customer.gstin ?? undefined,
    notes: parseNotes(customer.notes),
    createdAtEpochSeconds: customer.created_at,
  })
}

export function createRazorpayServerAdapter(input: {
  providerMode: ProviderMode
  sdk: RazorpaySdkPort
  offerReader?: RazorpayOfferReader
}): RazorpayServerAdapter {
  const providerMode = z.enum(PROVIDER_MODES).parse(input.providerMode)
  const { sdk, offerReader } = input

  return {
    providerMode,
    async createOrder(createInput) {
      const parsed = CreateRazorpayOrderInputSchema.parse(createInput)
      const payload: RazorpayOrderCreatePayload = {
        amount: parsed.amountPaise,
        currency: parsed.currency,
        receipt: parsed.receipt,
        notes: parsed.notes,
      }
      return normalizeOrder(providerMode, await sdk.orders.create(payload))
    },
    async findOrderByReceipt(receipt) {
      const exactReceipt = ReceiptSchema.parse(receipt)
      const page = RawRazorpayOrderCollectionSchema.refine(
        (collection) => (
          collection.count <= RAZORPAY_RECOVERY_MAX_PAGE_SIZE
        ),
        'Order recovery response exceeds requested page size',
      ).parse(await sdk.orders.all({
        receipt: exactReceipt,
        count: RAZORPAY_RECOVERY_MAX_PAGE_SIZE,
        skip: 0,
      }))
      const matches = new Map<string, RazorpayOrderDto>()
      for (const rawOrder of page.items) {
        const order = normalizeOrder(providerMode, rawOrder)
        if (order.receipt === exactReceipt) matches.set(order.id, order)
      }
      if (page.count === RAZORPAY_RECOVERY_MAX_PAGE_SIZE) {
        throw new RazorpayRecoveryScanLimitError('order')
      }
      return singleRecoveryMatch(matches, 'order')
    },
    async fetchOrder(orderId) {
      const parsedId = OrderIdSchema.parse(orderId)
      return normalizeOrder(providerMode, await sdk.orders.fetch(parsedId))
    },
    async fetchOrderPaymentAttempts(orderId) {
      const parsedId = OrderIdSchema.parse(orderId)
      const rawCollection = await sdk.orders.fetchPayments(parsedId)
      if (
        rawCollection !== null &&
        typeof rawCollection === 'object'
      ) {
        const untrusted = rawCollection as {
          count?: unknown
          items?: unknown
        }
        if (
          (
            typeof untrusted.count === 'number' &&
            untrusted.count > RAZORPAY_RECOVERY_MAX_PAGE_SIZE
          ) ||
          (
            Array.isArray(untrusted.items) &&
            untrusted.items.length > RAZORPAY_RECOVERY_MAX_PAGE_SIZE
          )
        ) {
          throw new RazorpayRecoveryScanLimitError('order')
        }
      }
      const collection = RawRazorpayPaymentCollectionSchema.refine(
        (value) => (
          value.count <= RAZORPAY_RECOVERY_MAX_PAGE_SIZE &&
          value.items.length <= RAZORPAY_RECOVERY_MAX_PAGE_SIZE &&
          value.count === value.items.length
        ),
        'Order payment-attempt response is inconsistent',
      ).parse(rawCollection)
      return collection.items.map((payment) => (
        normalizePayment(providerMode, payment)
      ))
    },
    async fetchPayment(paymentId) {
      const parsedId = PaymentIdSchema.parse(paymentId)
      return normalizePayment(
        providerMode,
        await sdk.payments.fetch(parsedId),
      )
    },
    async fetchInvoice(invoiceId) {
      const parsedId = InvoiceIdSchema.parse(invoiceId)
      return normalizeInvoice(
        providerMode,
        await sdk.invoices.fetch(parsedId),
      )
    },
    async fetchSubscriptionInvoices(subscriptionId) {
      const parsedId = CanonicalSubscriptionIdSchema.parse(subscriptionId)
      const listInvoices = sdk.invoices.all
      if (!listInvoices) {
        throw new RazorpaySdkCapabilityError(
          'Razorpay SDK does not expose subscription invoice enumeration',
        )
      }

      const invoicesById = new Map<string, RazorpayInvoiceDto>()
      let skip = 0

      while (skip <= RAZORPAY_SUBSCRIPTION_INVOICE_HARD_CAP) {
        const requestCount = Math.min(
          RAZORPAY_SUBSCRIPTION_INVOICE_PAGE_SIZE,
          RAZORPAY_SUBSCRIPTION_INVOICE_HARD_CAP - skip + 1,
        )
        const page = RawRazorpayInvoiceCollectionSchema.parse(
          await listInvoices({
            subscription_id: parsedId,
            count: requestCount,
            skip,
          }),
        )
        if (page.count > requestCount) {
          throw new RazorpaySubscriptionInvoiceCollectionError(
            'unexpected_page_size',
          )
        }

        for (const rawInvoice of page.items) {
          if (
            (
              rawInvoice.providerMode !== undefined &&
              rawInvoice.providerMode !== providerMode
            ) ||
            (
              rawInvoice.provider_mode !== undefined &&
              rawInvoice.provider_mode !== providerMode
            )
          ) {
            throw new RazorpayProviderEntityMismatchError(
              'Invoice reader returned data for a different provider mode',
            )
          }
          const invoice = normalizeInvoice(providerMode, rawInvoice)
          if (invoice.subscriptionId !== parsedId) {
            throw new RazorpayProviderEntityMismatchError(
              'Invoice reader returned an invoice for a different subscription',
            )
          }
          if (invoicesById.has(invoice.id)) {
            throw new RazorpaySubscriptionInvoiceCollectionError(
              'duplicate_invoice',
            )
          }
          if (
            invoicesById.size >= RAZORPAY_SUBSCRIPTION_INVOICE_HARD_CAP
          ) {
            throw new RazorpaySubscriptionInvoiceScanLimitError()
          }
          invoicesById.set(invoice.id, invoice)
        }

        if (page.count < requestCount) {
          return Array.from(invoicesById.values())
            .sort(compareSubscriptionInvoices)
        }
        skip += requestCount
      }

      throw new RazorpaySubscriptionInvoiceScanLimitError()
    },
    async fetchRefund(refundId) {
      const parsedId = RefundIdSchema.parse(refundId)
      if (!sdk.refunds) {
        throw new RazorpaySdkCapabilityError(
          'Razorpay SDK does not expose the Refunds read resource',
        )
      }
      const refund = normalizeRefund(
        providerMode,
        await sdk.refunds.fetch(parsedId),
      )
      if (refund.id !== parsedId) {
        throw new RazorpayProviderEntityMismatchError(
          'Refund reader returned a different refund identifier',
        )
      }
      return refund
    },
    async fetchDispute(disputeId) {
      const parsedId = DisputeIdSchema.parse(disputeId)
      if (!sdk.disputes) {
        throw new RazorpaySdkCapabilityError(
          'Razorpay SDK does not expose the Disputes read resource',
        )
      }
      const dispute = normalizeDispute(
        providerMode,
        await sdk.disputes.fetch(parsedId),
      )
      if (dispute.id !== parsedId) {
        throw new RazorpayProviderEntityMismatchError(
          'Dispute reader returned a different dispute identifier',
        )
      }
      return dispute
    },
    async createPlan(createInput) {
      const parsed = CreateRazorpayPlanInputSchema.parse(createInput)
      const payload: RazorpayPlanCreatePayload = {
        period: parsed.period,
        interval: parsed.interval,
        item: {
          name: parsed.name,
          amount: parsed.amountPaise,
          currency: parsed.currency,
        },
        notes: parsed.notes,
      }
      if (parsed.description !== undefined) {
        payload.item.description = parsed.description
      }
      return normalizePlan(providerMode, await sdk.plans.create(payload))
    },
    async fetchPlan(planId) {
      const parsedId = PlanIdSchema.parse(planId)
      return normalizePlan(providerMode, await sdk.plans.fetch(parsedId))
    },
    async fetchOffer(offerId) {
      const parsedId = OfferIdSchema.parse(offerId)
      if (!offerReader) {
        throw new RazorpaySdkCapabilityError(
          'razorpay@2.9.8 does not expose an Offers read resource',
        )
      }
      const terms = RazorpayOfferTermsSchema.parse(
        await offerReader.fetchOffer({
          providerMode,
          offerId: parsedId,
        }),
      )
      if (terms.id !== parsedId) {
        throw new RazorpayProviderEntityMismatchError(
          'Offer reader returned a different offer identifier',
        )
      }
      return RazorpayOfferDtoSchema.parse({
        providerMode,
        ...terms,
      })
    },
    async createSubscription(createInput) {
      const parsed = CreateRazorpaySubscriptionInputSchema.parse(createInput)
      const notes = RazorpayNotesSchema.parse({
        ...parsed.notes,
        checkout_receipt: parsed.receipt,
      })
      const payload: RazorpaySubscriptionCreatePayload = {
        plan_id: parsed.planId,
        total_count: parsed.totalCount,
        customer_notify: parsed.customerNotify,
        notes,
      }
      if (parsed.quantity !== undefined) {
        payload.quantity = parsed.quantity
      }
      if (parsed.offerId !== undefined) {
        payload.offer_id = parsed.offerId
      }
      if (parsed.upfrontItem !== undefined) {
        payload.addons = [{
          item: {
            name: parsed.upfrontItem.name,
            amount: parsed.upfrontItem.amountPaise,
            currency: parsed.upfrontItem.currency,
          },
        }]
      }
      if (parsed.startAtEpochSeconds !== undefined) {
        payload.start_at = parsed.startAtEpochSeconds
      }
      if (parsed.authorizationExpiresAtEpochSeconds !== undefined) {
        payload.expire_by =
          parsed.authorizationExpiresAtEpochSeconds
      }
      return normalizeSubscription(
        providerMode,
        await sdk.subscriptions.create(payload),
      )
    },
    async findSubscriptionByCheckoutReceipt(findInput) {
      const parsed = FindRazorpaySubscriptionByReceiptInputSchema
        .parse(findInput)
      const matches = new Map<string, RazorpaySubscriptionDto>()

      for (let pageIndex = 0; pageIndex < parsed.maxPages; pageIndex += 1) {
        const page = RawRazorpaySubscriptionCollectionSchema.refine(
          (collection) => collection.count <= parsed.pageSize,
          'Subscription recovery response exceeds requested page size',
        ).parse(await sdk.subscriptions.all({
          plan_id: parsed.expectedPlanId,
          from: parsed.fromEpochSeconds,
          to: parsed.toEpochSeconds,
          count: parsed.pageSize,
          skip: pageIndex * parsed.pageSize,
        }))

        for (const rawSubscription of page.items) {
          const subscription = normalizeSubscription(
            providerMode,
            rawSubscription,
          )
          if (
            subscription.planId === parsed.expectedPlanId &&
            subscription.notes.checkout_receipt === parsed.checkoutReceipt
          ) {
            matches.set(subscription.id, subscription)
          }
        }
        singleRecoveryMatch(matches, 'subscription')

        if (page.count < parsed.pageSize) {
          return singleRecoveryMatch(matches, 'subscription')
        }
      }
      throw new RazorpayRecoveryScanLimitError('subscription')
    },
    async fetchSubscription(subscriptionId) {
      const parsedId = SubscriptionIdSchema.parse(subscriptionId)
      return normalizeSubscription(
        providerMode,
        await sdk.subscriptions.fetch(parsedId),
      )
    },
    async createCustomer(createInput) {
      const parsed = CreateRazorpayCustomerInputSchema.parse(createInput)
      const payload: RazorpayCustomerCreatePayload = {
        name: parsed.name,
        fail_existing: parsed.failExisting,
        notes: parsed.notes,
      }
      if (parsed.email !== undefined) payload.email = parsed.email
      if (parsed.contact !== undefined) payload.contact = parsed.contact
      if (parsed.gstin !== undefined) payload.gstin = parsed.gstin
      return normalizeCustomer(
        providerMode,
        await sdk.customers.create(payload),
      )
    },
    async fetchCustomer(customerId) {
      const parsedId = CustomerIdSchema.parse(customerId)
      return normalizeCustomer(
        providerMode,
        await sdk.customers.fetch(parsedId),
      )
    },
  }
}

export const RAZORPAY_REFUND_COMMAND_PAGE_SIZE = 100 as const

const ApprovedRefundReceiptSchema = z.string()
  .regex(/^refund_[a-f0-9]{32}$/)

export const RazorpayRefundCommandInputSchema = z.object({
  paymentId: PaymentIdSchema,
  amountPaise: PositiveInrPaiseSchema,
  currency: z.literal('INR'),
  receipt: ApprovedRefundReceiptSchema,
}).strict()
export type RazorpayRefundCommandInput =
  z.input<typeof RazorpayRefundCommandInputSchema>

export interface RazorpayRefundCreateBody {
  amount: number
  speed: 'normal'
  receipt: string
}

export interface RazorpayRefundCommandTransport {
  listPaymentRefunds(input: {
    paymentId: string
    count: typeof RAZORPAY_REFUND_COMMAND_PAGE_SIZE
    skip: 0
  }): Promise<unknown>
  createRefund(input: {
    paymentId: string
    headers: {
      'X-Refund-Idempotency': string
    }
    body: RazorpayRefundCreateBody
  }): Promise<unknown>
}

export const RazorpayRefundCommandDtoSchema =
  RazorpayRefundDtoSchema.extend({
    receipt: ApprovedRefundReceiptSchema,
  }).strict()
export type RazorpayRefundCommandDto =
  z.output<typeof RazorpayRefundCommandDtoSchema>

export interface RazorpayRefundCommandResult {
  readonly source:
    | 'existing'
    | 'created'
    | 'recovered_after_create_error'
  readonly refund: RazorpayRefundCommandDto
}

export interface RazorpayRefundCommandAdapter {
  readonly providerMode: ProviderMode
  findExactRefund(
    input: RazorpayRefundCommandInput,
  ): Promise<RazorpayRefundCommandDto | null>
  submitOrRecoverRefund(
    input: RazorpayRefundCommandInput,
  ): Promise<RazorpayRefundCommandResult>
}

export type RazorpayRefundCommandConflictReason =
  | 'duplicate_refund_id'
  | 'duplicate_receipt'
  | 'receipt_binding_mismatch'
  | 'payment_binding_mismatch'

export class RazorpayRefundCommandConflictError extends Error {
  constructor(readonly reason: RazorpayRefundCommandConflictReason) {
    super(`Razorpay refund recovery conflict: ${reason}`)
    this.name = 'RazorpayRefundCommandConflictError'
  }
}

export class RazorpayRefundCommandScanLimitError extends Error {
  readonly count = RAZORPAY_REFUND_COMMAND_PAGE_SIZE

  constructor() {
    super('Razorpay refund recovery reached the bounded page limit')
    this.name = 'RazorpayRefundCommandScanLimitError'
  }
}

export class RazorpayRefundCommandEvidenceError extends Error {
  constructor(
    readonly reason:
      | 'malformed_collection'
      | 'malformed_create_response',
  ) {
    super(`Razorpay refund evidence is invalid: ${reason}`)
    this.name = 'RazorpayRefundCommandEvidenceError'
  }
}

export class RazorpayRefundOutcomeUnknownError extends Error {
  readonly providerMode: ProviderMode
  readonly paymentId: string
  readonly receipt: string

  constructor(input: {
    providerMode: ProviderMode
    paymentId: string
    receipt: string
  }) {
    super(
      'Razorpay refund creation outcome is unknown after exact recovery',
    )
    this.name = 'RazorpayRefundOutcomeUnknownError'
    this.providerMode = input.providerMode
    this.paymentId = input.paymentId
    this.receipt = input.receipt
  }
}

const RawRazorpayRefundCommandSchema =
  RawRazorpayRefundSchema.extend({
    receipt: z.string().trim().min(1).max(255).nullish(),
  }).passthrough()

const RawRazorpayRefundCommandCollectionSchema = z.object({
  entity: z.literal('collection'),
  count: SafeNonNegativeIntegerSchema.max(
    RAZORPAY_REFUND_COMMAND_PAGE_SIZE,
  ),
  items: z.array(RawRazorpayRefundCommandSchema)
    .max(RAZORPAY_REFUND_COMMAND_PAGE_SIZE),
}).strict().superRefine((collection, context) => {
  if (collection.count !== collection.items.length) {
    context.addIssue({
      code: 'custom',
      path: ['count'],
      message: 'Refund collection count must equal returned item count',
    })
  }
})

function exactRefundCommandEntity(
  providerMode: ProviderMode,
  input: z.output<typeof RazorpayRefundCommandInputSchema>,
  raw: z.output<typeof RawRazorpayRefundCommandSchema>,
): RazorpayRefundCommandDto {
  if (raw.payment_id !== input.paymentId) {
    throw new RazorpayRefundCommandConflictError(
      'payment_binding_mismatch',
    )
  }
  if (
    raw.receipt !== input.receipt ||
    raw.amount !== input.amountPaise ||
    raw.currency !== input.currency
  ) {
    throw new RazorpayRefundCommandConflictError(
      'receipt_binding_mismatch',
    )
  }
  return RazorpayRefundCommandDtoSchema.parse({
    providerMode,
    id: raw.id,
    paymentId: raw.payment_id,
    amountPaise: raw.amount,
    currency: raw.currency,
    status: raw.status,
    createdAtEpochSeconds: raw.created_at,
    receipt: raw.receipt,
  })
}

function reviewRequiredRefundCommandError(error: unknown): boolean {
  return (
    error instanceof RazorpayRefundCommandConflictError ||
    error instanceof RazorpayRefundCommandScanLimitError
  )
}

/**
 * A destructive refund capability kept separate from the broad read/create
 * adapter. The transport must support the Razorpay-specific idempotency
 * header; the installed SDK's refund helper cannot carry that header.
 */
export function createRazorpayRefundCommandAdapter(input: {
  providerMode: ProviderMode
  transport: RazorpayRefundCommandTransport
}): RazorpayRefundCommandAdapter {
  const providerMode = z.enum(PROVIDER_MODES).parse(input.providerMode)
  const { transport } = input

  async function findExactRefund(
    rawInput: RazorpayRefundCommandInput,
  ): Promise<RazorpayRefundCommandDto | null> {
    const command = RazorpayRefundCommandInputSchema.parse(rawInput)
    let collection: z.output<
      typeof RawRazorpayRefundCommandCollectionSchema
    >
    try {
      collection = RawRazorpayRefundCommandCollectionSchema.parse(
        await transport.listPaymentRefunds({
          paymentId: command.paymentId,
          count: RAZORPAY_REFUND_COMMAND_PAGE_SIZE,
          skip: 0,
        }),
      )
    } catch (error) {
      if (error instanceof RazorpayRefundCommandConflictError) throw error
      throw new RazorpayRefundCommandEvidenceError(
        'malformed_collection',
      )
    }

    const ids = new Set<string>()
    for (const refund of collection.items) {
      if (ids.has(refund.id)) {
        throw new RazorpayRefundCommandConflictError(
          'duplicate_refund_id',
        )
      }
      ids.add(refund.id)
      if (refund.payment_id !== command.paymentId) {
        throw new RazorpayRefundCommandConflictError(
          'payment_binding_mismatch',
        )
      }
    }
    if (collection.count === RAZORPAY_REFUND_COMMAND_PAGE_SIZE) {
      throw new RazorpayRefundCommandScanLimitError()
    }

    const receiptMatches = collection.items.filter(
      (refund) => refund.receipt === command.receipt,
    )
    if (receiptMatches.length > 1) {
      throw new RazorpayRefundCommandConflictError(
        'duplicate_receipt',
      )
    }
    const match = receiptMatches[0]
    return match
      ? exactRefundCommandEntity(providerMode, command, match)
      : null
  }

  return {
    providerMode,
    findExactRefund,
    async submitOrRecoverRefund(rawInput) {
      const command = RazorpayRefundCommandInputSchema.parse(rawInput)
      const existing = await findExactRefund(command)
      if (existing) {
        return Object.freeze({
          source: 'existing',
          refund: existing,
        })
      }

      try {
        const body: RazorpayRefundCreateBody = {
          amount: command.amountPaise,
          speed: 'normal',
          receipt: command.receipt,
        }
        const rawCreated = await transport.createRefund({
          paymentId: command.paymentId,
          headers: {
            'X-Refund-Idempotency': command.receipt,
          },
          body,
        })
        let created: z.output<typeof RawRazorpayRefundCommandSchema>
        try {
          created = RawRazorpayRefundCommandSchema.parse(rawCreated)
        } catch {
          throw new RazorpayRefundCommandEvidenceError(
            'malformed_create_response',
          )
        }
        return Object.freeze({
          source: 'created',
          refund: exactRefundCommandEntity(
            providerMode,
            command,
            created,
          ),
        })
      } catch {
        try {
          const recovered = await findExactRefund(command)
          if (recovered) {
            return Object.freeze({
              source: 'recovered_after_create_error',
              refund: recovered,
            })
          }
        } catch (recoveryError) {
          if (reviewRequiredRefundCommandError(recoveryError)) {
            throw recoveryError
          }
          throw new RazorpayRefundOutcomeUnknownError({
            providerMode,
            paymentId: command.paymentId,
            receipt: command.receipt,
          })
        }
        throw new RazorpayRefundOutcomeUnknownError({
          providerMode,
          paymentId: command.paymentId,
          receipt: command.receipt,
        })
      }
    },
  }
}
