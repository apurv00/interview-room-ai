import mongoose from 'mongoose'
import { connectDB } from '@shared/db/connection'
import {
  PR7_PREMIUM_RESUME_SALE_READY,
} from '@shared/services/pr7EntitlementRollout'
import {
  savedResumeRepository,
} from '@shared/services/savedResumeRepository'
import { sha256CanonicalJson } from '../lib/canonicalJson'
import { inrPaise, isInrPaise } from '../lib/money'
import {
  CheckoutIntent,
  type CheckoutIntentStatus,
  type ICheckoutQuoteSnapshot,
} from '../models/CheckoutIntent'
import {
  loadRazorpayApiCredentials,
  RazorpayConfigurationError,
} from '../providers/razorpayEnvironment'
import type { ProviderMode } from '../types/catalog'
import {
  CustomerBillingIdempotencyKeySchema,
} from '../validators/customerBilling'
import {
  CheckoutIntentIdempotencyConflictError,
  checkoutIntentRequestHash,
  createOrReuseCheckoutIntent,
  type CheckoutIntentCreationResult,
  type TrustedCheckoutIntentInput,
} from './checkoutIntentService'
import {
  CheckoutBlockedByAccountDeletionError,
  ConsumerBillingFenceConflictError,
} from './consumerBillingFenceService'
import {
  CustomerBillingQuoteUnavailableError,
  resolveCustomerBillingQuote,
  type ResolvedCustomerBillingQuote,
} from './customerBillingQuoteService'
import type { PaymentSaleBlockReason } from './paymentRuntimeGate'
import {
  createOrReuseRemoteCheckout,
  RemoteCheckoutCreationError,
  type RemoteCheckoutCreationResult,
} from './remoteCheckoutCreationService'
import {
  resolveSubscriptionCheckoutSaleContext,
  SubscriptionCheckoutError,
  type SubscriptionCheckoutSaleContext,
} from './subscriptionCheckoutService'

export const PR7_ONE_TIME_CHECKOUT_READY = false as const

export type OneTimeCheckoutSku =
  | 'single_interview'
  | 'premium_resume'

export interface OneTimeCheckoutInput {
  userId: string
  idempotencyKey: string
  request:
    | {
        sku: 'single_interview'
        resumeId?: never
      }
    | {
        sku: 'premium_resume'
        resumeId: string
      }
}

export interface OneTimeCheckoutQuote {
  quoteId: string
  expiresAt: string
  catalogVersion: string
  sku: OneTimeCheckoutSku
  currency: 'INR'
  gstInclusive: true
  gstRatePercent: 18
  listPricePaise: number
  discountPaise: 0
  payablePaise: number
  disclosure: {
    summary: string
    why: string
    gst: 'GST included.'
  }
  entitlementSummary: Readonly<Record<string, unknown>>
}

export interface OneTimeCheckoutResult {
  intentId: string
  providerMode: ProviderMode
  intentStatus: 'remote_created'
  reused: boolean
  checkout: {
    keyId: string
    orderId: string
  }
  quote: OneTimeCheckoutQuote
}

export const ONE_TIME_CHECKOUT_ERROR_CODES = [
  'invalid_request',
  'sale_blocked',
  'buyer_unavailable',
  'billing_profile_required',
  'resume_unavailable',
  'commercial_unavailable',
  'idempotency_conflict',
  'provider_unavailable',
  'review_required',
  'persistence_conflict',
] as const
export type OneTimeCheckoutErrorCode =
  (typeof ONE_TIME_CHECKOUT_ERROR_CODES)[number]

export class OneTimeCheckoutError extends Error {
  readonly saleBlockReason?: PaymentSaleBlockReason

  constructor(
    readonly code: OneTimeCheckoutErrorCode,
    message: string,
    options?: ErrorOptions & {
      saleBlockReason?: PaymentSaleBlockReason
    },
  ) {
    super(message, options)
    this.name = 'OneTimeCheckoutError'
    this.saleBlockReason = options?.saleBlockReason
  }
}

export interface StoredOneTimeCheckoutIntent {
  id: mongoose.Types.ObjectId
  userId: mongoose.Types.ObjectId
  kind: OneTimeCheckoutSku
  providerMode: ProviderMode
  status: CheckoutIntentStatus
  sku?: OneTimeCheckoutSku
  planKey?: unknown
  purpose?: unknown
  planChangeRequestId?: unknown
  leaseLane?: unknown
  requestedStartAt?: unknown
  authorizationExpiresAt?: unknown
  catalogVersion: string
  idempotencyKey: string
  requestHash: string
  receipt: string
  quote: ICheckoutQuoteSnapshot
  buyerSnapshot: Readonly<Record<string, unknown>>
  razorpayOrderId?: string
  razorpaySubscriptionId?: string
}

export interface OneTimeCheckoutDependencies {
  oneTimeCheckoutReady?: boolean
  premiumResumeSaleReady?: boolean
  resolveSaleContext?: typeof resolveSubscriptionCheckoutSaleContext
  resolveQuote?: typeof resolveCustomerBillingQuote
  ownsResume?: (input: {
    userId: string
    resumeId: string
  }) => boolean | Promise<boolean>
  createIntent?: typeof createOrReuseCheckoutIntent
  loadIntent?: (input: {
    intentId: string
    userId: string
  }) => Promise<StoredOneTimeCheckoutIntent | null>
  createRemote?: typeof createOrReuseRemoteCheckout
  loadKeyId?: (providerMode: ProviderMode) => string
}

interface NormalizedOneTimeCheckoutInput {
  userId: string
  idempotencyKey: string
  sku: OneTimeCheckoutSku
  resumeId?: string
}

interface OneTimeCommercialEvidence {
  quoteSnapshot: ICheckoutQuoteSnapshot
  publicQuote: OneTimeCheckoutQuote
}

interface LeanOneTimeCheckoutIntent {
  _id: mongoose.Types.ObjectId
  userId: mongoose.Types.ObjectId
  kind: OneTimeCheckoutSku
  providerMode: ProviderMode
  status: CheckoutIntentStatus
  sku?: OneTimeCheckoutSku
  planKey?: unknown
  purpose?: unknown
  planChangeRequestId?: unknown
  leaseLane?: unknown
  requestedStartAt?: unknown
  authorizationExpiresAt?: unknown
  catalogVersion: string
  idempotencyKey: string
  requestHash: string
  receipt: string
  quoteSnapshot: ICheckoutQuoteSnapshot
  buyerSnapshot: Readonly<Record<string, unknown>>
  razorpayOrderId?: string
  razorpaySubscriptionId?: string
}

function failure(
  code: OneTimeCheckoutErrorCode,
  message: string,
  options?: ErrorOptions & {
    saleBlockReason?: PaymentSaleBlockReason
  },
): OneTimeCheckoutError {
  return new OneTimeCheckoutError(code, message, options)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(
    value &&
    typeof value === 'object' &&
    !Array.isArray(value),
  )
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort()
  const sortedExpected = [...expected].sort()
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  )
}

function sameCanonical(left: unknown, right: unknown): boolean {
  try {
    return sha256CanonicalJson(left) === sha256CanonicalJson(right)
  } catch {
    return false
  }
}

function normalizeInput(
  input: OneTimeCheckoutInput,
): NormalizedOneTimeCheckoutInput {
  if (
    !isRecord(input) ||
    !/^[a-fA-F0-9]{24}$/.test(input.userId)
  ) {
    throw failure(
      'invalid_request',
      'Authenticated one-time checkout identity is invalid',
    )
  }
  const idempotencyKey =
    CustomerBillingIdempotencyKeySchema.safeParse(input.idempotencyKey)
  const request = input.request
  if (!idempotencyKey.success || !isRecord(request)) {
    throw failure(
      'invalid_request',
      'One-time checkout selection is invalid',
    )
  }
  if (
    request.sku === 'single_interview' &&
    hasExactKeys(request, ['sku'])
  ) {
    return {
      userId: input.userId.toLowerCase(),
      idempotencyKey: idempotencyKey.data,
      sku: 'single_interview',
    }
  }
  if (
    request.sku === 'premium_resume' &&
    hasExactKeys(request, ['sku', 'resumeId']) &&
    typeof request.resumeId === 'string'
  ) {
    const resumeId = request.resumeId.trim()
    if (resumeId.length >= 1 && resumeId.length <= 255) {
      return {
        userId: input.userId.toLowerCase(),
        idempotencyKey: idempotencyKey.data,
        sku: 'premium_resume',
        resumeId,
      }
    }
  }
  throw failure(
    'invalid_request',
    'One-time checkout target is invalid',
  )
}

async function defaultOwnsResume(input: {
  userId: string
  resumeId: string
}): Promise<boolean> {
  const identity = await savedResumeRepository.inspectIdentity(
    input.userId,
    input.resumeId,
    { maxTimeMS: 1_000 },
  )
  return identity?.status === 'exact'
}

function validCatalogControlPlane(
  resolved: ResolvedCustomerBillingQuote,
): boolean {
  const catalog = resolved.catalog
  return (
    catalog.status === 'published' &&
    resolved.context.activeCatalogVersion === catalog.version &&
    resolved.context.catalog?.version === catalog.version &&
    resolved.context.catalog.contentHash === catalog.contentHash &&
    catalog.validation?.contentHash === catalog.contentHash &&
    catalog.validation.errors.length === 0 &&
    catalog.approval?.contentHash === catalog.contentHash &&
    catalog.content.currency === 'INR' &&
    catalog.content.gstInclusive === true &&
    catalog.content.gstRatePercent === 18
  )
}

function validOneTimeProduct(
  resolved: ResolvedCustomerBillingQuote,
  sku: OneTimeCheckoutSku,
): boolean {
  const product = resolved.catalog.content.oneTimeProducts[sku]
  if (
    product.key !== sku ||
    product.billing !== 'one_time' ||
    product.couponEligible !== false ||
    !isInrPaise(product.listPricePaise) ||
    product.listPricePaise <= 0
  ) return false

  if (sku === 'single_interview') {
    const entitlement =
      resolved.catalog.content.oneTimeProducts.single_interview.entitlement
    return (
      entitlement.interviews === 1 &&
      entitlement.maxDurationMinutes === 30 &&
      entitlement.validityDaysBeforeUse === 30 &&
      entitlement.analysisAndReplayIncluded === true
    )
  }
  const entitlement =
    resolved.catalog.content.oneTimeProducts.premium_resume.entitlement
  return (
    entitlement.premiumSavedResumeVersions === 1 &&
    entitlement.revisionWindowDays === 7 &&
    entitlement.revisionWindowStartsAt === 'first_successful_render'
  )
}

function commercialEvidence(input: {
  resolved: ResolvedCustomerBillingQuote
  sale: SubscriptionCheckoutSaleContext
  checkout: NormalizedOneTimeCheckoutInput
}): OneTimeCommercialEvidence {
  const { resolved, sale, checkout } = input
  const { quote } = resolved
  const product =
    resolved.catalog.content.oneTimeProducts[checkout.sku]
  const expectedEntitlementSummary = {
    kind: checkout.sku,
    displayName: product.displayName,
    entitlement: product.entitlement,
  }
  const expiresAt = new Date(quote.expiresAt)
  if (
    resolved.providerMode !== sale.providerMode ||
    !validCatalogControlPlane(resolved) ||
    !validOneTimeProduct(resolved, checkout.sku) ||
    quote.catalogVersion !== resolved.catalog.version ||
    quote.sku !== checkout.sku ||
    quote.planKey !== undefined ||
    quote.currency !== 'INR' ||
    quote.gstInclusive !== true ||
    quote.gstRatePercent !== 18 ||
    quote.listPricePaise !== product.listPricePaise ||
    quote.discountPaise !== 0 ||
    quote.payablePaise !== product.listPricePaise ||
    quote.nextChargePaise !== undefined ||
    quote.renewalPricePaise !== undefined ||
    quote.discountedBillingCycles !== undefined ||
    quote.coupon !== undefined ||
    quote.manualCodeResult !== undefined ||
    resolved.selectedCandidate !== undefined ||
    !sameCanonical(
      quote.entitlementSummary,
      expectedEntitlementSummary,
    ) ||
    typeof quote.quoteId !== 'string' ||
    quote.quoteId.trim().length === 0 ||
    Number.isNaN(expiresAt.getTime())
  ) {
    throw failure(
      'commercial_unavailable',
      'Published one-time product terms are inconsistent',
    )
  }

  const entitlementSnapshot =
    checkout.sku === 'single_interview'
      ? {
          sku: 'single_interview' as const,
          maxInterviewDurationMinutes: 30 as const,
          validityDaysBeforeUse: 30 as const,
        }
      : {
          sku: 'premium_resume' as const,
          resumeId: checkout.resumeId!,
          revisionWindowDays: 7 as const,
        }
  return {
    quoteSnapshot: {
      currency: 'INR',
      listPricePaise: inrPaise(product.listPricePaise),
      discountPaise: inrPaise(0),
      payablePaise: inrPaise(product.listPricePaise),
      gst: {
        inclusive: true,
        rateBps: 1_800,
        componentAllocation: 'unallocated',
      },
      entitlementSnapshot,
    },
    publicQuote: {
      quoteId: quote.quoteId,
      expiresAt: quote.expiresAt,
      catalogVersion: quote.catalogVersion,
      sku: checkout.sku,
      currency: 'INR',
      gstInclusive: true,
      gstRatePercent: 18,
      listPricePaise: quote.listPricePaise,
      discountPaise: 0,
      payablePaise: quote.payablePaise,
      disclosure: structuredClone(quote.disclosure),
      entitlementSummary: structuredClone(quote.entitlementSummary),
    },
  }
}

async function defaultLoadIntent(input: {
  intentId: string
  userId: string
}): Promise<StoredOneTimeCheckoutIntent | null> {
  if (
    !/^[a-fA-F0-9]{24}$/.test(input.intentId) ||
    !/^[a-fA-F0-9]{24}$/.test(input.userId)
  ) return null
  await connectDB()
  const intent = await CheckoutIntent.findOne({
    _id: new mongoose.Types.ObjectId(input.intentId),
    userId: new mongoose.Types.ObjectId(input.userId),
    kind: { $in: ['single_interview', 'premium_resume'] },
  }).select([
    '_id',
    'userId',
    'kind',
    'providerMode',
    'status',
    'sku',
    'planKey',
    'purpose',
    'planChangeRequestId',
    'leaseLane',
    'requestedStartAt',
    'authorizationExpiresAt',
    'catalogVersion',
    'idempotencyKey',
    'requestHash',
    'receipt',
    'quoteSnapshot',
    'buyerSnapshot',
    'razorpayOrderId',
    'razorpaySubscriptionId',
  ].join(' ')).lean<LeanOneTimeCheckoutIntent>()
  return intent
    ? {
        id: intent._id,
        userId: intent.userId,
        kind: intent.kind,
        providerMode: intent.providerMode,
        status: intent.status,
        sku: intent.sku,
        planKey: intent.planKey,
        purpose: intent.purpose,
        planChangeRequestId: intent.planChangeRequestId,
        leaseLane: intent.leaseLane,
        requestedStartAt: intent.requestedStartAt,
        authorizationExpiresAt: intent.authorizationExpiresAt,
        catalogVersion: intent.catalogVersion,
        idempotencyKey: intent.idempotencyKey,
        requestHash: intent.requestHash,
        receipt: intent.receipt,
        quote: intent.quoteSnapshot,
        buyerSnapshot: intent.buyerSnapshot,
        razorpayOrderId: intent.razorpayOrderId,
        razorpaySubscriptionId: intent.razorpaySubscriptionId,
      }
    : null
}

function trustedIntentInput(input: {
  checkout: NormalizedOneTimeCheckoutInput
  sale: SubscriptionCheckoutSaleContext
  commercial: OneTimeCommercialEvidence
}): TrustedCheckoutIntentInput {
  return {
    userId: input.checkout.userId,
    kind: input.checkout.sku,
    providerMode: input.sale.providerMode,
    sku: input.checkout.sku,
    catalogVersion: input.commercial.publicQuote.catalogVersion,
    idempotencyKey: input.checkout.idempotencyKey,
    quoteSnapshot: input.commercial.quoteSnapshot,
    buyerSnapshot: input.sale.buyerSnapshot,
  }
}

function premiumResumeTarget(
  snapshot: unknown,
): string | undefined {
  if (
    !isRecord(snapshot) ||
    snapshot.sku !== 'premium_resume' ||
    typeof snapshot.resumeId !== 'string'
  ) return undefined
  return snapshot.resumeId
}

function assertStoredIntent(input: {
  stored: StoredOneTimeCheckoutIntent | null
  checkout: NormalizedOneTimeCheckoutInput
  sale: SubscriptionCheckoutSaleContext
  commercial: OneTimeCommercialEvidence
  local: CheckoutIntentCreationResult
  afterRemote?: string
}): asserts input is typeof input & {
  stored: StoredOneTimeCheckoutIntent
} {
  const { stored, checkout, sale, commercial, local } = input
  if (
    checkout.sku === 'premium_resume' &&
    stored &&
    premiumResumeTarget(stored.quote.entitlementSnapshot) !==
      checkout.resumeId
  ) {
    throw failure(
      'idempotency_conflict',
      'Idempotency-Key belongs to a different premium resume',
    )
  }
  const expectedRequestHash = checkoutIntentRequestHash(
    trustedIntentInput({ checkout, sale, commercial }),
  )
  const expectedRemoteId = input.afterRemote
  const validRemoteState = expectedRemoteId === undefined
    ? (
        stored?.status === 'created'
          ? stored.razorpayOrderId === undefined
          : stored?.status === 'remote_created' &&
            /^order_[A-Za-z0-9]+$/.test(
              stored.razorpayOrderId ?? '',
            )
      )
    : (
        stored?.status === 'remote_created' &&
        stored.razorpayOrderId === expectedRemoteId
      )
  if (
    !stored ||
    !stored.id.equals(local.intentId) ||
    !stored.userId.equals(checkout.userId) ||
    stored.kind !== checkout.sku ||
    stored.sku !== checkout.sku ||
    stored.providerMode !== sale.providerMode ||
    stored.catalogVersion !== commercial.publicQuote.catalogVersion ||
    stored.idempotencyKey !== checkout.idempotencyKey ||
    stored.requestHash !== expectedRequestHash ||
    local.requestHash !== expectedRequestHash ||
    stored.receipt !== local.receipt ||
    stored.planKey !== undefined ||
    stored.purpose !== undefined ||
    stored.planChangeRequestId !== undefined ||
    stored.leaseLane !== undefined ||
    stored.requestedStartAt !== undefined ||
    stored.authorizationExpiresAt !== undefined ||
    stored.razorpaySubscriptionId !== undefined ||
    !sameCanonical(stored.quote, commercial.quoteSnapshot) ||
    !validRemoteState
  ) {
    throw failure(
      'persistence_conflict',
      'One-time checkout intent could not be reloaded coherently',
    )
  }
}

function assertRemoteResult(input: {
  remote: RemoteCheckoutCreationResult
  local: CheckoutIntentCreationResult
  checkout: NormalizedOneTimeCheckoutInput
  sale: SubscriptionCheckoutSaleContext
}): void {
  if (
    input.remote.intentId !== input.local.intentId ||
    input.remote.providerMode !== input.sale.providerMode ||
    input.remote.kind !== input.checkout.sku ||
    !/^order_[A-Za-z0-9]+$/.test(input.remote.remoteId)
  ) {
    throw failure(
      'persistence_conflict',
      'Razorpay Order result does not match the trusted checkout intent',
    )
  }
}

function mapKnownFailure(error: unknown): never {
  if (error instanceof OneTimeCheckoutError) throw error
  if (error instanceof SubscriptionCheckoutError) {
    const supported = new Set<OneTimeCheckoutErrorCode>([
      'invalid_request',
      'sale_blocked',
      'buyer_unavailable',
      'billing_profile_required',
      'commercial_unavailable',
      'idempotency_conflict',
      'provider_unavailable',
      'review_required',
      'persistence_conflict',
    ])
    throw failure(
      supported.has(error.code as OneTimeCheckoutErrorCode)
        ? error.code as OneTimeCheckoutErrorCode
        : 'persistence_conflict',
      error.message,
      {
        cause: error,
        ...(error.saleBlockReason
          ? { saleBlockReason: error.saleBlockReason }
          : {}),
      },
    )
  }
  if (error instanceof CheckoutIntentIdempotencyConflictError) {
    throw failure(
      'idempotency_conflict',
      'Idempotency-Key belongs to a different checkout selection',
      { cause: error },
    )
  }
  if (error instanceof CheckoutBlockedByAccountDeletionError) {
    throw failure(
      'sale_blocked',
      'Checkout is unavailable while account deletion is pending',
      {
        cause: error,
        saleBlockReason: 'buyer_deletion_pending',
      },
    )
  }
  if (error instanceof ConsumerBillingFenceConflictError) {
    throw failure(
      'review_required',
      'One-time checkout requires reconciliation',
      { cause: error },
    )
  }
  if (error instanceof CustomerBillingQuoteUnavailableError) {
    throw failure(
      error.code === 'buyer_unavailable'
        ? 'buyer_unavailable'
        : 'commercial_unavailable',
      'One-time pricing is temporarily unavailable',
      { cause: error },
    )
  }
  if (error instanceof RemoteCheckoutCreationError) {
    if (error.code === 'sale_blocked') {
      throw failure(
        'sale_blocked',
        'One-time checkout is currently disabled',
        {
          cause: error,
          saleBlockReason: error.saleBlockReason,
        },
      )
    }
    if (error.code === 'provider_unavailable') {
      throw failure(
        'provider_unavailable',
        'Razorpay checkout is temporarily unavailable',
        { cause: error },
      )
    }
    if (
      error.code === 'remote_mismatch' ||
      error.code === 'reconciliation_conflict' ||
      error.code === 'persistence_conflict'
    ) {
      throw failure(
        'review_required',
        'One-time checkout requires reconciliation',
        { cause: error },
      )
    }
    throw failure(
      'persistence_conflict',
      'Razorpay Order could not be created coherently',
      { cause: error },
    )
  }
  if (error instanceof RazorpayConfigurationError) {
    throw failure(
      'provider_unavailable',
      'Razorpay checkout is temporarily unavailable',
      { cause: error },
    )
  }
  throw failure(
    'persistence_conflict',
    'One-time checkout could not be created coherently',
    { cause: error },
  )
}

/**
 * Authenticated one-time checkout orchestration. The caller selects only a
 * supported SKU and, for premium resumes, an owned saved-resume identity.
 * Prices, GST, entitlements, provider mode, and Razorpay amount are loaded
 * exclusively from trusted server state.
 */
export async function createOneTimeCheckout(
  unparsedInput: OneTimeCheckoutInput,
  dependencies: OneTimeCheckoutDependencies = {},
): Promise<OneTimeCheckoutResult> {
  try {
    if (
      (dependencies.oneTimeCheckoutReady ??
        PR7_ONE_TIME_CHECKOUT_READY) !== true
    ) {
      throw failure(
        'sale_blocked',
        'One-time checkout is not ready',
        { saleBlockReason: 'remote_creation_not_ready' },
      )
    }
    const checkout = normalizeInput(unparsedInput)
    if (
      checkout.sku === 'premium_resume' &&
      (
        dependencies.premiumResumeSaleReady ??
        PR7_PREMIUM_RESUME_SALE_READY
      ) !== true
    ) {
      throw failure(
        'sale_blocked',
        'Premium resume checkout prerequisites are not ready',
        { saleBlockReason: 'remote_creation_not_ready' },
      )
    }
    const resolveSale = dependencies.resolveSaleContext ??
      resolveSubscriptionCheckoutSaleContext
    const sale = await resolveSale(checkout.userId)

    if (checkout.sku === 'premium_resume') {
      const ownsResume = dependencies.ownsResume ?? defaultOwnsResume
      if (!await ownsResume({
        userId: checkout.userId,
        resumeId: checkout.resumeId!,
      })) {
        throw failure(
          'resume_unavailable',
          'Premium resume target was not found for this user',
        )
      }
    }

    const resolveQuote =
      dependencies.resolveQuote ?? resolveCustomerBillingQuote
    const resolved = await resolveQuote({
      userId: checkout.userId,
      request: {
        sku: checkout.sku,
        surface: 'checkout',
      },
    })
    const commercial = commercialEvidence({
      resolved,
      sale,
      checkout,
    })
    const trustedInput = trustedIntentInput({
      checkout,
      sale,
      commercial,
    })
    const createIntent =
      dependencies.createIntent ?? createOrReuseCheckoutIntent
    const local = await createIntent(trustedInput)
    const loadIntent = dependencies.loadIntent ?? defaultLoadIntent
    const loadInput = {
      intentId: local.intentId,
      userId: checkout.userId,
    }
    const storedBeforeRemote = await loadIntent(loadInput)
    assertStoredIntent({
      stored: storedBeforeRemote,
      checkout,
      sale,
      commercial,
      local,
    })

    const createRemote =
      dependencies.createRemote ?? createOrReuseRemoteCheckout
    const remote = await createRemote(loadInput)
    assertRemoteResult({ remote, local, checkout, sale })

    const storedAfterRemote = await loadIntent(loadInput)
    assertStoredIntent({
      stored: storedAfterRemote,
      checkout,
      sale,
      commercial,
      local,
      afterRemote: remote.remoteId,
    })

    const loadKeyId = dependencies.loadKeyId ??
      ((mode: ProviderMode) => loadRazorpayApiCredentials(mode).keyId)
    const keyId = loadKeyId(sale.providerMode)
    const expectedKeyPrefix =
      sale.providerMode === 'test' ? 'rzp_test_' : 'rzp_live_'
    if (!keyId.startsWith(expectedKeyPrefix)) {
      throw failure(
        'provider_unavailable',
        'Razorpay public key does not match the checkout mode',
      )
    }
    return {
      intentId: local.intentId,
      providerMode: sale.providerMode,
      intentStatus: 'remote_created',
      reused: local.reused || remote.reused,
      checkout: {
        keyId,
        orderId: remote.remoteId,
      },
      quote: commercial.publicQuote,
    }
  } catch (error) {
    return mapKnownFailure(error)
  }
}
