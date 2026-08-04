import type { ProviderMode } from '../types/catalog'
import type { CustomerBillingQuoteRequest } from '../validators/customerBilling'
import {
  resolveCustomerBillingQuote,
  type CustomerBillingQuote,
  type ResolvedCustomerBillingQuote,
} from './customerBillingQuoteService'

const OBJECT_ID_PATTERN = /^[a-f0-9]{24}$/
const MIN_PLAN_DISCOUNT_PAISE = 5_000
const MAX_PLAN_DISCOUNT_PAISE = 20_000

export class InterviewLimitQuoteError extends Error {
  constructor(
    readonly code:
      | 'invalid_request'
      | 'quote_unavailable'
      | 'quote_conflict',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'InterviewLimitQuoteError'
  }
}

export interface InterviewLimitQuoteBundle {
  catalogVersion: string
  providerMode: ProviderMode | null
  quotes: {
    plus: CustomerBillingQuote
    pro: CustomerBillingQuote
    singleInterview: CustomerBillingQuote
  }
}

export interface InterviewLimitQuoteDependencies {
  now?: () => Date
  resolveQuote?: (input: {
    userId: string
    request: CustomerBillingQuoteRequest
  }) => Promise<ResolvedCustomerBillingQuote>
}

function failure(
  code: InterviewLimitQuoteError['code'],
  message: string,
  cause?: unknown,
): InterviewLimitQuoteError {
  return new InterviewLimitQuoteError(
    code,
    message,
    cause === undefined ? undefined : { cause },
  )
}

function safeMoney(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0
  )
}

function validCommonQuote(
  quote: CustomerBillingQuote,
  now: Date,
): boolean {
  const expiresAt = new Date(quote.expiresAt)
  return (
    typeof quote.quoteId === 'string' &&
    quote.quoteId.length > 0 &&
    typeof quote.catalogVersion === 'string' &&
    quote.catalogVersion.length > 0 &&
    quote.currency === 'INR' &&
    quote.gstInclusive === true &&
    quote.gstRatePercent === 18 &&
    safeMoney(quote.listPricePaise) &&
    safeMoney(quote.discountPaise) &&
    safeMoney(quote.payablePaise) &&
    quote.discountPaise <= quote.listPricePaise &&
    quote.payablePaise ===
      quote.listPricePaise - quote.discountPaise &&
    Number.isFinite(expiresAt.getTime()) &&
    expiresAt.toISOString() === quote.expiresAt &&
    expiresAt > now
  )
}

function validPlanQuote(
  quote: CustomerBillingQuote,
  planKey: 'plus' | 'pro',
  now: Date,
): boolean {
  return (
    validCommonQuote(quote, now) &&
    quote.planKey === planKey &&
    quote.sku === undefined &&
    (
      quote.discountPaise === 0 ||
      (
        quote.discountPaise >=
          MIN_PLAN_DISCOUNT_PAISE &&
        quote.discountPaise <=
          MAX_PLAN_DISCOUNT_PAISE
      )
    ) &&
    (
      quote.discountPaise > 0
        ? quote.coupon !== undefined
        : quote.coupon === undefined
    )
  )
}

function validSingleInterviewQuote(
  quote: CustomerBillingQuote,
  now: Date,
): boolean {
  return (
    validCommonQuote(quote, now) &&
    quote.sku === 'single_interview' &&
    quote.planKey === undefined &&
    quote.discountPaise === 0 &&
    quote.payablePaise === quote.listPricePaise &&
    quote.coupon === undefined &&
    quote.manualCodeResult === undefined &&
    quote.discountedBillingCycles === undefined
  )
}

/**
 * Resolves the three server-owned paywall quotes as one fail-closed bundle.
 * The underlying catalog rows are immutable; a concurrent catalog publish is
 * detected by the exact version check and no partial quote set is returned.
 */
export async function resolveInterviewLimitQuoteBundle(
  input: { userId: unknown },
  dependencies: InterviewLimitQuoteDependencies = {},
): Promise<InterviewLimitQuoteBundle> {
  if (
    typeof input.userId !== 'string' ||
    !OBJECT_ID_PATTERN.test(input.userId)
  ) {
    throw failure(
      'invalid_request',
      'Quote userId must be a canonical ObjectId',
    )
  }
  const now = (dependencies.now ?? (() => new Date()))()
  if (
    !(now instanceof Date) ||
    !Number.isFinite(now.getTime())
  ) {
    throw failure(
      'invalid_request',
      'Quote clock returned an invalid date',
    )
  }
  const resolveQuote =
    dependencies.resolveQuote ?? resolveCustomerBillingQuote
  let resolved:
    [
      ResolvedCustomerBillingQuote,
      ResolvedCustomerBillingQuote,
      ResolvedCustomerBillingQuote,
    ]
  try {
    resolved = await Promise.all([
      resolveQuote({
        userId: input.userId,
        request: {
          planKey: 'plus',
          surface: 'interviewPaywall',
        },
      }),
      resolveQuote({
        userId: input.userId,
        request: {
          planKey: 'pro',
          surface: 'interviewPaywall',
        },
      }),
      resolveQuote({
        userId: input.userId,
        request: {
          sku: 'single_interview',
          surface: 'interviewPaywall',
        },
      }),
    ])
  } catch (error) {
    throw failure(
      'quote_unavailable',
      'Interview limit quotes are unavailable',
      error,
    )
  }
  const [plus, pro, singleInterview] = resolved
  const versions = new Set(
    resolved.map((entry) => entry.quote.catalogVersion),
  )
  const modes = new Set(
    resolved.map((entry) => entry.providerMode),
  )
  if (
    versions.size !== 1 ||
    modes.size !== 1 ||
    !validPlanQuote(plus.quote, 'plus', now) ||
    !validPlanQuote(pro.quote, 'pro', now) ||
    !validSingleInterviewQuote(
      singleInterview.quote,
      now,
    )
  ) {
    throw failure(
      'quote_conflict',
      'Interview limit quotes are not one coherent server snapshot',
    )
  }
  return {
    catalogVersion: plus.quote.catalogVersion,
    providerMode: plus.providerMode,
    quotes: {
      plus: plus.quote,
      pro: pro.quote,
      singleInterview: singleInterview.quote,
    },
  }
}
