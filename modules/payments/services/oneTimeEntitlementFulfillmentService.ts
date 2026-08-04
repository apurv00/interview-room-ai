import mongoose, { type ClientSession } from 'mongoose'
import { z } from 'zod'
import { connectDB } from '@shared/db/connection'
import { savedResumeRepository } from '@shared/services/savedResumeRepository'
import { canonicalJson } from '../lib/canonicalJson'
import { isInrPaise } from '../lib/money'
import {
  ChargeFulfillment,
  type ChargeFulfillmentStatus,
  type IChargeFulfillmentSteps,
} from '../models/ChargeFulfillment'
import {
  CheckoutIntent,
  type CheckoutIntentStatus,
} from '../models/CheckoutIntent'
import {
  PaidInterviewUnlock,
  PAID_INTERVIEW_MAX_DURATION_MINUTES,
} from '../models/PaidInterviewUnlock'
import { PaymentAttempt } from '../models/PaymentAttempt'
import {
  PREMIUM_RESUME_REVISION_WINDOW_DAYS,
  ResumeEntitlement,
} from '../models/ResumeEntitlement'
import type { ProviderMode } from '../types/catalog'

const SINGLE_INTERVIEW_VALIDITY_DAYS = 30 as const
const DAY_MS = 24 * 60 * 60 * 1_000
const SingleInterviewSnapshotSchema = z.object({
  sku: z.literal('single_interview'),
  maxInterviewDurationMinutes: z.literal(
    PAID_INTERVIEW_MAX_DURATION_MINUTES,
  ),
  validityDaysBeforeUse: z.literal(SINGLE_INTERVIEW_VALIDITY_DAYS),
}).strict()

const PremiumResumeSnapshotSchema = z.object({
  sku: z.literal('premium_resume'),
  resumeId: z.string().trim().min(1).max(255),
  revisionWindowDays: z.literal(PREMIUM_RESUME_REVISION_WINDOW_DAYS),
}).strict()

const OneTimeEntitlementSnapshotSchema = z.discriminatedUnion('sku', [
  SingleInterviewSnapshotSchema,
  PremiumResumeSnapshotSchema,
])

export const ONE_TIME_FULFILLMENT_ERROR_CODES = [
  'not_found',
  'unsupported_kind',
  'context_conflict',
  'snapshot_invalid',
  'persistence_conflict',
] as const
export type OneTimeFulfillmentErrorCode = (typeof ONE_TIME_FULFILLMENT_ERROR_CODES)[number]

export class OneTimeEntitlementFulfillmentError extends Error {
  readonly code: OneTimeFulfillmentErrorCode

  constructor(
    code: OneTimeFulfillmentErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'OneTimeEntitlementFulfillmentError'
    this.code = code
  }
}

export interface OneTimeFulfillmentContext {
  fulfillment: {
    id: mongoose.Types.ObjectId
    providerMode: ProviderMode
    razorpayPaymentId: string
    razorpayOrderId?: string
    razorpaySubscriptionId?: string
    userId: mongoose.Types.ObjectId
    kind: 'single_interview' | 'premium_resume' | 'subscription_cycle'
    status: ChargeFulfillmentStatus
    verifiedAmountPaise: number
    verifiedCurrency: string
    steps: IChargeFulfillmentSteps
  }
  attempt: {
    checkoutIntentId: mongoose.Types.ObjectId
    providerMode: ProviderMode
    razorpayPaymentId: string
    razorpayOrderId?: string
    razorpaySubscriptionId?: string
    userId: mongoose.Types.ObjectId
    status: string
    amountPaise: number
    currency: string
    lastSyncedAt: Date
  }
  intent: {
    id: mongoose.Types.ObjectId
    userId: mongoose.Types.ObjectId
    kind: 'subscription' | 'single_interview' | 'premium_resume'
    providerMode: ProviderMode
    status: CheckoutIntentStatus
    sku?: 'single_interview' | 'premium_resume'
    catalogVersion?: string
    listPricePaise?: number
    discountPaise?: number
    payablePaise: number
    couponCampaignId?: mongoose.Types.ObjectId
    currency: string
    razorpayOrderId?: string
    razorpaySubscriptionId?: string
    entitlementSnapshot: unknown
  }
}

export type OneTimeEntitlementDraft =
  | {
      kind: 'single_interview'
      providerMode: ProviderMode
      userId: mongoose.Types.ObjectId
      checkoutIntentId: mongoose.Types.ObjectId
      razorpayPaymentId: string
      maxDurationMinutes: typeof PAID_INTERVIEW_MAX_DURATION_MINUTES
      validUntil: Date
    }
  | {
      kind: 'premium_resume'
      providerMode: ProviderMode
      userId: mongoose.Types.ObjectId
      checkoutIntentId: mongoose.Types.ObjectId
      razorpayPaymentId: string
      resumeId: string
    }

export interface ApplyOneTimeEntitlementInput {
  fulfillmentId: mongoose.Types.ObjectId
  draft: OneTimeEntitlementDraft
  completedAt: Date
}

export interface OneTimeEntitlementActivatedAnalyticsEvidence {
  readonly sourceEvidenceId: string
  readonly correlationId: string
  readonly subjectId: string
  readonly providerMode: ProviderMode
  readonly occurredAt: Date
  readonly productKey: 'single_interview' | 'premium_resume'
  readonly catalogVersion: string | null
  readonly listPricePaise: number | null
  readonly discountPaise: number | null
  readonly payablePaise: number
  readonly couponCampaignId: string | null
  readonly accessEndsAt: Date | null
}

export interface OneTimeEntitlementActivatedAnalyticsProducer {
  appendOneTimeEntitlementActivatedInSession(
    evidence: () => OneTimeEntitlementActivatedAnalyticsEvidence,
    session: ClientSession,
  ): Promise<void>
}

export interface OneTimeEntitlementFulfillmentResult {
  fulfillmentId: string
  checkoutIntentId: string
  entitlementId: string
  kind: OneTimeEntitlementDraft['kind']
  fulfillmentStatus: 'entitlement_applied' | ChargeFulfillmentStatus
  reused: boolean
}

export interface OneTimeEntitlementFulfillmentStore {
  loadContext(
    fulfillmentId: mongoose.Types.ObjectId,
  ): Promise<OneTimeFulfillmentContext | null>
  applyEntitlement(
    input: ApplyOneTimeEntitlementInput,
    producer?: OneTimeEntitlementActivatedAnalyticsProducer,
  ): Promise<OneTimeEntitlementFulfillmentResult>
}

export interface OneTimeEntitlementFulfillmentDependencies {
  store?: OneTimeEntitlementFulfillmentStore
  now?: () => Date
  commercialAnalyticsProducer?: OneTimeEntitlementActivatedAnalyticsProducer
}

function failure(
  code: OneTimeFulfillmentErrorCode,
  message: string,
  cause?: unknown,
): OneTimeEntitlementFulfillmentError {
  return new OneTimeEntitlementFulfillmentError(
    code,
    message,
    cause === undefined ? undefined : { cause },
  )
}

function sameObjectId(
  left: mongoose.Types.ObjectId,
  right: mongoose.Types.ObjectId,
): boolean {
  return left.equals(right)
}

function assertValidDate(value: Date, label: string): void {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw failure('context_conflict', `${label} is invalid`)
  }
}

const postVerificationStatuses = new Set<ChargeFulfillmentStatus>([
  'verified', 'entitlement_applied', 'invoiced', 'notified', 'done',
])

function deriveEntitlementDraft(
  context: OneTimeFulfillmentContext,
): OneTimeEntitlementDraft {
  const { fulfillment, attempt, intent } = context
  if (
    fulfillment.kind !== 'single_interview' &&
    fulfillment.kind !== 'premium_resume'
  ) {
    throw failure(
      'unsupported_kind',
      'Subscription cycles require the subscription fulfillment path',
    )
  }
  if (
    !postVerificationStatuses.has(fulfillment.status) ||
    fulfillment.steps.verification.status !== 'complete' ||
    !fulfillment.steps.verification.completedAt ||
    fulfillment.steps.verification.referenceId !==
      fulfillment.razorpayPaymentId ||
    fulfillment.steps.verification.operationKey !==
      `${fulfillment.providerMode}:` +
        `${fulfillment.razorpayPaymentId}:verification`
  ) {
    throw failure(
      'context_conflict',
      'Charge fulfillment is not durably payment-verified',
    )
  }
  if (
    fulfillment.status !== 'verified' &&
    (
      fulfillment.steps.entitlement.status !== 'complete' ||
      !fulfillment.steps.entitlement.referenceId
    )
  ) {
    throw failure(
      'context_conflict',
      'Advanced fulfillment lacks entitlement evidence',
    )
  }
  if (
    fulfillment.status === 'verified' &&
    fulfillment.steps.entitlement.status !== 'pending'
  ) {
    throw failure(
      'context_conflict',
      'Verified fulfillment has an invalid entitlement step',
    )
  }
  if (
    attempt.status !== 'captured' ||
    attempt.currency !== 'INR' ||
    fulfillment.verifiedCurrency !== 'INR' ||
    intent.currency !== 'INR' ||
    !isInrPaise(attempt.amountPaise) ||
    !isInrPaise(fulfillment.verifiedAmountPaise) ||
    !isInrPaise(intent.payablePaise) ||
    fulfillment.verifiedAmountPaise === 0 ||
    attempt.amountPaise !== fulfillment.verifiedAmountPaise ||
    intent.payablePaise !== fulfillment.verifiedAmountPaise ||
    attempt.providerMode !== fulfillment.providerMode ||
    intent.providerMode !== fulfillment.providerMode ||
    attempt.razorpayPaymentId !== fulfillment.razorpayPaymentId ||
    !sameObjectId(attempt.userId, fulfillment.userId) ||
    !sameObjectId(intent.userId, fulfillment.userId) ||
    !sameObjectId(attempt.checkoutIntentId, intent.id) ||
    intent.kind !== fulfillment.kind ||
    intent.sku !== fulfillment.kind ||
    !fulfillment.razorpayOrderId ||
    attempt.razorpayOrderId !== fulfillment.razorpayOrderId ||
    intent.razorpayOrderId !== fulfillment.razorpayOrderId ||
    attempt.razorpaySubscriptionId !== undefined ||
    fulfillment.razorpaySubscriptionId !== undefined ||
    intent.razorpaySubscriptionId !== undefined ||
    (
      fulfillment.status === 'verified' &&
      intent.status === 'fulfilled'
    ) ||
    (
      intent.status !== 'payment_captured' &&
      intent.status !== 'fulfilled'
    )
  ) {
    throw failure(
      'context_conflict',
      'Payment, fulfillment, and checkout intent do not agree',
    )
  }
  assertValidDate(
    fulfillment.steps.verification.completedAt,
    'Fulfillment verification timestamp',
  )
  assertValidDate(attempt.lastSyncedAt, 'Payment last-sync timestamp')

  const snapshot = OneTimeEntitlementSnapshotSchema.safeParse(
    intent.entitlementSnapshot,
  )
  if (!snapshot.success || snapshot.data.sku !== fulfillment.kind) {
    throw failure(
      'snapshot_invalid',
      'Checkout entitlement snapshot is invalid for this purchase',
    )
  }

  const common = {
    providerMode: fulfillment.providerMode,
    userId: fulfillment.userId,
    checkoutIntentId: intent.id,
    razorpayPaymentId: fulfillment.razorpayPaymentId,
  }
  if (snapshot.data.sku === 'premium_resume') {
    return {
      kind: 'premium_resume',
      ...common,
      resumeId: snapshot.data.resumeId,
    }
  }

  const validUntil = new Date(
    fulfillment.steps.verification.completedAt.getTime() +
      snapshot.data.validityDaysBeforeUse * DAY_MS,
  )
  assertValidDate(validUntil, 'Paid interview expiry')
  return {
    kind: 'single_interview',
    ...common,
    maxDurationMinutes: snapshot.data.maxInterviewDurationMinutes,
    validUntil,
  }
}

interface LeanFulfillment {
  _id: mongoose.Types.ObjectId
  providerMode: ProviderMode
  razorpayPaymentId: string
  razorpayOrderId?: string
  razorpaySubscriptionId?: string
  userId: mongoose.Types.ObjectId
  kind: OneTimeFulfillmentContext['fulfillment']['kind']
  status: ChargeFulfillmentStatus
  verifiedAmountPaise: number
  verifiedCurrency: string
  steps: IChargeFulfillmentSteps
}

interface LeanAttempt {
  checkoutIntentId: mongoose.Types.ObjectId
  providerMode: ProviderMode
  razorpayPaymentId: string
  razorpayOrderId?: string
  razorpaySubscriptionId?: string
  userId: mongoose.Types.ObjectId
  status: string
  amountPaise: number
  currency: string
  lastSyncedAt: Date
}

interface LeanIntent {
  _id: mongoose.Types.ObjectId
  userId: mongoose.Types.ObjectId
  kind: OneTimeFulfillmentContext['intent']['kind']
  providerMode: ProviderMode
  status: CheckoutIntentStatus
  sku?: 'single_interview' | 'premium_resume'
  catalogVersion?: string
  quoteSnapshot: {
    listPricePaise?: number
    discountPaise?: number
    payablePaise: number
    couponCampaignId?: mongoose.Types.ObjectId
    currency: string
    entitlementSnapshot: unknown
  }
  razorpayOrderId?: string
  razorpaySubscriptionId?: string
}

async function loadMongoContext(
  fulfillmentId: mongoose.Types.ObjectId,
  session?: ClientSession,
): Promise<OneTimeFulfillmentContext | null> {
  const fulfillmentQuery = ChargeFulfillment.findById(fulfillmentId)
    .select([
      '_id',
      'providerMode',
      'razorpayPaymentId',
      'razorpayOrderId',
      'razorpaySubscriptionId',
      'userId',
      'kind',
      'status',
      'verifiedAmountPaise',
      'verifiedCurrency',
      'steps',
    ].join(' '))
  if (session) fulfillmentQuery.session(session)
  const fulfillment = await fulfillmentQuery.lean<LeanFulfillment>()
  if (!fulfillment) return null

  const attemptQuery = PaymentAttempt.findOne({
    providerMode: fulfillment.providerMode,
    razorpayPaymentId: fulfillment.razorpayPaymentId,
  }).select([
    'checkoutIntentId',
    'providerMode',
    'razorpayPaymentId',
    'razorpayOrderId',
    'razorpaySubscriptionId',
    'userId',
    'status',
    'amountPaise',
    'currency',
    'lastSyncedAt',
  ].join(' '))
  if (session) attemptQuery.session(session)
  const attempt = await attemptQuery.lean<LeanAttempt>()
  if (!attempt) {
    throw failure(
      'context_conflict',
      'Verified fulfillment has no payment attempt',
    )
  }

  const intentQuery = CheckoutIntent.findById(
    attempt.checkoutIntentId,
  ).select([
    '_id',
    'userId',
    'kind',
    'providerMode',
    'status',
    'sku',
    'catalogVersion',
    'quoteSnapshot.listPricePaise',
    'quoteSnapshot.discountPaise',
    'quoteSnapshot.payablePaise',
    'quoteSnapshot.couponCampaignId',
    'quoteSnapshot.currency',
    'quoteSnapshot.entitlementSnapshot',
    'razorpayOrderId',
    'razorpaySubscriptionId',
  ].join(' '))
  if (session) intentQuery.session(session)
  const intent = await intentQuery.lean<LeanIntent>()
  if (!intent) {
    throw failure(
      'context_conflict',
      'Verified payment attempt has no checkout intent',
    )
  }

  return {
    fulfillment: {
      id: fulfillment._id,
      providerMode: fulfillment.providerMode,
      razorpayPaymentId: fulfillment.razorpayPaymentId,
      razorpayOrderId: fulfillment.razorpayOrderId,
      razorpaySubscriptionId:
        fulfillment.razorpaySubscriptionId,
      userId: fulfillment.userId,
      kind: fulfillment.kind,
      status: fulfillment.status,
      verifiedAmountPaise: fulfillment.verifiedAmountPaise,
      verifiedCurrency: fulfillment.verifiedCurrency,
      steps: fulfillment.steps,
    },
    attempt,
    intent: {
      id: intent._id,
      userId: intent.userId,
      kind: intent.kind,
      providerMode: intent.providerMode,
      status: intent.status,
      sku: intent.sku,
      catalogVersion: intent.catalogVersion,
      listPricePaise: intent.quoteSnapshot.listPricePaise,
      discountPaise: intent.quoteSnapshot.discountPaise,
      payablePaise: intent.quoteSnapshot.payablePaise,
      couponCampaignId: intent.quoteSnapshot.couponCampaignId,
      currency: intent.quoteSnapshot.currency,
      razorpayOrderId: intent.razorpayOrderId,
      razorpaySubscriptionId: intent.razorpaySubscriptionId,
      entitlementSnapshot: intent.quoteSnapshot.entitlementSnapshot,
    },
  }
}

function draftComparable(draft: OneTimeEntitlementDraft): unknown {
  return {
    ...draft,
    userId: draft.userId.toString(),
    checkoutIntentId: draft.checkoutIntentId.toString(),
  }
}

function isDuplicateKeyError(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === 'object' &&
    (
      ('code' in error && error.code === 11000) ||
      ('cause' in error && isDuplicateKeyError(error.cause))
    ),
  )
}

async function assertPremiumResumeStillOwned(
  draft: OneTimeEntitlementDraft,
  session: ClientSession,
): Promise<void> {
  if (draft.kind !== 'premium_resume') return
  const ownership =
    await savedResumeRepository.fenceOwnedIdentityForMutation(
      draft.userId,
      draft.resumeId,
      { session, maxTimeMS: 1_000 },
    )
  if (ownership?.status !== 'exact') {
    throw failure(
      'context_conflict',
      'Premium resume was deleted before entitlement fulfillment',
    )
  }
}

async function upsertEntitlement(
  draft: OneTimeEntitlementDraft,
  session: ClientSession,
): Promise<{ id: string; reused: boolean }> {
  if (draft.kind === 'single_interview') {
    const key = {
      providerMode: draft.providerMode,
      razorpayPaymentId: draft.razorpayPaymentId,
    }
    const existing = await PaidInterviewUnlock.findOne(key)
      .session(session)
      .lean<{
        _id: mongoose.Types.ObjectId
        userId: mongoose.Types.ObjectId
        checkoutIntentId: mongoose.Types.ObjectId
        maxDurationMinutes: number
        validUntil: Date
      }>()
    const entitlement = await PaidInterviewUnlock.findOneAndUpdate(
      key,
      {
        $setOnInsert: {
          userId: draft.userId,
          providerMode: draft.providerMode,
          checkoutIntentId: draft.checkoutIntentId,
          razorpayPaymentId: draft.razorpayPaymentId,
          status: 'available',
          maxDurationMinutes: draft.maxDurationMinutes,
          validUntil: draft.validUntil,
        },
      },
      {
        upsert: true,
        new: true,
        runValidators: true,
        setDefaultsOnInsert: true,
        session,
      },
    ).lean<{
      _id: mongoose.Types.ObjectId
      userId: mongoose.Types.ObjectId
      checkoutIntentId: mongoose.Types.ObjectId
      maxDurationMinutes: number
      validUntil: Date
    }>()
    if (
      !entitlement ||
      !entitlement.userId.equals(draft.userId) ||
      !entitlement.checkoutIntentId.equals(draft.checkoutIntentId) ||
      entitlement.maxDurationMinutes !== draft.maxDurationMinutes ||
      entitlement.validUntil.getTime() !== draft.validUntil.getTime()
    ) {
      throw failure(
        'persistence_conflict',
        'Existing paid interview entitlement conflicts with payment',
      )
    }
    return {
      id: entitlement._id.toString(),
      reused: existing !== null,
    }
  }

  const key = {
    providerMode: draft.providerMode,
    razorpayPaymentId: draft.razorpayPaymentId,
  }
  const existing = await ResumeEntitlement.findOne(key)
    .session(session)
    .lean<{
      _id: mongoose.Types.ObjectId
      userId: mongoose.Types.ObjectId
      checkoutIntentId: mongoose.Types.ObjectId
      resumeId: string
      source: string
    }>()
  const entitlement = await ResumeEntitlement.findOneAndUpdate(
    key,
    {
      $setOnInsert: {
        userId: draft.userId,
        resumeId: draft.resumeId,
        source: 'premium_resume',
        providerMode: draft.providerMode,
        checkoutIntentId: draft.checkoutIntentId,
        razorpayPaymentId: draft.razorpayPaymentId,
        status: 'active',
      },
    },
    {
      upsert: true,
      new: true,
      runValidators: true,
      setDefaultsOnInsert: true,
      session,
    },
  ).lean<{
    _id: mongoose.Types.ObjectId
    userId: mongoose.Types.ObjectId
    checkoutIntentId: mongoose.Types.ObjectId
    resumeId: string
    source: string
  }>()
  if (
    !entitlement ||
    !entitlement.userId.equals(draft.userId) ||
    !entitlement.checkoutIntentId.equals(draft.checkoutIntentId) ||
    entitlement.resumeId !== draft.resumeId ||
    entitlement.source !== 'premium_resume'
  ) {
    throw failure(
      'persistence_conflict',
      'Existing premium resume entitlement conflicts with payment',
    )
  }
  return {
    id: entitlement._id.toString(),
    reused: existing !== null,
  }
}

async function applyMongoEntitlementInSession(
  input: ApplyOneTimeEntitlementInput,
  session: ClientSession,
  producer?: OneTimeEntitlementActivatedAnalyticsProducer,
): Promise<OneTimeEntitlementFulfillmentResult> {
  const current = await loadMongoContext(input.fulfillmentId, session)
  if (!current) {
    throw failure('not_found', 'Charge fulfillment was not found')
  }
  const currentDraft = deriveEntitlementDraft(current)
  if (
    canonicalJson(draftComparable(currentDraft)) !==
    canonicalJson(draftComparable(input.draft))
  ) {
    throw failure(
      'persistence_conflict',
      'Fulfillment context changed before entitlement application',
    )
  }
  if (current.fulfillment.status === 'verified') {
    await assertPremiumResumeStillOwned(currentDraft, session)
  }
  const entitlement = await upsertEntitlement(currentDraft, session)
  let fulfillmentStatus = current.fulfillment.status
  if (current.fulfillment.status === 'verified') {
    const advanced = await ChargeFulfillment.findOneAndUpdate(
      {
        _id: input.fulfillmentId,
        status: 'verified',
        'steps.entitlement.status': 'pending',
      },
      {
        $set: {
          status: 'entitlement_applied',
          'steps.entitlement': {
            status: 'complete',
            operationKey:
              current.fulfillment.steps.entitlement.operationKey,
            completedAt: input.completedAt,
            lastAttemptAt: input.completedAt,
            referenceId: entitlement.id,
          },
        },
      },
      { new: true, runValidators: true, session },
    ).lean<{
      status: ChargeFulfillmentStatus
      steps: IChargeFulfillmentSteps
    }>()
    if (!advanced) {
      throw failure(
        'persistence_conflict',
        'Entitlement step raced with another worker',
      )
    }
    fulfillmentStatus = advanced.status
  } else if (
    current.fulfillment.steps.entitlement.referenceId !== entitlement.id
  ) {
    throw failure(
      'persistence_conflict',
      'Fulfillment references a different entitlement',
    )
  }
  if (current.intent.status === 'payment_captured') {
    const intentUpdate = await CheckoutIntent.updateOne(
      { _id: current.intent.id, status: 'payment_captured' },
      { $set: { status: 'fulfilled' } },
      { runValidators: true, session },
    )
    if (intentUpdate.modifiedCount !== 1) {
      const raced = await CheckoutIntent.findById(current.intent.id)
        .select('status')
        .session(session)
        .lean<{ status: CheckoutIntentStatus }>()
      if (raced?.status !== 'fulfilled') {
        throw failure(
          'persistence_conflict',
          'Checkout intent could not advance to fulfilled',
        )
      }
    }
  }
  await producer?.appendOneTimeEntitlementActivatedInSession(
    () => ({
      sourceEvidenceId: entitlement.id,
      correlationId: current.intent.id.toHexString(),
      subjectId: current.intent.userId.toHexString(),
      providerMode: current.intent.providerMode,
      occurredAt: current.fulfillment.status === 'verified'
        ? input.completedAt
        : current.fulfillment.steps.entitlement.completedAt ??
          new Date(Number.NaN),
      productKey: currentDraft.kind,
      catalogVersion: current.intent.catalogVersion ?? null,
      listPricePaise: current.intent.listPricePaise ?? null,
      discountPaise: current.intent.discountPaise ?? null,
      payablePaise: current.intent.payablePaise,
      couponCampaignId:
        current.intent.couponCampaignId?.toHexString() ?? null,
      accessEndsAt: currentDraft.kind === 'single_interview'
        ? currentDraft.validUntil
        : null,
    }),
    session,
  )
  return {
    fulfillmentId: current.fulfillment.id.toString(),
    checkoutIntentId: current.intent.id.toString(),
    entitlementId: entitlement.id,
    kind: currentDraft.kind,
    fulfillmentStatus,
    reused:
      entitlement.reused ||
      current.fulfillment.status !== 'verified' ||
      current.intent.status === 'fulfilled',
  }
}

async function applyMongoEntitlementOnce(
  input: ApplyOneTimeEntitlementInput,
  producer?: OneTimeEntitlementActivatedAnalyticsProducer,
): Promise<OneTimeEntitlementFulfillmentResult> {
  const session = await mongoose.startSession()
  let result: OneTimeEntitlementFulfillmentResult | undefined
  try {
    await session.withTransaction(async () => {
      result = await applyMongoEntitlementInSession(
        input,
        session,
        producer,
      )
    }, {
      readConcern: { level: 'snapshot' },
      writeConcern: { w: 'majority' },
      readPreference: 'primary',
    })
  } finally {
    await session.endSession()
  }
  if (!result) {
    throw failure(
      'persistence_conflict',
      'Entitlement transaction completed without a result',
    )
  }
  return result
}

export async function fulfillOneTimeEntitlementInSession(
  input: { fulfillmentId: string; completedAt: Date },
  session: ClientSession,
  producer?: OneTimeEntitlementActivatedAnalyticsProducer,
): Promise<OneTimeEntitlementFulfillmentResult> {
  if (!/^[a-fA-F0-9]{24}$/.test(input.fulfillmentId)) {
    throw failure('not_found', 'Charge fulfillment was not found')
  }
  if (Number.isNaN(input.completedAt.getTime())) {
    throw failure('context_conflict', 'Completion timestamp is invalid')
  }
  const fulfillmentId = new mongoose.Types.ObjectId(input.fulfillmentId)
  const context = await loadMongoContext(fulfillmentId, session)
  if (!context) throw failure('not_found', 'Charge fulfillment was not found')
  return applyMongoEntitlementInSession({
    fulfillmentId,
    draft: deriveEntitlementDraft(context),
    completedAt: input.completedAt,
  }, session, producer)
}

export const mongoOneTimeEntitlementFulfillmentStore:
OneTimeEntitlementFulfillmentStore = {
  async loadContext(fulfillmentId) {
    await connectDB()
    return loadMongoContext(fulfillmentId)
  },

  async applyEntitlement(input, producer) {
    await connectDB()
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await applyMongoEntitlementOnce(input, producer)
      } catch (error) {
        if (attempt === 0 && isDuplicateKeyError(error)) continue
        throw error
      }
    }
    throw failure(
      'persistence_conflict',
      'Entitlement application exhausted concurrency recovery',
    )
  },
}

/**
 * Applies only the one-time product entitlement. Invoice creation and customer
 * notification remain separate idempotent fulfillment steps.
 */
export async function fulfillOneTimeEntitlement(
  input: { fulfillmentId: string },
  dependencies: OneTimeEntitlementFulfillmentDependencies = {},
): Promise<OneTimeEntitlementFulfillmentResult> {
  if (!/^[a-fA-F0-9]{24}$/.test(input.fulfillmentId)) {
    throw failure('not_found', 'Charge fulfillment was not found')
  }
  const fulfillmentId =
    new mongoose.Types.ObjectId(input.fulfillmentId)
  const store =
    dependencies.store ?? mongoOneTimeEntitlementFulfillmentStore
  const context = await store.loadContext(fulfillmentId)
  if (!context) {
    throw failure('not_found', 'Charge fulfillment was not found')
  }
  const draft = deriveEntitlementDraft(context)
  const completedAt = dependencies.now?.() ?? new Date()
  if (Number.isNaN(completedAt.getTime())) {
    throw failure('context_conflict', 'Completion timestamp is invalid')
  }
  try {
    const persistenceInput = {
      fulfillmentId,
      draft,
      completedAt,
    }
    return dependencies.commercialAnalyticsProducer
      ? await store.applyEntitlement(
          persistenceInput,
          dependencies.commercialAnalyticsProducer,
        )
      : await store.applyEntitlement(persistenceInput)
  } catch (error) {
    if (error instanceof OneTimeEntitlementFulfillmentError) throw error
    throw failure(
      'persistence_conflict',
      'One-time entitlement could not be applied coherently',
      error,
    )
  }
}
