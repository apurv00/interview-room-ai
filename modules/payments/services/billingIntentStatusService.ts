import mongoose from 'mongoose'
import { connectDB } from '@shared/db/connection'
import {
  type CheckoutIntentKind,
  type CheckoutIntentStatus,
  CheckoutIntent,
} from '../models/CheckoutIntent'
import {
  type ChargeFulfillmentStatus,
  ChargeFulfillment,
} from '../models/ChargeFulfillment'
import {
  PaymentAttempt,
  type PaymentAttemptStatus,
} from '../models/PaymentAttempt'
import type { ProviderMode } from '../types/catalog'

export const PUBLIC_BILLING_INTENT_STATUSES = [
  'preparing',
  'awaiting_payment',
  'processing',
  'completed',
  'expired',
  'failed',
  'cancelled',
  'manual_review',
] as const
export type PublicBillingIntentStatus =
  (typeof PUBLIC_BILLING_INTENT_STATUSES)[number]

export interface BillingIntentStatusResult {
  intentId: string
  kind: CheckoutIntentKind
  status: PublicBillingIntentStatus
  terminal: boolean
  pollAfterMs?: number
  updatedAt: string
}

export interface BillingIntentStatusRecord {
  intentId: string
  kind: CheckoutIntentKind
  intentStatus: CheckoutIntentStatus
  fulfillmentStatus?: ChargeFulfillmentStatus
  updatedAt: Date
}

export interface BillingIntentStatusStore {
  loadForUser(input: {
    intentId: mongoose.Types.ObjectId
    userId: mongoose.Types.ObjectId
  }): Promise<BillingIntentStatusRecord | null>
}

export interface BillingIntentStatusDependencies {
  store?: BillingIntentStatusStore
}

export class BillingIntentStatusNotFoundError extends Error {
  constructor() {
    super('Billing intent was not found for the authenticated user')
    this.name = 'BillingIntentStatusNotFoundError'
  }
}

function latestDate(...values: Array<Date | undefined>): Date {
  return values.reduce<Date>(
    (latest, value) => (
      value && value.getTime() > latest.getTime() ? value : latest
    ),
    new Date(0),
  )
}

function mapIntentStatus(
  intentStatus: CheckoutIntentStatus,
): PublicBillingIntentStatus {
  switch (intentStatus) {
    case 'created':
      return 'preparing'
    case 'remote_created':
    case 'checkout_opened':
      return 'awaiting_payment'
    case 'authorization_pending':
    case 'payment_captured':
      return 'processing'
    case 'fulfilled':
      return 'completed'
    case 'abandoned':
      return 'expired'
    case 'failed':
      return 'failed'
    case 'cancelled':
      return 'cancelled'
    case 'review':
      return 'manual_review'
  }
}

function publicStatus(
  record: BillingIntentStatusRecord,
): PublicBillingIntentStatus {
  if (record.fulfillmentStatus === 'done') return 'completed'
  if (
    record.intentStatus === 'review' ||
    record.fulfillmentStatus === 'review'
  ) {
    return 'manual_review'
  }
  if (
    record.intentStatus === 'abandoned' ||
    record.intentStatus === 'failed' ||
    record.intentStatus === 'cancelled'
  ) {
    return mapIntentStatus(record.intentStatus)
  }
  // Entitlement fulfillment advances the owning checkout intent last, in the
  // same transaction. Invoicing and notification may continue independently;
  // they must not keep a successfully granted purchase in an endless poll.
  if (record.intentStatus === 'fulfilled') return 'completed'
  if (record.fulfillmentStatus !== undefined) return 'processing'
  return mapIntentStatus(record.intentStatus)
}

function isTerminal(status: PublicBillingIntentStatus): boolean {
  return [
    'completed',
    'expired',
    'failed',
    'cancelled',
    'manual_review',
  ].includes(status)
}

interface LeanIntent {
  _id: mongoose.Types.ObjectId
  kind: CheckoutIntentKind
  providerMode: ProviderMode
  status: CheckoutIntentStatus
  updatedAt: Date
}

interface LeanAttempt {
  razorpayPaymentId: string
  status: PaymentAttemptStatus
  updatedAt: Date
}

interface LeanFulfillment {
  status: ChargeFulfillmentStatus
  updatedAt: Date
}

export const mongoBillingIntentStatusStore: BillingIntentStatusStore = {
  async loadForUser({ intentId, userId }) {
    await connectDB()
    const intent = await CheckoutIntent.findOne({
      _id: intentId,
      userId,
    })
      .select('_id kind providerMode status updatedAt')
      .lean<LeanIntent>()
    if (!intent) return null
    if (intent.status === 'fulfilled') {
      return {
        intentId: intent._id.toString(),
        kind: intent.kind,
        intentStatus: intent.status,
        updatedAt: intent.updatedAt,
      }
    }

    const attempts = await PaymentAttempt.find({
      checkoutIntentId: intentId,
      userId,
      providerMode: intent.providerMode,
      status: {
        $in: ['captured', 'review', 'refunded', 'disputed'],
      },
    })
      .sort({ createdAt: -1, _id: -1 })
      .limit(2)
      .select('razorpayPaymentId status updatedAt')
      .lean<LeanAttempt[]>()

    let fulfillment: LeanFulfillment | null = null
    const attempt = attempts[0]
    const attemptRequiresReview =
      attempts.length > 1 ||
      (attempt !== undefined && attempt.status !== 'captured')
    if (attempt && !attemptRequiresReview) {
      fulfillment = await ChargeFulfillment.findOne({
        providerMode: intent.providerMode,
        razorpayPaymentId: attempt.razorpayPaymentId,
        userId,
      })
        .select('status updatedAt')
        .lean<LeanFulfillment>()
    }

    return {
      intentId: intent._id.toString(),
      kind: intent.kind,
      intentStatus: intent.status,
      fulfillmentStatus: attemptRequiresReview
        ? 'review'
        : fulfillment?.status,
      updatedAt: latestDate(
        intent.updatedAt,
        ...attempts.map((candidate) => candidate.updatedAt),
        fulfillment?.updatedAt,
      ),
    }
  },
}

export async function readBillingIntentStatus(
  input: {
    intentId: string
    userId: string
  },
  dependencies: BillingIntentStatusDependencies = {},
): Promise<BillingIntentStatusResult> {
  if (
    !/^[a-f\d]{24}$/i.test(input.intentId) ||
    !/^[a-f\d]{24}$/i.test(input.userId)
  ) {
    throw new BillingIntentStatusNotFoundError()
  }

  const store = dependencies.store ?? mongoBillingIntentStatusStore
  const record = await store.loadForUser({
    intentId: new mongoose.Types.ObjectId(input.intentId),
    userId: new mongoose.Types.ObjectId(input.userId),
  })
  if (!record) throw new BillingIntentStatusNotFoundError()

  const status = publicStatus(record)
  const terminal = isTerminal(status)
  return {
    intentId: record.intentId,
    kind: record.kind,
    status,
    terminal,
    ...(!terminal && { pollAfterMs: 2_000 }),
    updatedAt: record.updatedAt.toISOString(),
  }
}
