import { createHash } from 'node:crypto'
import {
  LAUNCH_COUPON_POLICY,
  type PaidPersonalPlanKey,
} from '@shared/services/planConfig'
import type {
  CouponCampaignMode,
  CouponRevisionTerms,
  CouponSegment,
  ProviderMode,
} from '../types/catalog'
import type { BillingQuoteSurface } from '../validators/customerBilling'

export interface CouponSelectionAvailability {
  providerMode: ProviderMode
  redemptions: number
  openReservations: number
  userRedemptions: number
  userOpenReservations: number
}

export interface CouponSelectionCandidate {
  campaignId: string
  campaignKey: string
  revision: number
  mode: CouponCampaignMode
  code?: string
  terms: CouponRevisionTerms
  availability?: CouponSelectionAvailability
  selectable?: boolean
}

interface CouponSelectionCommon<T extends CouponSelectionCandidate> {
  planKey: PaidPersonalPlanKey
  surface: BillingQuoteSurface
  now: Date
  listPricePaise: number
  currency: 'INR'
  gstInclusive: true
  gstRatePercent: 18
  automaticCandidates: readonly T[]
  manualCode?: string
  manualCandidates?: readonly T[]
}

export type CouponSelectionInput<T extends CouponSelectionCandidate> =
  CouponSelectionCommon<T> & (
    | {
        mode: 'server'
        providerMode: ProviderMode
        customer: {
          userId: string
          isNewCustomer: boolean
          isUpgrade: boolean
          resolvedSegment?: CouponSegment
          resolvedAcquisitionSource?: string
        }
      }
    | {
        mode: 'simulation'
        customer: {
          userId?: string
          stableAnonymousId?: string
          isNewCustomer: boolean
          isUpgrade: boolean
          segment?: CouponSegment
          acquisitionSource?: string
        }
      }
  )

export type CouponManualCodeResult =
  | 'applied'
  | 'invalid'
  | 'ineligible'
  | 'not_better_than_automatic'

export interface CouponPricingDisclosure {
  summary: string
  why: string
  terms?: string
  gst: 'GST included.'
  cancellation: 'Auto-renews until cancelled.'
}

export interface CouponSelectionResult<T extends CouponSelectionCandidate> {
  selected?: T
  automatic?: T
  providerMode?: ProviderMode
  manualCodeResult?: CouponManualCodeResult
  pricing: {
    currency: 'INR'
    gstInclusive: true
    gstRatePercent: 18
    listPricePaise: number
    discountPaise: number
    payablePaise: number
    nextChargePaise: number
    renewalPricePaise: number
    discountedBillingCycles?: number
  }
  disclosure: CouponPricingDisclosure
}

function nonNegativeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0
}

function stableIdentity<T extends CouponSelectionCandidate>(
  input: CouponSelectionInput<T>,
): string | undefined {
  return input.customer.userId ??
    (input.mode === 'simulation'
      ? input.customer.stableAnonymousId
      : undefined)
}

function resolvedSegment<T extends CouponSelectionCandidate>(
  input: CouponSelectionInput<T>,
): CouponSegment | undefined {
  return input.mode === 'server'
    ? input.customer.resolvedSegment
    : input.customer.segment
}

function resolvedSource<T extends CouponSelectionCandidate>(
  input: CouponSelectionInput<T>,
): string | undefined {
  return input.mode === 'server'
    ? input.customer.resolvedAcquisitionSource
    : input.customer.acquisitionSource
}

function isEligible<T extends CouponSelectionCandidate>(
  candidate: T,
  input: CouponSelectionInput<T>,
): boolean {
  const { terms } = candidate
  const payable = input.listPricePaise - terms.discountPaise
  const launchFloor =
    LAUNCH_COUPON_POLICY.plans[input.planKey].minimumPayablePaise
  const floor = terms.minPayablePaiseByPlan[input.planKey] ?? launchFloor
  if (
    candidate.selectable === false ||
    !nonNegativeInteger(input.listPricePaise) ||
    !nonNegativeInteger(terms.discountPaise) ||
    !nonNegativeInteger(payable) ||
    !nonNegativeInteger(floor) ||
    floor < launchFloor ||
    payable < floor ||
    !Number.isSafeInteger(terms.discountedBillingCycles) ||
    terms.discountedBillingCycles < 1 ||
    !terms.applicablePlanKeys.includes(input.planKey) ||
    !terms.visibility.includes(input.surface) ||
    (terms.startsAt !== undefined &&
      (!(terms.startsAt instanceof Date) ||
        !Number.isFinite(terms.startsAt.getTime()) ||
        terms.startsAt > input.now)) ||
    (terms.endsAt !== undefined &&
      (!(terms.endsAt instanceof Date) ||
        !Number.isFinite(terms.endsAt.getTime()) ||
        terms.endsAt <= input.now)) ||
    (terms.holdoutBps !== undefined &&
      (!Number.isSafeInteger(terms.holdoutBps) ||
        terms.holdoutBps < 0 ||
        terms.holdoutBps > 10_000)) ||
    (terms.eligibility.newCustomerOnly && !input.customer.isNewCustomer) ||
    (input.customer.isUpgrade && !terms.eligibility.upgradesEligible)
  ) return false

  const userId = input.customer.userId
  if (
    terms.eligibility.userIds.length > 0 &&
    (!userId || !terms.eligibility.userIds.includes(userId))
  ) return false
  if (
    terms.eligibility.segments.length > 0 &&
    !terms.eligibility.segments.includes('all') &&
    (!resolvedSegment(input) ||
      !terms.eligibility.segments.includes(resolvedSegment(input)!))
  ) return false
  if (
    terms.eligibility.acquisitionSources.length > 0 &&
    (!resolvedSource(input) ||
      !terms.eligibility.acquisitionSources.includes(resolvedSource(input)!))
  ) return false

  const usage = candidate.availability
  if (input.mode === 'server') {
    if (!usage || usage.providerMode !== input.providerMode) return false
  }
  if (usage) {
    const values = [
      usage.redemptions,
      usage.openReservations,
      usage.userRedemptions,
      usage.userOpenReservations,
    ]
    if (!values.every(nonNegativeInteger)) return false
    if (
      usage.userRedemptions + usage.userOpenReservations >=
        terms.maxRedemptionsPerUser ||
      (terms.maxRedemptions !== undefined &&
        usage.redemptions + usage.openReservations >= terms.maxRedemptions)
    ) return false
  }

  if ((terms.holdoutBps ?? 0) > 0) {
    const identity = stableIdentity(input)
    if (!identity) return false
    const bucket = createHash('sha256')
      .update(`${candidate.campaignKey}:${identity}`)
      .digest()
      .readUInt32BE(0) % 10_000
    if (bucket < terms.holdoutBps!) return false
  }
  return true
}

function automaticRank<T extends CouponSelectionCandidate>(
  left: T,
  right: T,
): number {
  const ranked = right.terms.priority - left.terms.priority ||
    right.terms.discountPaise - left.terms.discountPaise
  if (ranked !== 0 || left.campaignKey === right.campaignKey) return ranked
  return left.campaignKey < right.campaignKey ? -1 : 1
}

function disclosure<T extends CouponSelectionCandidate>(
  selected: T | undefined,
  listPricePaise: number,
): CouponPricingDisclosure {
  const amount = (paise: number) => {
    const rupees = Math.trunc(paise / 100)
    const fraction = paise % 100
    return `₹${rupees}${fraction === 0
      ? ''
      : `.${String(fraction).padStart(2, '0')}`}`
  }
  const payable = listPricePaise - (selected?.terms.discountPaise ?? 0)
  const cycles = selected?.terms.discountedBillingCycles
  const summary = !selected
    ? `${amount(listPricePaise)} per billing month. GST included. Auto-renews until cancelled.`
    : cycles === 1
      ? `${amount(payable)} for the first billing month, then ${amount(listPricePaise)} per billing month. GST included. Auto-renews until cancelled.`
      : `${amount(payable)} per billing month for the first ${cycles} billing months, then ${amount(listPricePaise)} per billing month. GST included. Auto-renews until cancelled.`
  const why = !selected
    ? 'No eligible coupon is applied.'
    : selected.mode === 'code'
      ? `Coupon code ${selected.code} applied.`
      : selected.mode === 'targeted'
        ? 'Eligible targeted offer applied.'
        : 'Best eligible automatic offer applied.'
  return {
    summary,
    why,
    ...(selected ? { terms: selected.terms.termsText } : {}),
    gst: 'GST included.',
    cancellation: 'Auto-renews until cancelled.',
  }
}

export function selectCouponForPricing<T extends CouponSelectionCandidate>(
  input: CouponSelectionInput<T>,
): CouponSelectionResult<T> {
  const automatic = [...input.automaticCandidates]
    .filter((candidate) =>
      (candidate.mode === 'automatic' || candidate.mode === 'targeted') &&
      isEligible(candidate, input))
    .sort(automaticRank)[0]
  let selected = automatic
  let manualCodeResult: CouponManualCodeResult | undefined
  const normalizedCode = input.manualCode?.trim().toUpperCase()
  if (normalizedCode) {
    const matches = (input.manualCandidates ?? []).filter((candidate) =>
      candidate.mode === 'code' &&
      candidate.code?.trim().toUpperCase() === normalizedCode)
    const eligible = matches.filter((candidate) => isEligible(candidate, input))
      .sort((left, right) =>
        right.terms.discountPaise - left.terms.discountPaise ||
        automaticRank(left, right))[0]
    if (matches.length === 0) manualCodeResult = 'invalid'
    else if (!eligible) manualCodeResult = 'ineligible'
    else if (
      automatic &&
      eligible.terms.discountPaise <= automatic.terms.discountPaise
    ) manualCodeResult = 'not_better_than_automatic'
    else {
      selected = eligible
      manualCodeResult = 'applied'
    }
  }

  const discountPaise = selected?.terms.discountPaise ?? 0
  const payablePaise = input.listPricePaise - discountPaise
  const cycles = selected?.terms.discountedBillingCycles
  return {
    ...(selected ? { selected } : {}),
    ...(automatic ? { automatic } : {}),
    ...(input.mode === 'server' ? { providerMode: input.providerMode } : {}),
    ...(manualCodeResult ? { manualCodeResult } : {}),
    pricing: {
      currency: input.currency,
      gstInclusive: input.gstInclusive,
      gstRatePercent: input.gstRatePercent,
      listPricePaise: input.listPricePaise,
      discountPaise,
      payablePaise,
      nextChargePaise: selected && cycles! > 1
        ? payablePaise
        : input.listPricePaise,
      renewalPricePaise: input.listPricePaise,
      ...(selected ? { discountedBillingCycles: cycles } : {}),
    },
    disclosure: disclosure(selected, input.listPricePaise),
  }
}
