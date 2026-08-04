import type {
  AllowedCouponDiscountPaise,
  PaidPersonalPlanKey,
  SupportedInterviewDurationMinutes,
} from '@shared/services/planConfig'

export const CATALOG_STATUSES = [
  'draft',
  'scheduled',
  'published',
  'archived',
] as const
export type CatalogStatus = (typeof CATALOG_STATUSES)[number]

export const EXISTING_SUBSCRIPTION_TREATMENTS = [
  'grandfather',
  'migrate_at_renewal',
  'customer_opt_in',
] as const
export type ExistingSubscriptionTreatment =
  (typeof EXISTING_SUBSCRIPTION_TREATMENTS)[number]

export const PROVIDER_MODES = ['test', 'live'] as const
export type ProviderMode = (typeof PROVIDER_MODES)[number]

export interface ProviderPlanBinding {
  test?: string
  live?: string
}

export interface CatalogPlanTerms {
  key: 'free' | PaidPersonalPlanKey
  displayName: 'Basic' | 'Plus' | 'Pro'
  listPricePaise: number
  billingPeriod: 'none' | 'monthly'
  interview: {
    includedPerPeriod: number
    periodOwner: 'calendar_month' | 'razorpay_billing_cycle'
    maxDurationMinutes: SupportedInterviewDurationMinutes
    supportedDurationsMinutes: SupportedInterviewDurationMinutes[]
    analysisAndReplayIncluded: true
  }
  resume: {
    basicSavedResumeLimit: 1
    premiumSavedResumeLimitPerPeriod: number
  }
  razorpayPlanIdByMode?: ProviderPlanBinding
}

export interface CatalogContent {
  schemaVersion: number
  entitlementPolicyVersion: string
  currency: 'INR'
  gstInclusive: true
  gstRatePercent: 18
  plans: {
    free: CatalogPlanTerms
    plus: CatalogPlanTerms
    pro: CatalogPlanTerms
  }
  oneTimeProducts: {
    single_interview: {
      key: 'single_interview'
      displayName: string
      listPricePaise: number
      billing: 'one_time'
      couponEligible: false
      entitlement: {
        interviews: 1
        maxDurationMinutes: 30
        supportedDurationsMinutes: SupportedInterviewDurationMinutes[]
        validityDaysBeforeUse: number
        analysisAndReplayIncluded: true
      }
    }
    premium_resume: {
      key: 'premium_resume'
      displayName: string
      listPricePaise: number
      billing: 'one_time'
      couponEligible: false
      entitlement: {
        premiumSavedResumeVersions: 1
        revisionWindowDays: number
        revisionWindowStartsAt: 'first_successful_render'
      }
    }
  }
  existingSubscriptionTreatment: ExistingSubscriptionTreatment
}

export interface CatalogValidationSnapshot {
  contentHash: string
  errors: string[]
  warnings: string[]
  validatedBy: string
  validatedAt: Date
}

export interface CatalogApprovalSnapshot {
  contentHash: string
  approvedBy: string
  approvedAt: Date
}

export interface ProviderVerificationSnapshot {
  status: 'unavailable' | 'verified' | 'failed'
  fetchedAt: Date
  normalizedTermsHash?: string
  errors: string[]
}

export const COUPON_PROVIDER_VERIFICATION_MAX_AGE_MS = 15 * 60 * 1000

export const COUPON_POLICY_APPROVAL_KINDS = [
  'economics',
  'extended_cycles',
] as const
export type CouponPolicyApprovalKind =
  (typeof COUPON_POLICY_APPROVAL_KINDS)[number]

export interface CouponPolicyApprovalSnapshot {
  kind: CouponPolicyApprovalKind
  couponContentHash: string
  catalogVersion: string
  catalogContentHash: string
  providerMode: ProviderMode
  approvedBy: string
  approvedAt: Date
  reason: string
}

export interface CouponValidationSnapshot extends CatalogValidationSnapshot {
  catalogVersion: string
  catalogContentHash: string
  providerMode: ProviderMode
  requiredPolicyApprovals: CouponPolicyApprovalKind[]
}

export const COUPON_CAMPAIGN_MODES = [
  'automatic',
  'code',
  'targeted',
] as const
export type CouponCampaignMode = (typeof COUPON_CAMPAIGN_MODES)[number]

export const COUPON_REVISION_STATUSES = [
  'draft',
  'scheduled',
  'active',
  'paused',
  'expired',
] as const
export type CouponRevisionStatus =
  (typeof COUPON_REVISION_STATUSES)[number]

export const COUPON_SEGMENTS = [
  'waitlist',
  'student',
  'winback',
  'partner',
  'all',
] as const
export type CouponSegment = (typeof COUPON_SEGMENTS)[number]

export const COUPON_VISIBILITY_SURFACES = [
  'pricing',
  'checkout',
  'interviewPaywall',
  'feedback',
  'resume',
] as const
export type CouponVisibilitySurface =
  (typeof COUPON_VISIBILITY_SURFACES)[number]

export interface CouponRevisionTerms {
  discountPaise: AllowedCouponDiscountPaise
  applicablePlanKeys: PaidPersonalPlanKey[]
  discountedBillingCycles: number
  razorpayOfferIdByMode: ProviderPlanBinding
  startsAt?: Date
  endsAt?: Date
  priority: number
  eligibility: {
    newCustomerOnly: boolean
    userIds: string[]
    segments: CouponSegment[]
    acquisitionSources: string[]
    upgradesEligible: boolean
  }
  maxRedemptions?: number
  maxRedemptionsPerUser: number
  minPayablePaiseByPlan: Partial<Record<PaidPersonalPlanKey, number>>
  reservationTtlHours: number
  visibility: CouponVisibilitySurface[]
  bannerText?: string
  termsText: string
  holdoutBps?: number
}
