import type { PaidPersonalPlanKey } from '@shared/services/planConfig'
import { sha256CanonicalJson } from '../lib/canonicalJson'
import type {
  CatalogContent,
  CouponCampaignMode,
  CouponRevisionTerms,
  CouponSegment,
} from '../types/catalog'
import type { BillingQuoteSurface } from '../validators/customerBilling'
import {
  selectCouponForPricing,
  type CouponSelectionCandidate,
} from './couponSelectionService'
import { validateCouponCampaignPolicy } from './couponValidation'

export interface CouponPreviewCandidate extends CouponSelectionCandidate {
  campaignName: string
  terms: CouponRevisionTerms
}

export interface PricingPreviewCustomer {
  userId?: string
  stableAnonymousId?: string
  isNewCustomer: boolean
  isUpgrade: boolean
  segment?: CouponSegment
  acquisitionSource?: string
}

export interface PricingPreview {
  simulation: true
  planKey: PaidPersonalPlanKey
  currency: 'INR'
  gstInclusive: true
  gstRatePercent: 18
  listPricePaise: number
  discountPaise: number
  payableNowPaise: number
  nextChargePaise: number
  postDiscountPricePaise: number
  renewalPricePaise: number
  discountedBillingCycles?: number
  coupon?: {
    campaignId: string
    campaignKey: string
    revision: number
    mode: CouponCampaignMode
    code?: string
    displayText: string
    whyApplied: string
    termsText: string
  }
  manualCodeResult?:
    | 'applied'
    | 'invalid'
    | 'ineligible'
    | 'not_better_than_automatic'
  disclosure: string
  disclosureDetails: {
    why: string
    terms?: string
    gst: 'GST included.'
    cancellation: 'Auto-renews until cancelled.'
  }
}

function policySelectable(
  candidate: CouponPreviewCandidate,
  catalog: CatalogContent,
): CouponPreviewCandidate {
  const couponContentHash = sha256CanonicalJson(candidate.terms)
  const valid = validateCouponCampaignPolicy(candidate.terms, catalog, {
    campaignMode: candidate.mode,
    providerMode: 'test',
    couponContentHash,
    catalogVersion: 'cms-preview',
    catalogContentHash: 'cms-preview',
    requireApprovals: false,
  }).valid
  return { ...candidate, selectable: valid }
}

export function previewPlanPricing(input: {
  catalog: CatalogContent
  planKey: PaidPersonalPlanKey
  customer: PricingPreviewCustomer
  automaticCandidates: CouponPreviewCandidate[]
  manualCode?: string
  manualCandidates?: CouponPreviewCandidate[]
  surface?: BillingQuoteSurface
  now?: Date
}): PricingPreview {
  const result = selectCouponForPricing({
    mode: 'simulation',
    planKey: input.planKey,
    surface: input.surface ?? 'pricing',
    now: input.now ?? new Date(),
    listPricePaise: input.catalog.plans[input.planKey].listPricePaise,
    currency: input.catalog.currency,
    gstInclusive: input.catalog.gstInclusive,
    gstRatePercent: input.catalog.gstRatePercent,
    customer: input.customer,
    automaticCandidates: input.automaticCandidates.map((candidate) =>
      policySelectable(candidate, input.catalog)),
    manualCandidates: (input.manualCandidates ?? []).map((candidate) =>
      policySelectable(candidate, input.catalog)),
    manualCode: input.manualCode,
  })
  const selected = result.selected
  return {
    simulation: true,
    planKey: input.planKey,
    currency: result.pricing.currency,
    gstInclusive: result.pricing.gstInclusive,
    gstRatePercent: result.pricing.gstRatePercent,
    listPricePaise: result.pricing.listPricePaise,
    discountPaise: result.pricing.discountPaise,
    payableNowPaise: result.pricing.payablePaise,
    nextChargePaise: result.pricing.nextChargePaise,
    postDiscountPricePaise: result.pricing.renewalPricePaise,
    renewalPricePaise: result.pricing.renewalPricePaise,
    ...(result.pricing.discountedBillingCycles
      ? { discountedBillingCycles: result.pricing.discountedBillingCycles }
      : {}),
    ...(selected
      ? {
          coupon: {
            campaignId: selected.campaignId,
            campaignKey: selected.campaignKey,
            revision: selected.revision,
            mode: selected.mode,
            ...(selected.code ? { code: selected.code } : {}),
            displayText: selected.terms.bannerText ??
              `₹${selected.terms.discountPaise / 100} off`,
            whyApplied: result.disclosure.why,
            termsText: selected.terms.termsText,
          },
        }
      : {}),
    ...(result.manualCodeResult
      ? { manualCodeResult: result.manualCodeResult }
      : {}),
    disclosure: result.disclosure.summary,
    disclosureDetails: {
      why: result.disclosure.why,
      ...(result.disclosure.terms
        ? { terms: result.disclosure.terms }
        : {}),
      gst: result.disclosure.gst,
      cancellation: result.disclosure.cancellation,
    },
  }
}
