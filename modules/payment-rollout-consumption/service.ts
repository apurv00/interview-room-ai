import type {
  BillingRolloutAuthorityDecision,
  BillingRolloutSku,
} from '@modules/payment-rollout-control'
import {
  BILLING_ROLLOUT_DECISION_SCHEMA_VERSION,
  BILLING_ROLLOUT_SKUS,
} from '@modules/payment-rollout-control'
import {
  BILLING_ROLLOUT_CHECKOUT_AUTHORITY_SCHEMA_VERSION,
  BillingRolloutCheckoutAuthoritySchema,
  type BillingRolloutCheckoutAuthority,
} from './contracts'

const SUBSCRIPTION_COUPON_DISCOUNTS_PAISE =
  new Set([5_000, 10_000, 15_000, 20_000])
const OBJECT_ID_PATTERN = /^[a-f0-9]{24}$/
const COMMERCIAL_SKUS = Object.freeze([...BILLING_ROLLOUT_SKUS].sort())

export function parseBillingRolloutCheckoutAuthority(
  value: unknown,
): BillingRolloutCheckoutAuthority | null {
  const parsed =
    BillingRolloutCheckoutAuthoritySchema.safeParse(value)
  return parsed.success ? Object.freeze(parsed.data) : null
}

export function composeBillingRolloutCheckoutAuthority(input: {
  readonly decision: BillingRolloutAuthorityDecision
  readonly rolloutSku: BillingRolloutSku
  readonly boundAt: Date
}): BillingRolloutCheckoutAuthority | null {
  const { decision, rolloutSku, boundAt } = input
  return parseBillingRolloutCheckoutAuthority({
    schemaVersion:
      BILLING_ROLLOUT_CHECKOUT_AUTHORITY_SCHEMA_VERSION,
    decisionDigest: decision.decisionDigest,
    activationId: decision.activationId,
    activationSequence: decision.activationSequence,
    authorityRevision: decision.authorityRevision,
    stopEpoch: decision.stopEpoch,
    requestDigest: decision.requestDigest,
    requestedStateHash: decision.requestedStateHash,
    catalogVersion: decision.catalogVersion,
    catalogHash: decision.catalogHash,
    providerBindingHash: decision.providerBindingHash,
    couponPolicyHash: decision.couponPolicyHash,
    copyBundleHash: decision.copyBundleHash,
    rolloutPolicyHash: decision.rolloutPolicyHash,
    phaseId: decision.phaseId,
    audience: decision.audience,
    providerMode: decision.providerMode,
    rolloutSku,
    couponEnabled: decision.couponEnabled,
    boundAt:
      boundAt instanceof Date &&
      Number.isFinite(boundAt.getTime())
      ? boundAt.toISOString()
      : undefined,
  })
}

export interface BillingCommercialSurfaceAuthority {
  readonly evidence: BillingRolloutCheckoutAuthority
  readonly skuScope: readonly BillingRolloutSku[]
}

function sameSkuScope(
  actual: readonly BillingRolloutSku[],
  expected: readonly BillingRolloutSku[],
): boolean {
  return actual.length === expected.length &&
    actual.every((sku, index) => sku === expected[index])
}

export function composeBillingCommercialSurfaceAuthority(input: {
  readonly decision: BillingRolloutAuthorityDecision
  readonly catalogVersion: string
  readonly requiredSkuScope: readonly BillingRolloutSku[]
  readonly boundAt: Date
}): BillingCommercialSurfaceAuthority | null {
  const { decision, requiredSkuScope } = input
  const phase = decision.phaseId
  const qaPhase = phase === 'phase_1_test_qa' ||
    phase === 'phase_2_internal_live' ||
    phase === 'phase_3_qualified_pilot'
  const preEnforcement = phase === 'phase_1_test_qa' ||
    phase === 'phase_2_internal_live'
  const expectedScope: readonly BillingRolloutSku[] =
    phase === 'phase_2_internal_live'
    ? ['premium_resume_unlock']
    : COMMERCIAL_SKUS
  if (
    decision.schemaVersion !== BILLING_ROLLOUT_DECISION_SCHEMA_VERSION ||
    !decision.enabled || decision.reason !== 'public_treatment' ||
    !decision.cohortIncluded || !decision.sellingAllowed ||
    !decision.copyEnabled || !decision.analyticsEnabled ||
    !decision.couponEnabled ||
    decision.catalogVersion !== input.catalogVersion ||
    requiredSkuScope.length === 0 ||
    !requiredSkuScope.every((sku, index) =>
      index === 0 || requiredSkuScope[index - 1]! < sku) ||
    !sameSkuScope(decision.skuScope, expectedScope) ||
    !requiredSkuScope.every((sku) => decision.skuScope.includes(sku)) ||
    decision.providerMode !== (phase === 'phase_1_test_qa' ? 'test' : 'live') ||
    decision.audience !== (qaPhase ? 'qa' : 'public_treatment') ||
    decision.enforcementEnabled === preEnforcement ||
    decision.communicationsEnabled === preEnforcement
  ) return null
  const evidence = composeBillingRolloutCheckoutAuthority({
    decision,
    rolloutSku: requiredSkuScope[0]!,
    boundAt: input.boundAt,
  })
  return evidence ? Object.freeze({
    evidence,
    skuScope: Object.freeze([...decision.skuScope]),
  }) : null
}

export function sameBillingRolloutCheckoutAuthority(
  left: BillingRolloutCheckoutAuthority,
  right: BillingRolloutCheckoutAuthority,
): boolean {
  const expected =
    parseBillingRolloutCheckoutAuthority(left)
  const current =
    parseBillingRolloutCheckoutAuthority(right)
  if (!expected || !current) return false
  return (
    expected.decisionDigest === current.decisionDigest &&
    expected.activationId === current.activationId &&
    expected.activationSequence === current.activationSequence &&
    expected.authorityRevision === current.authorityRevision &&
    expected.stopEpoch === current.stopEpoch &&
    expected.requestDigest === current.requestDigest &&
    expected.requestedStateHash === current.requestedStateHash &&
    expected.catalogVersion === current.catalogVersion &&
    expected.catalogHash === current.catalogHash &&
    expected.providerBindingHash === current.providerBindingHash &&
    expected.couponPolicyHash === current.couponPolicyHash &&
    expected.copyBundleHash === current.copyBundleHash &&
    expected.rolloutPolicyHash === current.rolloutPolicyHash &&
    expected.phaseId === current.phaseId &&
    expected.audience === current.audience &&
    expected.providerMode === current.providerMode &&
    expected.rolloutSku === current.rolloutSku &&
    expected.couponEnabled === current.couponEnabled
  )
}

export function billingRolloutSubscriptionSku(
  planKey: 'plus' | 'pro',
): 'plus_subscription' | 'pro_subscription' {
  return planKey === 'plus'
    ? 'plus_subscription'
    : 'pro_subscription'
}

export function billingRolloutAuthorityMatchesSubscription(
  authority: BillingRolloutCheckoutAuthority,
  expected: {
    readonly planKey: 'plus' | 'pro'
    readonly providerMode: 'test' | 'live'
    readonly catalogVersion: string
    readonly catalogHash: string
    readonly discountPaise: number
    readonly discountedBillingCycles: number
    readonly couponCampaignId: string | null
    readonly couponCampaignRevision: number | null
  },
): boolean {
  return Boolean(
    billingRolloutAuthorityMatchesSubscriptionTarget(
      authority,
      expected,
    ) &&
    SUBSCRIPTION_COUPON_DISCOUNTS_PAISE.has(
      expected.discountPaise,
    ) &&
    Number.isSafeInteger(expected.discountedBillingCycles) &&
    expected.discountedBillingCycles >= 1 &&
    typeof expected.couponCampaignId === 'string' &&
    OBJECT_ID_PATTERN.test(expected.couponCampaignId) &&
    Number.isSafeInteger(expected.couponCampaignRevision) &&
    (expected.couponCampaignRevision ?? 0) >= 1
  )
}

export function billingRolloutAuthorityMatchesSubscriptionTarget(
  authority: BillingRolloutCheckoutAuthority,
  expected: {
    readonly planKey: 'plus' | 'pro'
    readonly providerMode: 'test' | 'live'
    readonly catalogVersion: string
    readonly catalogHash: string
  },
): boolean {
  const parsed =
    parseBillingRolloutCheckoutAuthority(authority)
  return Boolean(
    parsed &&
    parsed.rolloutSku ===
      billingRolloutSubscriptionSku(expected.planKey) &&
    parsed.providerMode === expected.providerMode &&
    parsed.catalogVersion === expected.catalogVersion &&
    parsed.catalogHash === expected.catalogHash &&
    parsed.couponEnabled === true
  )
}

export function bindBillingRolloutAuthorityToBuyerSnapshot(
  buyerSnapshot: Readonly<Record<string, unknown>>,
  authority: BillingRolloutCheckoutAuthority,
): Readonly<Record<string, unknown>> | null {
  const parsed =
    parseBillingRolloutCheckoutAuthority(authority)
  if (
    !parsed ||
    !buyerSnapshot ||
    Array.isArray(buyerSnapshot) ||
    Object.prototype.hasOwnProperty.call(
      buyerSnapshot,
      'billingRolloutAuthority',
    )
  ) return null
  return Object.freeze({
    ...buyerSnapshot,
    billingRolloutAuthority: parsed,
  })
}

export function readBillingRolloutAuthorityFromBuyerSnapshot(
  buyerSnapshot: unknown,
): BillingRolloutCheckoutAuthority | null {
  if (
    !buyerSnapshot ||
    typeof buyerSnapshot !== 'object' ||
    Array.isArray(buyerSnapshot)
  ) return null
  return parseBillingRolloutCheckoutAuthority(
    (buyerSnapshot as Record<string, unknown>)
      .billingRolloutAuthority,
  )
}
