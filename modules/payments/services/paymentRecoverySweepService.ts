import mongoose from 'mongoose'
import { RefundRecord } from '@financial-ledger'
import { connectDB } from '@shared/db/connection'
import { logger } from '@shared/logger'
import { ChargeFulfillment } from '../models/ChargeFulfillment'
import { CheckoutIntent } from '../models/CheckoutIntent'
import { PaymentWebhookEvent } from '../models/PaymentWebhookEvent'
import { PlanCatalogVersion } from '../models/PlanCatalogVersion'
import { Subscription } from '../models/Subscription'
import {
  createRazorpayClientFactory,
  type RazorpayClientFactory,
} from '../providers/razorpayClientFactory'
import type { CatalogContent, ProviderMode } from '../types/catalog'
import {
  expireCouponReservation,
  listCouponReservationsDueForRecovery,
  markCouponReservationReview,
  releaseCouponReservation,
  type CouponReservationRecoveryRow,
} from './couponReservationService'
import {
  issueApprovedGstCreditNote,
  type ApprovedGstCreditNoteRecoveryResult,
} from './approvedGstCreditNoteRecoveryService'
import {
  recoverChargeFulfillment,
  type ChargeFulfillmentRecoveryResult,
} from './chargeFulfillmentRecoveryService'
import {
  fulfillSubscriptionCycleProviderObservation,
  type SubscriptionCycleFulfillmentResult,
} from './subscriptionCycleFulfillmentService'
import {
  persistSubscriptionProviderObservation,
  type SubscriptionStatePersistenceResult,
} from './subscriptionStatePersistenceService'
import {
  PAYMENT_WEBHOOK_MAX_PROCESSING_ATTEMPTS,
  PAYMENT_WEBHOOK_STALE_CLAIM_MS,
  processPaymentWebhookEvent,
  type PaymentWebhookHandler,
  type PaymentWebhookProcessingResult,
} from './webhookProcessingService'
import {
  mongoWebhookDomainMappingStore,
  type TrustedWebhookSubscriptionContext,
} from './webhookDomainDispatchService'

const OBJECT_ID_PATTERN = /^[a-fA-F0-9]{24}$/
const SUBSCRIPTION_ID_PATTERN = /^sub_[A-Za-z0-9]+$/
const PAYMENT_ID_PATTERN = /^pay_[A-Za-z0-9]+$/
const DEFAULT_WEBHOOK_LIMIT = 25
const DEFAULT_COUPON_LIMIT = 10
const DEFAULT_SUBSCRIPTION_LIMIT = 5
const DEFAULT_CHARGE_LIMIT = 25
const MAX_SWEEP_LIMIT = 100
const WEBHOOK_RETRY_AGE_MS = 60 * 1000
const CHECKOUT_RECONCILIATION_AGE_MS = 15 * 60 * 1000
const ATTENTION_SUBSCRIPTION_AGE_MS = 15 * 60 * 1000
const STEADY_SUBSCRIPTION_AGE_MS = 6 * 60 * 60 * 1000
const CHARGE_RECOVERY_AGE_MS = 60 * 1000
const CHARGE_RECOVERY_BACKOFF_MS = 5 * 60 * 1000
const MAX_MISSING_CYCLES_PER_SUBSCRIPTION = 5
const COUPON_REMOTE_LOOKUP_WINDOW_SECONDS = 72 * 60 * 60
const RECOVERABLE_CHECKOUT_STATUSES = [
  'remote_created',
  'checkout_opened',
  'authorization_pending',
  'payment_captured',
] as const
const ATTENTION_SUBSCRIPTION_STATUSES = [
  'created',
  'authenticated',
  'activation_pending',
  'pending',
  'halted',
] as const
const STEADY_SUBSCRIPTION_STATUSES = ['active', 'paused'] as const

export const PAYMENT_RECOVERY_PROVIDER_MODES_ENV =
  'PAYMENT_RECOVERY_PROVIDER_MODES'

const recoveryLogger = logger.child({ module: 'payment-recovery-sweep' })

export class PaymentRecoveryConfigurationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PaymentRecoveryConfigurationError'
  }
}

export interface WebhookRecoveryCandidate {
  eventId: string
  providerMode: ProviderMode
}

export interface SubscriptionRecoveryCandidate {
  providerMode: ProviderMode
  razorpaySubscriptionId: string
  acquisitionCheckoutPending: boolean
  localPaymentIds: readonly string[]
}

export interface ChargeRecoveryCandidate {
  fulfillmentId: string
  providerMode: ProviderMode
}

export interface CreditNoteRecoveryCandidate {
  refundRecordId: string
  providerMode: ProviderMode
}

export interface CouponRecoveryCheckout {
  id: string
  providerMode: ProviderMode
  userId: string
  campaignId: string
  status: string
  receipt: string
  razorpayPlanId: string
  razorpaySubscriptionId?: string
  remoteCreationLeaseExpiresAt?: Date
  remoteCreationStartedAt?: Date
  createdAt: Date
}

export interface PaymentRecoveryCandidateStore {
  listWebhookCandidates(input: {
    providerMode: ProviderMode
    now: Date
    limit: number
  }): Promise<WebhookRecoveryCandidate[]>
  listSubscriptionCandidates(input: {
    providerMode: ProviderMode
    now: Date
    limit: number
  }): Promise<SubscriptionRecoveryCandidate[]>
  listCouponCandidates(input: {
    providerMode: ProviderMode
    now: Date
    limit: number
  }): Promise<CouponReservationRecoveryRow[]>
  loadCouponCheckout(
    candidate: CouponReservationRecoveryRow,
  ): Promise<CouponRecoveryCheckout | null>
  cancelUnstartedCouponCheckout(input: {
    checkout: CouponRecoveryCheckout
    now: Date
  }): Promise<boolean>
  markSubscriptionAttempted(input: {
    providerMode: ProviderMode
    razorpaySubscriptionId: string
    attemptedAt: Date
    checkoutNextRecoveryAt: Date
  }): Promise<void>
  listChargeCandidates(input: {
    providerMode: ProviderMode
    now: Date
    limit: number
  }): Promise<ChargeRecoveryCandidate[]>
  listCreditNoteCandidates(input: {
    providerMode: ProviderMode
    now: Date
    limit: number
  }): Promise<CreditNoteRecoveryCandidate[]>
  deferChargeCandidate(input: {
    providerMode: ProviderMode
    fulfillmentId: string
    attemptedAt: Date
    nextAttemptAt: Date
  }): Promise<void>
}

export interface PaymentRecoverySweepDependencies {
  store?: PaymentRecoveryCandidateStore
  webhookHandler: PaymentWebhookHandler
  processWebhook?: typeof processPaymentWebhookEvent
  clientFactory?: RazorpayClientFactory
  loadSubscriptionContext?: (input: {
    providerMode: ProviderMode
    razorpaySubscriptionId: string
  }) => Promise<TrustedWebhookSubscriptionContext | null>
  persistSubscription?: (
    input: Parameters<typeof persistSubscriptionProviderObservation>[0],
  ) => Promise<SubscriptionStatePersistenceResult>
  fulfillSubscriptionCycle?: (
    input: Parameters<
      typeof fulfillSubscriptionCycleProviderObservation
    >[0],
  ) => Promise<SubscriptionCycleFulfillmentResult>
  recoverCharge?: (input: {
    fulfillmentId: string
    providerMode: ProviderMode
  }) => Promise<ChargeFulfillmentRecoveryResult>
  recoverCreditNote?: (input: {
    refundRecordId: string
    providerMode: ProviderMode
  }) => Promise<ApprovedGstCreditNoteRecoveryResult>
  expireCoupon?: typeof expireCouponReservation
  releaseCoupon?: typeof releaseCouponReservation
  reviewCoupon?: typeof markCouponReservationReview
}

export interface PaymentRecoverySweepInput {
  providerModes: readonly ProviderMode[]
  now?: Date
  webhookLimit?: number
  couponLimit?: number
  subscriptionLimit?: number
  chargeLimit?: number
}

export interface PaymentRecoveryStageResult {
  candidates: number
  completed: number
  deferred: number
  failed: number
}

export interface PaymentRecoverySweepResult {
  providerModes: readonly ProviderMode[]
  webhook: PaymentRecoveryStageResult
  coupon: PaymentRecoveryStageResult
  subscription: PaymentRecoveryStageResult & {
    cyclesRecovered: number
  }
  charge: PaymentRecoveryStageResult
  creditNote: PaymentRecoveryStageResult
}

interface LeanWebhookCandidate {
  _id: mongoose.Types.ObjectId
  providerMode: ProviderMode
}

interface LeanCheckoutCandidate {
  providerMode: ProviderMode
  razorpaySubscriptionId: string
}

interface LeanSubscriptionCandidate {
  providerMode: ProviderMode
  razorpaySubscriptionId: string
}

interface LeanFulfillmentPayment {
  providerMode: ProviderMode
  razorpaySubscriptionId: string
  razorpayPaymentId: string
}

interface LeanChargeCandidate {
  _id: mongoose.Types.ObjectId
  providerMode: ProviderMode
}

interface LeanCreditNoteCandidate {
  _id: mongoose.Types.ObjectId
  providerMode: ProviderMode
}

interface LeanCouponCheckout {
  _id: mongoose.Types.ObjectId
  providerMode: ProviderMode
  userId: mongoose.Types.ObjectId
  status: string
  planKey?: 'plus' | 'pro'
  catalogVersion: string
  receipt: string
  razorpaySubscriptionId?: string
  remoteCreationLeaseExpiresAt?: Date
  remoteCreationStartedAt?: Date
  createdAt: Date
}

function validDate(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime())
}

function exactLimit(value: number | undefined, fallback: number): number {
  const limit = value ?? fallback
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > MAX_SWEEP_LIMIT
  ) {
    throw new PaymentRecoveryConfigurationError(
      `Payment recovery limits must be integers from 1 to ${MAX_SWEEP_LIMIT}`,
    )
  }
  return limit
}

function exactProviderModes(
  modes: readonly ProviderMode[],
): readonly ProviderMode[] {
  if (
    modes.length > 2 ||
    modes.some((mode) => mode !== 'test' && mode !== 'live') ||
    new Set(modes).size !== modes.length
  ) {
    throw new PaymentRecoveryConfigurationError(
      'Payment recovery provider modes are invalid',
    )
  }
  return (['test', 'live'] as const).filter((mode) => modes.includes(mode))
}

/**
 * Provider reads are disabled unless the operator explicitly lists each mode.
 * In particular, Live is never inferred from NODE_ENV or from sales state.
 */
export function parsePaymentRecoveryProviderModes(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): readonly ProviderMode[] {
  const raw = environment[PAYMENT_RECOVERY_PROVIDER_MODES_ENV]?.trim()
  if (!raw) return []
  const tokens = raw.split(',').map((token) => token.trim())
  if (
    tokens.some((token) => token !== 'test' && token !== 'live') ||
    new Set(tokens).size !== tokens.length
  ) {
    throw new PaymentRecoveryConfigurationError(
      `${PAYMENT_RECOVERY_PROVIDER_MODES_ENV} must be test, live, or test,live`,
    )
  }
  return exactProviderModes(tokens as ProviderMode[])
}

function assertCandidatesExact<T extends { providerMode: ProviderMode }>(
  candidates: readonly T[],
  providerMode: ProviderMode,
  limit: number,
): void {
  if (
    candidates.length > limit ||
    candidates.some((candidate) => candidate.providerMode !== providerMode)
  ) {
    throw new PaymentRecoveryConfigurationError(
      'Payment recovery candidate store crossed its mode or limit boundary',
    )
  }
}

type SubscriptionRecoveryCandidateWithoutPayments = Omit<
  SubscriptionRecoveryCandidate,
  'localPaymentIds'
>

export function selectSubscriptionRecoveryCandidates(input: {
  checkouts: readonly LeanCheckoutCandidate[]
  subscriptions: readonly LeanSubscriptionCandidate[]
  limit: number
}): SubscriptionRecoveryCandidateWithoutPayments[] {
  const limit = exactLimit(input.limit, DEFAULT_SUBSCRIPTION_LIMIT)
  const checkoutCandidates: SubscriptionRecoveryCandidateWithoutPayments[] = []
  const checkoutIds = new Set<string>()
  for (const row of input.checkouts) {
    if (!SUBSCRIPTION_ID_PATTERN.test(row.razorpaySubscriptionId)) {
      throw new PaymentRecoveryConfigurationError(
        'Stored checkout recovery identifier is invalid',
      )
    }
    if (checkoutIds.has(row.razorpaySubscriptionId)) continue
    checkoutIds.add(row.razorpaySubscriptionId)
    checkoutCandidates.push({
      providerMode: row.providerMode,
      razorpaySubscriptionId: row.razorpaySubscriptionId,
      acquisitionCheckoutPending: true,
    })
  }

  const subscriptionCandidates: SubscriptionRecoveryCandidateWithoutPayments[] = []
  const subscriptionIds = new Set<string>()
  for (const row of input.subscriptions) {
    if (!SUBSCRIPTION_ID_PATTERN.test(row.razorpaySubscriptionId)) {
      throw new PaymentRecoveryConfigurationError(
        'Stored subscription recovery identifier is invalid',
      )
    }
    if (
      checkoutIds.has(row.razorpaySubscriptionId) ||
      subscriptionIds.has(row.razorpaySubscriptionId)
    ) {
      continue
    }
    subscriptionIds.add(row.razorpaySubscriptionId)
    subscriptionCandidates.push({
      providerMode: row.providerMode,
      razorpaySubscriptionId: row.razorpaySubscriptionId,
      acquisitionCheckoutPending: false,
    })
  }

  const selected = checkoutCandidates.slice(
    0,
    subscriptionCandidates.length > 0 ? limit - 1 : limit,
  )
  if (subscriptionCandidates.length > 0) {
    selected.push(subscriptionCandidates[0])
  }
  for (const candidate of checkoutCandidates.slice(selected.length)) {
    if (selected.length >= limit) break
    selected.push(candidate)
  }
  for (const candidate of subscriptionCandidates.slice(1)) {
    if (selected.length >= limit) break
    selected.push(candidate)
  }
  return selected
}

export const mongoPaymentRecoveryCandidateStore:
PaymentRecoveryCandidateStore = {
  async listWebhookCandidates({ providerMode, now, limit }) {
    await connectDB()
    const retryBefore = new Date(now.getTime() - WEBHOOK_RETRY_AGE_MS)
    const staleBefore = new Date(
      now.getTime() - PAYMENT_WEBHOOK_STALE_CLAIM_MS,
    )
    const rows = await PaymentWebhookEvent.find({
      providerMode,
      signatureVerified: true,
      attempts: { $lt: PAYMENT_WEBHOOK_MAX_PROCESSING_ATTEMPTS },
      'rawPayloadStorage.strategy': 'encrypted',
      $or: [
        {
          status: 'received',
          receivedAt: { $lte: retryBefore },
        },
        {
          status: 'failed',
          updatedAt: { $lte: retryBefore },
        },
        {
          status: 'processing',
          updatedAt: { $lte: staleBefore },
        },
      ],
    })
      .sort({ receivedAt: 1, _id: 1 })
      .limit(limit)
      .select('_id providerMode')
      .lean<LeanWebhookCandidate[]>()
    return rows.map((row) => ({
      eventId: row._id.toHexString(),
      providerMode: row.providerMode,
    }))
  },

  async listCouponCandidates({ providerMode, now, limit }) {
    return listCouponReservationsDueForRecovery({
      providerMode,
      asOf: now,
      limit,
    })
  },

  async loadCouponCheckout(candidate) {
    if (
      !OBJECT_ID_PATTERN.test(candidate.id) ||
      !OBJECT_ID_PATTERN.test(candidate.campaignId) ||
      !OBJECT_ID_PATTERN.test(candidate.userId) ||
      !OBJECT_ID_PATTERN.test(candidate.checkoutIntentId)
    ) {
      throw new PaymentRecoveryConfigurationError(
        'Stored coupon recovery identity is invalid',
      )
    }
    await connectDB()
    const checkout = await CheckoutIntent.findOne({
      _id: new mongoose.Types.ObjectId(candidate.checkoutIntentId),
      userId: new mongoose.Types.ObjectId(candidate.userId),
      providerMode: candidate.providerMode,
      kind: 'subscription',
      'quoteSnapshot.couponCampaignId':
        new mongoose.Types.ObjectId(candidate.campaignId),
    })
      .select(
        '_id providerMode userId status planKey catalogVersion receipt ' +
        'razorpaySubscriptionId remoteCreationLeaseExpiresAt ' +
        'remoteCreationStartedAt createdAt',
      )
      .lean<LeanCouponCheckout>()
    if (!checkout?.planKey) return null
    const catalog = await PlanCatalogVersion.findOne({
      version: checkout.catalogVersion,
      status: { $in: ['published', 'archived'] },
    }).select('content').lean<{ content: CatalogContent }>()
    const razorpayPlanId =
      catalog?.content.plans[checkout.planKey]
        .razorpayPlanIdByMode?.[candidate.providerMode]
    if (!razorpayPlanId) return null
    return {
      id: checkout._id.toHexString(),
      providerMode: checkout.providerMode,
      userId: checkout.userId.toHexString(),
      campaignId: candidate.campaignId,
      status: checkout.status,
      receipt: checkout.receipt,
      razorpayPlanId,
      ...(checkout.razorpaySubscriptionId
        ? { razorpaySubscriptionId: checkout.razorpaySubscriptionId }
        : {}),
      ...(checkout.remoteCreationLeaseExpiresAt
        ? {
            remoteCreationLeaseExpiresAt:
              checkout.remoteCreationLeaseExpiresAt,
          }
        : {}),
      ...(checkout.remoteCreationStartedAt
        ? { remoteCreationStartedAt: checkout.remoteCreationStartedAt }
        : {}),
      createdAt: checkout.createdAt,
    }
  },

  async cancelUnstartedCouponCheckout({ checkout, now }) {
    await connectDB()
    const update = await CheckoutIntent.updateOne(
      {
        _id: new mongoose.Types.ObjectId(checkout.id),
        userId: new mongoose.Types.ObjectId(checkout.userId),
        providerMode: checkout.providerMode,
        kind: 'subscription',
        status: 'created',
        razorpaySubscriptionId: { $exists: false },
        remoteCreationStartedAt: { $exists: false },
        $or: [
          { remoteCreationLeaseToken: { $exists: false } },
          { remoteCreationLeaseExpiresAt: { $lte: now } },
        ],
      },
      {
        $set: { status: 'cancelled', updatedAt: now },
        $unset: {
          remoteCreationLeaseToken: 1,
          remoteCreationLeaseExpiresAt: 1,
        },
      },
      { runValidators: true, timestamps: false },
    )
    return update.matchedCount === 1
  },

  async listSubscriptionCandidates({ providerMode, now, limit }) {
    await connectDB()
    const checkoutBefore = new Date(
      now.getTime() - CHECKOUT_RECONCILIATION_AGE_MS,
    )
    const attentionBefore = new Date(
      now.getTime() - ATTENTION_SUBSCRIPTION_AGE_MS,
    )
    const steadyBefore = new Date(
      now.getTime() - STEADY_SUBSCRIPTION_AGE_MS,
    )
    const [checkouts, subscriptions] = await Promise.all([
      CheckoutIntent.find({
        providerMode,
        kind: 'subscription',
        status: {
          $in: RECOVERABLE_CHECKOUT_STATUSES,
        },
        razorpaySubscriptionId: { $type: 'string' },
        updatedAt: { $lte: checkoutBefore },
        $or: [
          { nextRecoveryAt: { $exists: false } },
          { nextRecoveryAt: null },
          { nextRecoveryAt: { $lte: now } },
        ],
      })
        .sort({ updatedAt: 1, _id: 1 })
        .limit(limit)
        .select('providerMode razorpaySubscriptionId')
        .lean<LeanCheckoutCandidate[]>(),
      Subscription.find({
        providerMode,
        $or: [
          {
            status: {
              $in: ATTENTION_SUBSCRIPTION_STATUSES,
            },
            updatedAt: { $lte: attentionBefore },
          },
          {
            status: { $in: STEADY_SUBSCRIPTION_STATUSES },
            updatedAt: { $lte: steadyBefore },
          },
        ],
      })
        .sort({ updatedAt: 1, _id: 1 })
        .limit(limit)
        .select('providerMode razorpaySubscriptionId')
        .lean<LeanSubscriptionCandidate[]>(),
    ])

    const selected = selectSubscriptionRecoveryCandidates({
      checkouts,
      subscriptions,
      limit,
    })
    if (selected.length === 0) return []

    const paymentRows = await ChargeFulfillment.find({
      providerMode,
      kind: 'subscription_cycle',
      razorpaySubscriptionId: {
        $in: selected.map((candidate) => (
          candidate.razorpaySubscriptionId
        )),
      },
      'steps.verification.status': 'complete',
    })
      .select(
        'providerMode razorpaySubscriptionId razorpayPaymentId',
      )
      .lean<LeanFulfillmentPayment[]>()
    const paymentsBySubscription = new Map<string, Set<string>>()
    for (const row of paymentRows) {
      if (
        row.providerMode !== providerMode ||
        !SUBSCRIPTION_ID_PATTERN.test(row.razorpaySubscriptionId) ||
        !PAYMENT_ID_PATTERN.test(row.razorpayPaymentId)
      ) {
        throw new PaymentRecoveryConfigurationError(
          'Stored subscription payment recovery evidence is invalid',
        )
      }
      const paymentIds = paymentsBySubscription.get(
        row.razorpaySubscriptionId,
      ) ?? new Set<string>()
      paymentIds.add(row.razorpayPaymentId)
      paymentsBySubscription.set(row.razorpaySubscriptionId, paymentIds)
    }
    return selected.map((candidate) => ({
      ...candidate,
      localPaymentIds: Array.from(
        paymentsBySubscription.get(candidate.razorpaySubscriptionId) ?? [],
      ),
    }))
  },

  async markSubscriptionAttempted({
    providerMode,
    razorpaySubscriptionId,
    attemptedAt,
    checkoutNextRecoveryAt,
  }) {
    await connectDB()
    await Promise.all([
      CheckoutIntent.updateOne(
        {
          providerMode,
          kind: 'subscription',
          razorpaySubscriptionId,
          status: { $in: RECOVERABLE_CHECKOUT_STATUSES },
        },
        {
          $set: {
            nextRecoveryAt: checkoutNextRecoveryAt,
            updatedAt: attemptedAt,
          },
        },
        { timestamps: false },
      ),
      Subscription.updateOne(
        {
          providerMode,
          razorpaySubscriptionId,
          status: {
            $in: [
              ...ATTENTION_SUBSCRIPTION_STATUSES,
              ...STEADY_SUBSCRIPTION_STATUSES,
            ],
          },
        },
        { $set: { updatedAt: attemptedAt } },
        { timestamps: false },
      ),
    ])
  },

  async listChargeCandidates({ providerMode, now, limit }) {
    await connectDB()
    const dueBefore = new Date(now.getTime() - CHARGE_RECOVERY_AGE_MS)
    const rows = await ChargeFulfillment.find({
      providerMode,
      'steps.verification.status': 'complete',
      updatedAt: { $lte: dueBefore },
      $and: [
        {
          $or: [
            {
              kind: { $in: ['single_interview', 'premium_resume'] },
              status: 'verified',
              'steps.entitlement.status': 'pending',
            },
            {
              kind: {
                $in: [
                  'subscription_cycle',
                  'single_interview',
                  'premium_resume',
                ],
              },
              status: {
                $in: ['entitlement_skipped', 'entitlement_applied'],
              },
              'steps.invoice.status': {
                $in: ['pending', 'running', 'failed'],
              },
            },
            {
              status: 'review',
              'steps.invoice.status': {
                $in: ['pending', 'running', 'failed'],
              },
              $or: [
                { 'steps.entitlement.status': 'complete' },
                {
                  kind: 'subscription_cycle',
                  'steps.entitlement.status': 'skipped',
                },
              ],
            },
          ],
        },
        {
          $or: [
            { nextAttemptAt: { $exists: false } },
            { nextAttemptAt: null },
            { nextAttemptAt: { $lte: now } },
          ],
        },
      ],
    })
      .sort({ updatedAt: 1, _id: 1 })
      .limit(limit)
      .select('_id providerMode')
      .lean<LeanChargeCandidate[]>()
    return rows.map((row) => ({
      fulfillmentId: row._id.toHexString(),
      providerMode: row.providerMode,
    }))
  },

  async listCreditNoteCandidates({ providerMode, now, limit }) {
    await connectDB()
    const rows = await RefundRecord.find({
      providerMode,
      status: { $in: ['verified', 'review_required', 'resolving', 'resolved'] },
      'creditNoteDecision.status': { $in: ['required', 'failed'] },
      $and: [
        {
          $or: [
            { nextAttemptAt: { $exists: false } },
            { nextAttemptAt: null },
            { nextAttemptAt: { $lte: now } },
          ],
        },
        {
          $or: [
            { 'creditNoteDecision.attemptedAt': { $exists: false } },
            { 'creditNoteDecision.attemptedAt': null },
            {
              'creditNoteDecision.attemptedAt': {
                $lte: new Date(now.getTime() - 15 * 60_000),
              },
            },
          ],
        },
      ],
    })
      .sort({ updatedAt: 1, _id: 1 })
      .limit(limit)
      .select('_id providerMode')
      .lean<LeanCreditNoteCandidate[]>()
    return rows.map((row) => ({
      refundRecordId: row._id.toHexString(),
      providerMode: row.providerMode,
    }))
  },

  async deferChargeCandidate({
    providerMode,
    fulfillmentId,
    attemptedAt,
    nextAttemptAt,
  }) {
    await connectDB()
    await ChargeFulfillment.updateOne(
      {
        _id: new mongoose.Types.ObjectId(fulfillmentId),
        providerMode,
        'steps.verification.status': 'complete',
        $or: [
          {
            kind: { $in: ['single_interview', 'premium_resume'] },
            status: 'verified',
            'steps.entitlement.status': 'pending',
          },
          {
            kind: {
              $in: [
                'subscription_cycle',
                'single_interview',
                'premium_resume',
              ],
            },
            status: {
              $in: ['entitlement_skipped', 'entitlement_applied'],
            },
            'steps.invoice.status': {
              $in: ['pending', 'running', 'failed'],
            },
          },
          {
            status: 'review',
            'steps.invoice.status': {
              $in: ['pending', 'running', 'failed'],
            },
            $or: [
              { 'steps.entitlement.status': 'complete' },
              {
                kind: 'subscription_cycle',
                'steps.entitlement.status': 'skipped',
              },
            ],
          },
        ],
      },
      { $set: { nextAttemptAt, updatedAt: attemptedAt } },
      { timestamps: false },
    )
  },
}

function emptyStage(): PaymentRecoveryStageResult {
  return { candidates: 0, completed: 0, deferred: 0, failed: 0 }
}

function processingCompleted(result: PaymentWebhookProcessingResult): boolean {
  return result.outcome === 'processed' ||
    result.outcome === 'already_processed'
}

async function retryWebhookInbox(input: {
  providerMode: ProviderMode
  now: Date
  limit: number
  store: PaymentRecoveryCandidateStore
  processWebhook: typeof processPaymentWebhookEvent
  webhookHandler: PaymentWebhookHandler
}): Promise<PaymentRecoveryStageResult> {
  const candidates = await input.store.listWebhookCandidates(input)
  assertCandidatesExact(candidates, input.providerMode, input.limit)
  const result = emptyStage()
  result.candidates = candidates.length
  for (const candidate of candidates) {
    if (!OBJECT_ID_PATTERN.test(candidate.eventId)) {
      throw new PaymentRecoveryConfigurationError(
        'Webhook recovery candidate identifier is invalid',
      )
    }
    try {
      const processed = await input.processWebhook({
        eventId: candidate.eventId,
        handler: input.webhookHandler,
        now: input.now,
      })
      if (processingCompleted(processed)) result.completed += 1
      else result.deferred += 1
    } catch (error) {
      result.failed += 1
      recoveryLogger.error({
        providerMode: input.providerMode,
        errorName: error instanceof Error ? error.name : 'UnknownError',
      }, 'Payment webhook recovery candidate failed')
    }
  }
  return result
}

function couponEvidenceKey(
  candidate: CouponReservationRecoveryRow,
  suffix: string,
): string {
  return `coupon-recovery:${candidate.id}:${suffix}`.slice(0, 255)
}

async function recoverCouponReservations(input: {
  providerMode: ProviderMode
  now: Date
  limit: number
  store: PaymentRecoveryCandidateStore
  clientFactory: RazorpayClientFactory
  expireCoupon: typeof expireCouponReservation
  releaseCoupon: typeof releaseCouponReservation
  reviewCoupon: typeof markCouponReservationReview
}): Promise<PaymentRecoveryStageResult> {
  const candidates = await input.store.listCouponCandidates(input)
  assertCandidatesExact(candidates, input.providerMode, input.limit)
  const result = emptyStage()
  result.candidates = candidates.length
  const client = candidates.length > 0
    ? input.clientFactory.forMode(input.providerMode)
    : undefined

  for (const candidate of candidates) {
    try {
      if (
        !OBJECT_ID_PATTERN.test(candidate.id) ||
        !OBJECT_ID_PATTERN.test(candidate.campaignId) ||
        !OBJECT_ID_PATTERN.test(candidate.userId) ||
        !OBJECT_ID_PATTERN.test(candidate.checkoutIntentId) ||
        !validDate(candidate.validUntil) ||
        candidate.validUntil > input.now
      ) {
        throw new PaymentRecoveryConfigurationError(
          'Stored coupon recovery candidate is invalid',
        )
      }
      const checkout = await input.store.loadCouponCheckout(candidate)
      if (!checkout || !validDate(checkout.createdAt)) {
        await input.reviewCoupon({
          providerMode: candidate.providerMode,
          campaignId: candidate.campaignId,
          userId: candidate.userId,
          checkoutIntentId: candidate.checkoutIntentId,
          reason: 'ambiguous_remote_state',
          evidenceKey: couponEvidenceKey(candidate, 'checkout-missing'),
        })
        result.completed += 1
        continue
      }
      if (
        checkout.id !== candidate.checkoutIntentId ||
        checkout.providerMode !== candidate.providerMode ||
        checkout.userId !== candidate.userId ||
        checkout.campaignId !== candidate.campaignId
      ) {
        throw new PaymentRecoveryConfigurationError(
          'Coupon checkout recovery identity crossed its boundary',
        )
      }

      const fromEpochSeconds = Math.floor(
        checkout.createdAt.getTime() / 1_000,
      )
      const remote = checkout.razorpaySubscriptionId
        ? await client!.fetchSubscription(
            checkout.razorpaySubscriptionId,
          )
        : await client!.findSubscriptionByCheckoutReceipt({
            checkoutReceipt: checkout.receipt,
            expectedPlanId: checkout.razorpayPlanId,
            fromEpochSeconds,
            toEpochSeconds:
              fromEpochSeconds + COUPON_REMOTE_LOOKUP_WINDOW_SECONDS,
          })

      if (!remote) {
        if (
          checkout.remoteCreationLeaseExpiresAt &&
          checkout.remoteCreationLeaseExpiresAt > input.now
        ) {
          result.deferred += 1
          continue
        }
        if (
          checkout.status === 'created' &&
          !await input.store.cancelUnstartedCouponCheckout({
            checkout,
            now: input.now,
          })
        ) {
          result.deferred += 1
          continue
        }
        if (
          checkout.status !== 'created' &&
          !['abandoned', 'failed', 'cancelled'].includes(checkout.status)
        ) {
          await input.reviewCoupon({
            providerMode: candidate.providerMode,
            campaignId: candidate.campaignId,
            userId: candidate.userId,
            checkoutIntentId: candidate.checkoutIntentId,
            reason: 'ambiguous_remote_state',
            evidenceKey: couponEvidenceKey(
              candidate,
              `local-${checkout.status}`,
            ),
          })
          result.completed += 1
          continue
        }
        await input.expireCoupon({
          providerMode: candidate.providerMode,
          campaignId: candidate.campaignId,
          userId: candidate.userId,
          checkoutIntentId: candidate.checkoutIntentId,
          evidence: {
            reason: 'local_intent_expired_without_remote_object',
            source: 'reconciliation',
            evidenceKey: couponEvidenceKey(candidate, 'remote-absent'),
            observedAt: input.now,
          },
          terminalAt: input.now,
        })
        result.completed += 1
        continue
      }

      if (
        remote.providerMode !== candidate.providerMode ||
        remote.planId !== checkout.razorpayPlanId ||
        remote.notes.checkout_receipt !== checkout.receipt ||
        (
          checkout.razorpaySubscriptionId !== undefined &&
          remote.id !== checkout.razorpaySubscriptionId
        )
      ) {
        await input.reviewCoupon({
          providerMode: candidate.providerMode,
          campaignId: candidate.campaignId,
          userId: candidate.userId,
          checkoutIntentId: candidate.checkoutIntentId,
          reason: 'ambiguous_remote_state',
          evidenceKey: couponEvidenceKey(candidate, 'remote-mismatch'),
        })
        result.completed += 1
        continue
      }

      const terminalReason = remote.status === 'cancelled'
        ? 'provider_subscription_cancelled_unpaid' as const
        : remote.status === 'completed'
          ? 'provider_subscription_completed_unpaid' as const
          : remote.status === 'expired'
            ? 'provider_subscription_expired_unpaid' as const
            : undefined
      if (!terminalReason) {
        if (!checkout.razorpaySubscriptionId) {
          await input.reviewCoupon({
            providerMode: candidate.providerMode,
            campaignId: candidate.campaignId,
            userId: candidate.userId,
            checkoutIntentId: candidate.checkoutIntentId,
            reason: 'ambiguous_remote_state',
            evidenceKey: couponEvidenceKey(
              candidate,
              'remote-correlation-missing',
            ),
          })
          result.completed += 1
        } else {
          result.deferred += 1
        }
        continue
      }

      const invoices = await client!.fetchSubscriptionInvoices(remote.id)
      const hasPaidEvidence = remote.paidCount > 0 || invoices.some(
        (invoice) =>
          invoice.subscriptionId === remote.id &&
          invoice.status === 'paid' &&
          invoice.amountPaidPaise > 0,
      )
      if (hasPaidEvidence) {
        await input.reviewCoupon({
          providerMode: candidate.providerMode,
          campaignId: candidate.campaignId,
          userId: candidate.userId,
          checkoutIntentId: candidate.checkoutIntentId,
          reason: 'ambiguous_remote_state',
          evidenceKey: couponEvidenceKey(candidate, 'paid-evidence'),
        })
        result.completed += 1
        continue
      }
      await input.releaseCoupon({
        providerMode: candidate.providerMode,
        campaignId: candidate.campaignId,
        userId: candidate.userId,
        checkoutIntentId: candidate.checkoutIntentId,
        evidence: {
          reason: terminalReason,
          source: 'provider_fetch',
          evidenceKey: couponEvidenceKey(
            candidate,
            `${remote.id}:${remote.status}`,
          ),
          observedAt: input.now,
        },
        terminalAt: input.now,
      })
      result.completed += 1
    } catch (error) {
      result.failed += 1
      recoveryLogger.error({
        providerMode: input.providerMode,
        errorName: error instanceof Error ? error.name : 'UnknownError',
      }, 'Coupon reservation recovery candidate failed')
    }
  }
  return result
}

async function reconcileSubscriptions(input: {
  providerMode: ProviderMode
  now: Date
  limit: number
  store: PaymentRecoveryCandidateStore
  clientFactory: RazorpayClientFactory
  loadSubscriptionContext: NonNullable<
    PaymentRecoverySweepDependencies['loadSubscriptionContext']
  >
  persistSubscription: NonNullable<
    PaymentRecoverySweepDependencies['persistSubscription']
  >
  fulfillSubscriptionCycle: NonNullable<
    PaymentRecoverySweepDependencies['fulfillSubscriptionCycle']
  >
}): Promise<PaymentRecoveryStageResult & { cyclesRecovered: number }> {
  const candidates = await input.store.listSubscriptionCandidates(input)
  assertCandidatesExact(candidates, input.providerMode, input.limit)
  const result = { ...emptyStage(), cyclesRecovered: 0 }
  result.candidates = candidates.length
  if (candidates.length === 0) return result
  const client = input.clientFactory.forMode(input.providerMode)
  if (client.providerMode !== input.providerMode) {
    throw new PaymentRecoveryConfigurationError(
      'Razorpay recovery client crossed its provider-mode boundary',
    )
  }

  for (const candidate of candidates) {
    if (!SUBSCRIPTION_ID_PATTERN.test(candidate.razorpaySubscriptionId)) {
      throw new PaymentRecoveryConfigurationError(
        'Subscription recovery candidate identifier is invalid',
      )
    }
    let candidateError: unknown
    try {
      const localContext = await input.loadSubscriptionContext({
        providerMode: input.providerMode,
        razorpaySubscriptionId: candidate.razorpaySubscriptionId,
      })
      if (!localContext) {
        throw new PaymentRecoveryConfigurationError(
          'Subscription recovery has no exact local context',
        )
      }
      const subscription = await client.fetchSubscription(
        candidate.razorpaySubscriptionId,
      )
      if (
        subscription.providerMode !== input.providerMode ||
        subscription.id !== candidate.razorpaySubscriptionId
      ) {
        throw new PaymentRecoveryConfigurationError(
          'Razorpay returned a cross-mode subscription',
        )
      }

      const localPaymentIds = new Set(candidate.localPaymentIds)
      // Razorpay excludes the CMS coupon-upfront payment from paidCount while
      // the local ledger stores it as subscription_cycle. Payment IDs remain
      // the exact dedupe fence, but their count must not gate invoice reads.
      if (
        candidate.acquisitionCheckoutPending ||
        subscription.paidCount > 0
      ) {
        const invoices = await client.fetchSubscriptionInvoices(
          candidate.razorpaySubscriptionId,
        )
        const recoverableInvoices = invoices
          .filter((invoice) => (
            invoice.providerMode === input.providerMode &&
            invoice.subscriptionId === candidate.razorpaySubscriptionId &&
            invoice.status === 'paid' &&
            invoice.partialPayment === false &&
            invoice.amountPaise > 0 &&
            invoice.amountPaidPaise === invoice.amountPaise &&
            invoice.amountDuePaise === 0 &&
            invoice.paymentId !== undefined &&
            invoice.orderId !== undefined &&
            !localPaymentIds.has(invoice.paymentId)
          ))
          .slice(0, MAX_MISSING_CYCLES_PER_SUBSCRIPTION)

        for (const invoice of recoverableInvoices) {
          const payment = await client.fetchPayment(invoice.paymentId!)
          await input.fulfillSubscriptionCycle({
            providerMode: input.providerMode,
            razorpaySubscriptionId: candidate.razorpaySubscriptionId,
            razorpayPaymentId: invoice.paymentId!,
            razorpayInvoiceId: invoice.id,
            razorpayOrderId: invoice.orderId!,
            payment,
            invoice,
            subscription,
          })
          localPaymentIds.add(invoice.paymentId!)
          result.cyclesRecovered += 1
        }
      }

      await input.persistSubscription({
        providerMode: input.providerMode,
        providerObservedAt: input.now,
        razorpaySubscriptionId: candidate.razorpaySubscriptionId,
        subscription,
        localContext,
      })
    } catch (error) {
      candidateError = error
    }
    try {
      await input.store.markSubscriptionAttempted({
        providerMode: input.providerMode,
        razorpaySubscriptionId: candidate.razorpaySubscriptionId,
        attemptedAt: input.now,
        checkoutNextRecoveryAt: new Date(
          input.now.getTime() + CHECKOUT_RECONCILIATION_AGE_MS,
        ),
      })
    } catch (error) {
      candidateError ??= error
    }
    if (candidateError === undefined) {
      result.completed += 1
    } else {
      result.failed += 1
      recoveryLogger.error({
        providerMode: input.providerMode,
        errorName: candidateError instanceof Error
          ? candidateError.name
          : 'UnknownError',
      }, 'Razorpay subscription reconciliation candidate failed')
    }
  }
  return result
}

async function recoverCharges(input: {
  providerMode: ProviderMode
  now: Date
  limit: number
  store: PaymentRecoveryCandidateStore
  recoverCharge: NonNullable<
    PaymentRecoverySweepDependencies['recoverCharge']
  >
}): Promise<PaymentRecoveryStageResult> {
  const candidates = await input.store.listChargeCandidates(input)
  assertCandidatesExact(candidates, input.providerMode, input.limit)
  const result = emptyStage()
  result.candidates = candidates.length
  for (const candidate of candidates) {
    if (!OBJECT_ID_PATTERN.test(candidate.fulfillmentId)) {
      throw new PaymentRecoveryConfigurationError(
        'Charge recovery candidate identifier is invalid',
      )
    }
    let candidateOutcome: 'completed' | 'deferred' | 'failed'
    let candidateError: unknown
    try {
      const recovered = await input.recoverCharge({
        fulfillmentId: candidate.fulfillmentId,
        providerMode: input.providerMode,
      })
      if (
        recovered.outcome === 'one_time_entitlement_processed' ||
        (
          recovered.outcome === 'financial_policy_handler_completed' &&
          recovered.financialPolicy.disposition !== 'deferred'
        ) ||
        recovered.outcome === 'done'
      ) {
        candidateOutcome = 'completed'
      } else {
        // A concurrent worker may have advanced the row, or an approved
        // invoice policy may have deferred for configuration/provider state.
        candidateOutcome = 'deferred'
      }
    } catch (error) {
      candidateOutcome = 'failed'
      candidateError = error
    }
    if (candidateOutcome !== 'completed') {
      try {
        await input.store.deferChargeCandidate({
          providerMode: input.providerMode,
          fulfillmentId: candidate.fulfillmentId,
          attemptedAt: input.now,
          nextAttemptAt: new Date(
            input.now.getTime() + CHARGE_RECOVERY_BACKOFF_MS,
          ),
        })
      } catch (error) {
        candidateOutcome = 'failed'
        candidateError ??= error
      }
    }
    if (candidateOutcome === 'completed') {
      result.completed += 1
    } else if (candidateOutcome === 'deferred') {
      result.deferred += 1
    } else {
      result.failed += 1
      recoveryLogger.error({
        providerMode: input.providerMode,
        errorName: candidateError instanceof Error
          ? candidateError.name
          : 'UnknownError',
      }, 'Charge fulfillment recovery candidate failed')
    }
  }
  return result
}

async function recoverCreditNotes(input: {
  providerMode: ProviderMode
  now: Date
  limit: number
  store: PaymentRecoveryCandidateStore
  recoverCreditNote: NonNullable<
    PaymentRecoverySweepDependencies['recoverCreditNote']
  >
}): Promise<PaymentRecoveryStageResult> {
  const candidates = await input.store.listCreditNoteCandidates(input)
  assertCandidatesExact(candidates, input.providerMode, input.limit)
  const result = emptyStage()
  result.candidates = candidates.length
  for (const candidate of candidates) {
    if (!OBJECT_ID_PATTERN.test(candidate.refundRecordId)) {
      throw new PaymentRecoveryConfigurationError(
        'Credit-note recovery candidate identifier is invalid',
      )
    }
    try {
      const recovered = await input.recoverCreditNote({
        refundRecordId: candidate.refundRecordId,
        providerMode: input.providerMode,
      })
      if (recovered.disposition === 'deferred') result.deferred += 1
      else result.completed += 1
    } catch (error) {
      result.failed += 1
      recoveryLogger.error({
        providerMode: input.providerMode,
        errorName: error instanceof Error ? error.name : 'UnknownError',
      }, 'GST credit-note recovery candidate failed')
    }
  }
  return result
}

function addStage(
  aggregate: PaymentRecoveryStageResult,
  next: PaymentRecoveryStageResult,
): void {
  aggregate.candidates += next.candidates
  aggregate.completed += next.completed
  aggregate.deferred += next.deferred
  aggregate.failed += next.failed
}

/**
 * Runs bounded, mode-isolated recovery. It never creates provider checkout
 * objects, notifications, refunds, or provider cancellations. Approved local
 * GST invoices are recovered through the injected charge policy handler.
 */
export async function runPaymentRecoverySweep(
  input: PaymentRecoverySweepInput,
  dependencies: PaymentRecoverySweepDependencies,
): Promise<PaymentRecoverySweepResult> {
  const providerModes = exactProviderModes(input.providerModes)
  const now = input.now ?? new Date()
  if (!validDate(now)) {
    throw new PaymentRecoveryConfigurationError(
      'Payment recovery sweep time is invalid',
    )
  }
  const webhookLimit = exactLimit(input.webhookLimit, DEFAULT_WEBHOOK_LIMIT)
  const couponLimit = exactLimit(input.couponLimit, DEFAULT_COUPON_LIMIT)
  const subscriptionLimit = exactLimit(
    input.subscriptionLimit,
    DEFAULT_SUBSCRIPTION_LIMIT,
  )
  const chargeLimit = exactLimit(input.chargeLimit, DEFAULT_CHARGE_LIMIT)
  const store = dependencies.store ?? mongoPaymentRecoveryCandidateStore
  const processWebhook = dependencies.processWebhook ??
    processPaymentWebhookEvent
  const clientFactory = dependencies.clientFactory ??
    createRazorpayClientFactory()
  const persistSubscription = dependencies.persistSubscription ??
    persistSubscriptionProviderObservation
  const loadSubscriptionContext =
    dependencies.loadSubscriptionContext ??
    ((contextInput) => (
      mongoWebhookDomainMappingStore.loadSubscriptionContext(contextInput)
    ))
  const fulfillSubscriptionCycle = dependencies.fulfillSubscriptionCycle ??
    fulfillSubscriptionCycleProviderObservation
  const recoverCharge = dependencies.recoverCharge ??
    recoverChargeFulfillment
  const recoverCreditNote = dependencies.recoverCreditNote ??
    issueApprovedGstCreditNote
  const expireCoupon = dependencies.expireCoupon ?? expireCouponReservation
  const releaseCoupon = dependencies.releaseCoupon ?? releaseCouponReservation
  const reviewCoupon = dependencies.reviewCoupon ?? markCouponReservationReview
  const result: PaymentRecoverySweepResult = {
    providerModes,
    webhook: emptyStage(),
    coupon: emptyStage(),
    subscription: { ...emptyStage(), cyclesRecovered: 0 },
    charge: emptyStage(),
    creditNote: emptyStage(),
  }

  for (const providerMode of providerModes) {
    const webhook = await retryWebhookInbox({
      providerMode,
      now,
      limit: webhookLimit,
      store,
      processWebhook,
      webhookHandler: dependencies.webhookHandler,
    })
    addStage(result.webhook, webhook)

    const coupon = await recoverCouponReservations({
      providerMode,
      now,
      limit: couponLimit,
      store,
      clientFactory,
      expireCoupon,
      releaseCoupon,
      reviewCoupon,
    })
    addStage(result.coupon, coupon)

    const subscription = await reconcileSubscriptions({
      providerMode,
      now,
      limit: subscriptionLimit,
      store,
      clientFactory,
      loadSubscriptionContext,
      persistSubscription,
      fulfillSubscriptionCycle,
    })
    addStage(result.subscription, subscription)
    result.subscription.cyclesRecovered += subscription.cyclesRecovered

    const charge = await recoverCharges({
      providerMode,
      now,
      limit: chargeLimit,
      store,
      recoverCharge,
    })
    addStage(result.charge, charge)

    const creditNote = await recoverCreditNotes({
      providerMode,
      now,
      limit: chargeLimit,
      store,
      recoverCreditNote,
    })
    addStage(result.creditNote, creditNote)
  }
  return result
}
