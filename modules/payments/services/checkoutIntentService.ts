import mongoose, { type ClientSession } from 'mongoose'
import { connectDB } from '@shared/db/connection'
import { sha256CanonicalJson } from '../lib/canonicalJson'
import {
  CheckoutIntent,
  type CheckoutIntentKind,
  type CheckoutIntentPurpose,
  type ICheckoutQuoteSnapshot,
} from '../models/CheckoutIntent'
import {
  ConsumerSubscriptionLease,
  consumerSubscriptionLeaseBlocksCheckout,
  type ConsumerSubscriptionLeaseLane,
} from '../models/ConsumerSubscriptionLease'
import { ConsumerBillingFence } from '../models/ConsumerBillingFence'
import type { ProviderMode } from '../types/catalog'
import {
  CustomerBillingIdempotencyKeySchema,
} from '../validators/customerBilling'
import {
  CheckoutBlockedByAccountDeletionError,
  ConsumerBillingFenceConflictError,
  claimConsumerBillingFenceForCheckout,
  mongoConsumerBillingFenceMutationStore,
} from './consumerBillingFenceService'
import {
  CouponReservationConcurrencyError,
  reserveCouponCapacityInSession,
  type ReserveCouponCapacityInput,
} from './couponReservationService'
import type {
  CapturedCommercialAnalyticsEvidence,
} from './capturedCheckoutVerificationService'
export class CheckoutIntentIdempotencyConflictError extends Error {
  constructor() {
    super('Idempotency-Key was already used for a different checkout request')
    this.name = 'CheckoutIntentIdempotencyConflictError'
  }
}
export class ConsumerSubscriptionCheckoutBlockedError extends Error {
  constructor() {
    super('An existing subscription checkout or mandate requires reconciliation')
    this.name = 'ConsumerSubscriptionCheckoutBlockedError'
  }
}
export class CheckoutCouponCapacityUnavailableError extends Error {
  constructor(
    readonly outcome:
      | 'global_cap_exhausted'
      | 'user_cap_exhausted',
  ) {
    super('The selected coupon no longer has reservable capacity')
    this.name = 'CheckoutCouponCapacityUnavailableError'
  }
}
export const ACQUISITION_AUTHORIZATION_TTL_SECONDS = 86_400 as const
export type TrustedCheckoutCouponReservationInput = Omit<
  ReserveCouponCapacityInput,
  | 'providerMode'
  | 'userId'
  | 'checkoutIntentId'
  | 'catalogVersion'
  | 'planKey'
  | 'reservedAt'
>
export interface TrustedCheckoutIntentInput {
  userId: string
  kind: CheckoutIntentKind
  providerMode: ProviderMode
  /**
   * Future subscription sagas allocate the Mongo identity before creating
   * the intent so the durable PlanChangeRequest can point at one exact row.
   * Acquisition and one-time checkouts continue to allocate locally.
   */
  preallocatedIntentId?: string
  purpose?: CheckoutIntentPurpose
  planChangeRequestId?: string
  leaseLane?: ConsumerSubscriptionLeaseLane
  requestedStartAt?: Date
  authorizationExpiresAt?: Date
  planKey?: 'plus' | 'pro'
  sku?: 'single_interview' | 'premium_resume'
  /**
   * Normalized customer selection used only for idempotency. Mutable server
   * economics are deliberately excluded so a retry reuses the original
   * immutable intent after a catalog, campaign, or buyer-state change.
   */
  manualCouponCode?: string
  catalogVersion: string
  idempotencyKey: string
  quoteSnapshot: ICheckoutQuoteSnapshot
  buyerSnapshot: Readonly<Record<string, unknown>>
  couponReservation?: TrustedCheckoutCouponReservationInput
}
export interface CheckoutIntentCreationResult {
  intentId: string
  receipt: string
  requestHash: string
  status: 'created' | string
  reused: boolean
  authorizationExpiresAt?: Date
}
export interface CheckoutIntentCreatedCommercialAnalyticsProducer {
  appendCheckoutIntentCreatedInSession(
    evidence: () => CapturedCommercialAnalyticsEvidence,
    session: ClientSession,
  ): Promise<void>
}
interface StoredCheckoutIntent {
  _id: mongoose.Types.ObjectId
  requestHash: string
  receipt: string
  status: string
  authorizationExpiresAt?: Date
}
interface CheckoutIntentDraft {
  _id: mongoose.Types.ObjectId
  userId: mongoose.Types.ObjectId
  kind: CheckoutIntentKind
  providerMode: ProviderMode
  purpose?: CheckoutIntentPurpose
  planChangeRequestId?: mongoose.Types.ObjectId
  leaseLane?: ConsumerSubscriptionLeaseLane
  requestedStartAt?: Date
  authorizationExpiresAt?: Date
  planKey?: 'plus' | 'pro'
  sku?: 'single_interview' | 'premium_resume'
  catalogVersion: string
  idempotencyKey: string
  requestHash: string
  quoteSnapshot: ICheckoutQuoteSnapshot
  buyerSnapshot: Readonly<Record<string, unknown>>
  status: 'created'
  receipt: string
}
export interface CheckoutIntentStore {
  createOrReuse(
    draft: CheckoutIntentDraft,
    couponReservation?: ReserveCouponCapacityInput,
    producer?: CheckoutIntentCreatedCommercialAnalyticsProducer,
  ): Promise<CheckoutIntentCreationResult>
}
function isExactEpochSecond(value: unknown): value is Date {
  return (
    value instanceof Date &&
    Number.isFinite(value.getTime()) &&
    value.getMilliseconds() === 0
  )
}

function oneCalendarMonthAfter(value: Date): Date {
  const targetYear = value.getUTCFullYear()
  const targetMonth = value.getUTCMonth() + 1
  const targetDay = value.getUTCDate()
  const lastTargetDay = new Date(Date.UTC(
    targetYear,
    targetMonth + 1,
    0,
  )).getUTCDate()
  return new Date(Date.UTC(
    targetYear,
    targetMonth,
    Math.min(targetDay, lastTargetDay),
    value.getUTCHours(),
    value.getUTCMinutes(),
    value.getUTCSeconds(),
  ))
}
function assertCheckoutTarget(input: TrustedCheckoutIntentInput): void {
  if (input.kind === 'subscription') {
    if (
      (input.planKey !== 'plus' && input.planKey !== 'pro') ||
      input.sku !== undefined
    ) {
      throw new TypeError('Subscription checkout requires one paid plan')
    }
    if (!input.purpose || !input.leaseLane) {
      throw new TypeError(
        'Subscription checkout requires trusted purpose and lease lane',
      )
    }
    if (input.purpose === 'acquisition') {
      if (
        input.preallocatedIntentId !== undefined ||
        input.leaseLane !== 'a' ||
        input.planChangeRequestId !== undefined ||
        input.requestedStartAt !== undefined ||
        input.authorizationExpiresAt !== undefined
      ) {
        throw new TypeError(
          'Acquisition checkout requires lane a and server-owned authorization expiry',
        )
      }
    } else if (
      !input.preallocatedIntentId ||
      !/^[a-fA-F0-9]{24}$/.test(input.preallocatedIntentId) ||
      !input.planChangeRequestId ||
      !/^[a-fA-F0-9]{24}$/.test(input.planChangeRequestId) ||
      !isExactEpochSecond(input.requestedStartAt) ||
      !isExactEpochSecond(input.authorizationExpiresAt) ||
      input.authorizationExpiresAt >= input.requestedStartAt
    ) {
      throw new TypeError(
        'Future subscription checkout requires exact durable lineage and timing',
      )
    }
    const quote = input.quoteSnapshot
    const reservation = input.couponReservation
    const hasCampaign = quote.couponCampaignId !== undefined
    const hasRevision = quote.couponCampaignRevision !== undefined
    const hasCycles = quote.discountedBillingCycles !== undefined
    if (
      quote.discountPaise > 0
        ? (
            !reservation ||
            !hasCampaign ||
            !hasRevision ||
            !hasCycles ||
            quote.couponCampaignId?.toString() !==
              reservation.campaignId ||
            quote.couponCampaignRevision !==
              reservation.campaignRevision ||
            quote.discountPaise !== reservation.discountPaise ||
            quote.discountedBillingCycles !==
              reservation.discountedBillingCycles ||
            quote.discountedBillingCycles !== 1 ||
            input.purpose !== 'acquisition'
          )
        : (
            reservation !== undefined ||
            hasCampaign ||
            hasRevision ||
            hasCycles
          )
    ) {
      throw new TypeError(
        'Subscription coupon reservation must match its immutable quote',
      )
    }
    return
  }
  if (
    input.planKey !== undefined ||
    input.sku !== input.kind ||
    input.preallocatedIntentId !== undefined ||
    input.purpose !== undefined ||
    input.planChangeRequestId !== undefined ||
    input.leaseLane !== undefined ||
    input.requestedStartAt !== undefined ||
    input.authorizationExpiresAt !== undefined ||
    input.manualCouponCode !== undefined ||
    input.couponReservation !== undefined
  ) {
    throw new TypeError('One-time checkout requires its matching server SKU')
  }
}
function requestHashInput(input: TrustedCheckoutIntentInput) {
  return {
    userId: input.userId,
    kind: input.kind,
    providerMode: input.providerMode,
    preallocatedIntentId:
      input.preallocatedIntentId?.toLowerCase(),
    purpose: input.purpose,
    planChangeRequestId:
      input.planChangeRequestId?.toLowerCase(),
    leaseLane: input.leaseLane,
    requestedStartAt: input.requestedStartAt?.toISOString(),
    authorizationExpiresAt:
      input.authorizationExpiresAt?.toISOString(),
    acquisitionAuthorizationTtlSeconds:
      input.purpose === 'acquisition'
        ? ACQUISITION_AUTHORIZATION_TTL_SECONDS
        : undefined,
    planKey: input.planKey,
    sku: input.sku,
    manualCouponCode: input.manualCouponCode,
  }
}
export function checkoutIntentRequestHash(
  input: TrustedCheckoutIntentInput,
): string {
  assertCheckoutTarget(input)
  return sha256CanonicalJson(requestHashInput(input))
}
export function checkoutReceiptForIntent(
  providerMode: ProviderMode,
  intentId: mongoose.Types.ObjectId,
): string {
  return `ipr_${providerMode === 'test' ? 't' : 'l'}_${intentId.toHexString()}`
}
function toResult(
  intent: StoredCheckoutIntent,
  reused: boolean,
): CheckoutIntentCreationResult {
  return {
    intentId: intent._id.toString(),
    receipt: intent.receipt,
    requestHash: intent.requestHash,
    status: intent.status,
    reused,
    ...(intent.authorizationExpiresAt
      ? { authorizationExpiresAt: intent.authorizationExpiresAt }
      : {}),
  }
}
function requireMatchingIdempotentRequest(
  intent: StoredCheckoutIntent,
  requestHash: string,
): CheckoutIntentCreationResult {
  if (intent.requestHash !== requestHash) {
    throw new CheckoutIntentIdempotencyConflictError()
  }
  return toResult(intent, true)
}

function isMongoDuplicateKeyError(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === 'object' &&
    'code' in error &&
    error.code === 11000,
  )
}

function isTransientTransactionError(error: unknown): boolean {
  if (
    !error ||
    typeof error !== 'object' ||
    !('hasErrorLabel' in error) ||
    typeof error.hasErrorLabel !== 'function'
  ) {
    return false
  }
  return error.hasErrorLabel('TransientTransactionError')
}

async function findExistingIntent(
  draft: CheckoutIntentDraft,
  session?: ClientSession,
): Promise<StoredCheckoutIntent | null> {
  const query = CheckoutIntent.findOne({
    userId: draft.userId,
    providerMode: draft.providerMode,
    kind: draft.kind,
    idempotencyKey: draft.idempotencyKey,
  })
  if (session) query.session(session)
  return query.lean<StoredCheckoutIntent>()
}

async function acquireSubscriptionLease(
  draft: CheckoutIntentDraft,
  session: ClientSession,
): Promise<void> {
  if (!draft.purpose || !draft.leaseLane) {
    throw new ConsumerSubscriptionCheckoutBlockedError()
  }
  if (draft.purpose === 'acquisition') {
    const blockingLease = await ConsumerSubscriptionLease.findOne({
      userId: draft.userId,
      providerMode: draft.providerMode,
      status: { $ne: 'released' },
    }).session(session).lean<{ status: string }>()
    if (blockingLease) {
      throw new ConsumerSubscriptionCheckoutBlockedError()
    }
  }

  const lease = await ConsumerSubscriptionLease.findOne({
    userId: draft.userId,
    providerMode: draft.providerMode,
    lane: draft.leaseLane,
  }).session(session).lean<{
    _id: mongoose.Types.ObjectId
    status: 'held' | 'release_pending' | 'released' | 'review'
  }>()

  if (!lease) {
    await ConsumerSubscriptionLease.create([{
      userId: draft.userId,
      providerMode: draft.providerMode,
      lane: draft.leaseLane,
      ownerCheckoutIntentId: draft._id,
      status: 'held',
      acquiredAt: new Date(),
    }], { session })
    return
  }
  if (consumerSubscriptionLeaseBlocksCheckout(lease.status)) {
    throw new ConsumerSubscriptionCheckoutBlockedError()
  }

  const reacquired = await ConsumerSubscriptionLease.findOneAndUpdate(
    { _id: lease._id, status: 'released' },
    {
      $set: {
        ownerCheckoutIntentId: draft._id,
        status: 'held',
        acquiredAt: new Date(),
      },
      $unset: {
        razorpaySubscriptionId: 1,
        remoteTerminalVerifiedAt: 1,
        releasedAt: 1,
        releaseReason: 1,
        releasedBy: 1,
      },
    },
    { new: true, session, runValidators: true },
  )
  if (!reacquired) {
    throw new ConsumerSubscriptionCheckoutBlockedError()
  }
}

async function createOrReuseInTransaction(
  draft: CheckoutIntentDraft,
  session: ClientSession,
  couponReservation?: ReserveCouponCapacityInput,
  producer?: CheckoutIntentCreatedCommercialAnalyticsProducer,
): Promise<CheckoutIntentCreationResult> {
  const existing = await findExistingIntent(draft, session)
  await claimConsumerBillingFenceForCheckout(
    {
      userId: draft.userId,
      checkoutIntentId: existing?._id ?? draft._id,
      kind: draft.kind,
      providerMode: draft.providerMode,
      claimedAt: new Date(),
    },
    mongoConsumerBillingFenceMutationStore(session),
  )
  if (existing) {
    return requireMatchingIdempotentRequest(
      existing,
      draft.requestHash,
    )
  }

  if (draft.kind === 'subscription') {
    await acquireSubscriptionLease(draft, session)
  }
  const created = await CheckoutIntent.create([draft], { session })
  if (couponReservation) {
    const reservation = await reserveCouponCapacityInSession(
      couponReservation,
      session,
    )
    if (
      reservation.outcome === 'global_cap_exhausted' ||
      reservation.outcome === 'user_cap_exhausted'
    ) {
      throw new CheckoutCouponCapacityUnavailableError(
        reservation.outcome,
      )
    }
  }
  await producer?.appendCheckoutIntentCreatedInSession(() => ({
    sourceEvidenceId: draft._id.toHexString(),
    correlationId: draft._id.toHexString(),
    subjectId: draft.userId.toHexString(),
    providerMode: draft.providerMode,
    occurredAt: draft._id.getTimestamp(),
    checkoutKind: draft.kind,
    productKey: draft.kind === 'subscription'
      ? draft.planKey ?? null
      : draft.kind,
    catalogVersion: draft.catalogVersion,
    listPricePaise: draft.quoteSnapshot.listPricePaise,
    discountPaise: draft.quoteSnapshot.discountPaise,
    payablePaise: draft.quoteSnapshot.payablePaise,
    renewalPricePaise:
      draft.quoteSnapshot.renewalPricePaise ?? null,
    couponCampaignId:
      draft.quoteSnapshot.couponCampaignId?.toHexString() ?? null,
  }), session)
  return toResult(
    created[0].toObject() as unknown as StoredCheckoutIntent,
    false,
  )
}

const mongoCheckoutIntentStore: CheckoutIntentStore = {
  async createOrReuse(draft, couponReservation, producer) {
    await connectDB()
    let lastError: unknown
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const session = await mongoose.startSession()
      let result: CheckoutIntentCreationResult | undefined
      try {
        await session.withTransaction(async () => {
          result = await createOrReuseInTransaction(
            draft,
            session,
            couponReservation,
            producer,
          )
        }, {
          readConcern: { level: 'snapshot' },
          writeConcern: { w: 'majority' },
          readPreference: 'primary',
        })
        if (!result) {
          throw new Error(
            'Checkout intent transaction completed without a result',
          )
        }
        return result
      } catch (error) {
        if (
          error instanceof CheckoutBlockedByAccountDeletionError
        ) {
          throw error
        }
        lastError = error
        const retryable =
          isMongoDuplicateKeyError(error) ||
          isTransientTransactionError(error) ||
          error instanceof ConsumerBillingFenceConflictError ||
          error instanceof CouponReservationConcurrencyError
        if (retryable && attempt < 2) continue
        break
      } finally {
        await session.endSession()
      }
    }

    const pendingDeletion = await ConsumerBillingFence.exists({
      userId: draft.userId,
      state: 'deletion_pending',
    })
    if (pendingDeletion) {
      throw new CheckoutBlockedByAccountDeletionError()
    }
    if (isMongoDuplicateKeyError(lastError)) {
      const existing = await findExistingIntent(draft)
      if (existing) {
        return requireMatchingIdempotentRequest(
          existing,
          draft.requestHash,
        )
      }
      if (draft.kind === 'subscription') {
        throw new ConsumerSubscriptionCheckoutBlockedError()
      }
      throw new ConsumerBillingFenceConflictError()
    }
    throw lastError
  },
}

/**
 * Creates only local, server-priced state. Remote Razorpay creation is a
 * separate operation and must pass the runtime sale gate first.
 */
export async function createOrReuseCheckoutIntent(
  input: TrustedCheckoutIntentInput,
  store: CheckoutIntentStore = mongoCheckoutIntentStore,
  producer?: CheckoutIntentCreatedCommercialAnalyticsProducer,
): Promise<CheckoutIntentCreationResult> {
  if (!mongoose.isValidObjectId(input.userId)) {
    throw new TypeError('userId must be a MongoDB ObjectId')
  }
  const idempotencyKey =
    CustomerBillingIdempotencyKeySchema.parse(input.idempotencyKey)
  const normalizedInput = { ...input, idempotencyKey }
  const requestHash = checkoutIntentRequestHash(normalizedInput)
  const intentId = input.preallocatedIntentId
    ? new mongoose.Types.ObjectId(input.preallocatedIntentId)
    : new mongoose.Types.ObjectId()
  const intentCreatedAt = intentId.getTimestamp()
  const acquisitionAuthorizationTtlSeconds =
    input.couponReservation
      ? Math.min(
          ACQUISITION_AUTHORIZATION_TTL_SECONDS,
          input.couponReservation.reservationTtlHours * 60 * 60,
        )
      : ACQUISITION_AUTHORIZATION_TTL_SECONDS
  const authorizationExpiresAt =
    input.kind === 'subscription' &&
    input.purpose === 'acquisition'
      ? new Date(
          intentCreatedAt.getTime() +
          acquisitionAuthorizationTtlSeconds * 1_000,
        )
      : input.authorizationExpiresAt
  const requestedStartAt =
    input.kind === 'subscription' &&
    input.purpose === 'acquisition' &&
    input.quoteSnapshot.discountPaise > 0 &&
    authorizationExpiresAt
      ? oneCalendarMonthAfter(authorizationExpiresAt)
      : input.requestedStartAt
  if (
    input.couponReservation &&
    authorizationExpiresAt &&
    authorizationExpiresAt.getTime() >
      intentCreatedAt.getTime() +
      input.couponReservation.reservationTtlHours * 60 * 60 * 1_000
  ) {
    throw new TypeError(
      'Authorization expiry exceeds the coupon reservation window',
    )
  }
  const draft: CheckoutIntentDraft = {
    _id: intentId,
    userId: new mongoose.Types.ObjectId(input.userId),
    kind: input.kind,
    providerMode: input.providerMode,
    purpose: input.purpose,
    planChangeRequestId: input.planChangeRequestId
      ? new mongoose.Types.ObjectId(input.planChangeRequestId)
      : undefined,
    leaseLane: input.leaseLane,
    requestedStartAt,
    authorizationExpiresAt,
    planKey: input.planKey,
    sku: input.sku,
    catalogVersion: input.catalogVersion,
    idempotencyKey,
    requestHash,
    quoteSnapshot: input.quoteSnapshot,
    buyerSnapshot: input.buyerSnapshot,
    status: 'created',
    receipt: checkoutReceiptForIntent(input.providerMode, intentId),
  }
  const couponReservation = input.couponReservation
    ? {
        ...input.couponReservation,
        providerMode: input.providerMode,
        userId: input.userId,
        checkoutIntentId: intentId.toString(),
        catalogVersion: input.catalogVersion,
        planKey: input.planKey as 'plus' | 'pro',
        reservedAt: new Date(),
      }
    : undefined
  return couponReservation
    ? store.createOrReuse(draft, couponReservation, producer)
    : store.createOrReuse(draft, undefined, producer)
}
