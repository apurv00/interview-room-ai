import { z } from 'zod'
import {
  COUPON_CAMPAIGN_MODES,
  COUPON_SEGMENTS,
  COUPON_VISIBILITY_SURFACES,
} from '../types/catalog'

const DiscountPaiseSchema = z.union([
  z.literal(5000),
  z.literal(10000),
  z.literal(15000),
  z.literal(20000),
])

export const CouponRevisionTermsSchema = z.object({
  discountPaise: DiscountPaiseSchema,
  applicablePlanKeys: z.array(z.enum(['plus', 'pro'])).min(1).max(2),
  discountedBillingCycles: z.number().int().min(1).max(12).default(1),
  razorpayOfferIdByMode: z.object({
    test: z.string().trim().min(4).max(100).optional(),
    live: z.string().trim().min(4).max(100).optional(),
  }).strict().default({}),
  startsAt: z.coerce.date().optional(),
  endsAt: z.coerce.date().optional(),
  priority: z.number().int().min(-10_000).max(10_000).default(0),
  eligibility: z.object({
    newCustomerOnly: z.boolean().default(false),
    userIds: z.array(z.string().regex(/^[a-f\d]{24}$/i)).max(10_000).default([]),
    segments: z.array(z.enum(COUPON_SEGMENTS)).max(COUPON_SEGMENTS.length)
      .default([]),
    acquisitionSources: z.array(z.string().trim().min(1).max(100))
      .max(100)
      .default([]),
    upgradesEligible: z.boolean().default(false),
  }).strict().default({
    newCustomerOnly: false,
    userIds: [],
    segments: [],
    acquisitionSources: [],
    upgradesEligible: false,
  }),
  maxRedemptions: z.number().int().positive().max(10_000_000).optional(),
  maxRedemptionsPerUser: z.number().int().positive().max(100).default(1),
  minPayablePaiseByPlan: z.object({
    plus: z.number().int().min(0).optional(),
    pro: z.number().int().min(0).optional(),
  }).strict().default({}),
  reservationTtlHours: z.number().int().min(1).max(168).default(24),
  visibility: z.array(z.enum(COUPON_VISIBILITY_SURFACES))
    .max(COUPON_VISIBILITY_SURFACES.length)
    .default([]),
  bannerText: z.string().trim().min(1).max(300).optional(),
  termsText: z.string().trim().min(10).max(2000),
  holdoutBps: z.number().int().min(0).max(10_000).optional(),
}).strict().superRefine((terms, context) => {
  if (new Set(terms.applicablePlanKeys).size !== terms.applicablePlanKeys.length) {
    context.addIssue({
      code: 'custom',
      path: ['applicablePlanKeys'],
      message: 'Applicable plans must be unique',
    })
  }
  if (terms.startsAt && terms.endsAt && terms.endsAt <= terms.startsAt) {
    context.addIssue({
      code: 'custom',
      path: ['endsAt'],
      message: 'Coupon end must be after its start',
    })
  }
})

export const CouponCodeSchema = z.string()
  .trim()
  .min(3)
  .max(40)
  .transform((value) => value.toUpperCase())
  .pipe(z.string().regex(/^[A-Z0-9][A-Z0-9_-]*$/))

export const CreateCouponCampaignSchema = z.object({
  mutationId: z.string().trim().min(1).max(200),
  correlationId: z.string().trim().min(1).max(200),
  reason: z.string().trim().min(10).max(2000),
  key: z.string().trim().regex(/^[a-z0-9][a-z0-9_-]{2,79}$/),
  name: z.string().trim().min(3).max(160),
  mode: z.enum(COUPON_CAMPAIGN_MODES),
  code: CouponCodeSchema.optional(),
  terms: CouponRevisionTermsSchema,
}).strict().superRefine((campaign, context) => {
  if (campaign.mode === 'code' && !campaign.code) {
    context.addIssue({
      code: 'custom',
      path: ['code'],
      message: 'Code campaigns require a coupon code',
    })
  }
  if (campaign.mode !== 'code' && campaign.code) {
    context.addIssue({
      code: 'custom',
      path: ['code'],
      message: 'Only code campaigns can define a coupon code',
    })
  }
})

export const UpdateCouponRevisionSchema = z.object({
  mutationId: z.string().trim().min(1).max(200),
  correlationId: z.string().trim().min(1).max(200),
  expectedEditRevision: z.number().int().min(0),
  reason: z.string().trim().min(10).max(2000),
  terms: CouponRevisionTermsSchema,
}).strict()

export const CouponWorkflowActionSchema = z.object({
  mutationId: z.string().trim().min(1).max(200),
  correlationId: z.string().trim().min(1).max(200),
  expectedEditRevision: z.number().int().min(0),
  reason: z.string().trim().min(10).max(2000),
  confirmation: z.string().trim().min(1).max(300).optional(),
  providerMode: z.enum(['test', 'live']).optional(),
}).strict()

export const CouponCatalogBoundActionSchema =
  CouponWorkflowActionSchema.extend({
    catalogVersion: z.string().trim().min(1).max(200),
    providerMode: z.enum(['test', 'live']),
  }).strict()

export type CouponRevisionTermsInput =
  z.infer<typeof CouponRevisionTermsSchema>
export type CreateCouponCampaignInput =
  z.infer<typeof CreateCouponCampaignSchema>
export type UpdateCouponRevisionInput =
  z.infer<typeof UpdateCouponRevisionSchema>
export type CouponWorkflowActionInput =
  z.infer<typeof CouponWorkflowActionSchema>
export type CouponCatalogBoundActionInput =
  z.infer<typeof CouponCatalogBoundActionSchema>
