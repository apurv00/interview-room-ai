import { createHash } from 'node:crypto'
import mongoose, { type ClientSession } from 'mongoose'
import { connectDB } from '@shared/db/connection'
import {
  SessionPersonalDataWriteBlockedError,
  withSessionPersonalDataWriteTransaction,
} from '@shared/services/accountDeletion'
import { InterviewSession } from '@shared/db/models/InterviewSession'
import {
  PR8_PAID_INTERVIEW_RESERVATION_RELEASE_READY,
} from '@shared/services/pr8InterviewRollout'
import { sha256CanonicalJson } from '../lib/canonicalJson'
import {
  InterviewUsage,
  NORMALIZED_INTERVIEW_DURATIONS_MINUTES,
  type InterviewUsageSource,
  type NormalizedInterviewDurationMinutes,
} from '../models/InterviewUsage'
import { InterviewRuntime } from '../models/InterviewRuntime'
import {
  PaidInterviewUnlock,
  PAID_INTERVIEW_MAX_DURATION_MINUTES,
  type PaidInterviewUnlockStatus,
} from '../models/PaidInterviewUnlock'
import {
  PROVIDER_MODES,
  type ProviderMode,
} from '../types/catalog'
import {
  INTERVIEW_ENTITLEMENT_DECISION_POLICY_VERSION,
  INTERVIEW_ENTITLEMENT_DECISION_SCHEMA_VERSION,
  type PaidUnlockInterviewUsageEntitlementSnapshot,
} from './interviewEntitlementDecisionKernel'

const OBJECT_ID_PATTERN = /^[a-f0-9]{24}$/
const SHA256_PATTERN = /^[a-f0-9]{64}$/
const INTERVIEW_TYPE_PATTERN =
  /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const SNAPSHOT_KEYS = [
  'schemaVersion',
  'policyVersion',
  'decidedAt',
  'userId',
  'providerMode',
  'interviewType',
  'normalizedDurationMinutes',
  'normalizedDurationSeconds',
  'source',
  'sourceId',
  'entitlementSource',
  'effectiveTier',
  'unlockStatus',
  'validUntil',
  'createdAt',
  'maxDurationMinutes',
] as const
const RELEASE_EVIDENCE_SESSION_KEYS = [
  'id',
  'userId',
  'status',
  'startedAt',
  'deletionPendingAt',
] as const
const RELEASE_EVIDENCE_RUNTIME_KEYS = [
  'id',
  'sessionId',
  'userId',
  'authorityKind',
  'usageId',
  'entitlementSource',
  'entitlementSourceId',
  'entitlementSnapshotDigest',
  'state',
  'startedAt',
  'deadlineAt',
  'restoreUntil',
  'runtimeVersion',
  'nextTurnOrdinal',
  'nextMainQuestionOrdinal',
  'mainQuestionReservationOperationId',
  'firstTurnRecordedAt',
  'firstTurnOperationId',
  'firstTurnId',
] as const

export const MAX_PAID_INTERVIEW_RESERVATION_EXPIRY_BATCH =
  25 as const

export const PAID_INTERVIEW_UNCONSUMED_RELEASE_REASONS = [
  'platform_session_initialization_failed',
  'platform_realtime_connection_failed',
] as const
export type PaidInterviewUnconsumedReleaseReason =
  (typeof PAID_INTERVIEW_UNCONSUMED_RELEASE_REASONS)[number]

export const PAID_INTERVIEW_RESERVATION_RELEASE_ERROR_CODES = [
  'not_ready',
  'invalid_request',
  'invalid_transaction_context',
  'unavailable',
  'evidence_required',
  'evidence_denied',
  'state_conflict',
  'persistence_conflict',
] as const
export type PaidInterviewReservationReleaseErrorCode =
  (typeof PAID_INTERVIEW_RESERVATION_RELEASE_ERROR_CODES)[number]

export class PaidInterviewReservationReleaseError extends Error {
  constructor(
    readonly code: PaidInterviewReservationReleaseErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'PaidInterviewReservationReleaseError'
  }
}

export interface ReleasePaidInterviewReservationInput {
  userId: string
  sessionId: string
  providerMode: ProviderMode
  releaseId: string
}

export interface ExpirePaidInterviewReservationsInput {
  userId: string
  providerMode: ProviderMode
}

export interface ExpirePaidInterviewReservationInput
extends ExpirePaidInterviewReservationsInput {
  sessionId: string
  unlockId: string
}

export interface ClaimedPaidInterviewSessionTransaction {
  session: ClientSession
  claimedUserId: mongoose.Types.ObjectId
  claimedSessionId: mongoose.Types.ObjectId
}

export interface AuthoritativePaidInterviewReservationReleaseEvidence {
  releaseId: string
  usageId: string
  userId: string
  sessionId: string
  source: 'paid_interview'
  sourceId: string
  providerMode: ProviderMode
  verified: true
  verifiedAt: Date
  interviewSession: {
    id: string
    userId: string
    status: 'created'
    startedAt: null
    deletionPendingAt: null
  }
  runtime: {
    id: string
    sessionId: string
    userId: string
    authorityKind: 'consumer_usage'
    usageId: string
    entitlementSource: 'paid_interview'
    entitlementSourceId: string
    entitlementSnapshotDigest: string
    state: 'reserved'
    startedAt: null
    deadlineAt: null
    restoreUntil: null
    runtimeVersion: 0
    nextTurnOrdinal: 0
    nextMainQuestionOrdinal: 0
    mainQuestionReservationOperationId: null
    firstTurnRecordedAt: null
    firstTurnOperationId: null
    firstTurnId: null
  }
  reason: PaidInterviewUnconsumedReleaseReason
}

export interface PaidInterviewReservationReleaseEvidenceProvider {
  /**
   * Production implementations must load InterviewSession and
   * InterviewRuntime from context.session. Caller assertions or client
   * telemetry are not authoritative evidence.
   */
  load(
    input: {
      releaseId: mongoose.Types.ObjectId
      userId: mongoose.Types.ObjectId
      sessionId: mongoose.Types.ObjectId
      providerMode: ProviderMode
      usageId: mongoose.Types.ObjectId
      unlockId: mongoose.Types.ObjectId
      entitlementSnapshotDigest: string
      verifiedAt: Date
    },
    context: ClaimedPaidInterviewSessionTransaction,
  ): Promise<
    AuthoritativePaidInterviewReservationReleaseEvidence | null
  >
}

export interface StoredPaidInterviewReservationUsage {
  id: mongoose.Types.ObjectId
  sessionId: mongoose.Types.ObjectId
  userId: mongoose.Types.ObjectId
  source: InterviewUsageSource
  sourceId: mongoose.Types.ObjectId
  periodKey?: string
  reservedAt: Date
  consumedAt?: Date
  restorationId?: mongoose.Types.ObjectId
  normalizedDurationMinutes: number
  entitlementSnapshot: unknown
  entitlementSnapshotDigest?: string
}

export interface StoredReservedPaidInterviewUnlock {
  id: mongoose.Types.ObjectId
  userId: mongoose.Types.ObjectId
  providerMode: ProviderMode
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

export interface PaidInterviewReservationReleasePersistence {
  findUsageBySession(
    sessionId: mongoose.Types.ObjectId,
    session: ClientSession,
  ): Promise<StoredPaidInterviewReservationUsage | null>
  findUnlockById(
    unlockId: mongoose.Types.ObjectId,
    session: ClientSession,
  ): Promise<StoredReservedPaidInterviewUnlock | null>
  markUsageReleased(
    input: {
      usageId: mongoose.Types.ObjectId
      sessionId: mongoose.Types.ObjectId
      userId: mongoose.Types.ObjectId
      unlockId: mongoose.Types.ObjectId
      entitlementSnapshotDigest: string
      releaseId: mongoose.Types.ObjectId
    },
    session: ClientSession,
  ): Promise<StoredPaidInterviewReservationUsage | null>
  releaseReservedUnlock(
    input: {
      unlockId: mongoose.Types.ObjectId
      sessionId: mongoose.Types.ObjectId
      userId: mongoose.Types.ObjectId
      providerMode: ProviderMode
      reservedAt: Date
      releasedAt: Date
      reason: PaidInterviewUnconsumedReleaseReason
      finalStatus: 'available' | 'expired'
    },
    session: ClientSession,
  ): Promise<StoredReservedPaidInterviewUnlock | null>
  expireReservedUnlock(
    input: {
      unlockId: mongoose.Types.ObjectId
      sessionId: mongoose.Types.ObjectId
      userId: mongoose.Types.ObjectId
      providerMode: ProviderMode
      reservedAt: Date
      now: Date
    },
    session: ClientSession,
  ): Promise<StoredReservedPaidInterviewUnlock | null>
}

export interface PaidInterviewReservationExpiryBatchStore {
  findExpiredReservedUnlocks(input: {
    userId: mongoose.Types.ObjectId
    providerMode: ProviderMode
    now: Date
    limit: number
  }): Promise<StoredReservedPaidInterviewUnlock[]>
  /**
   * The implementation must commit or roll back this one candidate
   * independently from every other candidate in the bounded batch.
   */
  withClaimedSessionTransaction<T>(
    input: {
      userId: mongoose.Types.ObjectId
      sessionId: mongoose.Types.ObjectId
    },
    work: (
      context: ClaimedPaidInterviewSessionTransaction,
    ) => Promise<T>,
  ): Promise<T>
}

export interface PaidInterviewReservationReleaseTransactionStore {
  withClaimedSessionTransaction<T>(
    input: {
      userId: mongoose.Types.ObjectId
      sessionId: mongoose.Types.ObjectId
    },
    work: (
      context: ClaimedPaidInterviewSessionTransaction,
    ) => Promise<T>,
  ): Promise<T>
}

export interface PaidInterviewReservationReleaseDependencies {
  now?: () => Date
  persistence?: PaidInterviewReservationReleasePersistence
  evidenceProvider?: PaidInterviewReservationReleaseEvidenceProvider
  transactionStore?: PaidInterviewReservationReleaseTransactionStore
  allowWhenReadinessDisabledForTests?: boolean
}

export interface PaidInterviewReservationExpiryDependencies {
  now?: () => Date
  persistence?: PaidInterviewReservationReleasePersistence
  batchStore?: PaidInterviewReservationExpiryBatchStore
  allowWhenReadinessDisabledForTests?: boolean
}

export interface PaidInterviewReservationReleaseResult {
  unlockId: string
  usageId: string
  sessionId: string
  releaseId: string
  disposition: 'available' | 'expired' | 'already_released'
  reused: boolean
}

export interface PaidInterviewReservationExpiryCandidateResult {
  unlockId: string
  usageId: string
  sessionId: string
  releaseId: string
  disposition: 'expired' | 'already_expired'
  reused: boolean
}

export interface PaidInterviewReservationExpiryResult {
  expiredCount: number
  replayedCount: number
  skippedCount: number
  attemptedCount: number
  batchLimit: typeof MAX_PAID_INTERVIEW_RESERVATION_EXPIRY_BATCH
  mayHaveMore: boolean
  expiredUsageIds: string[]
  skippedUnlockIds: string[]
}

interface NormalizedReleaseInput {
  userId: mongoose.Types.ObjectId
  sessionId: mongoose.Types.ObjectId
  providerMode: ProviderMode
  releaseId: mongoose.Types.ObjectId
}

interface NormalizedExpiryInput {
  userId: mongoose.Types.ObjectId
  providerMode: ProviderMode
}

interface NormalizedExpiryCandidateInput
extends NormalizedExpiryInput {
  sessionId: mongoose.Types.ObjectId
  unlockId: mongoose.Types.ObjectId
}

interface UsageRow {
  _id: mongoose.Types.ObjectId
  sessionId: mongoose.Types.ObjectId
  userId: mongoose.Types.ObjectId
  source: InterviewUsageSource
  sourceId: mongoose.Types.ObjectId
  periodKey?: string
  reservedAt: Date
  consumedAt?: Date
  restorationId?: mongoose.Types.ObjectId
  normalizedDurationMinutes: number
  entitlementSnapshot: unknown
  entitlementSnapshotDigest?: string
}

interface UnlockRow {
  _id: mongoose.Types.ObjectId
  userId: mongoose.Types.ObjectId
  providerMode: ProviderMode
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

interface ReleaseEvidenceSessionRow {
  _id: mongoose.Types.ObjectId
  userId: mongoose.Types.ObjectId
  status: 'created'
  startedAt?: Date
  deletionPendingAt?: Date
}

interface ReleaseEvidenceRuntimeRow {
  _id: mongoose.Types.ObjectId
  sessionId: mongoose.Types.ObjectId
  userId: mongoose.Types.ObjectId
  authorityKind: 'consumer_usage'
  usageId: mongoose.Types.ObjectId
  entitlementSource: 'paid_interview'
  entitlementSourceId: mongoose.Types.ObjectId
  entitlementSnapshotDigest: string
  periodKey?: string
  organizationId?: mongoose.Types.ObjectId
  inviteAuthorityId?: string
  recruiterUserId?: mongoose.Types.ObjectId
  recruiterReferenceErasedAt?: Date
  inviteVerifiedAt?: Date
  inviteProvenanceDigest?: string
  state: 'reserved'
  startedAt?: Date
  deadlineAt?: Date
  restoreUntil?: Date
  terminalAt?: Date
  runtimeVersion: number
  nextTurnOrdinal: number
  nextMainQuestionOrdinal: number
  mainQuestionReservationOperationId?: string
  firstTurnRecordedAt?: Date
  firstTurnOperationId?: string
  firstTurnId?: mongoose.Types.ObjectId
  lastActivityAt?: Date
}

function failure(
  code: PaidInterviewReservationReleaseErrorCode,
  message: string,
  cause?: unknown,
): PaidInterviewReservationReleaseError {
  return new PaidInterviewReservationReleaseError(
    code,
    message,
    cause === undefined ? undefined : { cause },
  )
}

function isDuplicateKeyError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 11000
  )
}

function exactObjectId(
  value: unknown,
  label: string,
): mongoose.Types.ObjectId {
  if (
    typeof value !== 'string' ||
    !OBJECT_ID_PATTERN.test(value)
  ) {
    throw failure(
      'invalid_request',
      `${label} must be a canonical ObjectId`,
    )
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

function validDate(value: unknown): value is Date {
  return (
    value instanceof Date &&
    Number.isFinite(value.getTime())
  )
}

function sameDate(left: unknown, right: Date): boolean {
  return validDate(left) && left.getTime() === right.getTime()
}

function observedNow(provider?: () => Date): Date {
  const value = provider ? provider() : new Date()
  if (!validDate(value)) {
    throw failure(
      'invalid_request',
      'Reservation release clock returned an invalid date',
    )
  }
  return new Date(value)
}

function assertReady(
  dependencies: {
    allowWhenReadinessDisabledForTests?: boolean
  },
): void {
  const testOverride =
    process.env.NODE_ENV === 'test' &&
    dependencies.allowWhenReadinessDisabledForTests === true
  if (
    !PR8_PAID_INTERVIEW_RESERVATION_RELEASE_READY &&
    !testOverride
  ) {
    throw failure(
      'not_ready',
      'Paid interview reservation release is not ready',
    )
  }
}

function assertClaimedSessionTransaction(
  context: ClaimedPaidInterviewSessionTransaction,
  expectedUserId: mongoose.Types.ObjectId,
  expectedSessionId: mongoose.Types.ObjectId,
): void {
  let active = false
  try {
    active = Boolean(
      context.session &&
      typeof context.session.inTransaction === 'function' &&
      context.session.inTransaction(),
    )
  } catch {
    active = false
  }
  if (
    !(
      context.claimedUserId instanceof
      mongoose.Types.ObjectId
    ) ||
    !(
      context.claimedSessionId instanceof
      mongoose.Types.ObjectId
    ) ||
    !context.claimedUserId.equals(expectedUserId) ||
    !context.claimedSessionId.equals(expectedSessionId) ||
    !active
  ) {
    throw failure(
      'invalid_transaction_context',
      'Reservation mutation requires the exact claimed session transaction',
    )
  }
}

function normalizeReleaseInput(
  input: ReleasePaidInterviewReservationInput,
): NormalizedReleaseInput {
  return {
    userId: exactObjectId(input.userId, 'userId'),
    sessionId: exactObjectId(input.sessionId, 'sessionId'),
    providerMode: exactProviderMode(input.providerMode),
    releaseId: exactObjectId(input.releaseId, 'releaseId'),
  }
}

function normalizeExpiryInput(
  input: ExpirePaidInterviewReservationsInput,
): NormalizedExpiryInput {
  return {
    userId: exactObjectId(input.userId, 'userId'),
    providerMode: exactProviderMode(input.providerMode),
  }
}

function normalizeExpiryCandidateInput(
  input: ExpirePaidInterviewReservationInput,
): NormalizedExpiryCandidateInput {
  return {
    ...normalizeExpiryInput(input),
    sessionId: exactObjectId(input.sessionId, 'sessionId'),
    unlockId: exactObjectId(input.unlockId, 'unlockId'),
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value)
  )
    ? value as Record<string, unknown>
    : null
}

function exactIso(value: unknown): Date | null {
  if (typeof value !== 'string') return null
  const parsed = new Date(value)
  return (
    Number.isFinite(parsed.getTime()) &&
    parsed.toISOString() === value
  )
    ? parsed
    : null
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value).sort()
  const expectedKeys = [...expected].sort()
  return (
    keys.length === expectedKeys.length &&
    keys.every((key, index) => key === expectedKeys[index])
  )
}

function exactPaidSnapshot(
  usage: StoredPaidInterviewReservationUsage,
  input: {
    userId: mongoose.Types.ObjectId
    providerMode: ProviderMode
  },
): PaidUnlockInterviewUsageEntitlementSnapshot {
  const snapshot = record(usage.entitlementSnapshot)
  const decidedAt = exactIso(snapshot?.decidedAt)
  const createdAt = exactIso(snapshot?.createdAt)
  const validUntil = exactIso(snapshot?.validUntil)
  const expectedSeconds =
    usage.normalizedDurationMinutes === 10
      ? 600
      : usage.normalizedDurationMinutes === 20
        ? 1200
        : usage.normalizedDurationMinutes === 30
          ? 1800
          : null
  if (
    !snapshot ||
    !exactKeys(snapshot, SNAPSHOT_KEYS) ||
    !decidedAt ||
    !sameDate(decidedAt, usage.reservedAt) ||
    snapshot.schemaVersion !==
      INTERVIEW_ENTITLEMENT_DECISION_SCHEMA_VERSION ||
    snapshot.policyVersion !==
      INTERVIEW_ENTITLEMENT_DECISION_POLICY_VERSION ||
    snapshot.userId !== input.userId.toHexString() ||
    snapshot.providerMode !== input.providerMode ||
    typeof snapshot.interviewType !== 'string' ||
    snapshot.interviewType.length < 1 ||
    snapshot.interviewType.length > 100 ||
    !INTERVIEW_TYPE_PATTERN.test(snapshot.interviewType) ||
    snapshot.normalizedDurationMinutes !==
      usage.normalizedDurationMinutes ||
    snapshot.normalizedDurationSeconds !== expectedSeconds ||
    snapshot.source !== 'paid_interview' ||
    snapshot.sourceId !== usage.sourceId.toHexString() ||
    snapshot.entitlementSource !== 'one_time_purchase' ||
    (
      snapshot.effectiveTier !== 'basic' &&
      snapshot.effectiveTier !== 'plus' &&
      snapshot.effectiveTier !== 'pro'
    ) ||
    (
      snapshot.unlockStatus !== 'available' &&
      snapshot.unlockStatus !== 'restored'
    ) ||
    !createdAt ||
    !validUntil ||
    createdAt > decidedAt ||
    validUntil <= decidedAt ||
    validUntil <= createdAt ||
    snapshot.maxDurationMinutes !==
      PAID_INTERVIEW_MAX_DURATION_MINUTES ||
    usage.periodKey !== undefined ||
    typeof usage.entitlementSnapshotDigest !== 'string' ||
    !SHA256_PATTERN.test(usage.entitlementSnapshotDigest) ||
    usage.entitlementSnapshotDigest !==
      sha256CanonicalJson(snapshot)
  ) {
    throw failure(
      'state_conflict',
      'Paid interview usage does not carry exact PR8 reservation evidence',
    )
  }
  return snapshot as unknown as
    PaidUnlockInterviewUsageEntitlementSnapshot
}

function exactUsage(
  usage: StoredPaidInterviewReservationUsage,
  input: {
    userId: mongoose.Types.ObjectId
    sessionId: mongoose.Types.ObjectId
    providerMode: ProviderMode
  },
): PaidUnlockInterviewUsageEntitlementSnapshot {
  if (
    !usage.id ||
    !usage.userId.equals(input.userId) ||
    !usage.sessionId.equals(input.sessionId) ||
    usage.source !== 'paid_interview' ||
    !validDate(usage.reservedAt) ||
    usage.consumedAt !== undefined ||
    !NORMALIZED_INTERVIEW_DURATIONS_MINUTES.includes(
      usage.normalizedDurationMinutes as
        NormalizedInterviewDurationMinutes,
    )
  ) {
    throw failure(
      'state_conflict',
      'Paid interview reservation usage is not releasable',
    )
  }
  return exactPaidSnapshot(usage, input)
}

function exactUnlockTerms(
  unlock: StoredReservedPaidInterviewUnlock,
  usage: StoredPaidInterviewReservationUsage,
  snapshot: PaidUnlockInterviewUsageEntitlementSnapshot,
  input: {
    userId: mongoose.Types.ObjectId
    providerMode: ProviderMode
  },
): void {
  if (
    !unlock.id.equals(usage.sourceId) ||
    !unlock.userId.equals(input.userId) ||
    unlock.providerMode !== input.providerMode ||
    unlock.maxDurationMinutes !==
      PAID_INTERVIEW_MAX_DURATION_MINUTES ||
    !validDate(unlock.createdAt) ||
    !validDate(unlock.validUntil) ||
    unlock.createdAt.toISOString() !== snapshot.createdAt ||
    unlock.validUntil.toISOString() !== snapshot.validUntil
  ) {
    throw failure(
      'state_conflict',
      'Paid interview unlock terms do not match its PR8 usage',
    )
  }
}

function exactReservedUnlock(
  unlock: StoredReservedPaidInterviewUnlock,
  usage: StoredPaidInterviewReservationUsage,
): void {
  if (
    unlock.status !== 'reserved' ||
    !unlock.reservedSessionId?.equals(usage.sessionId) ||
    !sameDate(unlock.reservedAt, usage.reservedAt) ||
    unlock.consumedSessionId !== undefined ||
    unlock.consumedAt !== undefined
  ) {
    throw failure(
      'state_conflict',
      'Paid interview unlock is not exactly reserved for this session',
    )
  }
}

function exactExpiredUnlock(
  unlock: StoredReservedPaidInterviewUnlock,
): void {
  if (
    unlock.status !== 'expired' ||
    unlock.reservedSessionId !== undefined ||
    unlock.consumedSessionId !== undefined ||
    unlock.reservedAt !== undefined ||
    unlock.consumedAt !== undefined
  ) {
    throw failure(
      'state_conflict',
      'Paid interview expiry replay does not match terminal unlock state',
    )
  }
}

function skippableExpiryCandidateFailure(
  error: unknown,
): boolean {
  return (
    error instanceof SessionPersonalDataWriteBlockedError ||
    (
      error instanceof PaidInterviewReservationReleaseError &&
      (
        error.code === 'unavailable' ||
        error.code === 'state_conflict' ||
        error.code === 'persistence_conflict'
      )
    )
  )
}

function exactEvidence(
  evidence:
    | AuthoritativePaidInterviewReservationReleaseEvidence
    | null,
  input: NormalizedReleaseInput,
  usage: StoredPaidInterviewReservationUsage,
  now: Date,
): AuthoritativePaidInterviewReservationReleaseEvidence {
  if (!evidence) {
    throw failure(
      'evidence_denied',
      'Authoritative platform-failure evidence was not found',
    )
  }
  const interviewSession = record(evidence.interviewSession)
  const runtime = record(evidence.runtime)
  let releaseId: mongoose.Types.ObjectId
  let usageId: mongoose.Types.ObjectId
  let userId: mongoose.Types.ObjectId
  let sessionId: mongoose.Types.ObjectId
  let sourceId: mongoose.Types.ObjectId
  try {
    releaseId = exactObjectId(
      evidence.releaseId,
      'evidence.releaseId',
    )
    usageId = exactObjectId(
      evidence.usageId,
      'evidence.usageId',
    )
    userId = exactObjectId(
      evidence.userId,
      'evidence.userId',
    )
    sessionId = exactObjectId(
      evidence.sessionId,
      'evidence.sessionId',
    )
    sourceId = exactObjectId(
      evidence.sourceId,
      'evidence.sourceId',
    )
    exactObjectId(
      interviewSession?.id,
      'evidence.interviewSession.id',
    )
    exactObjectId(
      interviewSession?.userId,
      'evidence.interviewSession.userId',
    )
    exactObjectId(runtime?.id, 'evidence.runtime.id')
    exactObjectId(
      runtime?.sessionId,
      'evidence.runtime.sessionId',
    )
    exactObjectId(
      runtime?.userId,
      'evidence.runtime.userId',
    )
    exactObjectId(
      runtime?.usageId,
      'evidence.runtime.usageId',
    )
    exactObjectId(
      runtime?.entitlementSourceId,
      'evidence.runtime.entitlementSourceId',
    )
  } catch (error) {
    throw failure(
      'evidence_denied',
      'Authoritative reservation-release identity is invalid',
      error,
    )
  }
  if (
    evidence.verified !== true ||
    evidence.source !== 'paid_interview' ||
    evidence.providerMode !== input.providerMode ||
    !releaseId.equals(input.releaseId) ||
    !usageId.equals(usage.id) ||
    !userId.equals(input.userId) ||
    !sessionId.equals(input.sessionId) ||
    !sourceId.equals(usage.sourceId) ||
    !interviewSession ||
    !exactKeys(
      interviewSession,
      RELEASE_EVIDENCE_SESSION_KEYS,
    ) ||
    interviewSession.id !== input.sessionId.toHexString() ||
    interviewSession.userId !== input.userId.toHexString() ||
    interviewSession.status !== 'created' ||
    interviewSession.startedAt !== null ||
    interviewSession.deletionPendingAt !== null ||
    !runtime ||
    !exactKeys(runtime, RELEASE_EVIDENCE_RUNTIME_KEYS) ||
    runtime.sessionId !== input.sessionId.toHexString() ||
    runtime.userId !== input.userId.toHexString() ||
    runtime.authorityKind !== 'consumer_usage' ||
    runtime.usageId !== usage.id.toHexString() ||
    runtime.entitlementSource !== 'paid_interview' ||
    runtime.entitlementSourceId !==
      usage.sourceId.toHexString() ||
    runtime.entitlementSnapshotDigest !==
      usage.entitlementSnapshotDigest ||
    runtime.state !== 'reserved' ||
    runtime.startedAt !== null ||
    runtime.deadlineAt !== null ||
    runtime.restoreUntil !== null ||
    runtime.runtimeVersion !== 0 ||
    runtime.nextTurnOrdinal !== 0 ||
    runtime.nextMainQuestionOrdinal !== 0 ||
    runtime.mainQuestionReservationOperationId !== null ||
    runtime.firstTurnRecordedAt !== null ||
    runtime.firstTurnOperationId !== null ||
    runtime.firstTurnId !== null ||
    !PAID_INTERVIEW_UNCONSUMED_RELEASE_REASONS.includes(
      evidence.reason,
    ) ||
    !validDate(evidence.verifiedAt) ||
    evidence.verifiedAt < usage.reservedAt ||
    evidence.verifiedAt > now
  ) {
    throw failure(
      'evidence_denied',
      'Authoritative platform-failure evidence does not match this reservation',
    )
  }
  return evidence
}

function expiryReleaseId(
  usage: StoredPaidInterviewReservationUsage,
  unlock: StoredReservedPaidInterviewUnlock,
): mongoose.Types.ObjectId {
  const digest = createHash('sha256')
    .update('paid-interview-reservation-expiry:v1:')
    .update(usage.id.toHexString())
    .update(':')
    .update(unlock.id.toHexString())
    .update(':')
    .update(unlock.validUntil.toISOString())
    .digest('hex')
  return new mongoose.Types.ObjectId(digest.slice(0, 24))
}

function storedUsage(
  row: UsageRow,
): StoredPaidInterviewReservationUsage {
  return {
    id: row._id,
    sessionId: row.sessionId,
    userId: row.userId,
    source: row.source,
    sourceId: row.sourceId,
    periodKey: row.periodKey,
    reservedAt: row.reservedAt,
    consumedAt: row.consumedAt,
    restorationId: row.restorationId,
    normalizedDurationMinutes: row.normalizedDurationMinutes,
    entitlementSnapshot: row.entitlementSnapshot,
    entitlementSnapshotDigest: row.entitlementSnapshotDigest,
  }
}

function storedUnlock(
  row: UnlockRow,
): StoredReservedPaidInterviewUnlock {
  return {
    id: row._id,
    userId: row.userId,
    providerMode: row.providerMode,
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

function exactEvidenceRows(
  interviewSession: ReleaseEvidenceSessionRow,
  runtime: ReleaseEvidenceRuntimeRow,
  input: {
    userId: mongoose.Types.ObjectId
    sessionId: mongoose.Types.ObjectId
    usageId: mongoose.Types.ObjectId
    unlockId: mongoose.Types.ObjectId
    entitlementSnapshotDigest: string
    verifiedAt: Date
  },
): boolean {
  const objectIdMatches = (
    value: unknown,
    expected?: mongoose.Types.ObjectId,
  ): value is mongoose.Types.ObjectId =>
    value instanceof mongoose.Types.ObjectId &&
    (expected === undefined || value.equals(expected))
  return (
    validDate(input.verifiedAt) &&
    SHA256_PATTERN.test(input.entitlementSnapshotDigest) &&
    objectIdMatches(interviewSession._id, input.sessionId) &&
    objectIdMatches(interviewSession.userId, input.userId) &&
    interviewSession.status === 'created' &&
    interviewSession.startedAt === undefined &&
    interviewSession.deletionPendingAt === undefined &&
    objectIdMatches(runtime._id) &&
    objectIdMatches(runtime.sessionId, input.sessionId) &&
    objectIdMatches(runtime.userId, input.userId) &&
    runtime.authorityKind === 'consumer_usage' &&
    objectIdMatches(runtime.usageId, input.usageId) &&
    runtime.entitlementSource === 'paid_interview' &&
    objectIdMatches(runtime.entitlementSourceId, input.unlockId) &&
    runtime.entitlementSnapshotDigest ===
      input.entitlementSnapshotDigest &&
    runtime.periodKey === undefined &&
    runtime.organizationId === undefined &&
    runtime.inviteAuthorityId === undefined &&
    runtime.recruiterUserId === undefined &&
    runtime.recruiterReferenceErasedAt === undefined &&
    runtime.inviteVerifiedAt === undefined &&
    runtime.inviteProvenanceDigest === undefined &&
    runtime.state === 'reserved' &&
    runtime.startedAt === undefined &&
    runtime.deadlineAt === undefined &&
    runtime.restoreUntil === undefined &&
    runtime.terminalAt === undefined &&
    runtime.runtimeVersion === 0 &&
    runtime.nextTurnOrdinal === 0 &&
    runtime.nextMainQuestionOrdinal === 0 &&
    runtime.mainQuestionReservationOperationId === undefined &&
    runtime.firstTurnRecordedAt === undefined &&
    runtime.firstTurnOperationId === undefined &&
    runtime.firstTurnId === undefined &&
    runtime.lastActivityAt === undefined
  )
}

export const mongoPaidInterviewReservationReleaseEvidenceProvider:
PaidInterviewReservationReleaseEvidenceProvider = {
  async load(input, context) {
    assertClaimedSessionTransaction(
      context,
      input.userId,
      input.sessionId,
    )
    const interviewSession = await InterviewSession.findOne({
      _id: input.sessionId,
      userId: input.userId,
      status: 'created',
      startedAt: { $exists: false },
      deletionPendingAt: { $exists: false },
    })
      .select(
        '_id userId status startedAt deletionPendingAt',
      )
      .session(context.session)
      .lean<ReleaseEvidenceSessionRow>()
    if (!interviewSession) return null

    const runtime = await InterviewRuntime.findOne({
      sessionId: input.sessionId,
      userId: input.userId,
      authorityKind: 'consumer_usage',
      usageId: input.usageId,
      entitlementSource: 'paid_interview',
      entitlementSourceId: input.unlockId,
      entitlementSnapshotDigest:
        input.entitlementSnapshotDigest,
      periodKey: { $exists: false },
      organizationId: { $exists: false },
      inviteAuthorityId: { $exists: false },
      recruiterUserId: { $exists: false },
      recruiterReferenceErasedAt: { $exists: false },
      inviteVerifiedAt: { $exists: false },
      inviteProvenanceDigest: { $exists: false },
      state: 'reserved',
      startedAt: { $exists: false },
      deadlineAt: { $exists: false },
      restoreUntil: { $exists: false },
      terminalAt: { $exists: false },
      runtimeVersion: 0,
      nextTurnOrdinal: 0,
      nextMainQuestionOrdinal: 0,
      mainQuestionReservationOperationId: {
        $exists: false,
      },
      firstTurnRecordedAt: { $exists: false },
      firstTurnOperationId: { $exists: false },
      firstTurnId: { $exists: false },
      lastActivityAt: { $exists: false },
    })
      .select(
        '_id sessionId userId authorityKind usageId ' +
          'entitlementSource entitlementSourceId ' +
          'entitlementSnapshotDigest periodKey organizationId ' +
          'inviteAuthorityId recruiterUserId ' +
          'recruiterReferenceErasedAt inviteVerifiedAt ' +
          'inviteProvenanceDigest ' +
          'state startedAt deadlineAt restoreUntil terminalAt ' +
          'runtimeVersion nextTurnOrdinal nextMainQuestionOrdinal ' +
          'mainQuestionReservationOperationId firstTurnRecordedAt ' +
          'firstTurnOperationId firstTurnId lastActivityAt',
      )
      .session(context.session)
      .lean<ReleaseEvidenceRuntimeRow>()
    if (
      !runtime ||
      !exactEvidenceRows(
        interviewSession,
        runtime,
        input,
      )
    ) {
      return null
    }

    return {
      releaseId: input.releaseId.toHexString(),
      usageId: input.usageId.toHexString(),
      userId: input.userId.toHexString(),
      sessionId: input.sessionId.toHexString(),
      source: 'paid_interview',
      sourceId: input.unlockId.toHexString(),
      providerMode: input.providerMode,
      verified: true,
      verifiedAt: new Date(input.verifiedAt),
      interviewSession: {
        id: input.sessionId.toHexString(),
        userId: input.userId.toHexString(),
        status: 'created',
        startedAt: null,
        deletionPendingAt: null,
      },
      runtime: {
        id: runtime._id.toHexString(),
        sessionId: input.sessionId.toHexString(),
        userId: input.userId.toHexString(),
        authorityKind: 'consumer_usage',
        usageId: input.usageId.toHexString(),
        entitlementSource: 'paid_interview',
        entitlementSourceId: input.unlockId.toHexString(),
        entitlementSnapshotDigest:
          input.entitlementSnapshotDigest,
        state: 'reserved',
        startedAt: null,
        deadlineAt: null,
        restoreUntil: null,
        runtimeVersion: 0,
        nextTurnOrdinal: 0,
        nextMainQuestionOrdinal: 0,
        mainQuestionReservationOperationId: null,
        firstTurnRecordedAt: null,
        firstTurnOperationId: null,
        firstTurnId: null,
      },
      reason: 'platform_session_initialization_failed',
    }
  },
}

export const mongoPaidInterviewReservationReleasePersistence:
PaidInterviewReservationReleasePersistence = {
  async findUsageBySession(sessionId, session) {
    const row = await InterviewUsage.findOne({ sessionId })
      .session(session)
      .lean<UsageRow>()
    return row ? storedUsage(row) : null
  },
  async findUnlockById(unlockId, session) {
    const row = await PaidInterviewUnlock.findById(unlockId)
      .session(session)
      .lean<UnlockRow>()
    return row ? storedUnlock(row) : null
  },
  async markUsageReleased(input, session) {
    const row = await InterviewUsage.findOneAndUpdate(
      {
        _id: input.usageId,
        sessionId: input.sessionId,
        userId: input.userId,
        source: 'paid_interview',
        sourceId: input.unlockId,
        entitlementSnapshotDigest:
          input.entitlementSnapshotDigest,
        consumedAt: { $exists: false },
        restorationId: { $exists: false },
      },
      {
        $set: { restorationId: input.releaseId },
      },
      { new: true, runValidators: true, session },
    ).lean<UsageRow>()
    return row ? storedUsage(row) : null
  },
  async releaseReservedUnlock(input, session) {
    const row = await PaidInterviewUnlock.findOneAndUpdate(
      {
        _id: input.unlockId,
        userId: input.userId,
        providerMode: input.providerMode,
        status: 'reserved',
        reservedSessionId: input.sessionId,
        reservedAt: input.reservedAt,
        consumedSessionId: { $exists: false },
        consumedAt: { $exists: false },
      },
      {
        $set: {
          status: input.finalStatus,
          restoredAt: input.releasedAt,
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
    ).lean<UnlockRow>()
    return row ? storedUnlock(row) : null
  },
  async expireReservedUnlock(input, session) {
    const row = await PaidInterviewUnlock.findOneAndUpdate(
      {
        _id: input.unlockId,
        userId: input.userId,
        providerMode: input.providerMode,
        status: 'reserved',
        reservedSessionId: input.sessionId,
        reservedAt: input.reservedAt,
        consumedSessionId: { $exists: false },
        consumedAt: { $exists: false },
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
      { new: true, runValidators: true, session },
    ).lean<UnlockRow>()
    return row ? storedUnlock(row) : null
  },
}

export const mongoPaidInterviewReservationReleaseTransactionStore:
PaidInterviewReservationReleaseTransactionStore = {
  async withClaimedSessionTransaction(input, work) {
    return withSessionPersonalDataWriteTransaction(
      input.userId,
      input.sessionId,
      async (session, claimedUserId, claimedSessionId) =>
        work({
          session,
          claimedUserId,
          claimedSessionId,
        }),
    )
  },
}

export const mongoPaidInterviewReservationExpiryBatchStore:
PaidInterviewReservationExpiryBatchStore = {
  async findExpiredReservedUnlocks(input) {
    await connectDB()
    const rows = await PaidInterviewUnlock.find({
      userId: input.userId,
      providerMode: input.providerMode,
      status: 'reserved',
      maxDurationMinutes:
        PAID_INTERVIEW_MAX_DURATION_MINUTES,
      validUntil: { $lte: input.now },
      reservedSessionId: { $type: 'objectId' },
      reservedAt: { $type: 'date' },
      consumedSessionId: { $exists: false },
      consumedAt: { $exists: false },
    })
      .sort({ validUntil: 1, createdAt: 1, _id: 1 })
      .limit(input.limit)
      .lean<UnlockRow[]>()
    return rows.map(storedUnlock)
  },
  async withClaimedSessionTransaction(input, work) {
    return withSessionPersonalDataWriteTransaction(
      input.userId,
      input.sessionId,
      async (session, claimedUserId, claimedSessionId) =>
        work({
          session,
          claimedUserId,
          claimedSessionId,
        }),
    )
  },
}

export async function releasePaidInterviewReservationInSession(
  rawInput: ReleasePaidInterviewReservationInput,
  context: ClaimedPaidInterviewSessionTransaction,
  dependencies:
    PaidInterviewReservationReleaseDependencies = {},
): Promise<PaidInterviewReservationReleaseResult> {
  assertReady(dependencies)
  const input = normalizeReleaseInput(rawInput)
  assertClaimedSessionTransaction(
    context,
    input.userId,
    input.sessionId,
  )
  const { session } = context
  const persistence =
    dependencies.persistence ??
    mongoPaidInterviewReservationReleasePersistence
  const usage = await persistence.findUsageBySession(
    input.sessionId,
    session,
  )
  if (!usage) {
    throw failure(
      'unavailable',
      'Paid interview reservation usage was not found',
    )
  }
  const snapshot = exactUsage(usage, input)
  const unlock = await persistence.findUnlockById(
    usage.sourceId,
    session,
  )
  if (!unlock) {
    throw failure(
      'state_conflict',
      'Paid interview reservation references a missing unlock',
    )
  }
  exactUnlockTerms(unlock, usage, snapshot, input)
  if (usage.restorationId) {
    if (!usage.restorationId.equals(input.releaseId)) {
      throw failure(
        'state_conflict',
        'Paid interview reservation was released by a different operation',
      )
    }
    return {
      unlockId: unlock.id.toHexString(),
      usageId: usage.id.toHexString(),
      sessionId: input.sessionId.toHexString(),
      releaseId: input.releaseId.toHexString(),
      disposition: 'already_released',
      reused: true,
    }
  }
  if (!dependencies.evidenceProvider) {
    throw failure(
      'evidence_required',
      'No authoritative reservation-release evidence provider is configured',
    )
  }
  const now = observedNow(dependencies.now)
  const evidence = exactEvidence(
    await dependencies.evidenceProvider.load(
      {
        releaseId: input.releaseId,
        userId: input.userId,
        sessionId: input.sessionId,
        providerMode: input.providerMode,
        usageId: usage.id,
        unlockId: unlock.id,
        entitlementSnapshotDigest:
          usage.entitlementSnapshotDigest!,
        verifiedAt: new Date(now),
      },
      context,
    ),
    input,
    usage,
    now,
  )
  exactReservedUnlock(unlock, usage)
  const finalStatus = unlock.validUntil > now
    ? 'available'
    : 'expired'
  let releasedUsage:
    | StoredPaidInterviewReservationUsage
    | null
  try {
    releasedUsage = await persistence.markUsageReleased(
      {
        usageId: usage.id,
        sessionId: input.sessionId,
        userId: input.userId,
        unlockId: unlock.id,
        entitlementSnapshotDigest:
          usage.entitlementSnapshotDigest!,
        releaseId: input.releaseId,
      },
      session,
    )
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      throw failure(
        'state_conflict',
        'Reservation release marker is already bound to another usage',
        error,
      )
    }
    throw error
  }
  if (
    !releasedUsage ||
    !releasedUsage.restorationId?.equals(input.releaseId) ||
    releasedUsage.consumedAt !== undefined
  ) {
    throw failure(
      'persistence_conflict',
      'Paid interview usage release raced with another mutation',
    )
  }
  const releasedUnlock =
    await persistence.releaseReservedUnlock(
      {
        unlockId: unlock.id,
        sessionId: input.sessionId,
        userId: input.userId,
        providerMode: input.providerMode,
        reservedAt: usage.reservedAt,
        releasedAt: now,
        reason: evidence.reason,
        finalStatus,
      },
      session,
    )
  if (
    !releasedUnlock ||
    releasedUnlock.status !== finalStatus ||
    releasedUnlock.reservedSessionId !== undefined ||
    releasedUnlock.consumedSessionId !== undefined ||
    releasedUnlock.reservedAt !== undefined ||
    releasedUnlock.consumedAt !== undefined ||
    !sameDate(releasedUnlock.restoredAt, now) ||
    releasedUnlock.restoreReason !== evidence.reason
  ) {
    throw failure(
      'persistence_conflict',
      'Paid interview unlock release did not persist exact evidence',
    )
  }
  return {
    unlockId: unlock.id.toHexString(),
    usageId: usage.id.toHexString(),
    sessionId: input.sessionId.toHexString(),
    releaseId: input.releaseId.toHexString(),
    disposition: finalStatus,
    reused: false,
  }
}

export async function releasePaidInterviewReservation(
  rawInput: ReleasePaidInterviewReservationInput,
  dependencies:
    PaidInterviewReservationReleaseDependencies = {},
): Promise<PaidInterviewReservationReleaseResult> {
  assertReady(dependencies)
  const input = normalizeReleaseInput(rawInput)
  const transactionStore =
    dependencies.transactionStore ??
    mongoPaidInterviewReservationReleaseTransactionStore
  return transactionStore.withClaimedSessionTransaction(
    {
      userId: input.userId,
      sessionId: input.sessionId,
    },
    (context) =>
      releasePaidInterviewReservationInSession(
        {
          userId: input.userId.toHexString(),
          sessionId: input.sessionId.toHexString(),
          providerMode: input.providerMode,
          releaseId: input.releaseId.toHexString(),
        },
        context,
        {
          ...dependencies,
          evidenceProvider:
            dependencies.evidenceProvider ??
            mongoPaidInterviewReservationReleaseEvidenceProvider,
        },
      ),
  )
}

export async function expirePaidInterviewReservationInSession(
  rawInput: ExpirePaidInterviewReservationInput,
  context: ClaimedPaidInterviewSessionTransaction,
  dependencies:
    PaidInterviewReservationExpiryDependencies = {},
): Promise<PaidInterviewReservationExpiryCandidateResult> {
  assertReady(dependencies)
  const input = normalizeExpiryCandidateInput(rawInput)
  assertClaimedSessionTransaction(
    context,
    input.userId,
    input.sessionId,
  )
  const now = observedNow(dependencies.now)
  const persistence =
    dependencies.persistence ??
    mongoPaidInterviewReservationReleasePersistence
  const usage = await persistence.findUsageBySession(
    input.sessionId,
    context.session,
  )
  if (!usage) {
    throw failure(
      'unavailable',
      'Expired reservation candidate has no durable usage',
    )
  }
  const snapshot = exactUsage(usage, input)
  const unlock = await persistence.findUnlockById(
    input.unlockId,
    context.session,
  )
  if (!unlock) {
    throw failure(
      'unavailable',
      'Expired reservation candidate unlock was not found',
    )
  }
  exactUnlockTerms(unlock, usage, snapshot, input)
  const releaseId = expiryReleaseId(usage, unlock)
  if (usage.restorationId) {
    if (!usage.restorationId.equals(releaseId)) {
      throw failure(
        'state_conflict',
        'Expired reservation usage has a different release marker',
      )
    }
    exactExpiredUnlock(unlock)
    return {
      unlockId: unlock.id.toHexString(),
      usageId: usage.id.toHexString(),
      sessionId: usage.sessionId.toHexString(),
      releaseId: releaseId.toHexString(),
      disposition: 'already_expired',
      reused: true,
    }
  }
  exactReservedUnlock(unlock, usage)
  if (unlock.validUntil > now) {
    throw failure(
      'state_conflict',
      'Reservation expiry candidate is still valid',
    )
  }
  let releasedUsage:
    | StoredPaidInterviewReservationUsage
    | null
  try {
    releasedUsage = await persistence.markUsageReleased(
      {
        usageId: usage.id,
        sessionId: usage.sessionId,
        userId: input.userId,
        unlockId: unlock.id,
        entitlementSnapshotDigest:
          usage.entitlementSnapshotDigest!,
        releaseId,
      },
      context.session,
    )
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      throw failure(
        'state_conflict',
        'Reservation expiry marker is already bound to another usage',
        error,
      )
    }
    throw error
  }
  if (
    !releasedUsage ||
    !releasedUsage.restorationId?.equals(releaseId) ||
    releasedUsage.consumedAt !== undefined
  ) {
    throw failure(
      'persistence_conflict',
      'Reservation expiry usage marker raced with another mutation',
    )
  }
  const expiredUnlock =
    await persistence.expireReservedUnlock(
      {
        unlockId: unlock.id,
        sessionId: usage.sessionId,
        userId: input.userId,
        providerMode: input.providerMode,
        reservedAt: usage.reservedAt,
        now,
      },
      context.session,
    )
  if (!expiredUnlock) {
    throw failure(
      'persistence_conflict',
      'Reservation expiry raced after its ledger marker',
    )
  }
  exactExpiredUnlock(expiredUnlock)
  return {
    unlockId: unlock.id.toHexString(),
    usageId: usage.id.toHexString(),
    sessionId: usage.sessionId.toHexString(),
    releaseId: releaseId.toHexString(),
    disposition: 'expired',
    reused: false,
  }
}

export async function expirePaidInterviewReservations(
  rawInput: ExpirePaidInterviewReservationsInput,
  dependencies:
    PaidInterviewReservationExpiryDependencies = {},
): Promise<PaidInterviewReservationExpiryResult> {
  assertReady(dependencies)
  const input = normalizeExpiryInput(rawInput)
  const now = observedNow(dependencies.now)
  const persistence =
    dependencies.persistence ??
    mongoPaidInterviewReservationReleasePersistence
  const batchStore =
    dependencies.batchStore ??
    mongoPaidInterviewReservationExpiryBatchStore
  const candidates =
    await batchStore.findExpiredReservedUnlocks({
      userId: input.userId,
      providerMode: input.providerMode,
      now,
      limit:
        MAX_PAID_INTERVIEW_RESERVATION_EXPIRY_BATCH,
    })
  if (
    candidates.length >
    MAX_PAID_INTERVIEW_RESERVATION_EXPIRY_BATCH
  ) {
    throw failure(
      'persistence_conflict',
      'Reservation expiry store exceeded its batch bound',
    )
  }

  const expiredUsageIds: string[] = []
  const skippedUnlockIds: string[] = []
  let replayedCount = 0
  for (const candidate of candidates) {
    if (!candidate.reservedSessionId) {
      skippedUnlockIds.push(candidate.id.toHexString())
      continue
    }
    try {
      const result =
        await batchStore.withClaimedSessionTransaction(
          {
            userId: input.userId,
            sessionId: candidate.reservedSessionId,
          },
          (context) =>
            expirePaidInterviewReservationInSession(
              {
                userId: input.userId.toHexString(),
                sessionId:
                  candidate.reservedSessionId!.toHexString(),
                unlockId: candidate.id.toHexString(),
                providerMode: input.providerMode,
              },
              context,
              {
                allowWhenReadinessDisabledForTests:
                  dependencies
                    .allowWhenReadinessDisabledForTests,
                persistence,
                now: () => new Date(now),
              },
            ),
        )
      if (result.reused) {
        replayedCount += 1
      } else {
        expiredUsageIds.push(result.usageId)
      }
    } catch (error) {
      if (!skippableExpiryCandidateFailure(error)) {
        throw error
      }
      skippedUnlockIds.push(candidate.id.toHexString())
    }
  }

  return {
    expiredCount: expiredUsageIds.length,
    replayedCount,
    skippedCount: skippedUnlockIds.length,
    attemptedCount: candidates.length,
    batchLimit:
      MAX_PAID_INTERVIEW_RESERVATION_EXPIRY_BATCH,
    mayHaveMore:
      candidates.length ===
        MAX_PAID_INTERVIEW_RESERVATION_EXPIRY_BATCH ||
      skippedUnlockIds.length > 0,
    expiredUsageIds,
    skippedUnlockIds,
  }
}
