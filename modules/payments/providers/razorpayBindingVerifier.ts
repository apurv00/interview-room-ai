import { ZodError } from 'zod'
import { sha256CanonicalJson } from '../lib/canonicalJson'
import { isInrPaise } from '../lib/money'
import type {
  CatalogBindingVerificationInput,
  CouponBindingVerificationInput,
  PaymentBindingVerifier,
} from './bindingVerifier'
import type { RazorpayClientFactory } from './razorpayClientFactory'
import {
  RazorpayProviderEntityMismatchError,
  RazorpaySdkCapabilityError,
  type RazorpayOfferDto,
  type RazorpayPlanDto,
  type RazorpayServerAdapter,
} from './razorpayServerAdapter'
import { RazorpayConfigurationError } from './razorpayEnvironment'
import type {
  ProviderMode,
  ProviderVerificationSnapshot,
} from '../types/catalog'

type PaidPlanKey = 'plus' | 'pro'
type VerificationStatus = ProviderVerificationSnapshot['status']

export const RAZORPAY_BINDING_VERIFICATION_ERRORS = {
  catalogHashMismatch:
    'Catalog content does not match its canonical contentHash',
  couponHashMismatch:
    'Coupon terms do not match their canonical contentHash',
  couponCatalogHashMissing:
    'Coupon verification requires the pinned canonical catalogContentHash',
  couponPlanContextIncomplete:
    'Coupon verification requires every mode-specific catalog Plan binding',
  clientModeMismatch:
    'Razorpay client mode does not match the requested provider mode',
  credentialsUnavailable:
    'Razorpay credentials are unavailable for the requested provider mode',
  planCapabilityUnavailable:
    'Razorpay Plan verification capability is unavailable',
  offerCapabilityUnavailable:
    'Razorpay Offer verification capability is unavailable',
  planProviderUnavailable:
    'Razorpay Plan verification could not be completed',
  offerProviderUnavailable:
    'Razorpay Offer verification could not be completed',
  planResponseInvalid:
    'Razorpay Plan response did not satisfy the normalized contract',
  offerResponseInvalid:
    'Razorpay Offer response did not satisfy the normalized contract',
} as const

export interface RazorpayPaymentBindingVerifierOptions {
  clientFactory: RazorpayClientFactory
  now?: () => Date
}

function snapshot(
  status: VerificationStatus,
  fetchedAt: Date,
  errors: string[],
  normalizedTermsHash?: string,
): ProviderVerificationSnapshot {
  return {
    status,
    fetchedAt: new Date(fetchedAt.getTime()),
    ...(normalizedTermsHash ? { normalizedTermsHash } : {}),
    errors,
  }
}

function statusCode(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined
  const value = (error as { statusCode?: unknown }).statusCode
  if (typeof value === 'number' && Number.isInteger(value)) return value
  if (typeof value === 'string' && /^\d{3}$/.test(value)) {
    return Number(value)
  }
  return undefined
}

function isMissingProviderEntity(error: unknown): boolean {
  const code = statusCode(error)
  return code === 400 || code === 404
}

function getAdapter(
  factory: RazorpayClientFactory,
  mode: ProviderMode,
  providerUnavailableError: string,
):
  | { adapter: RazorpayServerAdapter }
  | { status: 'unavailable'; error: string } {
  try {
    return { adapter: factory.forMode(mode) }
  } catch (error) {
    if (error instanceof RazorpayConfigurationError) {
      return {
        status: 'unavailable',
        error: RAZORPAY_BINDING_VERIFICATION_ERRORS.credentialsUnavailable,
      }
    }
    return {
      status: 'unavailable',
      error: providerUnavailableError,
    }
  }
}

function planLabel(planKey: PaidPlanKey): 'Plus' | 'Pro' {
  return planKey === 'plus' ? 'Plus' : 'Pro'
}

function isRazorpayPlanId(value: string): boolean {
  return /^plan_[A-Za-z0-9]+$/.test(value)
}

function isRazorpayOfferId(value: string): boolean {
  return /^offer_[A-Za-z0-9]+$/.test(value)
}

function comparePlan(
  planKey: PaidPlanKey,
  expectedId: string,
  expectedAmountPaise: number,
  remote: RazorpayPlanDto,
): string[] {
  const label = planLabel(planKey)
  const errors: string[] = []
  if (remote.id !== expectedId) {
    errors.push(`${label} Plan identifier does not match the catalog binding`)
  }
  if (!remote.item.active) {
    errors.push(`${label} Plan item is not active`)
  }
  if (remote.item.currency !== 'INR') {
    errors.push(`${label} Plan currency must be INR`)
  }
  if (
    !isInrPaise(remote.item.amountPaise) ||
    remote.item.amountPaise !== expectedAmountPaise
  ) {
    errors.push(`${label} Plan amount does not match catalog integer paise`)
  }
  if (remote.period !== 'monthly') {
    errors.push(`${label} Plan billing period must be monthly`)
  }
  if (remote.interval !== 1) {
    errors.push(`${label} Plan interval must equal 1`)
  }
  return errors
}

async function fetchAndComparePlan(input: {
  adapter: RazorpayServerAdapter
  planKey: PaidPlanKey
  expectedId: string
  expectedAmountPaise: number
}): Promise<
  | { status: 'matched' | 'failed'; errors: string[] }
  | { status: 'unavailable'; errors: string[] }
> {
  const label = planLabel(input.planKey)
  try {
    const remote = await input.adapter.fetchPlan(input.expectedId)
    const errors = comparePlan(
      input.planKey,
      input.expectedId,
      input.expectedAmountPaise,
      remote,
    )
    return {
      status: errors.length ? 'failed' : 'matched',
      errors,
    }
  } catch (error) {
    if (
      error instanceof RazorpaySdkCapabilityError ||
      error instanceof RazorpayConfigurationError
    ) {
      return {
        status: 'unavailable',
        errors: [
          RAZORPAY_BINDING_VERIFICATION_ERRORS.planCapabilityUnavailable,
        ],
      }
    }
    if (error instanceof ZodError) {
      return {
        status: 'failed',
        errors: [
          `${label} ${RAZORPAY_BINDING_VERIFICATION_ERRORS.planResponseInvalid}`,
        ],
      }
    }
    if (isMissingProviderEntity(error)) {
      return {
        status: 'failed',
        errors: [`${label} configured Razorpay Plan could not be fetched`],
      }
    }
    return {
      status: 'unavailable',
      errors: [
        RAZORPAY_BINDING_VERIFICATION_ERRORS.planProviderUnavailable,
      ],
    }
  }
}

function isCanonicalHash(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value)
}

function sortedUnique(values: string[]): string[] {
  return Array.from(new Set(values)).sort()
}

function sameStringSet(left: string[], right: string[]): boolean {
  const normalizedLeft = sortedUnique(left)
  const normalizedRight = sortedUnique(right)
  return normalizedLeft.length === left.length &&
    normalizedRight.length === right.length &&
    normalizedLeft.length === normalizedRight.length &&
    normalizedLeft.every((value, index) => value === normalizedRight[index])
}

function epochSeconds(value: Date | undefined): number | undefined {
  if (value === undefined) return undefined
  return Math.floor(value.getTime() / 1000)
}

function compareOffer(
  input: CouponBindingVerificationInput,
  expectedId: string,
  remote: RazorpayOfferDto,
): string[] {
  const errors: string[] = []
  if (remote.id !== expectedId) {
    errors.push('Offer identifier does not match the coupon binding')
  }
  if (!remote.active) {
    errors.push('Razorpay Offer is not active')
  }
  if (
    !isInrPaise(remote.discountAmountPaise) ||
    remote.discountAmountPaise !== input.terms.discountPaise
  ) {
    errors.push('Offer discount does not match coupon integer paise')
  }
  if (
    !sameStringSet(remote.applicablePlanIds, input.applicablePlanIds)
  ) {
    errors.push('Offer applicable Plan IDs do not exactly match the catalog')
  }
  if (
    remote.discountedBillingCycles !== input.terms.discountedBillingCycles
  ) {
    errors.push('Offer discounted billing cycles do not match the coupon')
  }
  if (
    remote.startsAtEpochSeconds !== epochSeconds(input.terms.startsAt)
  ) {
    errors.push('Offer start time does not match the coupon')
  }
  if (
    remote.endsAtEpochSeconds !== epochSeconds(input.terms.endsAt)
  ) {
    errors.push('Offer end time does not match the coupon')
  }
  return errors
}

async function fetchAndCompareOffer(input: {
  adapter: RazorpayServerAdapter
  verification: CouponBindingVerificationInput
  expectedId: string
}): Promise<
  | { status: 'matched' | 'failed'; errors: string[] }
  | { status: 'unavailable'; errors: string[] }
> {
  try {
    const remote = await input.adapter.fetchOffer(input.expectedId)
    const errors = compareOffer(
      input.verification,
      input.expectedId,
      remote,
    )
    return {
      status: errors.length ? 'failed' : 'matched',
      errors,
    }
  } catch (error) {
    if (error instanceof RazorpayProviderEntityMismatchError) {
      return {
        status: 'failed',
        errors: ['Offer identifier does not match the coupon binding'],
      }
    }
    if (
      error instanceof RazorpaySdkCapabilityError ||
      error instanceof RazorpayConfigurationError
    ) {
      return {
        status: 'unavailable',
        errors: [
          RAZORPAY_BINDING_VERIFICATION_ERRORS.offerCapabilityUnavailable,
        ],
      }
    }
    if (error instanceof ZodError) {
      return {
        status: 'failed',
        errors: [
          RAZORPAY_BINDING_VERIFICATION_ERRORS.offerResponseInvalid,
        ],
      }
    }
    if (isMissingProviderEntity(error)) {
      return {
        status: 'failed',
        errors: ['Configured Razorpay Offer could not be fetched'],
      }
    }
    return {
      status: 'unavailable',
      errors: [
        RAZORPAY_BINDING_VERIFICATION_ERRORS.offerProviderUnavailable,
      ],
    }
  }
}

function validateCouponContext(
  input: CouponBindingVerificationInput,
): string[] {
  const errors: string[] = []
  if (sha256CanonicalJson(input.terms) !== input.contentHash) {
    errors.push(
      RAZORPAY_BINDING_VERIFICATION_ERRORS.couponHashMismatch,
    )
  }
  if (!isCanonicalHash(input.catalogContentHash)) {
    errors.push(
      RAZORPAY_BINDING_VERIFICATION_ERRORS.couponCatalogHashMissing,
    )
  }
  if (
    input.applicablePlanIds.length !== input.terms.applicablePlanKeys.length ||
    new Set(input.applicablePlanIds).size !== input.applicablePlanIds.length ||
    input.applicablePlanIds.some((planId) => !isRazorpayPlanId(planId))
  ) {
    errors.push(
      RAZORPAY_BINDING_VERIFICATION_ERRORS.couponPlanContextIncomplete,
    )
  }
  if (!isInrPaise(input.terms.discountPaise)) {
    errors.push('Coupon discount must be non-negative safe-integer INR paise')
  }
  if (
    !Number.isSafeInteger(input.terms.discountedBillingCycles) ||
    input.terms.discountedBillingCycles <= 0
  ) {
    errors.push('Coupon discounted billing cycles must be a positive integer')
  }
  for (const [label, value] of [
    ['start', input.terms.startsAt],
    ['end', input.terms.endsAt],
  ] as const) {
    if (
      value !== undefined &&
      (!(value instanceof Date) || Number.isNaN(value.getTime()))
    ) {
      errors.push(`Coupon ${label} time must be a valid date`)
    }
  }
  return errors
}

export function createRazorpayPaymentBindingVerifier(
  options: RazorpayPaymentBindingVerifierOptions,
): PaymentBindingVerifier {
  const now = options.now ?? (() => new Date())

  return {
    async verifyCatalog(input: CatalogBindingVerificationInput) {
      const fetchedAt = now()
      if (sha256CanonicalJson(input.content) !== input.contentHash) {
        return snapshot('failed', fetchedAt, [
          RAZORPAY_BINDING_VERIFICATION_ERRORS.catalogHashMismatch,
        ])
      }

      const localErrors: string[] = []
      const expectedBindings: Array<{
        planKey: PaidPlanKey
        id: string
        amountPaise: number
      }> = []
      for (const planKey of ['plus', 'pro'] as const) {
        const plan = input.content.plans[planKey]
        const id = plan.razorpayPlanIdByMode?.[input.mode]
        if (!id) {
          localErrors.push(
            `${planLabel(planKey)} Plan binding is missing for ${input.mode} mode`,
          )
        } else if (!isRazorpayPlanId(id)) {
          localErrors.push(
            `${planLabel(planKey)} Plan binding is invalid for ${input.mode} mode`,
          )
        } else {
          expectedBindings.push({
            planKey,
            id,
            amountPaise: plan.listPricePaise,
          })
        }
        if (!isInrPaise(plan.listPricePaise)) {
          localErrors.push(
            `${planLabel(planKey)} catalog price must be integer INR paise`,
          )
        }
      }
      if (localErrors.length) {
        return snapshot('failed', fetchedAt, localErrors)
      }

      const resolved = getAdapter(
        options.clientFactory,
        input.mode,
        RAZORPAY_BINDING_VERIFICATION_ERRORS.planProviderUnavailable,
      )
      if ('status' in resolved) {
        return snapshot('unavailable', fetchedAt, [resolved.error])
      }
      if (resolved.adapter.providerMode !== input.mode) {
        return snapshot('failed', fetchedAt, [
          RAZORPAY_BINDING_VERIFICATION_ERRORS.clientModeMismatch,
        ])
      }

      const mismatchErrors: string[] = []
      for (const binding of expectedBindings) {
        const result = await fetchAndComparePlan({
          adapter: resolved.adapter,
          planKey: binding.planKey,
          expectedId: binding.id,
          expectedAmountPaise: binding.amountPaise,
        })
        if (result.status === 'unavailable') {
          return snapshot('unavailable', fetchedAt, result.errors)
        }
        mismatchErrors.push(...result.errors)
      }
      if (mismatchErrors.length) {
        return snapshot('failed', fetchedAt, mismatchErrors)
      }
      return snapshot('verified', fetchedAt, [], input.contentHash)
    },

    async verifyCoupon(input: CouponBindingVerificationInput) {
      const fetchedAt = now()
      const contextErrors = validateCouponContext(input)
      const expectedId = input.terms.razorpayOfferIdByMode[input.mode]
      if (!expectedId) {
        contextErrors.push(
          `Offer binding is missing for ${input.mode} mode`,
        )
      } else if (!isRazorpayOfferId(expectedId)) {
        contextErrors.push(
          `Offer binding is invalid for ${input.mode} mode`,
        )
      }
      if (contextErrors.length || !expectedId) {
        return snapshot('failed', fetchedAt, contextErrors)
      }

      const resolved = getAdapter(
        options.clientFactory,
        input.mode,
        RAZORPAY_BINDING_VERIFICATION_ERRORS.offerProviderUnavailable,
      )
      if ('status' in resolved) {
        return snapshot('unavailable', fetchedAt, [resolved.error])
      }
      if (resolved.adapter.providerMode !== input.mode) {
        return snapshot('failed', fetchedAt, [
          RAZORPAY_BINDING_VERIFICATION_ERRORS.clientModeMismatch,
        ])
      }

      const result = await fetchAndCompareOffer({
        adapter: resolved.adapter,
        verification: input,
        expectedId,
      })
      if (result.status === 'unavailable') {
        return snapshot('unavailable', fetchedAt, result.errors)
      }
      if (result.errors.length) {
        return snapshot('failed', fetchedAt, result.errors)
      }
      return snapshot('verified', fetchedAt, [], input.contentHash)
    },
  }
}
