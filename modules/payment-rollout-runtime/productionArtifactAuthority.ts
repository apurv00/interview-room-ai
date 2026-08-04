import type { ClientSession } from 'mongoose'
import {
  BillingConfig,
  CouponCampaignRevision,
  PlanCatalogVersion,
  sha256CanonicalJson,
  type CatalogContent,
  type ProviderMode,
} from '@payments'
import { LAUNCH_COUPON_POLICY } from '@shared/services/planConfig'
import {
  billingRolloutDigest,
  type BillingRolloutRequestedState,
} from '@/modules/payment-rollout-control'
import type { BillingRolloutArtifactSnapshot } from './contracts'

const BILLING_ROLLOUT_POLICY_PATHS_V1 = Object.freeze([
  '/pricing',
  '/terms',
  '/privacy',
  '/cancellation-refunds',
  '/fulfilment',
  '/contact',
] as const)

export function buildBillingRolloutCopyBundleV1(catalog: CatalogContent) {
  const customerPlan = (terms: CatalogContent['plans']['free']) => {
    const copyTerms = { ...terms }
    delete copyTerms.razorpayPlanIdByMode
    return copyTerms
  }

  return Object.freeze({
    schemaVersion: 'consumer_billing_copy_bundle_v1',
    catalogSchemaVersion: catalog.schemaVersion,
    entitlementPolicyVersion: catalog.entitlementPolicyVersion,
    currency: catalog.currency,
    gstDisclosure: {
      policyVersion: 'gst_inclusive_disclosure_v1',
      inclusive: catalog.gstInclusive,
      ratePercent: catalog.gstRatePercent,
    },
    existingSubscriptionTreatment:
      catalog.existingSubscriptionTreatment,
    plans: {
      basic: customerPlan(catalog.plans.free),
      plus: customerPlan(catalog.plans.plus),
      pro: customerPlan(catalog.plans.pro),
    },
    oneTime: {
      additionalInterview:
        catalog.oneTimeProducts.single_interview,
      premiumResumeUnlock:
        catalog.oneTimeProducts.premium_resume,
    },
    couponDisclosure: {
      policyVersion: 'launch_coupon_disclosure_v1',
      allowedDiscountsPaise: [
        ...LAUNCH_COUPON_POLICY.allowedDiscountsPaise,
      ],
      stacking: LAUNCH_COUPON_POLICY.couponsStack,
      campaignAuthority: 'couponPolicyHash',
    },
    policyManifest: {
      schemaVersion: 'served_billing_policy_manifest_v1',
      paths: [...BILLING_ROLLOUT_POLICY_PATHS_V1],
    },
  })
}

interface CatalogLean {
  readonly version: string
  readonly status: string
  readonly content: CatalogContent
  readonly contentHash: string
  readonly validation?: {
    readonly contentHash?: string
    readonly errors?: readonly string[]
  }
  readonly approval?: { readonly contentHash?: string }
  readonly providerVerification?: Partial<Record<
    ProviderMode,
    {
      readonly status?: string
      readonly normalizedTermsHash?: string
    }
  >>
}

interface CouponLean {
  readonly campaignId: { toString(): string } | string
  readonly revision: number
  readonly status: string
  readonly contentHash: string
  readonly validation?: {
    readonly contentHash?: string
    readonly errors?: readonly string[]
    readonly catalogVersion?: string
    readonly catalogContentHash?: string
    readonly providerMode?: string
    readonly requiredPolicyApprovals?: readonly string[]
  }
  readonly approval?: { readonly contentHash?: string }
  readonly policyApprovals?: Record<
    string,
    {
      readonly couponContentHash?: string
      readonly catalogVersion?: string
      readonly catalogContentHash?: string
      readonly providerMode?: string
    }
  >
  readonly providerVerification?: Partial<Record<
    ProviderMode,
    {
      readonly status?: string
      readonly normalizedTermsHash?: string
    }
  >>
  readonly terms?: {
    readonly razorpayOfferIdByMode?: Partial<
      Record<ProviderMode, string>
    >
  }
}

function exactDeploymentIdentity(): {
  deploymentId: string
  commitSha: string
} {
  const deploymentId =
    process.env.BILLING_ROLLOUT_DEPLOYMENT_ID ??
    process.env.VERCEL_DEPLOYMENT_ID ??
    process.env.VERCEL_URL
  const commitSha =
    process.env.BILLING_ROLLOUT_COMMIT_SHA ??
    process.env.VERCEL_GIT_COMMIT_SHA
  if (
    !deploymentId ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{2,199}$/.test(deploymentId) ||
    !commitSha ||
    !/^[a-f0-9]{7,64}$/.test(commitSha)
  ) throw new Error('Exact billing rollout deployment identity is missing')
  return { deploymentId, commitSha }
}

function providerBindingHash(
  catalog: CatalogLean,
  mode: BillingRolloutRequestedState['providerMode'],
): string {
  if (mode === 'none') {
    return billingRolloutDigest({
      domain: 'billing_rollout_provider_binding_v1',
      mode,
      catalogVersion: catalog.version,
      catalogContentHash: catalog.contentHash,
    })
  }
  const verification = catalog.providerVerification?.[mode]
  const plusPlanId =
    catalog.content.plans.plus.razorpayPlanIdByMode?.[mode]
  const proPlanId =
    catalog.content.plans.pro.razorpayPlanIdByMode?.[mode]
  if (
    verification?.status !== 'verified' ||
    !verification.normalizedTermsHash ||
    !/^[a-f0-9]{64}$/.test(verification.normalizedTermsHash) ||
    !plusPlanId ||
    !proPlanId
  ) throw new Error('Catalog provider binding is not verified')
  return billingRolloutDigest({
    domain: 'billing_rollout_provider_binding_v1',
    mode,
    catalogVersion: catalog.version,
    catalogContentHash: catalog.contentHash,
    plusPlanId,
    proPlanId,
    normalizedTermsHash: verification.normalizedTermsHash,
  })
}

function couponBundleHash(input: {
  readonly rows: readonly CouponLean[]
  readonly mode: BillingRolloutRequestedState['providerMode']
  readonly catalog: CatalogLean
  readonly couponRequired: boolean
}): string {
  if (input.mode === 'none') {
    return billingRolloutDigest({
      domain: 'billing_rollout_coupon_bundle_v1',
      mode: input.mode,
      campaigns: [],
    })
  }
  const rows = [...input.rows].sort((left, right) =>
    `${left.campaignId}:${left.revision}`.localeCompare(
      `${right.campaignId}:${right.revision}`,
    ))
  if (input.couponRequired && rows.length === 0) {
    throw new Error('An approved automatic coupon is required')
  }
  const mode: ProviderMode = input.mode
  const evidence = rows.map((row) => {
    const validation = row.validation
    const verification = row.providerVerification?.[mode]
    const required = validation?.requiredPolicyApprovals ?? []
    if (
      row.status !== 'active' ||
      !/^[a-f0-9]{64}$/.test(row.contentHash) ||
      validation?.contentHash !== row.contentHash ||
      (validation.errors?.length ?? 1) !== 0 ||
      validation.catalogVersion !== input.catalog.version ||
      validation.catalogContentHash !== input.catalog.contentHash ||
      validation.providerMode !== mode ||
      row.approval?.contentHash !== row.contentHash ||
      verification?.status !== 'verified' ||
      !verification.normalizedTermsHash ||
      !/^[a-f0-9]{64}$/.test(verification.normalizedTermsHash) ||
      required.some((kind) => {
        const approval = row.policyApprovals?.[kind]
        return approval?.couponContentHash !== row.contentHash ||
          approval.catalogVersion !== input.catalog.version ||
          approval.catalogContentHash !== input.catalog.contentHash ||
          approval.providerMode !== mode
      })
    ) throw new Error('Coupon rollout evidence is incomplete')
    const offerId = row.terms?.razorpayOfferIdByMode?.[mode]
    if (!offerId) throw new Error('Coupon provider offer is missing')
    return {
      campaignId: String(row.campaignId),
      revision: row.revision,
      contentHash: row.contentHash,
      offerId,
      normalizedTermsHash: verification.normalizedTermsHash,
      requiredPolicyApprovals: [...required].sort(),
    }
  })
  return billingRolloutDigest({
    domain: 'billing_rollout_coupon_bundle_v1',
    mode,
    campaigns: evidence,
  })
}

export function billingRolloutCopyBundleHash(
  catalog: CatalogContent,
): string {
  return billingRolloutDigest({
    domain: 'billing_rollout_copy_bundle_v1',
    bundle: buildBillingRolloutCopyBundleV1(catalog),
  })
}

export async function observeProductionBillingRolloutArtifacts(input: {
  readonly requestedState: BillingRolloutRequestedState
  readonly transaction: ClientSession
}): Promise<BillingRolloutArtifactSnapshot> {
  const config = await BillingConfig.findOne({ key: 'singleton' })
    .select('activeCatalogVersion')
    .session(input.transaction)
    .lean<{ activeCatalogVersion?: string }>()
  if (
    !config?.activeCatalogVersion ||
    config.activeCatalogVersion !==
      input.requestedState.activeCatalogVersion
  ) throw new Error('Active catalog pointer changed')
  const catalog = await PlanCatalogVersion.findOne({
    version: config.activeCatalogVersion,
    status: 'published',
  })
    .select(
      'version status content contentHash validation approval ' +
      'providerVerification',
    )
    .session(input.transaction)
    .lean<CatalogLean>()
  if (
    !catalog ||
    sha256CanonicalJson(catalog.content) !== catalog.contentHash ||
    catalog.validation?.contentHash !== catalog.contentHash ||
    (catalog.validation.errors?.length ?? 1) !== 0 ||
    catalog.approval?.contentHash !== catalog.contentHash
  ) throw new Error('Published catalog evidence is invalid')
  const couponRequired =
    input.requestedState.autoCouponRequired &&
    input.requestedState.couponMode !== 'off' &&
    input.requestedState.skuScope.some(
      (sku) =>
        sku === 'plus_subscription' ||
        sku === 'pro_subscription',
    )
  const coupons = input.requestedState.providerMode === 'none'
    ? []
    : await CouponCampaignRevision.find({
        status: 'active',
        lifecycleClaim: 'live',
      })
      .select(
        'campaignId revision status contentHash validation approval ' +
        'policyApprovals providerVerification terms.razorpayOfferIdByMode',
      )
      .session(input.transaction)
      .lean<CouponLean[]>()
  const identity = exactDeploymentIdentity()
  return Object.freeze({
    ...identity,
    activeCatalogVersion: catalog.version,
    activeCatalogHash: catalog.contentHash,
    providerBindingHash: providerBindingHash(
      catalog,
      input.requestedState.providerMode,
    ),
    couponPolicyHash: couponBundleHash({
      rows: coupons,
      mode: input.requestedState.providerMode,
      catalog,
      couponRequired,
    }),
    copyBundleHash: billingRolloutCopyBundleHash(catalog.content),
  })
}
