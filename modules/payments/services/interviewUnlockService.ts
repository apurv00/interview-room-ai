import mongoose, { type ClientSession } from 'mongoose'
import { connectDB } from '@shared/db/connection'
import { withPersonalDataWriteTransaction } from '@shared/services/accountDeletion'
import {
  InterviewUsage,
  NORMALIZED_INTERVIEW_DURATIONS_MINUTES,
  type NormalizedInterviewDurationMinutes,
} from '../models/InterviewUsage'
import {
  PaidInterviewUnlock,
  PAID_INTERVIEW_MAX_DURATION_MINUTES,
  type PaidInterviewUnlockStatus,
} from '../models/PaidInterviewUnlock'
import {
  PROVIDER_MODES,
  type ProviderMode,
} from '../types/catalog'

const OBJECT_ID_PATTERN = /^[a-fA-F0-9]{24}$/
const ELIGIBLE_UNLOCK_STATUSES = ['available', 'restored'] as const
export const MAX_LAZY_INTERVIEW_UNLOCK_EXPIRY_BATCH = 25 as const
export const PR7_INTERVIEW_UNLOCK_STATE_READY = false as const
export const PR7_INTERVIEW_UNLOCK_PREVIEW_READY = false as const

export const RESTORABLE_INTERVIEW_PLATFORM_FAILURE_REASONS = [
  'platform_session_initialization_failed',
  'platform_realtime_connection_failed',
  'platform_first_turn_generation_failed',
] as const
export type RestorableInterviewPlatformFailureReason =
  (typeof RESTORABLE_INTERVIEW_PLATFORM_FAILURE_REASONS)[number]

export const INTERVIEW_UNLOCK_ERROR_CODES = [
  'not_ready',
  'invalid_request',
  'unavailable',
  'usage_conflict',
  'state_conflict',
  'evidence_required',
  'evidence_denied',
  'persistence_conflict',
] as const
export type InterviewUnlockErrorCode =
  (typeof INTERVIEW_UNLOCK_ERROR_CODES)[number]

export class InterviewUnlockError extends Error {
  constructor(
    readonly code: InterviewUnlockErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'InterviewUnlockError'
  }
}

export interface InterviewUnlockPreviewInput {
  userId: string
  providerMode: ProviderMode
}

export interface InterviewUnlockPreviewResult {
  availableCount: number
  earliestValidUntil: Date | null
  maxDurationMinutes: typeof PAID_INTERVIEW_MAX_DURATION_MINUTES
}

export interface ReservePaidInterviewUnlockInput
  extends InterviewUnlockPreviewInput {
  sessionId: string
  normalizedDurationMinutes: NormalizedInterviewDurationMinutes
}

export interface PaidInterviewUnlockReservationResult {
  unlockId: string
  usageId: string
  sessionId: string
  state: 'reserved' | 'consumed' | 'restored'
  normalizedDurationMinutes: NormalizedInterviewDurationMinutes
  validUntil: Date
  reused: boolean
}

export interface ConsumePaidInterviewUnlockInput
  extends ReservePaidInterviewUnlockInput {}

export interface PaidInterviewUnlockConsumptionResult {
  unlockId: string
  usageId: string
  sessionId: string
  state: 'consumed'
  consumedAt: Date
  reused: boolean
}

export interface SingleInterviewConsumedAnalyticsEvidence {
  readonly sourceEvidenceId: string
  readonly correlationId: string
  readonly subjectId: string
  readonly providerMode: ProviderMode
  readonly occurredAt: Date
  readonly normalizedDurationMinutes: NormalizedInterviewDurationMinutes
  readonly maxDurationMinutes: typeof PAID_INTERVIEW_MAX_DURATION_MINUTES
  readonly validUntil: Date
}

export interface SingleInterviewConsumedAnalyticsProducer {
  appendSingleInterviewConsumedInSession(
    evidence: () => SingleInterviewConsumedAnalyticsEvidence,
    session: ClientSession,
  ): Promise<void>
}

export interface RestorePaidInterviewUnlockInput
  extends InterviewUnlockPreviewInput {
  sessionId: string
  restorationId: string
}

export interface AuthoritativeInterviewRestorationEvidence {
  restorationId: string
  usageId: string
  userId: string
  sessionId: string
  source: 'paid_interview'
  sourceId: string
  providerMode: ProviderMode
  verified: true
  verifiedAt: Date
  firstTurnRecordedAt: Date | null
  reason: RestorableInterviewPlatformFailureReason
}

export interface InterviewRestorationEvidenceProvider {
  load(
    input: {
      restorationId: mongoose.Types.ObjectId
      userId: mongoose.Types.ObjectId
      sessionId: mongoose.Types.ObjectId
      providerMode: ProviderMode
    },
    session: ClientSession,
  ): Promise<AuthoritativeInterviewRestorationEvidence | null>
}

export interface PaidInterviewUnlockRestorationResult {
  unlockId: string
  usageId: string
  sessionId: string
  disposition: 'available' | 'expired' | 'already_restored'
  restorationId: string
  reused: boolean
}

export interface ExpirePaidInterviewUnlocksInput
  extends InterviewUnlockPreviewInput {}

export interface ExpirePaidInterviewUnlocksResult {
  expiredCount: number
  batchLimit: typeof MAX_LAZY_INTERVIEW_UNLOCK_EXPIRY_BATCH
  mayHaveMore: boolean
}

export interface StoredPaidInterviewUnlock {
  id: mongoose.Types.ObjectId
  userId: mongoose.Types.ObjectId
  providerMode: ProviderMode
  checkoutIntentId: mongoose.Types.ObjectId
  status: PaidInterviewUnlockStatus
  maxDurationMinutes: number
  validUntil: Date
  createdAt: Date
  reservedSessionId?: mongoose.Types.ObjectId
  consumedSessionId?: mongoose.Types.ObjectId
  reservedAt?: Date
  consumedAt?: Date
  restoredAt?: Date
  restoreReason?: string
}

export interface StoredPaidInterviewUsage {
  id: mongoose.Types.ObjectId
  sessionId: mongoose.Types.ObjectId
  userId: mongoose.Types.ObjectId
  source: string
  sourceId: mongoose.Types.ObjectId
  reservedAt: Date
  consumedAt?: Date
  restorationId?: mongoose.Types.ObjectId
  normalizedDurationMinutes: number
  entitlementSnapshot: unknown
}

export interface InterviewUnlockPersistence {
  previewAvailable(input: {
    userId: mongoose.Types.ObjectId
    providerMode: ProviderMode
    now: Date
  }): Promise<{
    availableCount: number
    earliestValidUntil: Date | null
  }>
  expireEligible(
    input: {
      userId: mongoose.Types.ObjectId
      providerMode: ProviderMode
      now: Date
      limit: typeof MAX_LAZY_INTERVIEW_UNLOCK_EXPIRY_BATCH
    },
    session: ClientSession,
  ): Promise<number>
  findUsageBySession(
    sessionId: mongoose.Types.ObjectId,
    session: ClientSession,
  ): Promise<StoredPaidInterviewUsage | null>
  findUnlockById(
    unlockId: mongoose.Types.ObjectId,
    session: ClientSession,
  ): Promise<StoredPaidInterviewUnlock | null>
  reserveEarliest(
    input: {
      userId: mongoose.Types.ObjectId
      providerMode: ProviderMode
      sessionId: mongoose.Types.ObjectId
      reservedAt: Date
    },
    session: ClientSession,
  ): Promise<StoredPaidInterviewUnlock | null>
  createUsage(
    input: {
      sessionId: mongoose.Types.ObjectId
      userId: mongoose.Types.ObjectId
      unlock: StoredPaidInterviewUnlock
      reservedAt: Date
      normalizedDurationMinutes: NormalizedInterviewDurationMinutes
    },
    session: ClientSession,
  ): Promise<StoredPaidInterviewUsage>
  markUsageConsumed(
    input: {
      usageId: mongoose.Types.ObjectId
      sessionId: mongoose.Types.ObjectId
      userId: mongoose.Types.ObjectId
      unlockId: mongoose.Types.ObjectId
      consumedAt: Date
    },
    session: ClientSession,
  ): Promise<StoredPaidInterviewUsage | null>
  markUnlockConsumed(
    input: {
      unlockId: mongoose.Types.ObjectId
      sessionId: mongoose.Types.ObjectId
      userId: mongoose.Types.ObjectId
      providerMode: ProviderMode
      consumedAt: Date
    },
    session: ClientSession,
  ): Promise<StoredPaidInterviewUnlock | null>
  markUsageRestored(
    input: {
      usageId: mongoose.Types.ObjectId
      sessionId: mongoose.Types.ObjectId
      userId: mongoose.Types.ObjectId
      unlockId: mongoose.Types.ObjectId
      restorationId: mongoose.Types.ObjectId
    },
    session: ClientSession,
  ): Promise<StoredPaidInterviewUsage | null>
  releaseRestoredUnlock(
    input: {
      unlockId: mongoose.Types.ObjectId
      sessionId: mongoose.Types.ObjectId
      userId: mongoose.Types.ObjectId
      providerMode: ProviderMode
      restoredAt: Date
      reason: RestorableInterviewPlatformFailureReason
      finalStatus: 'available' | 'expired'
    },
    session: ClientSession,
  ): Promise<StoredPaidInterviewUnlock | null>
}

export interface InterviewUnlockTransactionRunner {
  run<T>(
    userId: string,
    work: (
      session: ClientSession,
      userObjectId: mongoose.Types.ObjectId,
    ) => Promise<T>,
  ): Promise<T>
}

export interface InterviewUnlockDependencies {
  stateReady?: boolean
  now?: () => Date
  persistence?: InterviewUnlockPersistence
  transactionRunner?: InterviewUnlockTransactionRunner
  evidenceProvider?: InterviewRestorationEvidenceProvider
  commercialAnalyticsProducer?: SingleInterviewConsumedAnalyticsProducer
}

export interface InterviewUnlockPreviewDependencies
  extends Pick<
    InterviewUnlockDependencies,
    'now' | 'persistence'
  > {
  previewReady?: boolean
}

interface NormalizedPreviewInput {
  userId: mongoose.Types.ObjectId
  providerMode: ProviderMode
}

interface NormalizedReservationInput extends NormalizedPreviewInput {
  sessionId: mongoose.Types.ObjectId
  normalizedDurationMinutes: NormalizedInterviewDurationMinutes
}

interface NormalizedRestorationInput extends NormalizedPreviewInput {
  sessionId: mongoose.Types.ObjectId
  restorationId: mongoose.Types.ObjectId
}

interface MongoUnlockRow {
  _id: mongoose.Types.ObjectId
  userId: mongoose.Types.ObjectId
  providerMode: ProviderMode
  checkoutIntentId: mongoose.Types.ObjectId
  status: PaidInterviewUnlockStatus
  maxDurationMinutes: number
  validUntil: Date
  createdAt: Date
  reservedSessionId?: mongoose.Types.ObjectId
  consumedSessionId?: mongoose.Types.ObjectId
  reservedAt?: Date
  consumedAt?: Date
  restoredAt?: Date
  restoreReason?: string
}

interface MongoUsageRow {
  _id: mongoose.Types.ObjectId
  sessionId: mongoose.Types.ObjectId
  userId: mongoose.Types.ObjectId
  source: string
  sourceId: mongoose.Types.ObjectId
  reservedAt: Date
  consumedAt?: Date
  restorationId?: mongoose.Types.ObjectId
  normalizedDurationMinutes: number
  entitlementSnapshot: unknown
}

function failure(
  code: InterviewUnlockErrorCode,
  message: string,
  cause?: unknown,
): InterviewUnlockError {
  return new InterviewUnlockError(
    code,
    message,
    cause === undefined ? undefined : { cause },
  )
}

function exactObjectId(value: unknown, label: string): mongoose.Types.ObjectId {
  if (
    typeof value !== 'string' ||
    !OBJECT_ID_PATTERN.test(value)
  ) {
    throw failure('invalid_request', `${label} must be an exact ObjectId`)
  }
  return new mongoose.Types.ObjectId(value)
}

function exactProviderMode(value: unknown): ProviderMode {
  if (
    typeof value !== 'string' ||
    !PROVIDER_MODES.includes(value as ProviderMode)
  ) {
    throw failure(
      'invalid_request',
      'providerMode must be exactly test or live',
    )
  }
  return value as ProviderMode
}

function exactDuration(
  value: unknown,
): NormalizedInterviewDurationMinutes {
  if (
    typeof value !== 'number' ||
    !NORMALIZED_INTERVIEW_DURATIONS_MINUTES.includes(
      value as NormalizedInterviewDurationMinutes,
    )
  ) {
    throw failure(
      'invalid_request',
      'normalizedDurationMinutes must be exactly 10, 20, or 30',
    )
  }
  return value as NormalizedInterviewDurationMinutes
}

function exactDate(value: unknown, label: string): Date {
  if (
    !(value instanceof Date) ||
    !Number.isFinite(value.getTime())
  ) {
    throw failure('persistence_conflict', `${label} is invalid`)
  }
  return value
}

function observedNow(provider: (() => Date) | undefined): Date {
  const value = (provider ?? (() => new Date()))()
  if (
    !(value instanceof Date) ||
    !Number.isFinite(value.getTime())
  ) {
    throw failure('invalid_request', 'Current time is invalid')
  }
  return new Date(value)
}

function normalizePreviewInput(
  input: InterviewUnlockPreviewInput,
): NormalizedPreviewInput {
  return {
    userId: exactObjectId(input.userId, 'userId'),
    providerMode: exactProviderMode(input.providerMode),
  }
}

function normalizeReservationInput(
  input: ReservePaidInterviewUnlockInput,
): NormalizedReservationInput {
  return {
    ...normalizePreviewInput(input),
    sessionId: exactObjectId(input.sessionId, 'sessionId'),
    normalizedDurationMinutes: exactDuration(
      input.normalizedDurationMinutes,
    ),
  }
}

function normalizeRestorationInput(
  input: RestorePaidInterviewUnlockInput,
): NormalizedRestorationInput {
  return {
    ...normalizePreviewInput(input),
    sessionId: exactObjectId(input.sessionId, 'sessionId'),
    restorationId: exactObjectId(
      input.restorationId,
      'restorationId',
    ),
  }
}

function exactClaimedUser(
  expected: mongoose.Types.ObjectId,
  claimed: mongoose.Types.ObjectId,
): void {
  if (!claimed.equals(expected)) {
    throw failure(
      'usage_conflict',
      'Transaction user does not match the unlock request',
    )
  }
}

function storedUnlock(row: MongoUnlockRow): StoredPaidInterviewUnlock {
  return {
    id: row._id,
    userId: row.userId,
    providerMode: row.providerMode,
    checkoutIntentId: row.checkoutIntentId,
    status: row.status,
    maxDurationMinutes: row.maxDurationMinutes,
    validUntil: row.validUntil,
    createdAt: row.createdAt,
    reservedSessionId: row.reservedSessionId,
    consumedSessionId: row.consumedSessionId,
    reservedAt: row.reservedAt,
    consumedAt: row.consumedAt,
    restoredAt: row.restoredAt,
    restoreReason: row.restoreReason,
  }
}

function storedUsage(row: MongoUsageRow): StoredPaidInterviewUsage {
  return {
    id: row._id,
    sessionId: row.sessionId,
    userId: row.userId,
    source: row.source,
    sourceId: row.sourceId,
    reservedAt: row.reservedAt,
    consumedAt: row.consumedAt,
    restorationId: row.restorationId,
    normalizedDurationMinutes: row.normalizedDurationMinutes,
    entitlementSnapshot: row.entitlementSnapshot,
  }
}

function exactUnlock(
  unlock: StoredPaidInterviewUnlock,
  input: NormalizedPreviewInput,
): void {
  if (
    !unlock.userId.equals(input.userId) ||
    unlock.providerMode !== input.providerMode ||
    unlock.maxDurationMinutes !== PAID_INTERVIEW_MAX_DURATION_MINUTES
  ) {
    throw failure(
      'state_conflict',
      'Paid interview unlock ownership or terms conflict',
    )
  }
  exactDate(unlock.validUntil, 'unlock.validUntil')
  exactDate(unlock.createdAt, 'unlock.createdAt')
}

function exactUsage(
  usage: StoredPaidInterviewUsage,
  input: NormalizedReservationInput,
): void {
  if (
    !usage.sessionId.equals(input.sessionId) ||
    !usage.userId.equals(input.userId) ||
    usage.source !== 'paid_interview' ||
    usage.normalizedDurationMinutes !==
      input.normalizedDurationMinutes
  ) {
    throw failure(
      'usage_conflict',
      'Interview session is linked to a different usage',
    )
  }
  exactDate(usage.reservedAt, 'usage.reservedAt')
  if (usage.consumedAt) {
    exactDate(usage.consumedAt, 'usage.consumedAt')
    if (usage.consumedAt < usage.reservedAt) {
      throw failure(
        'state_conflict',
        'Interview usage consumption precedes reservation',
      )
    }
  }
}

function exactRestorationUsage(
  usage: StoredPaidInterviewUsage,
  input: NormalizedRestorationInput,
): void {
  if (
    !usage.sessionId.equals(input.sessionId) ||
    !usage.userId.equals(input.userId) ||
    usage.source !== 'paid_interview' ||
    !NORMALIZED_INTERVIEW_DURATIONS_MINUTES.includes(
      usage.normalizedDurationMinutes as
        NormalizedInterviewDurationMinutes,
    )
  ) {
    throw failure(
      'usage_conflict',
      'Interview session is linked to a different usage',
    )
  }
  exactDate(usage.reservedAt, 'usage.reservedAt')
  if (!usage.consumedAt) {
    throw failure(
      'state_conflict',
      'Only a consumed paid interview can be restored',
    )
  }
  exactDate(usage.consumedAt, 'usage.consumedAt')
  if (usage.consumedAt < usage.reservedAt) {
    throw failure(
      'state_conflict',
      'Interview usage consumption precedes reservation',
    )
  }
}

function reservationResult(
  usage: StoredPaidInterviewUsage,
  unlock: StoredPaidInterviewUnlock,
  state: PaidInterviewUnlockReservationResult['state'],
  reused: boolean,
): PaidInterviewUnlockReservationResult {
  return {
    unlockId: unlock.id.toHexString(),
    usageId: usage.id.toHexString(),
    sessionId: usage.sessionId.toHexString(),
    state,
    normalizedDurationMinutes:
      usage.normalizedDurationMinutes as
        NormalizedInterviewDurationMinutes,
    validUntil: new Date(unlock.validUntil),
    reused,
  }
}

function isDuplicateKeyError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 11000
  )
}

export const mongoInterviewUnlockPersistence:
InterviewUnlockPersistence = {
  async previewAvailable(input) {
    await connectDB()
    const rows = await PaidInterviewUnlock.aggregate<{
      availableCount: number
      earliestValidUntil: Date
    }>([
      {
        $match: {
          userId: input.userId,
          providerMode: input.providerMode,
          status: { $in: [...ELIGIBLE_UNLOCK_STATUSES] },
          maxDurationMinutes: PAID_INTERVIEW_MAX_DURATION_MINUTES,
          validUntil: { $gt: input.now },
        },
      },
      { $sort: { validUntil: 1, createdAt: 1, _id: 1 } },
      {
        $group: {
          _id: null,
          availableCount: { $sum: 1 },
          earliestValidUntil: { $first: '$validUntil' },
        },
      },
    ])
    return rows[0] ?? {
      availableCount: 0,
      earliestValidUntil: null,
    }
  },

  async expireEligible(input, session) {
    const candidates = await PaidInterviewUnlock.find({
      userId: input.userId,
      providerMode: input.providerMode,
      status: { $in: [...ELIGIBLE_UNLOCK_STATUSES] },
      maxDurationMinutes: PAID_INTERVIEW_MAX_DURATION_MINUTES,
      validUntil: { $lte: input.now },
    })
      .select('_id')
      .sort({ validUntil: 1, createdAt: 1, _id: 1 })
      .limit(input.limit)
      .session(session)
      .lean<Array<{ _id: mongoose.Types.ObjectId }>>()
    if (candidates.length === 0) return 0
    const result = await PaidInterviewUnlock.updateMany(
      {
        _id: { $in: candidates.map((candidate) => candidate._id) },
        userId: input.userId,
        providerMode: input.providerMode,
        status: { $in: [...ELIGIBLE_UNLOCK_STATUSES] },
        maxDurationMinutes: PAID_INTERVIEW_MAX_DURATION_MINUTES,
        validUntil: { $lte: input.now },
      },
      {
        $set: { status: 'expired' },
        $unset: {
          reservedSessionId: 1,
          consumedSessionId: 1,
          reservedAt: 1,
          consumedAt: 1,
        },
      },
      { runValidators: true, session },
    )
    return result.modifiedCount
  },

  async findUsageBySession(sessionId, session) {
    const row = await InterviewUsage.findOne({ sessionId })
      .session(session)
      .lean<MongoUsageRow>()
    return row ? storedUsage(row) : null
  },

  async findUnlockById(unlockId, session) {
    const row = await PaidInterviewUnlock.findById(unlockId)
      .session(session)
      .lean<MongoUnlockRow>()
    return row ? storedUnlock(row) : null
  },

  async reserveEarliest(input, session) {
    const row = await PaidInterviewUnlock.findOneAndUpdate(
      {
        userId: input.userId,
        providerMode: input.providerMode,
        status: { $in: [...ELIGIBLE_UNLOCK_STATUSES] },
        maxDurationMinutes: PAID_INTERVIEW_MAX_DURATION_MINUTES,
        validUntil: { $gt: input.reservedAt },
      },
      {
        $set: {
          status: 'reserved',
          reservedSessionId: input.sessionId,
          reservedAt: input.reservedAt,
        },
        $unset: {
          consumedSessionId: 1,
          consumedAt: 1,
        },
      },
      {
        sort: { validUntil: 1, createdAt: 1, _id: 1 },
        new: true,
        runValidators: true,
        session,
      },
    ).lean<MongoUnlockRow>()
    return row ? storedUnlock(row) : null
  },

  async createUsage(input, session) {
    const created = await InterviewUsage.create([{
      sessionId: input.sessionId,
      userId: input.userId,
      source: 'paid_interview',
      sourceId: input.unlock.id,
      reservedAt: input.reservedAt,
      normalizedDurationMinutes: input.normalizedDurationMinutes,
      entitlementSnapshot: {
        kind: 'paid_interview',
        providerMode: input.unlock.providerMode,
        unlockId: input.unlock.id.toHexString(),
        maxDurationMinutes:
          PAID_INTERVIEW_MAX_DURATION_MINUTES,
        normalizedDurationMinutes:
          input.normalizedDurationMinutes,
        validUntil: input.unlock.validUntil.toISOString(),
      },
    }], { session })
    const row = created[0].toObject() as unknown as MongoUsageRow
    return storedUsage(row)
  },

  async markUsageConsumed(input, session) {
    const row = await InterviewUsage.findOneAndUpdate(
      {
        _id: input.usageId,
        sessionId: input.sessionId,
        userId: input.userId,
        source: 'paid_interview',
        sourceId: input.unlockId,
        consumedAt: { $exists: false },
        restorationId: { $exists: false },
      },
      { $set: { consumedAt: input.consumedAt } },
      { new: true, runValidators: true, session },
    ).lean<MongoUsageRow>()
    return row ? storedUsage(row) : null
  },

  async markUnlockConsumed(input, session) {
    const row = await PaidInterviewUnlock.findOneAndUpdate(
      {
        _id: input.unlockId,
        userId: input.userId,
        providerMode: input.providerMode,
        status: 'reserved',
        reservedSessionId: input.sessionId,
        consumedSessionId: { $exists: false },
      },
      {
        $set: {
          status: 'consumed',
          consumedSessionId: input.sessionId,
          consumedAt: input.consumedAt,
        },
      },
      { new: true, runValidators: true, session },
    ).lean<MongoUnlockRow>()
    return row ? storedUnlock(row) : null
  },

  async markUsageRestored(input, session) {
    const row = await InterviewUsage.findOneAndUpdate(
      {
        _id: input.usageId,
        sessionId: input.sessionId,
        userId: input.userId,
        source: 'paid_interview',
        sourceId: input.unlockId,
        consumedAt: { $exists: true },
        restorationId: { $exists: false },
      },
      { $set: { restorationId: input.restorationId } },
      { new: true, runValidators: true, session },
    ).lean<MongoUsageRow>()
    return row ? storedUsage(row) : null
  },

  async releaseRestoredUnlock(input, session) {
    const row = await PaidInterviewUnlock.findOneAndUpdate(
      {
        _id: input.unlockId,
        userId: input.userId,
        providerMode: input.providerMode,
        status: 'consumed',
        reservedSessionId: input.sessionId,
        consumedSessionId: input.sessionId,
      },
      {
        $set: {
          status: input.finalStatus,
          restoredAt: input.restoredAt,
          restoreReason: input.reason,
        },
        $unset: {
          reservedSessionId: 1,
          consumedSessionId: 1,
          reservedAt: 1,
          consumedAt: 1,
        },
      },
      { new: true, runValidators: true, session },
    ).lean<MongoUnlockRow>()
    return row ? storedUnlock(row) : null
  },
}

const defaultTransactionRunner: InterviewUnlockTransactionRunner = {
  run(userId, work) {
    return withPersonalDataWriteTransaction(userId, work)
  },
}

async function replayReservation(
  input: NormalizedReservationInput,
  usage: StoredPaidInterviewUsage,
  persistence: InterviewUnlockPersistence,
  session: ClientSession,
): Promise<PaidInterviewUnlockReservationResult> {
  exactUsage(usage, input)
  const unlock = await persistence.findUnlockById(
    usage.sourceId,
    session,
  )
  if (!unlock) {
    throw failure(
      'state_conflict',
      'Interview usage references a missing unlock',
    )
  }
  exactUnlock(unlock, input)
  if (usage.restorationId) {
    if (!usage.consumedAt) {
      throw failure(
        'state_conflict',
        'Restored usage has no consumption evidence',
      )
    }
    return reservationResult(usage, unlock, 'restored', true)
  }
  if (usage.consumedAt) {
    if (
      unlock.status !== 'consumed' ||
      !unlock.consumedSessionId?.equals(input.sessionId)
    ) {
      throw failure(
        'state_conflict',
        'Consumed usage and unlock state disagree',
      )
    }
    return reservationResult(usage, unlock, 'consumed', true)
  }
  if (
    unlock.status !== 'reserved' ||
    !unlock.reservedSessionId?.equals(input.sessionId)
  ) {
    throw failure(
      'state_conflict',
      'Reserved usage and unlock state disagree',
    )
  }
  return reservationResult(usage, unlock, 'reserved', true)
}

async function reserveNormalizedInSession(
  input: NormalizedReservationInput,
  now: Date,
  session: ClientSession,
  persistence: InterviewUnlockPersistence,
): Promise<PaidInterviewUnlockReservationResult> {
  const existing = await persistence.findUsageBySession(
    input.sessionId,
    session,
  )
  if (existing) {
    return replayReservation(input, existing, persistence, session)
  }
  await persistence.expireEligible({
    userId: input.userId,
    providerMode: input.providerMode,
    now,
    limit: MAX_LAZY_INTERVIEW_UNLOCK_EXPIRY_BATCH,
  }, session)
  const unlock = await persistence.reserveEarliest({
    userId: input.userId,
    providerMode: input.providerMode,
    sessionId: input.sessionId,
    reservedAt: now,
  }, session)
  if (!unlock) {
    throw failure(
      'unavailable',
      'No unexpired paid interview unlock is available',
    )
  }
  exactUnlock(unlock, input)
  if (
    unlock.status !== 'reserved' ||
    !unlock.reservedSessionId?.equals(input.sessionId) ||
    !unlock.reservedAt ||
    unlock.reservedAt.getTime() !== now.getTime() ||
    unlock.validUntil <= now
  ) {
    throw failure(
      'persistence_conflict',
      'Unlock reservation did not return the exact reserved state',
    )
  }
  const usage = await persistence.createUsage({
    sessionId: input.sessionId,
    userId: input.userId,
    unlock,
    reservedAt: now,
    normalizedDurationMinutes: input.normalizedDurationMinutes,
  }, session)
  exactUsage(usage, input)
  if (
    !usage.sourceId.equals(unlock.id) ||
    usage.reservedAt.getTime() !== now.getTime()
  ) {
    throw failure(
      'persistence_conflict',
      'Created usage references a different unlock',
    )
  }
  return reservationResult(usage, unlock, 'reserved', false)
}

export async function reservePaidInterviewUnlockInSession(
  input: ReservePaidInterviewUnlockInput,
  session: ClientSession,
  claimedUserId: mongoose.Types.ObjectId,
  dependencies: Pick<
    InterviewUnlockDependencies,
    'now' | 'persistence'
  > = {},
): Promise<PaidInterviewUnlockReservationResult> {
  const normalized = normalizeReservationInput(input)
  exactClaimedUser(normalized.userId, claimedUserId)
  return reserveNormalizedInSession(
    normalized,
    observedNow(dependencies.now),
    session,
    dependencies.persistence ?? mongoInterviewUnlockPersistence,
  )
}

export async function reservePaidInterviewUnlock(
  input: ReservePaidInterviewUnlockInput,
  dependencies: InterviewUnlockDependencies = {},
): Promise<PaidInterviewUnlockReservationResult> {
  const normalized = normalizeReservationInput(input)
  if (
    (dependencies.stateReady ??
      PR7_INTERVIEW_UNLOCK_STATE_READY) !== true
  ) {
    throw failure(
      'not_ready',
      'Paid interview unlock mutation is not ready',
    )
  }
  const now = observedNow(dependencies.now)
  const persistence =
    dependencies.persistence ?? mongoInterviewUnlockPersistence
  const runner =
    dependencies.transactionRunner ?? defaultTransactionRunner
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await runner.run(
        normalized.userId.toHexString(),
        async (session, claimedUserId) => {
          exactClaimedUser(normalized.userId, claimedUserId)
          return reserveNormalizedInSession(
            normalized,
            now,
            session,
            persistence,
          )
        },
      )
    } catch (error) {
      if (attempt === 0 && isDuplicateKeyError(error)) continue
      if (isDuplicateKeyError(error)) {
        throw failure(
          'usage_conflict',
          'Interview session already has a different usage',
          error,
        )
      }
      throw error
    }
  }
  throw failure(
    'persistence_conflict',
    'Unlock reservation exhausted concurrency recovery',
  )
}

async function consumeNormalizedInSession(
  input: NormalizedReservationInput,
  now: Date,
  session: ClientSession,
  persistence: InterviewUnlockPersistence,
  producer?: SingleInterviewConsumedAnalyticsProducer,
): Promise<PaidInterviewUnlockConsumptionResult> {
  const usage = await persistence.findUsageBySession(
    input.sessionId,
    session,
  )
  if (!usage) {
    throw failure(
      'unavailable',
      'Paid interview reservation was not found',
    )
  }
  exactUsage(usage, input)
  if (usage.restorationId) {
    throw failure(
      'state_conflict',
      'A restored interview usage cannot be consumed again',
    )
  }
  const unlock = await persistence.findUnlockById(
    usage.sourceId,
    session,
  )
  if (!unlock) {
    throw failure(
      'state_conflict',
      'Interview usage references a missing unlock',
    )
  }
  exactUnlock(unlock, input)
  if (usage.consumedAt) {
    if (
      unlock.status !== 'consumed' ||
      !unlock.consumedSessionId?.equals(input.sessionId) ||
      !unlock.consumedAt ||
      unlock.consumedAt.getTime() !== usage.consumedAt.getTime()
    ) {
      throw failure(
        'state_conflict',
        'Consumed usage and unlock state disagree',
      )
    }
    await producer?.appendSingleInterviewConsumedInSession(
      () => ({
        sourceEvidenceId: unlock.id.toHexString(),
        correlationId: unlock.checkoutIntentId.toHexString(),
        subjectId: input.userId.toHexString(),
        providerMode: input.providerMode,
        occurredAt: new Date(usage.consumedAt as Date),
        normalizedDurationMinutes: usage.normalizedDurationMinutes as
          NormalizedInterviewDurationMinutes,
        maxDurationMinutes: PAID_INTERVIEW_MAX_DURATION_MINUTES,
        validUntil: new Date(unlock.validUntil),
      }),
      session,
    )
    return {
      unlockId: unlock.id.toHexString(),
      usageId: usage.id.toHexString(),
      sessionId: input.sessionId.toHexString(),
      state: 'consumed',
      consumedAt: new Date(usage.consumedAt),
      reused: true,
    }
  }
  if (now < usage.reservedAt) {
    throw failure(
      'invalid_request',
      'Current time precedes the unlock reservation',
    )
  }
  if (
    unlock.status !== 'reserved' ||
    !unlock.reservedSessionId?.equals(input.sessionId)
  ) {
    throw failure(
      'state_conflict',
      'Unlock is not reserved for this interview session',
    )
  }
  const consumedUsage = await persistence.markUsageConsumed({
    usageId: usage.id,
    sessionId: input.sessionId,
    userId: input.userId,
    unlockId: unlock.id,
    consumedAt: now,
  }, session)
  if (!consumedUsage) {
    throw failure(
      'persistence_conflict',
      'Interview usage consumption raced with another mutation',
    )
  }
  const consumedUnlock = await persistence.markUnlockConsumed({
    unlockId: unlock.id,
    sessionId: input.sessionId,
    userId: input.userId,
    providerMode: input.providerMode,
    consumedAt: now,
  }, session)
  if (!consumedUnlock) {
    throw failure(
      'persistence_conflict',
      'Unlock consumption raced with another mutation',
    )
  }
  if (
    !consumedUsage.consumedAt ||
    !consumedUnlock.consumedAt ||
    consumedUsage.consumedAt.getTime() !== now.getTime() ||
    consumedUnlock.consumedAt.getTime() !== now.getTime()
  ) {
    throw failure(
      'persistence_conflict',
      'Consumption did not persist coherent timestamps',
    )
  }
  await producer?.appendSingleInterviewConsumedInSession(
    () => ({
      sourceEvidenceId: unlock.id.toHexString(),
      correlationId: unlock.checkoutIntentId.toHexString(),
      subjectId: input.userId.toHexString(),
      providerMode: input.providerMode,
      occurredAt: new Date(now),
      normalizedDurationMinutes: usage.normalizedDurationMinutes as
        NormalizedInterviewDurationMinutes,
      maxDurationMinutes: PAID_INTERVIEW_MAX_DURATION_MINUTES,
      validUntil: new Date(unlock.validUntil),
    }),
    session,
  )
  return {
    unlockId: unlock.id.toHexString(),
    usageId: usage.id.toHexString(),
    sessionId: input.sessionId.toHexString(),
    state: 'consumed',
    consumedAt: new Date(now),
    reused: false,
  }
}

export async function consumePaidInterviewUnlockInSession(
  input: ConsumePaidInterviewUnlockInput,
  session: ClientSession,
  claimedUserId: mongoose.Types.ObjectId,
  dependencies: Pick<
    InterviewUnlockDependencies,
    'now' | 'persistence' | 'commercialAnalyticsProducer'
  > = {},
): Promise<PaidInterviewUnlockConsumptionResult> {
  const normalized = normalizeReservationInput(input)
  exactClaimedUser(normalized.userId, claimedUserId)
  return consumeNormalizedInSession(
    normalized,
    observedNow(dependencies.now),
    session,
    dependencies.persistence ?? mongoInterviewUnlockPersistence,
    dependencies.commercialAnalyticsProducer,
  )
}

export async function consumePaidInterviewUnlock(
  input: ConsumePaidInterviewUnlockInput,
  dependencies: InterviewUnlockDependencies = {},
): Promise<PaidInterviewUnlockConsumptionResult> {
  const normalized = normalizeReservationInput(input)
  if (
    (dependencies.stateReady ??
      PR7_INTERVIEW_UNLOCK_STATE_READY) !== true
  ) {
    throw failure(
      'not_ready',
      'Paid interview unlock mutation is not ready',
    )
  }
  const now = observedNow(dependencies.now)
  const persistence =
    dependencies.persistence ?? mongoInterviewUnlockPersistence
  const runner =
    dependencies.transactionRunner ?? defaultTransactionRunner
  return runner.run(
    normalized.userId.toHexString(),
    async (session, claimedUserId) => {
      exactClaimedUser(normalized.userId, claimedUserId)
      return consumeNormalizedInSession(
        normalized,
        now,
        session,
        persistence,
        dependencies.commercialAnalyticsProducer,
      )
    },
  )
}

function exactEvidence(
  evidence: AuthoritativeInterviewRestorationEvidence | null,
  input: NormalizedRestorationInput,
  usage: StoredPaidInterviewUsage,
  now: Date,
): AuthoritativeInterviewRestorationEvidence {
  if (!evidence) {
    throw failure(
      'evidence_denied',
      'Authoritative platform-failure evidence was not found',
    )
  }
  let restorationId: mongoose.Types.ObjectId
  let usageId: mongoose.Types.ObjectId
  let userId: mongoose.Types.ObjectId
  let sessionId: mongoose.Types.ObjectId
  let sourceId: mongoose.Types.ObjectId
  try {
    restorationId = exactObjectId(
      evidence.restorationId,
      'evidence.restorationId',
    )
    usageId = exactObjectId(evidence.usageId, 'evidence.usageId')
    userId = exactObjectId(evidence.userId, 'evidence.userId')
    sessionId = exactObjectId(
      evidence.sessionId,
      'evidence.sessionId',
    )
    sourceId = exactObjectId(evidence.sourceId, 'evidence.sourceId')
  } catch (error) {
    throw failure(
      'evidence_denied',
      'Authoritative restoration identity is invalid',
      error,
    )
  }
  const verifiedAt = evidence.verifiedAt
  if (
    evidence.verified !== true ||
    evidence.source !== 'paid_interview' ||
    evidence.providerMode !== input.providerMode ||
    !restorationId.equals(input.restorationId) ||
    !usageId.equals(usage.id) ||
    !userId.equals(input.userId) ||
    !sessionId.equals(input.sessionId) ||
    !sourceId.equals(usage.sourceId) ||
    evidence.firstTurnRecordedAt !== null ||
    !RESTORABLE_INTERVIEW_PLATFORM_FAILURE_REASONS.includes(
      evidence.reason,
    ) ||
    !(verifiedAt instanceof Date) ||
    !Number.isFinite(verifiedAt.getTime()) ||
    verifiedAt < usage.consumedAt! ||
    verifiedAt > now
  ) {
    throw failure(
      'evidence_denied',
      'Authoritative restoration evidence does not match this usage',
    )
  }
  return evidence
}

async function restoreNormalizedInSession(
  input: NormalizedRestorationInput,
  now: Date,
  session: ClientSession,
  persistence: InterviewUnlockPersistence,
  evidenceProvider: InterviewRestorationEvidenceProvider,
): Promise<PaidInterviewUnlockRestorationResult> {
  const usage = await persistence.findUsageBySession(
    input.sessionId,
    session,
  )
  if (!usage) {
    throw failure(
      'unavailable',
      'Consumed paid interview usage was not found',
    )
  }
  exactRestorationUsage(usage, input)
  const unlock = await persistence.findUnlockById(
    usage.sourceId,
    session,
  )
  if (!unlock) {
    throw failure(
      'state_conflict',
      'Interview usage references a missing unlock',
    )
  }
  exactUnlock(unlock, input)
  const evidence = exactEvidence(
    await evidenceProvider.load({
      restorationId: input.restorationId,
      userId: input.userId,
      sessionId: input.sessionId,
      providerMode: input.providerMode,
    }, session),
    input,
    usage,
    now,
  )
  if (usage.restorationId) {
    if (!usage.restorationId.equals(input.restorationId)) {
      throw failure(
        'state_conflict',
        'Interview usage was restored by a different operation',
      )
    }
    return {
      unlockId: unlock.id.toHexString(),
      usageId: usage.id.toHexString(),
      sessionId: input.sessionId.toHexString(),
      disposition: 'already_restored',
      restorationId: input.restorationId.toHexString(),
      reused: true,
    }
  }
  if (
    unlock.status !== 'consumed' ||
    !unlock.reservedSessionId?.equals(input.sessionId) ||
    !unlock.consumedSessionId?.equals(input.sessionId)
  ) {
    throw failure(
      'state_conflict',
      'Unlock is not consumed by this interview session',
    )
  }
  const finalStatus = unlock.validUntil > now
    ? 'available'
    : 'expired'
  const restoredUsage = await persistence.markUsageRestored({
    usageId: usage.id,
    sessionId: input.sessionId,
    userId: input.userId,
    unlockId: unlock.id,
    restorationId: input.restorationId,
  }, session)
  if (
    !restoredUsage ||
    !restoredUsage.restorationId?.equals(input.restorationId)
  ) {
    throw failure(
      'persistence_conflict',
      'Interview usage restoration raced with another mutation',
    )
  }
  const restoredUnlock = await persistence.releaseRestoredUnlock({
    unlockId: unlock.id,
    sessionId: input.sessionId,
    userId: input.userId,
    providerMode: input.providerMode,
    restoredAt: now,
    reason: evidence.reason,
    finalStatus,
  }, session)
  if (
    !restoredUnlock ||
    restoredUnlock.status !== finalStatus ||
    restoredUnlock.reservedSessionId ||
    restoredUnlock.consumedSessionId
  ) {
    throw failure(
      'persistence_conflict',
      'Unlock restoration did not release current session pointers',
    )
  }
  return {
    unlockId: unlock.id.toHexString(),
    usageId: usage.id.toHexString(),
    sessionId: input.sessionId.toHexString(),
    disposition: finalStatus,
    restorationId: input.restorationId.toHexString(),
    reused: false,
  }
}

export async function restorePaidInterviewUnlockInSession(
  input: RestorePaidInterviewUnlockInput,
  session: ClientSession,
  claimedUserId: mongoose.Types.ObjectId,
  dependencies: Pick<
    InterviewUnlockDependencies,
    'now' | 'persistence' | 'evidenceProvider'
  >,
): Promise<PaidInterviewUnlockRestorationResult> {
  const normalized = normalizeRestorationInput(input)
  exactClaimedUser(normalized.userId, claimedUserId)
  if (!dependencies.evidenceProvider) {
    throw failure(
      'evidence_required',
      'No authoritative restoration evidence provider is configured',
    )
  }
  return restoreNormalizedInSession(
    normalized,
    observedNow(dependencies.now),
    session,
    dependencies.persistence ?? mongoInterviewUnlockPersistence,
    dependencies.evidenceProvider,
  )
}

export async function restorePaidInterviewUnlock(
  input: RestorePaidInterviewUnlockInput,
  dependencies: InterviewUnlockDependencies = {},
): Promise<PaidInterviewUnlockRestorationResult> {
  const normalized = normalizeRestorationInput(input)
  if (
    (dependencies.stateReady ??
      PR7_INTERVIEW_UNLOCK_STATE_READY) !== true
  ) {
    throw failure(
      'not_ready',
      'Paid interview unlock mutation is not ready',
    )
  }
  if (!dependencies.evidenceProvider) {
    throw failure(
      'evidence_required',
      'No authoritative restoration evidence provider is configured',
    )
  }
  const now = observedNow(dependencies.now)
  const persistence =
    dependencies.persistence ?? mongoInterviewUnlockPersistence
  const runner =
    dependencies.transactionRunner ?? defaultTransactionRunner
  try {
    return await runner.run(
      normalized.userId.toHexString(),
      async (session, claimedUserId) => {
        exactClaimedUser(normalized.userId, claimedUserId)
        return restoreNormalizedInSession(
          normalized,
          now,
          session,
          persistence,
          dependencies.evidenceProvider!,
        )
      },
    )
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      throw failure(
        'state_conflict',
        'Restoration operation is already linked to another usage',
        error,
      )
    }
    throw error
  }
}

async function expireNormalizedInSession(
  input: NormalizedPreviewInput,
  now: Date,
  session: ClientSession,
  persistence: InterviewUnlockPersistence,
): Promise<ExpirePaidInterviewUnlocksResult> {
  const expiredCount = await persistence.expireEligible({
    userId: input.userId,
    providerMode: input.providerMode,
    now,
    limit: MAX_LAZY_INTERVIEW_UNLOCK_EXPIRY_BATCH,
  }, session)
  if (
    !Number.isSafeInteger(expiredCount) ||
    expiredCount < 0 ||
    expiredCount > MAX_LAZY_INTERVIEW_UNLOCK_EXPIRY_BATCH
  ) {
    throw failure(
      'persistence_conflict',
      'Expiry persistence returned an invalid count',
    )
  }
  return {
    expiredCount,
    batchLimit: MAX_LAZY_INTERVIEW_UNLOCK_EXPIRY_BATCH,
    mayHaveMore:
      expiredCount === MAX_LAZY_INTERVIEW_UNLOCK_EXPIRY_BATCH,
  }
}

export async function expirePaidInterviewUnlocksInSession(
  input: ExpirePaidInterviewUnlocksInput,
  session: ClientSession,
  claimedUserId: mongoose.Types.ObjectId,
  dependencies: Pick<
    InterviewUnlockDependencies,
    'now' | 'persistence'
  > = {},
): Promise<ExpirePaidInterviewUnlocksResult> {
  const normalized = normalizePreviewInput(input)
  exactClaimedUser(normalized.userId, claimedUserId)
  return expireNormalizedInSession(
    normalized,
    observedNow(dependencies.now),
    session,
    dependencies.persistence ?? mongoInterviewUnlockPersistence,
  )
}

export async function expirePaidInterviewUnlocks(
  input: ExpirePaidInterviewUnlocksInput,
  dependencies: InterviewUnlockDependencies = {},
): Promise<ExpirePaidInterviewUnlocksResult> {
  const normalized = normalizePreviewInput(input)
  if (
    (dependencies.stateReady ??
      PR7_INTERVIEW_UNLOCK_STATE_READY) !== true
  ) {
    throw failure(
      'not_ready',
      'Paid interview unlock mutation is not ready',
    )
  }
  const now = observedNow(dependencies.now)
  const persistence =
    dependencies.persistence ?? mongoInterviewUnlockPersistence
  const runner =
    dependencies.transactionRunner ?? defaultTransactionRunner
  return runner.run(
    normalized.userId.toHexString(),
    async (session, claimedUserId) => {
      exactClaimedUser(normalized.userId, claimedUserId)
      return expireNormalizedInSession(
        normalized,
        now,
        session,
        persistence,
      )
    },
  )
}

export async function previewPaidInterviewUnlocks(
  input: InterviewUnlockPreviewInput,
  dependencies: InterviewUnlockPreviewDependencies = {},
): Promise<InterviewUnlockPreviewResult> {
  if (
    (dependencies.previewReady ??
      PR7_INTERVIEW_UNLOCK_PREVIEW_READY) !== true
  ) {
    throw failure(
      'not_ready',
      'Paid interview unlock preview is not ready',
    )
  }
  const normalized = normalizePreviewInput(input)
  const now = observedNow(dependencies.now)
  const preview = await (
    dependencies.persistence ?? mongoInterviewUnlockPersistence
  ).previewAvailable({
    ...normalized,
    now,
  })
  if (
    !Number.isSafeInteger(preview.availableCount) ||
    preview.availableCount < 0 ||
    (
      preview.availableCount === 0 &&
      preview.earliestValidUntil !== null
    ) ||
    (
      preview.availableCount > 0 &&
      (
        !(preview.earliestValidUntil instanceof Date) ||
        !Number.isFinite(preview.earliestValidUntil.getTime()) ||
        preview.earliestValidUntil <= now
      )
    )
  ) {
    throw failure(
      'persistence_conflict',
      'Unlock preview returned an invalid availability projection',
    )
  }
  return {
    availableCount: preview.availableCount,
    earliestValidUntil: preview.earliestValidUntil
      ? new Date(preview.earliestValidUntil)
      : null,
    maxDurationMinutes: PAID_INTERVIEW_MAX_DURATION_MINUTES,
  }
}
