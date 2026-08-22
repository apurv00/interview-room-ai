import { LAUNCH_COUPON_POLICY } from '@shared/services/planConfig'
import { sha256CanonicalJson } from '../lib/canonicalJson'
import type {
  CatalogContent,
  CouponCampaignMode,
  CouponPolicyApprovalKind,
  CouponPolicyApprovalSnapshot,
  CouponRevisionTerms,
  ProviderMode,
} from '../types/catalog'
import { CouponRevisionTermsSchema } from '../validators/coupon'

const URGENCY_LANGUAGE =
  /\b(?:ends?|expires?|limited|last chance|today|tonight|hours? left)\b/i

export interface CouponValidationResult {
  valid: boolean
  terms?: CouponRevisionTerms
  contentHash?: string
  errors: string[]
  warnings: string[]
}

export interface CouponPolicyValidationContext {
  campaignMode: CouponCampaignMode
  providerMode: ProviderMode
  couponContentHash: string
  catalogVersion: string
  catalogContentHash: string
  policyApprovals?: Partial<
    Record<CouponPolicyApprovalKind, CouponPolicyApprovalSnapshot>
  >
  requireApprovals?: boolean
}

export interface CouponPolicyValidationResult extends CouponValidationResult {
  requiredPolicyApprovals: CouponPolicyApprovalKind[]
}

function hasGenuineTarget(terms: CouponRevisionTerms): boolean {
  return (
    terms.eligibility.userIds.length > 0 ||
    terms.eligibility.segments.some((segment) => segment !== 'all') ||
    terms.eligibility.acquisitionSources.length > 0
  )
}

function approvalMatches(
  approval: CouponPolicyApprovalSnapshot | undefined,
  kind: CouponPolicyApprovalKind,
  context: CouponPolicyValidationContext,
): boolean {
  return Boolean(
    approval &&
      approval.kind === kind &&
      approval.couponContentHash === context.couponContentHash &&
      approval.catalogVersion === context.catalogVersion &&
      approval.catalogContentHash === context.catalogContentHash &&
      approval.providerMode === context.providerMode,
  )
}

export function validateCouponTerms(
  input: unknown,
  catalog: CatalogContent,
): CouponValidationResult {
  const parsed = CouponRevisionTermsSchema.safeParse(input)
  if (!parsed.success) {
    return {
      valid: false,
      errors: parsed.error.issues.map(
        (issue) => `${issue.path.join('.') || 'coupon'}: ${issue.message}`,
      ),
      warnings: [],
    }
  }

  const terms = parsed.data as CouponRevisionTerms
  const errors: string[] = []
  const warnings: string[] = []

  if (
    terms.discountedBillingCycles !==
      LAUNCH_COUPON_POLICY.defaultDiscountedBillingCycles
  ) {
    errors.push('Launch coupons must discount exactly 1 billing cycle')
  }
  if (terms.eligibility.upgradesEligible) {
    errors.push('Launch coupons cannot apply to subscription upgrades')
  }

  for (const planKey of terms.applicablePlanKeys) {
    const listPricePaise = catalog.plans[planKey].listPricePaise
    const payablePaise = listPricePaise - terms.discountPaise
    const policy = LAUNCH_COUPON_POLICY.plans[planKey]
    const configuredFloor =
      terms.minPayablePaiseByPlan[planKey] ?? policy.minimumPayablePaise

    if (payablePaise < policy.minimumPayablePaise) {
      errors.push(
        `${planKey} payable ₹${payablePaise / 100} is below the launch floor ₹${policy.minimumPayablePaise / 100}`,
      )
    }
    if (configuredFloor < policy.minimumPayablePaise) {
      errors.push(
        `${planKey} configured floor cannot be below ₹${policy.minimumPayablePaise / 100}`,
      )
    }
    if (payablePaise < configuredFloor) {
      errors.push(
        `${planKey} payable is below this campaign's configured floor`,
      )
    }
  }

  if (
    [terms.bannerText, terms.termsText].some(
      (copy) => copy && URGENCY_LANGUAGE.test(copy),
    ) &&
    !terms.endsAt
  ) {
    errors.push('Urgency copy requires a real coupon end time')
  }
  if (!/\b(?:renew|list price|thereafter)\b/i.test(terms.termsText)) {
    warnings.push('Terms should disclose the undiscounted renewal price')
  }

  return {
    valid: errors.length === 0,
    terms,
    contentHash: sha256CanonicalJson(terms),
    errors,
    warnings,
  }
}

/**
 * Validates cross-document coupon policy. Approval attestations deliberately
 * live outside editable terms and are accepted only when they match the exact
 * coupon hash, catalog snapshot, and provider mode under review.
 */
export function validateCouponCampaignPolicy(
  input: unknown,
  catalog: CatalogContent,
  context: CouponPolicyValidationContext,
): CouponPolicyValidationResult {
  const base = validateCouponTerms(input, catalog)
  if (!base.terms || !base.contentHash) {
    return { ...base, requiredPolicyApprovals: [] }
  }

  const errors = [...base.errors]
  const warnings = [...base.warnings]
  const requiredPolicyApprovals: CouponPolicyApprovalKind[] = []
  const genuineTarget = hasGenuineTarget(base.terms)

  if (base.contentHash !== context.couponContentHash) {
    errors.push('Stored coupon content hash does not match its terms')
  }

  if (base.terms.eligibility.userIds.length > 0) {
    errors.push(
      'Direct user-targeted coupon lists are deferred until deletable audience membership is supported',
    )
  }

  if (context.campaignMode === 'targeted' && !genuineTarget) {
    errors.push(
      'Targeted campaigns require at least one user, non-all segment, or acquisition source',
    )
  }
  if (
    context.campaignMode === 'targeted' &&
    base.terms.eligibility.segments.includes('all')
  ) {
    errors.push(
      'Targeted campaigns cannot include the globally eligible all segment',
    )
  }

  const plusIsBelowApprovalThreshold =
    base.terms.applicablePlanKeys.includes('plus') &&
    catalog.plans.plus.listPricePaise - base.terms.discountPaise <
      LAUNCH_COUPON_POLICY.plans.plus.unitEconomicsApprovalBelowPaise

  if (plusIsBelowApprovalThreshold) {
    if (context.campaignMode !== 'targeted') {
      errors.push('Plus payable below ₹499 requires a targeted campaign')
    }
    if (!base.terms.maxRedemptions) {
      errors.push('Plus payable below ₹499 requires a finite redemption cap')
    }
    if (!genuineTarget) {
      errors.push('Plus payable below ₹499 requires a genuine target')
    }
    requiredPolicyApprovals.push('economics')
  }

  if (base.terms.discountedBillingCycles > 1) {
    requiredPolicyApprovals.push('extended_cycles')
  }

  if (context.requireApprovals) {
    for (const kind of requiredPolicyApprovals) {
      if (!approvalMatches(context.policyApprovals?.[kind], kind, context)) {
        errors.push(
          kind === 'economics'
            ? 'A current server-owned unit-economics approval is required'
            : 'A current server-owned extended-cycle approval is required',
        )
      }
    }
  } else {
    for (const kind of requiredPolicyApprovals) {
      if (!approvalMatches(context.policyApprovals?.[kind], kind, context)) {
        warnings.push(
          kind === 'economics'
            ? 'Unit-economics approval is required before workflow approval'
            : 'Extended-cycle approval is required before workflow approval',
        )
      }
    }
  }

  return {
    ...base,
    valid: errors.length === 0,
    errors,
    warnings,
    requiredPolicyApprovals,
  }
}
