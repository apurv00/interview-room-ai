/**
 * Consumer billing contract.
 *
 * This is the product contract for the Razorpay implementation, not the
 * currently enforced runtime plan configuration. Until BillingConfig enables
 * the new entitlement system, legacy callers must continue to use
 * `shared/services/stripe.ts`.
 */

export const PERSONAL_PLAN_KEYS = ['free', 'plus', 'pro'] as const
export type PersonalPlanKey = (typeof PERSONAL_PLAN_KEYS)[number]

export const PAID_PERSONAL_PLAN_KEYS = ['plus', 'pro'] as const
export type PaidPersonalPlanKey = (typeof PAID_PERSONAL_PLAN_KEYS)[number]

/**
 * `enterprise` is retained only while legacy personal rows and JWTs are
 * inventoried. Organization billing has its own unrelated Enterprise tier.
 */
export const LEGACY_STORED_PLAN_KEYS = ['free', 'plus', 'pro', 'enterprise'] as const
export type LegacyStoredPlanKey = (typeof LEGACY_STORED_PLAN_KEYS)[number]

export const ONE_TIME_PRODUCT_SKUS = ['single_interview', 'premium_resume'] as const
export type OneTimeProductSku = (typeof ONE_TIME_PRODUCT_SKUS)[number]

export type BillingProductKey = PersonalPlanKey | OneTimeProductSku

/**
 * One coordinated customer-surface switch. Keep this false until the PR6
 * activation checklist (replica-set snapshots, profile writes, payment
 * policies, provider QA, and browser/device verification) is complete.
 *
 * This lives in the client-safe plan contract so pricing/settings and the
 * server catalog cannot drift onto different rollout states.
 */
export const PR6_CUSTOMER_BILLING_UI_READY = true as const
export const PR6_CUSTOMER_TIER_OPERATION_READ_UI_READY =
  false as const
export const PR6_CUSTOMER_TIER_OPERATION_DECISION_UI_READY =
  false as const
export const CMS_TIER_OPERATION_READ_UI_READY =
  false as const
export const CMS_TIER_OPERATION_MUTATION_UI_READY =
  false as const

export const SUPPORTED_INTERVIEW_DURATIONS_MINUTES = [10, 20, 30] as const
export type SupportedInterviewDurationMinutes =
  (typeof SUPPORTED_INTERVIEW_DURATIONS_MINUTES)[number]

export const CURRENT_PLAN_VOCABULARY_VERSION = 2 as const
export type PlanVocabularyVersion = 1 | typeof CURRENT_PLAN_VOCABULARY_VERSION

export interface PlanDefinition {
  key: PersonalPlanKey
  displayName: 'Basic' | 'Plus' | 'Pro'
  listPricePaise: number
  billingPeriod: 'none' | 'monthly'
  interview: {
    includedPerPeriod: number
    periodOwner: 'calendar_month' | 'razorpay_billing_cycle'
    maxDurationMinutes: SupportedInterviewDurationMinutes
    supportedDurationsMinutes: readonly SupportedInterviewDurationMinutes[]
    analysisAndReplayIncluded: true
  }
  resume: {
    basicSavedResumeLimit: 1
    premiumSavedResumeLimitPerPeriod: number
  }
}

export interface SingleInterviewDefinition {
  key: 'single_interview'
  displayName: 'Additional interview'
  listPricePaise: 6900
  billing: 'one_time'
  couponEligible: false
  entitlement: {
    interviews: 1
    maxDurationMinutes: 30
    supportedDurationsMinutes: readonly SupportedInterviewDurationMinutes[]
    validityDaysBeforeUse: 30
    analysisAndReplayIncluded: true
  }
}

export interface PremiumResumeDefinition {
  key: 'premium_resume'
  displayName: 'Premium resume unlock'
  listPricePaise: 2900
  billing: 'one_time'
  couponEligible: false
  entitlement: {
    premiumSavedResumeVersions: 1
    revisionWindowDays: 7
    revisionWindowStartsAt: 'first_successful_render'
  }
}

export interface ConsumerCatalogV1 {
  schemaVersion: 1
  catalogVersion: string
  entitlementPolicyVersion: string
  currency: 'INR'
  gstInclusive: true
  gstRatePercent: 18
  plans: Readonly<Record<PersonalPlanKey, PlanDefinition>>
  oneTimeProducts: Readonly<{
    single_interview: SingleInterviewDefinition
    premium_resume: PremiumResumeDefinition
  }>
}

export const ALLOWED_COUPON_DISCOUNTS_PAISE = [5000, 10000, 15000, 20000] as const
export type AllowedCouponDiscountPaise =
  (typeof ALLOWED_COUPON_DISCOUNTS_PAISE)[number]

export interface LaunchCouponPolicy {
  allowedDiscountsPaise: readonly AllowedCouponDiscountPaise[]
  couponsStack: false
  defaultDiscountedBillingCycles: 1
  plans: Readonly<Record<PaidPersonalPlanKey, {
    defaultAutomaticDiscountPaise: AllowedCouponDiscountPaise
    defaultFirstCyclePayablePaise: number
    minimumPayablePaise: number
    unitEconomicsApprovalBelowPaise?: number
  }>>
  oneTimeProductsCouponEligible: false
}

type Primitive = string | number | boolean | bigint | symbol | null | undefined
export type DeepReadonly<T> =
  T extends Primitive | ((...args: never[]) => unknown)
    ? T
    : T extends readonly (infer Item)[]
      ? readonly DeepReadonly<Item>[]
      : { readonly [Key in keyof T]: DeepReadonly<T[Key]> }

function deepFreeze<T extends object>(value: T): DeepReadonly<T> {
  Object.freeze(value)
  for (const nested of Object.values(value)) {
    if (nested !== null && typeof nested === 'object' && !Object.isFrozen(nested)) {
      deepFreeze(nested)
    }
  }
  return value as DeepReadonly<T>
}

export const CONSUMER_CATALOG_V1 = deepFreeze({
  schemaVersion: 1,
  catalogVersion: 'consumer-inr-2026-07-v1',
  entitlementPolicyVersion: 'consumer-entitlements-2026-07-v1',
  currency: 'INR',
  gstInclusive: true,
  gstRatePercent: 18,
  plans: {
    free: {
      key: 'free',
      displayName: 'Basic',
      listPricePaise: 0,
      billingPeriod: 'none',
      interview: {
        includedPerPeriod: 1,
        periodOwner: 'calendar_month',
        maxDurationMinutes: 10,
        supportedDurationsMinutes: [10],
        analysisAndReplayIncluded: true,
      },
      resume: {
        basicSavedResumeLimit: 1,
        premiumSavedResumeLimitPerPeriod: 0,
      },
    },
    plus: {
      key: 'plus',
      displayName: 'Plus',
      listPricePaise: 59900,
      billingPeriod: 'monthly',
      interview: {
        includedPerPeriod: 10,
        periodOwner: 'razorpay_billing_cycle',
        maxDurationMinutes: 30,
        supportedDurationsMinutes: [10, 20, 30],
        analysisAndReplayIncluded: true,
      },
      resume: {
        basicSavedResumeLimit: 1,
        premiumSavedResumeLimitPerPeriod: 5,
      },
    },
    pro: {
      key: 'pro',
      displayName: 'Pro',
      listPricePaise: 99900,
      billingPeriod: 'monthly',
      interview: {
        includedPerPeriod: 15,
        periodOwner: 'razorpay_billing_cycle',
        maxDurationMinutes: 30,
        supportedDurationsMinutes: [10, 20, 30],
        analysisAndReplayIncluded: true,
      },
      resume: {
        basicSavedResumeLimit: 1,
        premiumSavedResumeLimitPerPeriod: 15,
      },
    },
  },
  oneTimeProducts: {
    single_interview: {
      key: 'single_interview',
      displayName: 'Additional interview',
      listPricePaise: 6900,
      billing: 'one_time',
      couponEligible: false,
      entitlement: {
        interviews: 1,
        maxDurationMinutes: 30,
        supportedDurationsMinutes: [10, 20, 30],
        validityDaysBeforeUse: 30,
        analysisAndReplayIncluded: true,
      },
    },
    premium_resume: {
      key: 'premium_resume',
      displayName: 'Premium resume unlock',
      listPricePaise: 2900,
      billing: 'one_time',
      couponEligible: false,
      entitlement: {
        premiumSavedResumeVersions: 1,
        revisionWindowDays: 7,
        revisionWindowStartsAt: 'first_successful_render',
      },
    },
  },
} as const satisfies ConsumerCatalogV1)

export const INITIAL_BASIC_ENTITLEMENT_PROJECTION_VERSION = 1 as const

export interface InitialBasicEntitlementProjection {
  entitlementSource: 'free'
  usagePeriodKey: string
  interviewsUsed: 0
  interviewLimit: number
  premiumResumesUsed: 0
  premiumResumeLimit: number
  usageResetAt: Date
  entitlementVersion:
    typeof INITIAL_BASIC_ENTITLEMENT_PROJECTION_VERSION
}

/**
 * Builds the authoritative v2 projection for a newly created Basic user.
 * Basic calendar months use Asia/Kolkata; IST is UTC+05:30 year-round.
 */
export function initialBasicEntitlementProjection(
  now = new Date(),
): InitialBasicEntitlementProjection {
  if (!Number.isFinite(now.getTime())) {
    throw new Error(
      'A valid Basic entitlement initialization timestamp is required',
    )
  }
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: 'numeric',
  }).formatToParts(now)
  const year = Number(
    parts.find((part) => part.type === 'year')?.value,
  )
  const month = Number(
    parts.find((part) => part.type === 'month')?.value,
  )
  const basic = CONSUMER_CATALOG_V1.plans.free
  const istOffsetMs = 5.5 * 60 * 60 * 1000

  return {
    entitlementSource: 'free',
    usagePeriodKey:
      `basic:${year}-${String(month).padStart(2, '0')}`,
    interviewsUsed: 0,
    interviewLimit: basic.interview.includedPerPeriod,
    premiumResumesUsed: 0,
    premiumResumeLimit:
      basic.resume.premiumSavedResumeLimitPerPeriod,
    usageResetAt:
      new Date(Date.UTC(year, month, 1) - istOffsetMs),
    entitlementVersion:
      INITIAL_BASIC_ENTITLEMENT_PROJECTION_VERSION,
  }
}

export const LAUNCH_COUPON_POLICY = deepFreeze({
  allowedDiscountsPaise: ALLOWED_COUPON_DISCOUNTS_PAISE,
  couponsStack: false,
  defaultDiscountedBillingCycles: 1,
  plans: {
    plus: {
      defaultAutomaticDiscountPaise: 10000,
      defaultFirstCyclePayablePaise: 49900,
      minimumPayablePaise: 39900,
      unitEconomicsApprovalBelowPaise: 49900,
    },
    pro: {
      defaultAutomaticDiscountPaise: 20000,
      defaultFirstCyclePayablePaise: 79900,
      minimumPayablePaise: 79900,
    },
  },
  oneTimeProductsCouponEligible: false,
} as const satisfies LaunchCouponPolicy)

export function isPersonalPlanKey(value: unknown): value is PersonalPlanKey {
  return typeof value === 'string' &&
    (PERSONAL_PLAN_KEYS as readonly string[]).includes(value)
}

export function isLegacyStoredPlanKey(value: unknown): value is LegacyStoredPlanKey {
  return typeof value === 'string' &&
    (LEGACY_STORED_PLAN_KEYS as readonly string[]).includes(value)
}

export function isOneTimeProductSku(value: unknown): value is OneTimeProductSku {
  return typeof value === 'string' &&
    (ONE_TIME_PRODUCT_SKUS as readonly string[]).includes(value)
}

/**
 * Fail-safe parser for legacy storage/JWT display hints. This must never be
 * used as proof of a paid entitlement.
 */
export function coerceLegacyStoredPlanKey(value: unknown): LegacyStoredPlanKey {
  return isLegacyStoredPlanKey(value) ? value : 'free'
}

export function coercePlanVocabularyVersion(value: unknown): PlanVocabularyVersion {
  return value === CURRENT_PLAN_VOCABULARY_VERSION
    ? CURRENT_PLAN_VOCABULARY_VERSION
    : 1
}

export function getStaticPlanDefinition(planKey: PersonalPlanKey): DeepReadonly<PlanDefinition> {
  return CONSUMER_CATALOG_V1.plans[planKey]
}

export function getStaticOneTimeProduct(
  sku: OneTimeProductSku,
): DeepReadonly<SingleInterviewDefinition | PremiumResumeDefinition> {
  return CONSUMER_CATALOG_V1.oneTimeProducts[sku]
}
