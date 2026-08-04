import { z } from 'zod'
import {
  COUPON_VISIBILITY_SURFACES,
} from '../types/catalog'
import { CouponCodeSchema } from './coupon'

export const BILLING_QUOTE_SURFACES = COUPON_VISIBILITY_SURFACES
export type BillingQuoteSurface =
  (typeof BILLING_QUOTE_SURFACES)[number]

const ObjectIdSchema = z.string().regex(
  /^[a-f\d]{24}$/i,
  'Expected a MongoDB ObjectId',
)

/**
 * The quote endpoint accepts one commercial target only. Prices, catalog
 * versions, eligibility attributes, user identity, and entitlement values are
 * deliberately absent because the server owns all of them.
 */
export const CustomerBillingQuoteRequestSchema = z.object({
  planKey: z.enum(['plus', 'pro']).optional(),
  sku: z.enum(['single_interview', 'premium_resume']).optional(),
  surface: z.enum(BILLING_QUOTE_SURFACES),
  manualCouponCode: CouponCodeSchema.optional(),
}).strict().superRefine((request, context) => {
  const selectedTargets = Number(request.planKey !== undefined) +
    Number(request.sku !== undefined)
  if (selectedTargets !== 1) {
    context.addIssue({
      code: 'custom',
      path: ['planKey'],
      message: 'Select exactly one planKey or sku',
    })
  }
  if (request.sku !== undefined && request.manualCouponCode !== undefined) {
    context.addIssue({
      code: 'custom',
      path: ['manualCouponCode'],
      message: 'One-time products are not coupon eligible',
    })
  }
})
export type CustomerBillingQuoteRequest = z.output<
  typeof CustomerBillingQuoteRequestSchema
>

/**
 * The idempotency key is supplied in the `Idempotency-Key` header. Keeping it
 * outside the JSON request avoids accidental reuse when a client changes the
 * commercial selection.
 */
export const CustomerBillingIdempotencyKeySchema = z.string()
  .trim()
  .min(8)
  .max(100)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._:-]*$/,
    'Idempotency-Key contains unsupported characters',
  )

export const SubscriptionCheckoutRequestSchema = z.object({
  planKey: z.enum(['plus', 'pro']),
  manualCouponCode: CouponCodeSchema.optional(),
}).strict()

export const SubscriptionPlanChangeRequestSchema = z.discriminatedUnion(
  'action',
  [
    z.object({
      action: z.literal('schedule'),
      targetPlanKey: z.enum(['plus', 'pro']),
      manualCouponCode: CouponCodeSchema.optional(),
    }).strict(),
    z.object({
      action: z.literal('cancel_scheduled'),
      planChangeRequestId: ObjectIdSchema,
    }).strict(),
  ],
)

export const SubscriptionPeriodEndCancellationRequestSchema = z.object({
  confirmPeriodEnd: z.literal(true),
}).strict()

export const SubscriptionResubscribeRequestSchema = z.object({
  manualCouponCode: CouponCodeSchema.optional(),
}).strict()

/**
 * Order routes identify the SKU in the URL. An empty strict object makes it
 * impossible for a browser to submit an amount, user, or entitlement override.
 */
export const OneTimeOrderRequestSchema = z.object({}).strict()

const RazorpayPaymentIdSchema = z.string()
  .trim()
  .regex(/^pay_[A-Za-z0-9]+$/)
  .max(128)

const RazorpayCheckoutSignatureSchema = z.string()
  .trim()
  .regex(/^[a-fA-F0-9]{64}$/)

const CheckoutVerificationRequestBaseSchema = z.object({
  intentId: ObjectIdSchema,
  razorpayPaymentId: RazorpayPaymentIdSchema,
  razorpaySignature: RazorpayCheckoutSignatureSchema,
}).strict()

/**
 * The callback does not accept a Razorpay Order ID or Subscription ID. The
 * verifier must load that identifier from the trusted local CheckoutIntent.
 */
export const OrderCheckoutVerificationRequestSchema =
  CheckoutVerificationRequestBaseSchema

export const SubscriptionCheckoutVerificationRequestSchema =
  CheckoutVerificationRequestBaseSchema

export const BillingIntentIdSchema = ObjectIdSchema
