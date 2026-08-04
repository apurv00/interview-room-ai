import mongoose, { type ClientSession } from 'mongoose'
import { createHash } from 'node:crypto'
import { connectDB } from '@shared/db/connection'
import {
  CouponCampaignUsageFence,
  type CouponUsageFenceScope,
} from '../models/CouponCampaignUsageFence'
import {
  CouponRedemption,
} from '../models/CouponRedemption'
import {
  COUPON_RESERVATION_REVIEW_REASONS,
  COUPON_TERMINAL_EVIDENCE_SOURCES,
  COUPON_TERMINAL_REASONS,
  CouponReservation,
  type CouponCapacityConversionSource,
  type CouponCapacityDisposition,
  type CouponReservationReviewReason,
  type CouponReservationStatus,
  type CouponTerminalEvidenceSource,
  type CouponTerminalReason,
} from '../models/CouponReservation'
import {
  COUPON_CAMPAIGN_MODES,
  PROVIDER_MODES,
  type CouponCampaignMode,
  type ProviderMode,
} from '../types/catalog'

const ALLOWED_DISCOUNTS = new Set([5_000, 10_000, 15_000, 20_000])
const RAZORPAY_SUBSCRIPTION_ID_PATTERN = /^sub_[A-Za-z0-9]+$/
const RAZORPAY_PAYMENT_ID_PATTERN = /^pay_[A-Za-z0-9]+$/
const TRANSACTION_OPTIONS = {
  readConcern: { level: 'snapshot' as const },
  writeConcern: { w: 'majority' as const },
  readPreference: 'primary' as const,
}

export interface ReserveCouponCapacityInput {
  providerMode: ProviderMode
  campaignId: string
  campaignRevision: number
  userId: string
  checkoutIntentId: string
  catalogVersion: string
  planKey: 'plus' | 'pro'
  campaignModeSnapshot: CouponCampaignMode
  codeSnapshot?: string
  discountPaise: number
  discountedBillingCycles: number
  maxRedemptions?: number
  maxRedemptionsPerUser: number
  reservationTtlHours: number
  reservedAt: Date
}

export interface ConvertCouponReservationCycleInput {
  providerMode: ProviderMode
  campaignId: string
  campaignRevision: number
  userId: string
  checkoutIntentId: string
  paymentId: string
  subscriptionId?: string
  orderId?: string
  discountedBillingCycleNumber: number
  capturedAt: Date
}

export interface CommitCouponReservationAuthorizationInput {
  providerMode: ProviderMode
  campaignId: string
  campaignRevision: number
  userId: string
  checkoutIntentId: string
  providerSubscriptionId: string
  authorizationPaymentId: string
  authenticatedAt: Date
}

export interface CouponTerminalEvidence {
  reason: CouponTerminalReason
  source: CouponTerminalEvidenceSource
  evidenceKey: string
  observedAt: Date
}

export interface TerminateCouponReservationInput {
  providerMode: ProviderMode
  campaignId: string
  userId: string
  checkoutIntentId: string
  evidence: CouponTerminalEvidence
  terminalAt: Date
}

export interface ReviewCouponReservationInput {
  providerMode: ProviderMode
  campaignId: string
  userId: string
  checkoutIntentId: string
  reason: 'ambiguous_remote_state' | 'operator_review'
  evidenceKey: string
}

export interface CouponReservationView {
  id: string
  providerMode: ProviderMode
  campaignId: string
  campaignRevision: number
  userId: string
  checkoutIntentId: string
  catalogVersion: string
  planKey: 'plus' | 'pro'
  campaignModeSnapshot: CouponCampaignMode
  codeSnapshot?: string
  discountPaise: number
  discountedBillingCycles: number
  maxRedemptions?: number
  maxRedemptionsPerUser: number
  reservationTtlHours: number
  status: CouponReservationStatus
  capacityDisposition: CouponCapacityDisposition
  reservedAt: Date
  validUntil: Date
  convertedAt?: Date
  terminalAt?: Date
  terminalReason?: CouponTerminalReason
  reviewReason?: CouponReservationReviewReason
}

export interface CouponRedemptionView {
  id: string
  providerMode: ProviderMode
  reservationId: string
  campaignId: string
  campaignRevision: number
  userId: string
  checkoutIntentId: string
  subscriptionId?: string
  orderId?: string
  paymentId: string
  catalogVersion: string
  codeSnapshot?: string
  discountPaise: number
  discountedBillingCycleNumber: number
  requiresReview: boolean
  createdAt: Date
}

export type ReserveCouponCapacityResult =
  | {
      outcome: 'reserved' | 'reused'
      reservation: CouponReservationView
    }
  | {
      outcome: 'global_cap_exhausted' | 'user_cap_exhausted'
    }

export interface ConvertCouponReservationCycleResult {
  outcome: 'converted' | 'redemption_recorded' | 'reused' | 'review'
  reservation: CouponReservationView
  redemption?: CouponRedemptionView
  requiresReview: boolean
}

export interface CommitCouponReservationAuthorizationResult {
  outcome: 'converted' | 'reused' | 'review'
  reservation: CouponReservationView
  requiresReview: boolean
}

export interface TerminateCouponReservationResult {
  outcome: 'released' | 'expired' | 'reused' | 'already_converted' | 'review'
  reservation: CouponReservationView
}

export interface CouponReservationRecoveryRow {
  id: string
  providerMode: ProviderMode
  campaignId: string
  userId: string
  checkoutIntentId: string
  validUntil: Date
}

interface StoredCouponReservation {
  _id: mongoose.Types.ObjectId
  providerMode: ProviderMode
  campaignId: mongoose.Types.ObjectId
  campaignRevision: number
  userId: mongoose.Types.ObjectId
  checkoutIntentId: mongoose.Types.ObjectId
  catalogVersion: string
  planKey: 'plus' | 'pro'
  campaignModeSnapshot: CouponCampaignMode
  codeSnapshot?: string
  discountPaise: number
  discountedBillingCycles: number
  maxRedemptionsSnapshot?: number
  maxRedemptionsPerUserSnapshot: number
  reservationTtlHoursSnapshot: number
  status: CouponReservationStatus
  capacityDisposition: CouponCapacityDisposition
  reservedAt: Date
  validUntil: Date
  convertedAt?: Date
  capacityConversionSource?: CouponCapacityConversionSource
  conversionProviderSubscriptionId?: string
  conversionProviderPaymentId?: string
  terminalAt?: Date
  terminalReason?: CouponTerminalReason
  terminalEvidenceSource?: CouponTerminalEvidenceSource
  terminalEvidenceKey?: string
  terminalObservedAt?: Date
  reviewReason?: CouponReservationReviewReason
  reviewEvidenceKey?: string
}

interface StoredCouponRedemption {
  _id: mongoose.Types.ObjectId
  providerMode: ProviderMode
  reservationId: mongoose.Types.ObjectId
  campaignId: mongoose.Types.ObjectId
  campaignRevision: number
  userId: mongoose.Types.ObjectId
  checkoutIntentId: mongoose.Types.ObjectId
  subscriptionId?: string
  orderId?: string
  paymentId: string
  catalogVersion: string
  codeSnapshot?: string
  discountPaise: number
  discountedBillingCycleNumber: number
  requiresReview: boolean
  createdAt: Date
}

interface ReservationDraft extends Omit<
  StoredCouponReservation,
  '_id' | 'terminalAt' | 'terminalReason' |
  'terminalEvidenceSource' | 'terminalEvidenceKey' |
  'terminalObservedAt' | 'reviewReason' | 'reviewEvidenceKey' |
  'convertedAt'
> {}

interface RedemptionDraft extends Omit<StoredCouponRedemption, '_id'> {}

interface ReservationTransition {
  reservationId: mongoose.Types.ObjectId
  expectedStatus: CouponReservationStatus
  expectedCapacityDisposition: CouponCapacityDisposition
  set: Partial<StoredCouponReservation>
  unset?: Array<
    'reviewReason' | 'reviewEvidenceKey'
  >
}

interface AuthorizationCapacityCommit {
  reservationId: mongoose.Types.ObjectId
  convertedAt: Date
  providerSubscriptionId: string
  authorizationPaymentId: string
  requiresReview: boolean
  reviewEvidenceKey: string
}

export interface CouponReservationTransaction {
  findReservation(input: {
    checkoutIntentId: mongoose.Types.ObjectId
    providerMode?: ProviderMode
  }): Promise<StoredCouponReservation | null>
  claimCapacity(input: {
    providerMode: ProviderMode
    campaignId: mongoose.Types.ObjectId
    userId: mongoose.Types.ObjectId
    maxRedemptions?: number
    maxRedemptionsPerUser: number
  }): Promise<'claimed' | 'global_cap_exhausted' | 'user_cap_exhausted'>
  createReservation(
    draft: ReservationDraft,
  ): Promise<StoredCouponReservation>
  convertHeldCapacity(input: {
    providerMode: ProviderMode
    campaignId: mongoose.Types.ObjectId
    userId: mongoose.Types.ObjectId
  }): Promise<{ drifted: boolean }>
  commitAuthorizationCapacity(
    input: AuthorizationCapacityCommit,
  ): Promise<StoredCouponReservation | null>
  recordLateConvertedCapacity(input: {
    providerMode: ProviderMode
    campaignId: mongoose.Types.ObjectId
    userId: mongoose.Types.ObjectId
  }): Promise<void>
  releaseHeldCapacity(input: {
    providerMode: ProviderMode
    campaignId: mongoose.Types.ObjectId
    userId: mongoose.Types.ObjectId
  }): Promise<{ drifted: boolean }>
  transitionReservation(
    input: ReservationTransition,
  ): Promise<StoredCouponReservation | null>
  findRedemptionByCycle(input: {
    providerMode: ProviderMode
    checkoutIntentId: mongoose.Types.ObjectId
    discountedBillingCycleNumber: number
  }): Promise<StoredCouponRedemption | null>
  findRedemptionByPayment(input: {
    providerMode: ProviderMode
    paymentId: string
  }): Promise<StoredCouponRedemption | null>
  createRedemption(
    draft: RedemptionDraft,
  ): Promise<StoredCouponRedemption>
}

export interface CouponReservationStore {
  runTransaction<T>(
    work: (transaction: CouponReservationTransaction) => Promise<T>,
  ): Promise<T>
  listDueForRecovery(input: {
    providerMode: ProviderMode
    asOf: Date
    afterId?: mongoose.Types.ObjectId
    limit: number
  }): Promise<StoredCouponReservation[]>
}

export class CouponReservationValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CouponReservationValidationError'
  }
}

export class CouponReservationIdempotencyConflictError extends Error {
  constructor(message = 'Checkout intent is bound to different coupon terms') {
    super(message)
    this.name = 'CouponReservationIdempotencyConflictError'
  }
}

export class CouponReservationConcurrencyError extends Error {
  constructor(message = 'Coupon reservation changed concurrently') {
    super(message)
    this.name = 'CouponReservationConcurrencyError'
  }
}

function objectId(value: string, field: string): mongoose.Types.ObjectId {
  if (!mongoose.Types.ObjectId.isValid(value)) {
    throw new CouponReservationValidationError(`${field} is invalid`)
  }
  return new mongoose.Types.ObjectId(value)
}

function nonEmpty(value: string, field: string, max = 255): string {
  const normalized = value.trim()
  if (!normalized || normalized.length > max) {
    throw new CouponReservationValidationError(`${field} is invalid`)
  }
  return normalized
}

function canonicalProviderId(
  value: string,
  field: string,
  pattern: RegExp,
): string {
  const normalized = nonEmpty(value, field)
  if (normalized !== value || !pattern.test(normalized)) {
    throw new CouponReservationValidationError(`${field} is invalid`)
  }
  return normalized
}

function positiveInteger(
  value: number,
  field: string,
  max: number,
): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new CouponReservationValidationError(`${field} is invalid`)
  }
  return value
}

function validDate(value: Date, field: string): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new CouponReservationValidationError(`${field} is invalid`)
  }
  return value
}

function assertProviderMode(value: string): asserts value is ProviderMode {
  if (!PROVIDER_MODES.includes(value as ProviderMode)) {
    throw new CouponReservationValidationError('providerMode is invalid')
  }
}

function assertCampaignMode(
  value: string,
): asserts value is CouponCampaignMode {
  if (!COUPON_CAMPAIGN_MODES.includes(value as CouponCampaignMode)) {
    throw new CouponReservationValidationError(
      'campaignModeSnapshot is invalid',
    )
  }
}

function reservationView(
  row: StoredCouponReservation,
): CouponReservationView {
  return {
    id: row._id.toString(),
    providerMode: row.providerMode,
    campaignId: row.campaignId.toString(),
    campaignRevision: row.campaignRevision,
    userId: row.userId.toString(),
    checkoutIntentId: row.checkoutIntentId.toString(),
    catalogVersion: row.catalogVersion,
    planKey: row.planKey,
    campaignModeSnapshot: row.campaignModeSnapshot,
    codeSnapshot: row.codeSnapshot,
    discountPaise: row.discountPaise,
    discountedBillingCycles: row.discountedBillingCycles,
    maxRedemptions: row.maxRedemptionsSnapshot,
    maxRedemptionsPerUser: row.maxRedemptionsPerUserSnapshot,
    reservationTtlHours: row.reservationTtlHoursSnapshot,
    status: row.status,
    capacityDisposition: row.capacityDisposition,
    reservedAt: row.reservedAt,
    validUntil: row.validUntil,
    convertedAt: row.convertedAt,
    terminalAt: row.terminalAt,
    terminalReason: row.terminalReason,
    reviewReason: row.reviewReason,
  }
}

function redemptionView(
  row: StoredCouponRedemption,
): CouponRedemptionView {
  return {
    id: row._id.toString(),
    providerMode: row.providerMode,
    reservationId: row.reservationId.toString(),
    campaignId: row.campaignId.toString(),
    campaignRevision: row.campaignRevision,
    userId: row.userId.toString(),
    checkoutIntentId: row.checkoutIntentId.toString(),
    subscriptionId: row.subscriptionId,
    orderId: row.orderId,
    paymentId: row.paymentId,
    catalogVersion: row.catalogVersion,
    codeSnapshot: row.codeSnapshot,
    discountPaise: row.discountPaise,
    discountedBillingCycleNumber: row.discountedBillingCycleNumber,
    requiresReview: row.requiresReview,
    createdAt: row.createdAt,
  }
}

function exactReservationBinding(
  existing: StoredCouponReservation,
  draft: ReservationDraft,
): boolean {
  return (
    existing.providerMode === draft.providerMode &&
    existing.campaignId.equals(draft.campaignId) &&
    existing.campaignRevision === draft.campaignRevision &&
    existing.userId.equals(draft.userId) &&
    existing.checkoutIntentId.equals(draft.checkoutIntentId) &&
    existing.catalogVersion === draft.catalogVersion &&
    existing.planKey === draft.planKey &&
    existing.campaignModeSnapshot === draft.campaignModeSnapshot &&
    existing.codeSnapshot === draft.codeSnapshot &&
    existing.discountPaise === draft.discountPaise &&
    existing.discountedBillingCycles === draft.discountedBillingCycles &&
    existing.maxRedemptionsSnapshot === draft.maxRedemptionsSnapshot &&
    existing.maxRedemptionsPerUserSnapshot ===
      draft.maxRedemptionsPerUserSnapshot &&
    existing.reservationTtlHoursSnapshot ===
      draft.reservationTtlHoursSnapshot
  )
}

function validateReserveInput(
  input: ReserveCouponCapacityInput,
): ReservationDraft {
  assertProviderMode(input.providerMode)
  assertCampaignMode(input.campaignModeSnapshot)
  const campaignRevision = positiveInteger(
    input.campaignRevision,
    'campaignRevision',
    Number.MAX_SAFE_INTEGER,
  )
  if (!ALLOWED_DISCOUNTS.has(input.discountPaise)) {
    throw new CouponReservationValidationError('discountPaise is invalid')
  }
  const discountedBillingCycles = positiveInteger(
    input.discountedBillingCycles,
    'discountedBillingCycles',
    12,
  )
  const maxRedemptions = input.maxRedemptions === undefined
    ? undefined
    : positiveInteger(
        input.maxRedemptions,
        'maxRedemptions',
        10_000_000,
      )
  const maxRedemptionsPerUser = positiveInteger(
    input.maxRedemptionsPerUser,
    'maxRedemptionsPerUser',
    100,
  )
  const reservationTtlHours = positiveInteger(
    input.reservationTtlHours,
    'reservationTtlHours',
    168,
  )
  const reservedAt = validDate(input.reservedAt, 'reservedAt')
  const validUntil = new Date(
    reservedAt.getTime() + reservationTtlHours * 60 * 60 * 1_000,
  )
  const codeSnapshot = input.codeSnapshot === undefined
    ? undefined
    : nonEmpty(input.codeSnapshot, 'codeSnapshot', 40).toUpperCase()
  if (
    (input.campaignModeSnapshot === 'code' && !codeSnapshot) ||
    (input.campaignModeSnapshot !== 'code' && codeSnapshot !== undefined) ||
    (codeSnapshot !== undefined &&
      (
        codeSnapshot.length < 3 ||
        !/^[A-Z0-9][A-Z0-9_-]*$/.test(codeSnapshot)
      ))
  ) {
    throw new CouponReservationValidationError(
      'codeSnapshot does not match campaignModeSnapshot',
    )
  }
  return {
    providerMode: input.providerMode,
    campaignId: objectId(input.campaignId, 'campaignId'),
    campaignRevision,
    userId: objectId(input.userId, 'userId'),
    checkoutIntentId: objectId(
      input.checkoutIntentId,
      'checkoutIntentId',
    ),
    catalogVersion: nonEmpty(input.catalogVersion, 'catalogVersion', 100),
    planKey: input.planKey,
    campaignModeSnapshot: input.campaignModeSnapshot,
    codeSnapshot,
    discountPaise: input.discountPaise,
    discountedBillingCycles,
    maxRedemptionsSnapshot: maxRedemptions,
    maxRedemptionsPerUserSnapshot: maxRedemptionsPerUser,
    reservationTtlHoursSnapshot: reservationTtlHours,
    status: 'reserved',
    capacityDisposition: 'held',
    reservedAt,
    validUntil,
  }
}

function assertExpectedReservation(
  reservation: StoredCouponReservation | null,
  input: {
    providerMode: ProviderMode
    campaignId: mongoose.Types.ObjectId
    userId: mongoose.Types.ObjectId
  },
): StoredCouponReservation {
  if (!reservation) {
    throw new CouponReservationValidationError(
      'Coupon reservation was not found',
    )
  }
  if (
    reservation.providerMode !== input.providerMode ||
    !reservation.campaignId.equals(input.campaignId) ||
    !reservation.userId.equals(input.userId)
  ) {
    throw new CouponReservationIdempotencyConflictError(
      'Coupon reservation identity does not match the payment',
    )
  }
  return reservation
}

function terminalEvidenceIsProven(
  evidence: CouponTerminalEvidence,
  target: 'released' | 'expired',
): boolean {
  if (
    !COUPON_TERMINAL_REASONS.includes(evidence.reason) ||
    !COUPON_TERMINAL_EVIDENCE_SOURCES.includes(evidence.source) ||
    !evidence.evidenceKey.trim() ||
    !Number.isFinite(evidence.observedAt.getTime())
  ) {
    return false
  }
  if (target === 'expired') {
    return (
      evidence.reason === 'local_intent_expired_without_remote_object' &&
      (
        evidence.source === 'provider_fetch' ||
        evidence.source === 'reconciliation'
      )
    )
  }
  if (evidence.reason === 'local_intent_expired_without_remote_object') {
    return false
  }
  if (evidence.reason === 'checkout_cancelled_before_remote_creation') {
    return (
      evidence.source === 'provider_fetch' ||
      evidence.source === 'reconciliation'
    )
  }
  if (evidence.reason === 'reconciliation_timeout') {
    return evidence.source === 'reconciliation'
  }
  return evidence.source !== 'local_database'
}

function exactRedemption(
  redemption: StoredCouponRedemption,
  input: ConvertCouponReservationCycleInput,
  reservation: StoredCouponReservation,
): boolean {
  return (
    redemption.providerMode === input.providerMode &&
    redemption.reservationId.equals(reservation._id) &&
    redemption.campaignId.equals(reservation.campaignId) &&
    redemption.campaignRevision === reservation.campaignRevision &&
    redemption.userId.equals(reservation.userId) &&
    redemption.checkoutIntentId.equals(reservation.checkoutIntentId) &&
    redemption.subscriptionId === input.subscriptionId &&
    redemption.orderId === input.orderId &&
    redemption.paymentId === input.paymentId &&
    redemption.discountedBillingCycleNumber ===
      input.discountedBillingCycleNumber
  )
}

async function markReviewInTransaction(
  transaction: CouponReservationTransaction,
  reservation: StoredCouponReservation,
  reason: CouponReservationReviewReason,
  evidenceKey: string,
): Promise<StoredCouponReservation> {
  const updated = await transaction.transitionReservation({
    reservationId: reservation._id,
    expectedStatus: reservation.status,
    expectedCapacityDisposition: reservation.capacityDisposition,
    set: {
      status: 'review',
      reviewReason: reason,
      reviewEvidenceKey: evidenceKey,
    },
  })
  if (!updated) throw new CouponReservationConcurrencyError()
  return updated
}

function futureAuthorizationEvidenceKey(input: {
  providerMode: ProviderMode
  providerSubscriptionId: string
  authorizationPaymentId: string
}): string {
  const digest = createHash('sha256')
    .update([
      input.providerMode,
      input.providerSubscriptionId,
      input.authorizationPaymentId,
    ].join('\0'))
    .digest('hex')
  return `${input.providerMode}:future-authorization:${digest}`
}

function exactFutureAuthorizationEvidence(
  reservation: StoredCouponReservation,
  input: {
    providerSubscriptionId: string
    authorizationPaymentId: string
  },
): boolean {
  return (
    reservation.capacityConversionSource ===
      'future_subscription_authorization' &&
    reservation.conversionProviderSubscriptionId ===
      input.providerSubscriptionId &&
    reservation.conversionProviderPaymentId ===
      input.authorizationPaymentId
  )
}

export async function reserveCouponCapacityInTransaction(
  input: ReserveCouponCapacityInput,
  transaction: CouponReservationTransaction,
): Promise<ReserveCouponCapacityResult> {
  const draft = validateReserveInput(input)
  const existing = await transaction.findReservation({
    checkoutIntentId: draft.checkoutIntentId,
  })
  if (existing) {
    if (!exactReservationBinding(existing, draft)) {
      throw new CouponReservationIdempotencyConflictError()
    }
    return { outcome: 'reused', reservation: reservationView(existing) }
  }
  const capacity = await transaction.claimCapacity({
    providerMode: draft.providerMode,
    campaignId: draft.campaignId,
    userId: draft.userId,
    maxRedemptions: draft.maxRedemptionsSnapshot,
    maxRedemptionsPerUser: draft.maxRedemptionsPerUserSnapshot,
  })
  if (capacity !== 'claimed') return { outcome: capacity }
  const reservation = await transaction.createReservation(draft)
  return { outcome: 'reserved', reservation: reservationView(reservation) }
}

export async function commitCouponReservationAuthorizationInTransaction(
  input: CommitCouponReservationAuthorizationInput,
  transaction: CouponReservationTransaction,
): Promise<CommitCouponReservationAuthorizationResult> {
  assertProviderMode(input.providerMode)
  const campaignId = objectId(input.campaignId, 'campaignId')
  const userId = objectId(input.userId, 'userId')
  const checkoutIntentId = objectId(
    input.checkoutIntentId,
    'checkoutIntentId',
  )
  positiveInteger(
    input.campaignRevision,
    'campaignRevision',
    Number.MAX_SAFE_INTEGER,
  )
  const providerSubscriptionId = canonicalProviderId(
    input.providerSubscriptionId,
    'providerSubscriptionId',
    RAZORPAY_SUBSCRIPTION_ID_PATTERN,
  )
  const authorizationPaymentId = canonicalProviderId(
    input.authorizationPaymentId,
    'authorizationPaymentId',
    RAZORPAY_PAYMENT_ID_PATTERN,
  )
  const authenticatedAt = validDate(
    input.authenticatedAt,
    'authenticatedAt',
  )
  let reservation = assertExpectedReservation(
    await transaction.findReservation({
      providerMode: input.providerMode,
      checkoutIntentId,
    }),
    { providerMode: input.providerMode, campaignId, userId },
  )
  if (reservation.campaignRevision !== input.campaignRevision) {
    throw new CouponReservationIdempotencyConflictError(
      'Coupon revision does not match the authorized checkout',
    )
  }

  const evidence = {
    providerSubscriptionId,
    authorizationPaymentId,
  }
  const evidenceKey = futureAuthorizationEvidenceKey({
    providerMode: input.providerMode,
    ...evidence,
  })
  const evidenceFieldsPresent = Boolean(
    reservation.capacityConversionSource ||
    reservation.conversionProviderSubscriptionId ||
    reservation.conversionProviderPaymentId,
  )
  const exactEvidence = exactFutureAuthorizationEvidence(
    reservation,
    evidence,
  )

  if (reservation.capacityDisposition === 'converted' && exactEvidence) {
    const requiresReview = reservation.status !== 'converted'
    return {
      outcome: requiresReview ? 'review' : 'reused',
      reservation: reservationView(reservation),
      requiresReview,
    }
  }
  if (
    reservation.capacityDisposition === 'converted' ||
    evidenceFieldsPresent
  ) {
    reservation = await markReviewInTransaction(
      transaction,
      reservation,
      'payment_identity_conflict',
      evidenceKey,
    )
    return {
      outcome: 'review',
      reservation: reservationView(reservation),
      requiresReview: true,
    }
  }
  if (
    reservation.status === 'released' ||
    reservation.status === 'expired' ||
    reservation.capacityDisposition === 'released'
  ) {
    reservation = await markReviewInTransaction(
      transaction,
      reservation,
      'ambiguous_remote_state',
      evidenceKey,
    )
    return {
      outcome: 'review',
      reservation: reservationView(reservation),
      requiresReview: true,
    }
  }
  if (
    reservation.status !== 'reserved' ||
    reservation.capacityDisposition !== 'held' ||
    authenticatedAt.getTime() < reservation.reservedAt.getTime() ||
    authenticatedAt.getTime() >= reservation.validUntil.getTime()
  ) {
    if (reservation.status !== 'review') {
      reservation = await markReviewInTransaction(
        transaction,
        reservation,
        'ambiguous_remote_state',
        evidenceKey,
      )
    }
    return {
      outcome: 'review',
      reservation: reservationView(reservation),
      requiresReview: true,
    }
  }

  const capacity = await transaction.convertHeldCapacity({
    providerMode: reservation.providerMode,
    campaignId: reservation.campaignId,
    userId: reservation.userId,
  })
  const updated = await transaction.commitAuthorizationCapacity({
    reservationId: reservation._id,
    convertedAt: authenticatedAt,
    providerSubscriptionId,
    authorizationPaymentId,
    requiresReview: capacity.drifted,
    reviewEvidenceKey: evidenceKey,
  })
  if (!updated) throw new CouponReservationConcurrencyError()
  return {
    outcome: capacity.drifted ? 'review' : 'converted',
    reservation: reservationView(updated),
    requiresReview: capacity.drifted,
  }
}

export async function convertCouponReservationCycleInTransaction(
  input: ConvertCouponReservationCycleInput,
  transaction: CouponReservationTransaction,
): Promise<ConvertCouponReservationCycleResult> {
  assertProviderMode(input.providerMode)
  const campaignId = objectId(input.campaignId, 'campaignId')
  const userId = objectId(input.userId, 'userId')
  const checkoutIntentId = objectId(
    input.checkoutIntentId,
    'checkoutIntentId',
  )
  positiveInteger(
    input.campaignRevision,
    'campaignRevision',
    Number.MAX_SAFE_INTEGER,
  )
  const cycleNumber = positiveInteger(
    input.discountedBillingCycleNumber,
    'discountedBillingCycleNumber',
    12,
  )
  const capturedAt = validDate(input.capturedAt, 'capturedAt')
  const paymentId = nonEmpty(input.paymentId, 'paymentId')
  const hasSubscription = Boolean(input.subscriptionId?.trim())
  const hasOrder = Boolean(input.orderId?.trim())
  if (Number(hasSubscription) + Number(hasOrder) !== 1) {
    throw new CouponReservationValidationError(
      'Exactly one provider purchase target is required',
    )
  }
  const targetInput = {
    ...input,
    paymentId,
    subscriptionId: hasSubscription
      ? nonEmpty(input.subscriptionId!, 'subscriptionId')
      : undefined,
    orderId: hasOrder ? nonEmpty(input.orderId!, 'orderId') : undefined,
    discountedBillingCycleNumber: cycleNumber,
  }
  let reservation = assertExpectedReservation(
    await transaction.findReservation({
      providerMode: input.providerMode,
      checkoutIntentId,
    }),
    { providerMode: input.providerMode, campaignId, userId },
  )
  if (reservation.campaignRevision !== input.campaignRevision) {
    throw new CouponReservationIdempotencyConflictError(
      'Coupon revision does not match the captured checkout',
    )
  }
  const byCycle = await transaction.findRedemptionByCycle({
    providerMode: input.providerMode,
    checkoutIntentId,
    discountedBillingCycleNumber: cycleNumber,
  })
  if (byCycle) {
    if (exactRedemption(byCycle, targetInput, reservation)) {
      return {
        outcome: 'reused',
        reservation: reservationView(reservation),
        redemption: redemptionView(byCycle),
        requiresReview: byCycle.requiresReview,
      }
    }
    reservation = await markReviewInTransaction(
      transaction,
      reservation,
      'redemption_cycle_conflict',
      `${input.providerMode}:cycle:${cycleNumber}:${paymentId}`,
    )
    return {
      outcome: 'review',
      reservation: reservationView(reservation),
      redemption: redemptionView(byCycle),
      requiresReview: true,
    }
  }
  const byPayment = await transaction.findRedemptionByPayment({
    providerMode: input.providerMode,
    paymentId,
  })
  if (byPayment) {
    reservation = await markReviewInTransaction(
      transaction,
      reservation,
      'payment_identity_conflict',
      `${input.providerMode}:payment:${paymentId}`,
    )
    return {
      outcome: 'review',
      reservation: reservationView(reservation),
      redemption: redemptionView(byPayment),
      requiresReview: true,
    }
  }

  let requiresReview =
    reservation.status === 'review' ||
    cycleNumber > reservation.discountedBillingCycles
  let reviewReason: CouponReservationReviewReason | undefined =
    cycleNumber > reservation.discountedBillingCycles
      ? 'redemption_cycle_conflict'
      : undefined
  let outcome: ConvertCouponReservationCycleResult['outcome'] =
    'redemption_recorded'
  if (reservation.capacityDisposition === 'held') {
    const capacity = await transaction.convertHeldCapacity({
      providerMode: reservation.providerMode,
      campaignId: reservation.campaignId,
      userId: reservation.userId,
    })
    if (capacity.drifted) {
      requiresReview = true
      reviewReason = 'capacity_fence_drift'
    }
    const updated = await transaction.transitionReservation({
      reservationId: reservation._id,
      expectedStatus: reservation.status,
      expectedCapacityDisposition: 'held',
      set: {
        status: requiresReview ? 'review' : 'converted',
        capacityDisposition: 'converted',
        convertedAt: capturedAt,
        ...(requiresReview && {
          reviewReason: reviewReason ?? 'ambiguous_remote_state',
          reviewEvidenceKey:
            `${input.providerMode}:capture:${paymentId}`,
        }),
      },
      ...(!requiresReview && {
        unset: ['reviewReason', 'reviewEvidenceKey'],
      }),
    })
    if (!updated) throw new CouponReservationConcurrencyError()
    reservation = updated
    outcome = requiresReview ? 'review' : 'converted'
  } else if (reservation.capacityDisposition === 'released') {
    await transaction.recordLateConvertedCapacity({
      providerMode: reservation.providerMode,
      campaignId: reservation.campaignId,
      userId: reservation.userId,
    })
    const lateReason: CouponReservationReviewReason =
      reservation.status === 'expired' ||
      reservation.terminalReason ===
        'local_intent_expired_without_remote_object'
        ? 'late_capture_after_expiry'
        : 'late_capture_after_release'
    const updated = await transaction.transitionReservation({
      reservationId: reservation._id,
      expectedStatus: reservation.status,
      expectedCapacityDisposition: 'released',
      set: {
        status: 'review',
        capacityDisposition: 'converted',
        convertedAt: capturedAt,
        reviewReason: lateReason,
        reviewEvidenceKey:
          `${input.providerMode}:late-capture:${paymentId}`,
      },
    })
    if (!updated) throw new CouponReservationConcurrencyError()
    reservation = updated
    requiresReview = true
    outcome = 'review'
  } else if (requiresReview && reservation.status !== 'review') {
    reservation = await markReviewInTransaction(
      transaction,
      reservation,
      reviewReason ?? 'ambiguous_remote_state',
      `${input.providerMode}:capture:${paymentId}`,
    )
    outcome = 'review'
  }

  const redemption = await transaction.createRedemption({
    providerMode: reservation.providerMode,
    reservationId: reservation._id,
    campaignId: reservation.campaignId,
    campaignRevision: reservation.campaignRevision,
    userId: reservation.userId,
    checkoutIntentId: reservation.checkoutIntentId,
    subscriptionId: targetInput.subscriptionId,
    orderId: targetInput.orderId,
    paymentId,
    catalogVersion: reservation.catalogVersion,
    codeSnapshot: reservation.codeSnapshot,
    discountPaise: reservation.discountPaise,
    discountedBillingCycleNumber: cycleNumber,
    requiresReview,
    createdAt: capturedAt,
  })
  return {
    outcome,
    reservation: reservationView(reservation),
    redemption: redemptionView(redemption),
    requiresReview,
  }
}

async function terminateCouponReservationInTransaction(
  input: TerminateCouponReservationInput,
  target: 'released' | 'expired',
  transaction: CouponReservationTransaction,
): Promise<TerminateCouponReservationResult> {
  assertProviderMode(input.providerMode)
  const campaignId = objectId(input.campaignId, 'campaignId')
  const userId = objectId(input.userId, 'userId')
  const checkoutIntentId = objectId(
    input.checkoutIntentId,
    'checkoutIntentId',
  )
  const terminalAt = validDate(input.terminalAt, 'terminalAt')
  validDate(input.evidence.observedAt, 'evidence.observedAt')
  if (!terminalEvidenceIsProven(input.evidence, target)) {
    throw new CouponReservationValidationError(
      'A proven terminal reason is required',
    )
  }
  let reservation = assertExpectedReservation(
    await transaction.findReservation({
      providerMode: input.providerMode,
      checkoutIntentId,
    }),
    { providerMode: input.providerMode, campaignId, userId },
  )
  if (
    target === 'expired' &&
    terminalAt.getTime() < reservation.validUntil.getTime()
  ) {
    throw new CouponReservationValidationError(
      'A reservation cannot expire before validUntil',
    )
  }
  if (reservation.capacityDisposition === 'converted') {
    return {
      outcome: 'already_converted',
      reservation: reservationView(reservation),
    }
  }
  if (reservation.capacityDisposition === 'released') {
    return { outcome: 'reused', reservation: reservationView(reservation) }
  }
  const capacity = await transaction.releaseHeldCapacity({
    providerMode: reservation.providerMode,
    campaignId: reservation.campaignId,
    userId: reservation.userId,
  })
  const status: CouponReservationStatus =
    capacity.drifted ? 'review' : target
  const updated = await transaction.transitionReservation({
    reservationId: reservation._id,
    expectedStatus: reservation.status,
    expectedCapacityDisposition: 'held',
    set: {
      status,
      capacityDisposition: 'released',
      terminalAt,
      terminalReason: input.evidence.reason,
      terminalEvidenceSource: input.evidence.source,
      terminalEvidenceKey: nonEmpty(
        input.evidence.evidenceKey,
        'evidence.evidenceKey',
      ),
      terminalObservedAt: input.evidence.observedAt,
      ...(capacity.drifted && {
        reviewReason: 'capacity_fence_drift',
        reviewEvidenceKey:
          `${input.providerMode}:terminal:${input.evidence.evidenceKey}`,
      }),
    },
  })
  if (!updated) throw new CouponReservationConcurrencyError()
  reservation = updated
  return {
    outcome: capacity.drifted ? 'review' : target,
    reservation: reservationView(reservation),
  }
}

export async function releaseCouponReservationInTransaction(
  input: TerminateCouponReservationInput,
  transaction: CouponReservationTransaction,
): Promise<TerminateCouponReservationResult> {
  return terminateCouponReservationInTransaction(
    input,
    'released',
    transaction,
  )
}

export async function expireCouponReservationInTransaction(
  input: TerminateCouponReservationInput,
  transaction: CouponReservationTransaction,
): Promise<TerminateCouponReservationResult> {
  return terminateCouponReservationInTransaction(
    input,
    'expired',
    transaction,
  )
}

export async function markCouponReservationReviewInTransaction(
  input: ReviewCouponReservationInput,
  transaction: CouponReservationTransaction,
): Promise<CouponReservationView> {
  assertProviderMode(input.providerMode)
  if (
    !COUPON_RESERVATION_REVIEW_REASONS.includes(input.reason)
  ) {
    throw new CouponReservationValidationError('review reason is invalid')
  }
  const campaignId = objectId(input.campaignId, 'campaignId')
  const userId = objectId(input.userId, 'userId')
  const checkoutIntentId = objectId(
    input.checkoutIntentId,
    'checkoutIntentId',
  )
  const reservation = assertExpectedReservation(
    await transaction.findReservation({
      providerMode: input.providerMode,
      checkoutIntentId,
    }),
    { providerMode: input.providerMode, campaignId, userId },
  )
  if (
    reservation.status === 'review' &&
    reservation.reviewReason === input.reason &&
    reservation.reviewEvidenceKey === input.evidenceKey
  ) {
    return reservationView(reservation)
  }
  return reservationView(await markReviewInTransaction(
    transaction,
    reservation,
    input.reason,
    nonEmpty(input.evidenceKey, 'evidenceKey'),
  ))
}

type FenceIdentity = {
  providerMode: ProviderMode
  campaignId: mongoose.Types.ObjectId
  scope: CouponUsageFenceScope
  userId?: mongoose.Types.ObjectId
}

function fenceIdentities(input: {
  providerMode: ProviderMode
  campaignId: mongoose.Types.ObjectId
  userId: mongoose.Types.ObjectId
}): [FenceIdentity, FenceIdentity] {
  return [
    {
      providerMode: input.providerMode,
      campaignId: input.campaignId,
      scope: 'campaign',
    },
    {
      providerMode: input.providerMode,
      campaignId: input.campaignId,
      scope: 'user',
      userId: input.userId,
    },
  ]
}

async function ensureFence(
  identity: FenceIdentity,
  session: ClientSession,
): Promise<void> {
  await CouponCampaignUsageFence.updateOne(
    identity,
    {
      $setOnInsert: {
        ...identity,
        reservedCount: 0,
        convertedCount: 0,
      },
    },
    { upsert: true, session },
  )
}

async function claimFence(
  identity: FenceIdentity,
  limit: number | undefined,
  session: ClientSession,
): Promise<boolean> {
  const filter: Record<string, unknown> = { ...identity }
  if (limit !== undefined) {
    filter.$expr = {
      $lt: [
        { $add: ['$reservedCount', '$convertedCount'] },
        limit,
      ],
    }
  }
  const result = await CouponCampaignUsageFence.updateOne(
    filter,
    { $inc: { reservedCount: 1 } },
    { session },
  )
  return result.matchedCount === 1
}

async function reverseFenceClaim(
  identity: FenceIdentity,
  session: ClientSession,
): Promise<void> {
  const result = await CouponCampaignUsageFence.updateOne(
    { ...identity, reservedCount: { $gte: 1 } },
    { $inc: { reservedCount: -1 } },
    { session },
  )
  if (result.matchedCount !== 1) {
    throw new CouponReservationConcurrencyError(
      'Coupon capacity rollback failed',
    )
  }
}

async function changeHeldFence(
  identity: FenceIdentity,
  action: 'convert' | 'release',
  session: ClientSession,
): Promise<boolean> {
  const result = await CouponCampaignUsageFence.updateOne(
    { ...identity, reservedCount: { $gte: 1 } },
    action === 'convert'
      ? { $inc: { reservedCount: -1, convertedCount: 1 } }
      : { $inc: { reservedCount: -1 } },
    { session },
  )
  if (result.matchedCount === 1) return false
  if (action === 'convert') {
    await CouponCampaignUsageFence.updateOne(
      identity,
      { $inc: { convertedCount: 1 } },
      { session },
    )
  }
  return true
}

function mongoCouponReservationTransaction(
  session: ClientSession,
): CouponReservationTransaction {
  return {
    async findReservation(input) {
      return CouponReservation.findOne({
        checkoutIntentId: input.checkoutIntentId,
        ...(input.providerMode && {
          providerMode: input.providerMode,
        }),
      })
        .session(session)
        .lean<StoredCouponReservation>()
    },
    async claimCapacity(input) {
      const [campaignFence, userFence] = fenceIdentities(input)
      await ensureFence(campaignFence, session)
      await ensureFence(userFence, session)
      const campaignClaimed = await claimFence(
        campaignFence,
        input.maxRedemptions,
        session,
      )
      if (!campaignClaimed) return 'global_cap_exhausted'
      const userClaimed = await claimFence(
        userFence,
        input.maxRedemptionsPerUser,
        session,
      )
      if (!userClaimed) {
        await reverseFenceClaim(campaignFence, session)
        return 'user_cap_exhausted'
      }
      return 'claimed'
    },
    async createReservation(draft) {
      const [created] = await CouponReservation.create([draft], { session })
      return created.toObject() as StoredCouponReservation
    },
    async convertHeldCapacity(input) {
      const identities = fenceIdentities(input)
      // The MongoDB driver does not support parallel operations on one
      // transaction session. Keep fence initialization deterministic and
      // sequential inside the caller-owned transaction.
      for (const identity of identities) {
        await ensureFence(identity, session)
      }
      const outcomes = []
      for (const identity of identities) {
        outcomes.push(
          await changeHeldFence(identity, 'convert', session),
        )
      }
      return { drifted: outcomes.some(Boolean) }
    },
    async commitAuthorizationCapacity(input) {
      const updated = await CouponReservation.collection.findOneAndUpdate(
        {
          _id: input.reservationId,
          status: 'reserved',
          capacityDisposition: 'held',
          capacityConversionSource: { $exists: false },
          conversionProviderSubscriptionId: { $exists: false },
          conversionProviderPaymentId: { $exists: false },
        },
        {
          $set: {
            status: input.requiresReview ? 'review' : 'converted',
            capacityDisposition: 'converted',
            convertedAt: input.convertedAt,
            capacityConversionSource:
              'future_subscription_authorization',
            conversionProviderSubscriptionId:
              input.providerSubscriptionId,
            conversionProviderPaymentId:
              input.authorizationPaymentId,
            ...(input.requiresReview && {
              reviewReason: 'capacity_fence_drift',
              reviewEvidenceKey: input.reviewEvidenceKey,
            }),
          },
          ...(!input.requiresReview && {
            $unset: {
              reviewReason: 1,
              reviewEvidenceKey: 1,
            },
          }),
        },
        { returnDocument: 'after', session },
      )
      return updated as StoredCouponReservation | null
    },
    async recordLateConvertedCapacity(input) {
      const identities = fenceIdentities(input)
      for (const identity of identities) {
        await ensureFence(identity, session)
      }
      for (const identity of identities) {
        await CouponCampaignUsageFence.updateOne(
          identity,
          { $inc: { convertedCount: 1 } },
          { session },
        )
      }
    },
    async releaseHeldCapacity(input) {
      const identities = fenceIdentities(input)
      for (const identity of identities) {
        await ensureFence(identity, session)
      }
      const outcomes = []
      for (const identity of identities) {
        outcomes.push(
          await changeHeldFence(identity, 'release', session),
        )
      }
      return { drifted: outcomes.some(Boolean) }
    },
    async transitionReservation(input) {
      const unset = Object.fromEntries(
        (input.unset ?? []).map((field) => [field, 1]),
      )
      return CouponReservation.findOneAndUpdate(
        {
          _id: input.reservationId,
          status: input.expectedStatus,
          capacityDisposition: input.expectedCapacityDisposition,
        },
        {
          $set: input.set,
          ...(Object.keys(unset).length > 0 && { $unset: unset }),
        },
        { new: true, runValidators: true, session },
      ).lean<StoredCouponReservation>()
    },
    async findRedemptionByCycle(input) {
      return CouponRedemption.findOne(input)
        .session(session)
        .lean<StoredCouponRedemption>()
    },
    async findRedemptionByPayment(input) {
      return CouponRedemption.findOne(input)
        .session(session)
        .lean<StoredCouponRedemption>()
    },
    async createRedemption(draft) {
      const [created] = await CouponRedemption.create([draft], { session })
      return created.toObject() as StoredCouponRedemption
    },
  }
}

async function runMongoCouponTransaction<T>(
  work: (transaction: CouponReservationTransaction) => Promise<T>,
): Promise<T> {
  await connectDB()
  const session = await mongoose.startSession()
  let result: T | undefined
  try {
    await session.withTransaction(async () => {
      result = await work(mongoCouponReservationTransaction(session))
    }, TRANSACTION_OPTIONS)
  } finally {
    await session.endSession()
  }
  if (result === undefined) {
    throw new CouponReservationConcurrencyError(
      'Coupon reservation transaction did not commit',
    )
  }
  return result
}

export const mongoCouponReservationStore: CouponReservationStore = {
  runTransaction: runMongoCouponTransaction,
  async listDueForRecovery(input) {
    await connectDB()
    return CouponReservation.find({
      providerMode: input.providerMode,
      status: 'reserved',
      capacityDisposition: 'held',
      validUntil: { $lte: input.asOf },
      ...(input.afterId && { _id: { $gt: input.afterId } }),
    })
      .sort({ _id: 1 })
      .limit(input.limit)
      .lean<StoredCouponReservation[]>()
  },
}

export function couponReservationTransactionForSession(
  session: ClientSession,
): CouponReservationTransaction {
  return mongoCouponReservationTransaction(session)
}

export async function reserveCouponCapacityInSession(
  input: ReserveCouponCapacityInput,
  session: ClientSession,
): Promise<ReserveCouponCapacityResult> {
  return reserveCouponCapacityInTransaction(
    input,
    couponReservationTransactionForSession(session),
  )
}

export async function convertCouponReservationCycleInSession(
  input: ConvertCouponReservationCycleInput,
  session: ClientSession,
): Promise<ConvertCouponReservationCycleResult> {
  return convertCouponReservationCycleInTransaction(
    input,
    couponReservationTransactionForSession(session),
  )
}

export async function commitCouponReservationAuthorizationInSession(
  input: CommitCouponReservationAuthorizationInput,
  session: ClientSession,
): Promise<CommitCouponReservationAuthorizationResult> {
  // The caller must first verify the exact future ₹5 mandate
  // authorization and run this inside its existing Mongo transaction.
  return commitCouponReservationAuthorizationInTransaction(
    input,
    couponReservationTransactionForSession(session),
  )
}

export async function releaseCouponReservationInSession(
  input: TerminateCouponReservationInput,
  session: ClientSession,
): Promise<TerminateCouponReservationResult> {
  return releaseCouponReservationInTransaction(
    input,
    couponReservationTransactionForSession(session),
  )
}

export async function expireCouponReservationInSession(
  input: TerminateCouponReservationInput,
  session: ClientSession,
): Promise<TerminateCouponReservationResult> {
  return expireCouponReservationInTransaction(
    input,
    couponReservationTransactionForSession(session),
  )
}

export async function markCouponReservationReviewInSession(
  input: ReviewCouponReservationInput,
  session: ClientSession,
): Promise<CouponReservationView> {
  return markCouponReservationReviewInTransaction(
    input,
    couponReservationTransactionForSession(session),
  )
}

export async function reserveCouponCapacity(
  input: ReserveCouponCapacityInput,
  store: CouponReservationStore = mongoCouponReservationStore,
): Promise<ReserveCouponCapacityResult> {
  return store.runTransaction((transaction) =>
    reserveCouponCapacityInTransaction(input, transaction))
}

export async function convertCouponReservationCycle(
  input: ConvertCouponReservationCycleInput,
  store: CouponReservationStore = mongoCouponReservationStore,
): Promise<ConvertCouponReservationCycleResult> {
  return store.runTransaction((transaction) =>
    convertCouponReservationCycleInTransaction(input, transaction))
}

export async function commitCouponReservationAuthorization(
  input: CommitCouponReservationAuthorizationInput,
  store: CouponReservationStore = mongoCouponReservationStore,
): Promise<CommitCouponReservationAuthorizationResult> {
  return store.runTransaction((transaction) =>
    commitCouponReservationAuthorizationInTransaction(input, transaction))
}

export async function releaseCouponReservation(
  input: TerminateCouponReservationInput,
  store: CouponReservationStore = mongoCouponReservationStore,
): Promise<TerminateCouponReservationResult> {
  return store.runTransaction((transaction) =>
    releaseCouponReservationInTransaction(input, transaction))
}

export async function expireCouponReservation(
  input: TerminateCouponReservationInput,
  store: CouponReservationStore = mongoCouponReservationStore,
): Promise<TerminateCouponReservationResult> {
  return store.runTransaction((transaction) =>
    expireCouponReservationInTransaction(input, transaction))
}

export async function markCouponReservationReview(
  input: ReviewCouponReservationInput,
  store: CouponReservationStore = mongoCouponReservationStore,
): Promise<CouponReservationView> {
  return store.runTransaction((transaction) =>
    markCouponReservationReviewInTransaction(input, transaction))
}

export async function listCouponReservationsDueForRecovery(
  input: {
    providerMode: ProviderMode
    asOf: Date
    afterId?: string
    limit?: number
  },
  store: CouponReservationStore = mongoCouponReservationStore,
): Promise<CouponReservationRecoveryRow[]> {
  assertProviderMode(input.providerMode)
  const asOf = validDate(input.asOf, 'asOf')
  const limit = positiveInteger(input.limit ?? 100, 'limit', 500)
  const rows = await store.listDueForRecovery({
    providerMode: input.providerMode,
    asOf,
    afterId: input.afterId
      ? objectId(input.afterId, 'afterId')
      : undefined,
    limit,
  })
  return rows.map((row) => ({
    id: row._id.toString(),
    providerMode: row.providerMode,
    campaignId: row.campaignId.toString(),
    userId: row.userId.toString(),
    checkoutIntentId: row.checkoutIntentId.toString(),
    validUntil: row.validUntil,
  }))
}
