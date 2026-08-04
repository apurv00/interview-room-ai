import { z } from 'zod'
import {
  EXISTING_SUBSCRIPTION_TREATMENTS,
  type CatalogContent,
} from '../types/catalog'

const DurationSchema = z.union([
  z.literal(10),
  z.literal(20),
  z.literal(30),
])

const ProviderBindingSchema = z.object({
  test: z.string().trim().min(4).max(100).optional(),
  live: z.string().trim().min(4).max(100).optional(),
}).strict()

const InterviewTermsSchema = z.object({
  includedPerPeriod: z.number().int().min(1).max(10_000),
  periodOwner: z.enum(['calendar_month', 'razorpay_billing_cycle']),
  maxDurationMinutes: DurationSchema,
  supportedDurationsMinutes: z.array(DurationSchema).min(1).max(3),
  analysisAndReplayIncluded: z.literal(true),
}).strict().superRefine((interview, context) => {
  const unique = new Set(interview.supportedDurationsMinutes)
  if (unique.size !== interview.supportedDurationsMinutes.length) {
    context.addIssue({
      code: 'custom',
      path: ['supportedDurationsMinutes'],
      message: 'Supported durations must be unique',
    })
  }
  if (!unique.has(interview.maxDurationMinutes)) {
    context.addIssue({
      code: 'custom',
      path: ['supportedDurationsMinutes'],
      message: 'Supported durations must include the maximum duration',
    })
  }
  if (
    interview.supportedDurationsMinutes.some(
      (duration) => duration > interview.maxDurationMinutes,
    )
  ) {
    context.addIssue({
      code: 'custom',
      path: ['supportedDurationsMinutes'],
      message: 'A supported duration cannot exceed the maximum duration',
    })
  }
})

const ResumeTermsSchema = z.object({
  basicSavedResumeLimit: z.literal(1),
  premiumSavedResumeLimitPerPeriod: z.number().int().min(0).max(10_000),
}).strict()

function planSchema(
  key: 'free' | 'plus' | 'pro',
  displayName: 'Basic' | 'Plus' | 'Pro',
) {
  return z.object({
    key: z.literal(key),
    displayName: z.literal(displayName),
    listPricePaise: key === 'free'
      ? z.literal(0)
      : z.number().int().positive().max(10_000_000),
    billingPeriod: z.literal(key === 'free' ? 'none' : 'monthly'),
    interview: InterviewTermsSchema,
    resume: ResumeTermsSchema,
    razorpayPlanIdByMode: key === 'free'
      ? z.never().optional()
      : ProviderBindingSchema.optional(),
  }).strict().superRefine((plan, context) => {
    const expectedOwner = key === 'free'
      ? 'calendar_month'
      : 'razorpay_billing_cycle'
    if (plan.interview.periodOwner !== expectedOwner) {
      context.addIssue({
        code: 'custom',
        path: ['interview', 'periodOwner'],
        message: `${displayName} must use ${expectedOwner}`,
      })
    }
    if (
      key === 'free' &&
      (
        plan.interview.includedPerPeriod !== 1 ||
        plan.interview.maxDurationMinutes !== 10 ||
        plan.interview.supportedDurationsMinutes.length !== 1 ||
        plan.interview.supportedDurationsMinutes[0] !== 10 ||
        plan.resume.basicSavedResumeLimit !== 1 ||
        plan.resume.premiumSavedResumeLimitPerPeriod !== 0
      )
    ) {
      context.addIssue({
        code: 'custom',
        path: ['interview'],
        message:
          'Basic terms are fixed at one 10-minute interview and one basic resume',
      })
    }
  })
}

export const CatalogContentSchema = z.object({
  schemaVersion: z.number().int().positive(),
  entitlementPolicyVersion: z.string().trim().min(1).max(200),
  currency: z.literal('INR'),
  gstInclusive: z.literal(true),
  gstRatePercent: z.literal(18),
  plans: z.object({
    free: planSchema('free', 'Basic'),
    plus: planSchema('plus', 'Plus'),
    pro: planSchema('pro', 'Pro'),
  }).strict(),
  oneTimeProducts: z.object({
    single_interview: z.object({
      key: z.literal('single_interview'),
      displayName: z.string().trim().min(1).max(100),
      listPricePaise: z.number().int().positive().max(10_000_000),
      billing: z.literal('one_time'),
      couponEligible: z.literal(false),
      entitlement: z.object({
        interviews: z.literal(1),
        maxDurationMinutes: z.literal(30),
        supportedDurationsMinutes: z.array(DurationSchema).min(1).max(3),
        validityDaysBeforeUse: z.number().int().positive().max(365),
        analysisAndReplayIncluded: z.literal(true),
      }).strict(),
    }).strict(),
    premium_resume: z.object({
      key: z.literal('premium_resume'),
      displayName: z.string().trim().min(1).max(100),
      listPricePaise: z.number().int().positive().max(10_000_000),
      billing: z.literal('one_time'),
      couponEligible: z.literal(false),
      entitlement: z.object({
        premiumSavedResumeVersions: z.literal(1),
        revisionWindowDays: z.number().int().positive().max(365),
        revisionWindowStartsAt: z.literal('first_successful_render'),
      }).strict(),
    }).strict(),
  }).strict(),
  existingSubscriptionTreatment: z.enum(EXISTING_SUBSCRIPTION_TREATMENTS),
}).strict()

export const CreateCatalogDraftSchema = z.object({
  mutationId: z.string().trim().min(1).max(200),
  correlationId: z.string().trim().min(1).max(200),
  reason: z.string().trim().min(10).max(2000),
  content: CatalogContentSchema.optional(),
  sourceVersion: z.string().trim().min(1).max(200).optional(),
}).strict()

export const UpdateCatalogDraftSchema = z.object({
  mutationId: z.string().trim().min(1).max(200),
  correlationId: z.string().trim().min(1).max(200),
  expectedRevision: z.number().int().min(0),
  reason: z.string().trim().min(10).max(2000),
  content: CatalogContentSchema,
}).strict()

export const CatalogWorkflowActionSchema = z.object({
  mutationId: z.string().trim().min(1).max(200),
  correlationId: z.string().trim().min(1).max(200),
  expectedRevision: z.number().int().min(0),
  reason: z.string().trim().min(10).max(2000),
  confirmation: z.string().trim().min(1).max(300).optional(),
  effectiveAt: z.coerce.date().optional(),
  providerMode: z.enum(['test', 'live']).optional(),
}).strict()

export type CatalogContentInput = z.input<typeof CatalogContentSchema>
export type CatalogContentOutput =
  z.output<typeof CatalogContentSchema> & CatalogContent
export type CreateCatalogDraftInput =
  z.infer<typeof CreateCatalogDraftSchema>
export type UpdateCatalogDraftInput =
  z.infer<typeof UpdateCatalogDraftSchema>
export type CatalogWorkflowActionInput =
  z.infer<typeof CatalogWorkflowActionSchema>
