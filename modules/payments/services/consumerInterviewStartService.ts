import { createHash } from 'node:crypto'
import mongoose, { type ClientSession } from 'mongoose'
import { connectDB } from '@shared/db/connection'
import { withSessionPersonalDataWriteTransaction } from '@shared/services/accountDeletion'
import { PR8_INTERVIEW_ENTITLEMENT_ENFORCEMENT_READY } from '@shared/services/pr8InterviewRollout'
import {
  INTERVIEW_AUTHORITY_DIGEST_DOMAINS,
  digestInterviewAuthority,
} from '@shared/services/interviewAuthorityDigest'
import type { InterviewUsageSource } from '../models/InterviewUsage'
import type { StoredPaidInterviewUnlock } from './interviewUnlockService'
import {
  InterviewUnlockError,
  consumePaidInterviewUnlockInSession,
  mongoInterviewUnlockPersistence,
  type SingleInterviewConsumedAnalyticsProducer,
} from './interviewUnlockService'
import {
  AUTHORITATIVE_INTERVIEW_RESTORE_GRACE_MS,
  AuthoritativeInterviewRuntimeError,
  digestAuthoritativeInterviewConfig,
  digestOpaqueInterviewRuntimeSnapshot,
  establishAuthoritativeInterviewRuntimeInSession,
  mongoAuthoritativeInterviewRuntimeCreationStore,
  normalizeAuthoritativeInterviewConfig,
  type AuthoritativeInterviewConfig,
  type ClaimAuthoritativeInterviewOperationResult,
  type RuntimeAuthorityRecord,
  type RuntimeSessionRecord,
  type RuntimeUsageRecord,
} from './authoritativeInterviewRuntimeService'
import type { ProviderMode } from '../types/catalog'
const OBJECT_ID_PATTERN = /^[a-f0-9]{24}$/
const SHA256_PATTERN = /^[a-f0-9]{64}$/
const CONSUMER_SOURCES = new Set<InterviewUsageSource>([
  'free_period',
  'subscription_cycle',
  'subscription_grace',
  'paid_interview',
  'admin',
])
export type ConsumerInterviewStartErrorCode =
  | 'not_ready'
  | 'invalid_request'
  | 'not_found_or_ineligible'
  | 'authority_conflict'
  | 'persistence_conflict'
  | 'persistence_unavailable'
export class ConsumerInterviewStartError extends Error {
  constructor(
    readonly code: ConsumerInterviewStartErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'ConsumerInterviewStartError'
  }
}
export interface ConsumerInterviewStartInput {
  userId: unknown
  sessionId: unknown
}
export interface ConsumerInterviewStartResult {
  sessionId: string
  status: 'in_progress'
  config: AuthoritativeInterviewConfig
}
export interface ConsumerInterviewStartEvidence {
  session: RuntimeSessionRecord
  runtime: RuntimeAuthorityRecord | null
  usage: RuntimeUsageRecord | null
  paidUnlock: StoredPaidInterviewUnlock | null
}
export interface ConsumerInterviewStartStore {
  load(input: {
    session: ClientSession
    userId: mongoose.Types.ObjectId
    sessionId: mongoose.Types.ObjectId
  }): Promise<ConsumerInterviewStartEvidence | null>
}
export interface ConsumerInterviewStartTransactionRunner {
  run<T>(
    input: { userId: string; sessionId: string },
    work: (
      session: ClientSession,
      userId: mongoose.Types.ObjectId,
      sessionId: mongoose.Types.ObjectId,
    ) => Promise<T>,
  ): Promise<T>
}
export interface FirstPaidInterviewStartedAnalyticsProducer {
  appendFirstPaidInterviewStartedInSession(
    evidenceFactory: () => {
      readonly subjectId: string
      readonly authority: ExactConsumerAuthority
    },
    session: ClientSession,
  ): Promise<void>
}
export interface SubscriptionGraceInterviewConsumptionPort {
  consume(
    input: {
      readonly userId: string
      readonly sessionId: string
      readonly usageId: string
      readonly providerMode: ProviderMode
      readonly occurredAt: Date
      readonly authority: Readonly<{
        sourceId: string
        periodKey: string
        entitlementSnapshotDigest: string
        entitlementSnapshot: unknown
      }>
    },
    session: ClientSession,
  ): Promise<{
    readonly caseId: string
    readonly grantId: string
    readonly state: 'consumed'
    readonly reservedSessionId: string
    readonly usageReferenceId: string
    readonly consumedAt: Date
  }>
}
type ConsumePaidUnlock = typeof consumePaidInterviewUnlockInSession
type EstablishRuntime = typeof establishAuthoritativeInterviewRuntimeInSession
export interface ConsumerInterviewStartDependencies {
  ready?: boolean
  runtimeWritesReady?: boolean
  now?: () => Date
  store?: ConsumerInterviewStartStore
  transactionRunner?: ConsumerInterviewStartTransactionRunner
  consumePaidUnlock?: ConsumePaidUnlock
  establishRuntime?: EstablishRuntime
  commercialAnalyticsProducer?: SingleInterviewConsumedAnalyticsProducer
  firstPaidInterviewAnalyticsProducer?:
    FirstPaidInterviewStartedAnalyticsProducer
  subscriptionGraceConsumptionPort?:
    SubscriptionGraceInterviewConsumptionPort
}
export interface ExactConsumerAuthority {
  config: AuthoritativeInterviewConfig
  runtimeId: string
  plannedMainQuestionCount: number
  source: InterviewUsageSource
  sourceId: string
  usageId: string
  entitlementSnapshotDigest: string
  periodKey?: string
  providerMode?: ProviderMode
  startedAt?: Date
  consumedAt?: Date
  subscriptionGraceCaseId?: string
  entitlementSnapshot: unknown
  checkoutIntentId?: string
}
function failure(
  code: ConsumerInterviewStartErrorCode,
  message: string,
  cause?: unknown,
): ConsumerInterviewStartError {
  return new ConsumerInterviewStartError(
    code,
    message,
    cause === undefined ? undefined : { cause },
  )
}
function exactObjectId(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    !OBJECT_ID_PATTERN.test(value)
  ) {
    throw failure(
      'invalid_request',
      `${label} must be an exact canonical ObjectId`,
    )
  }
  return value
}
function exactDate(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime())
}
function sameDate(left: Date | undefined, right: Date | undefined): boolean {
  return left?.getTime() === right?.getTime()
}
function observedNow(provider: (() => Date) | undefined): Date {
  const value = (provider ?? (() => new Date()))()
  if (!exactDate(value)) {
    throw failure('invalid_request', 'Current time is invalid')
  }
  return new Date(value)
}
function deterministicUuid(namespace: string): string {
  const bytes = Buffer.from(
    createHash('sha256').update(namespace).digest().subarray(0, 16),
  )
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-')
}
function sessionStartIdentity(input: {
  userId: string
  sessionId: string
}): { operationId: string; requestDigest: string } {
  return {
    operationId: deterministicUuid(
      `pr8:consumer-session-start:v1:${input.userId}:${input.sessionId}`,
    ),
    requestDigest: digestInterviewAuthority(
      INTERVIEW_AUTHORITY_DIGEST_DOMAINS
        .sessionStartRequest,
      {
        schemaVersion: 1,
        source: 'consumer',
        userId: input.userId,
        sessionId: input.sessionId,
      },
    ),
  }
}
function exactSnapshotDigest(usage: RuntimeUsageRecord): string {
  let calculated: string
  try {
    calculated = digestOpaqueInterviewRuntimeSnapshot(
      usage.entitlementSnapshot,
    )
  } catch (error) {
    throw failure(
      'authority_conflict',
      'Interview usage snapshot is invalid',
      error,
    )
  }
  if (
    !usage.entitlementSnapshotDigest ||
    !SHA256_PATTERN.test(usage.entitlementSnapshotDigest) ||
    usage.entitlementSnapshotDigest !== calculated
  ) {
    throw failure(
      'authority_conflict',
      'Interview usage snapshot digest is incoherent',
    )
  }
  return calculated
}
function exactPaidUnlock(
  unlock: StoredPaidInterviewUnlock | null,
  input: {
    userId: string
    sessionId: string
    sourceId: string
    usage: RuntimeUsageRecord
    phase: 'before' | 'after'
    sessionStatus: string
  },
): ProviderMode {
  if (
    !unlock ||
    unlock.id.toHexString() !== input.sourceId ||
    unlock.userId.toHexString() !== input.userId ||
    !['test', 'live'].includes(unlock.providerMode) ||
    unlock.maxDurationMinutes !== 30 ||
    !exactDate(unlock.validUntil) ||
    !exactDate(unlock.createdAt) ||
    unlock.reservedSessionId?.toHexString() !== input.sessionId ||
    !sameDate(unlock.reservedAt, input.usage.reservedAt)
  ) {
    throw failure(
      'authority_conflict',
      'Paid interview unlock linkage is invalid',
    )
  }
  const mustBeConsumed =
    input.phase === 'after' ||
    input.sessionStatus === 'in_progress'
  if (
    mustBeConsumed
      ? (
          unlock.status !== 'consumed' ||
          unlock.consumedSessionId?.toHexString() !== input.sessionId ||
          !exactDate(unlock.consumedAt) ||
          !exactDate(input.usage.consumedAt) ||
          !sameDate(unlock.consumedAt, input.usage.consumedAt)
        )
      : (
          unlock.status !== 'reserved' ||
          unlock.consumedSessionId !== undefined ||
          unlock.consumedAt !== undefined ||
          input.usage.consumedAt !== undefined
        )
  ) {
    throw failure(
      'authority_conflict',
      'Paid interview unlock state is incoherent',
    )
  }
  return unlock.providerMode
}
function exactStartState(
  session: RuntimeSessionRecord,
  runtime: RuntimeAuthorityRecord,
  phase: 'before' | 'after',
): void {
  const mustBeActive =
    phase === 'after' || session.status === 'in_progress'
  if (mustBeActive) {
    if (
      session.status !== 'in_progress' ||
      runtime.state !== 'active' ||
      !exactDate(session.startedAt) ||
      !exactDate(runtime.startedAt) ||
      !sameDate(session.startedAt, runtime.startedAt) ||
      !exactDate(runtime.deadlineAt) ||
      !exactDate(runtime.restoreUntil) ||
      runtime.deadlineAt.getTime() - runtime.startedAt.getTime() !==
        runtime.normalizedDurationMinutes * 60_000 ||
      runtime.restoreUntil.getTime() - runtime.deadlineAt.getTime() !==
        AUTHORITATIVE_INTERVIEW_RESTORE_GRACE_MS ||
      !Number.isInteger(runtime.nextTurnOrdinal) ||
      runtime.nextTurnOrdinal < 1
    ) {
      throw failure(
        'authority_conflict',
        'Established interview runtime state is incoherent',
      )
    }
    return
  }
  if (
    session.status !== 'created' ||
    runtime.state !== 'reserved' ||
    session.startedAt !== undefined ||
    runtime.startedAt !== undefined ||
    runtime.deadlineAt !== undefined ||
    runtime.restoreUntil !== undefined ||
    runtime.runtimeVersion !== 0 ||
    runtime.nextTurnOrdinal !== 0 ||
    runtime.nextMainQuestionOrdinal !== 0 ||
    runtime.mainQuestionReservationOperationId !== undefined
  ) {
    throw failure(
      'authority_conflict',
      'Reserved interview runtime state is incoherent',
    )
  }
}
function exactConsumerAuthority(
  evidence: ConsumerInterviewStartEvidence | null,
  input: {
    userId: string
    sessionId: string
    phase: 'before' | 'after'
  },
): ExactConsumerAuthority {
  if (!evidence) {
    throw failure(
      'not_found_or_ineligible',
      'Owned consumer interview session was not found',
    )
  }
  const { session, runtime, usage, paidUnlock } = evidence
  if (
    session.id !== input.sessionId ||
    session.userId !== input.userId ||
    session.deletionPendingAt !== undefined ||
    session.organizationId !== undefined ||
    session.inviteTokenHash !== undefined ||
    session.inviteProvenance !== undefined
  ) {
    throw failure(
      'not_found_or_ineligible',
      'Interview session is not an eligible owned consumer session',
    )
  }
  if (
    !runtime ||
    !OBJECT_ID_PATTERN.test(runtime.id) ||
    runtime.sessionId !== input.sessionId ||
    runtime.userId !== input.userId ||
    runtime.authorityKind !== 'consumer_usage' ||
    runtime.organizationId !== undefined ||
    runtime.inviteAuthorityId !== undefined ||
    runtime.recruiterUserId !== undefined ||
    runtime.recruiterReferenceErasedAt !== undefined ||
    runtime.inviteVerifiedAt !== undefined ||
    runtime.inviteProvenanceDigest !== undefined ||
    !runtime.usageId ||
    !OBJECT_ID_PATTERN.test(runtime.usageId) ||
    !runtime.entitlementSource ||
    !CONSUMER_SOURCES.has(runtime.entitlementSource) ||
    !runtime.entitlementSourceId ||
    !OBJECT_ID_PATTERN.test(runtime.entitlementSourceId) ||
    !runtime.entitlementSnapshotDigest ||
    !SHA256_PATTERN.test(runtime.entitlementSnapshotDigest)
  ) {
    throw failure(
      'authority_conflict',
      'Consumer interview runtime authority is invalid',
    )
  }
  const config = normalizeAuthoritativeInterviewConfig(session.config)
  if (
    runtime.sessionConfigDigest !==
      digestAuthoritativeInterviewConfig(config) ||
    runtime.normalizedDurationMinutes !== config.duration ||
    !Number.isInteger(runtime.plannedMainQuestionCount) ||
    runtime.plannedMainQuestionCount < 1 ||
    runtime.plannedMainQuestionCount > 500 ||
    session.plannedQuestionCount !==
      runtime.plannedMainQuestionCount
  ) {
    throw failure(
      'authority_conflict',
      'Consumer interview configuration linkage is invalid',
    )
  }
  exactStartState(session, runtime, input.phase)
  if (
    !usage ||
    usage.id !== runtime.usageId ||
    usage.sessionId !== input.sessionId ||
    usage.userId !== input.userId ||
    usage.source !== runtime.entitlementSource ||
    usage.sourceId !== runtime.entitlementSourceId ||
    usage.periodKey !== runtime.periodKey ||
    usage.normalizedDurationMinutes !== config.duration ||
    !exactDate(usage.reservedAt) ||
    usage.restorationId !== undefined
  ) {
    throw failure(
      'authority_conflict',
      'Consumer interview usage linkage is invalid',
    )
  }
  const snapshotDigest = exactSnapshotDigest(usage)
  if (runtime.entitlementSnapshotDigest !== snapshotDigest) {
    throw failure(
      'authority_conflict',
      'Runtime and usage snapshot digests disagree',
    )
  }
  const source = usage.source as ExactConsumerAuthority['source']
  const record = (
    usage.entitlementSnapshot !== null &&
    typeof usage.entitlementSnapshot === 'object' &&
    !Array.isArray(usage.entitlementSnapshot)
  ) ? usage.entitlementSnapshot as Record<string, unknown> : null
  const authority = {
    config,
    runtimeId: runtime.id,
    plannedMainQuestionCount: runtime.plannedMainQuestionCount,
    source,
    sourceId: usage.sourceId,
    usageId: usage.id,
    entitlementSnapshotDigest: snapshotDigest,
    entitlementSnapshot: usage.entitlementSnapshot,
    ...(runtime.startedAt ? { startedAt: new Date(runtime.startedAt) } : {}),
  }
  if (source === 'paid_interview') {
    if (usage.periodKey !== undefined) {
      throw failure(
        'authority_conflict',
        'Paid interview usage cannot carry a period key',
      )
    }
    const providerMode = exactPaidUnlock(paidUnlock, {
      userId: input.userId, sessionId: input.sessionId,
      sourceId: usage.sourceId, usage, phase: input.phase,
      sessionStatus: session.status,
    })
    if (record?.providerMode !== providerMode) {
      throw failure(
        'authority_conflict',
        'Paid interview snapshot provider mode is invalid',
      )
    }
    return { ...authority, providerMode,
      checkoutIntentId: paidUnlock!.checkoutIntentId.toHexString() }
  }
  if (source === 'subscription_grace') {
    const mustBeConsumed =
      input.phase === 'after' || session.status === 'in_progress'
    if (
      paidUnlock !== null ||
      !record ||
      record.schemaVersion !== 2 ||
      record.policyVersion !==
        'pr8-interview-entitlement-decision-v2' ||
      record.source !== 'subscription_grace' ||
      record.sourceId !== usage.sourceId ||
      record.grantId !== usage.sourceId ||
      typeof record.caseId !== 'string' ||
      !OBJECT_ID_PATTERN.test(record.caseId) ||
      record.entitlementSource !== 'subscription_grace' ||
      record.userId !== input.userId ||
      record.periodKey !== usage.periodKey ||
      record.normalizedDurationMinutes !== config.duration ||
      record.maxDurationMinutes !== 30 ||
      (
        record.providerMode !== 'test' &&
        record.providerMode !== 'live'
      ) ||
      !usage.periodKey ||
      (
        mustBeConsumed
          ? (
              !exactDate(usage.consumedAt) ||
              usage.consumedAt < usage.reservedAt
            )
          : usage.consumedAt !== undefined
      )
    ) {
      throw failure(
        'authority_conflict',
        'Subscription grace interview usage is incoherent',
      )
    }
    return {
      ...authority,
      periodKey: usage.periodKey,
      providerMode: record.providerMode,
      subscriptionGraceCaseId: record.caseId,
      ...(usage.consumedAt
        ? { consumedAt: new Date(usage.consumedAt) }
        : {}),
    }
  }
  if (source === 'admin') {
    const periodOwned =
      record?.adminGrantKind === 'comp_period'
    if (
      paidUnlock !== null ||
      !record ||
      record.schemaVersion !== 2 ||
      record.source !== 'admin' ||
      record.sourceId !== usage.sourceId ||
      record.entitlementSource !== 'admin_grant' ||
      (
        record.providerMode !== 'test' &&
        record.providerMode !== 'live'
      ) ||
      (
        record.adminGrantKind !== 'interview' &&
        !periodOwned
      ) ||
      periodOwned !== (usage.periodKey !== undefined) ||
      (
        periodOwned &&
        record.periodKey !== usage.periodKey
      ) ||
      !exactDate(usage.consumedAt) ||
      !sameDate(usage.consumedAt, usage.reservedAt)
    ) {
      throw failure(
        'authority_conflict',
        'Admin interview usage state is incoherent',
      )
    }
    return { ...authority, providerMode: record.providerMode,
      ...(usage.periodKey ? { periodKey: usage.periodKey } : {}) }
  }
  if (
    paidUnlock !== null ||
    !usage.periodKey ||
    (
      source === 'subscription_cycle' &&
      record?.providerMode !== 'test' &&
      record?.providerMode !== 'live'
    ) ||
    !exactDate(usage.consumedAt) ||
    !sameDate(usage.consumedAt, usage.reservedAt)
  ) {
    throw failure(
      'authority_conflict',
      'Included interview usage state is incoherent',
    )
  }
  return { ...authority, periodKey: usage.periodKey,
    ...(source === 'subscription_cycle' ? {
      providerMode: record!.providerMode as ProviderMode,
    } : {}) }
}
function exactEstablishedResult(
  result: ClaimAuthoritativeInterviewOperationResult,
  input: {
    operationId: string
    authority: ExactConsumerAuthority
  },
): void {
  const { config } = input.authority
  if (
    result.state !== 'completed' ||
    result.operationId !== input.operationId ||
    result.operationKind !== 'session_start' ||
    result.runtime.id !== input.authority.runtimeId ||
    result.runtime.authorityKind !== 'consumer_usage' ||
    result.runtime.state !== 'active' ||
    result.runtime.normalizedDurationMinutes !== config.duration ||
    result.runtime.plannedMainQuestionCount !==
      input.authority.plannedMainQuestionCount ||
    !exactDate(result.runtime.startedAt) ||
    result.runtime.periodKey !== input.authority.periodKey ||
    result.authoritativeConfig.role !== config.role ||
    result.authoritativeConfig.interviewType !== config.interviewType ||
    result.authoritativeConfig.experience !== config.experience ||
    result.authoritativeConfig.duration !== config.duration
  ) {
    throw failure(
      'persistence_conflict',
      'Authoritative interview start postcondition failed',
    )
  }
}
const mongoConsumerInterviewStartStore: ConsumerInterviewStartStore = {
  async load(input) {
    const session =
      await mongoAuthoritativeInterviewRuntimeCreationStore.loadSession(input)
    if (!session) return null
    const runtime =
      await mongoAuthoritativeInterviewRuntimeCreationStore.loadRuntime(input)
    if (
      !runtime?.usageId ||
      !OBJECT_ID_PATTERN.test(runtime.usageId)
    ) {
      return {
        session,
        runtime: runtime ?? null,
        usage: null,
        paidUnlock: null,
      }
    }
    const usage =
      await mongoAuthoritativeInterviewRuntimeCreationStore.loadUsage({
        ...input,
        usageId: new mongoose.Types.ObjectId(runtime.usageId),
      })
    let paidUnlock: StoredPaidInterviewUnlock | null = null
    if (
      usage?.source === 'paid_interview' &&
      OBJECT_ID_PATTERN.test(usage.sourceId)
    ) {
      paidUnlock = await mongoInterviewUnlockPersistence.findUnlockById(
        new mongoose.Types.ObjectId(usage.sourceId),
        input.session,
      )
    }
    return { session, runtime, usage, paidUnlock }
  },
}
const defaultTransactionRunner: ConsumerInterviewStartTransactionRunner = {
  async run(input, work) {
    await connectDB()
    return withSessionPersonalDataWriteTransaction(
      input.userId,
      input.sessionId,
      work,
    )
  },
}
function translateFailure(error: unknown): never {
  if (error instanceof ConsumerInterviewStartError) throw error
  if (error instanceof AuthoritativeInterviewRuntimeError) {
    if (error.code === 'not_ready') {
      throw failure('not_ready', 'Authoritative interview start is not ready')
    }
    if (error.code === 'session_not_found') {
      throw failure(
        'not_found_or_ineligible',
        'Owned consumer interview session was not found',
        error,
      )
    }
    throw failure(
      error.code.includes('persistence') ||
        error.code === 'runtime_conflict'
        ? 'persistence_conflict'
        : 'authority_conflict',
      'Authoritative interview runtime rejected the start',
      error,
    )
  }
  if (error instanceof InterviewUnlockError) {
    throw failure(
      error.code === 'persistence_conflict'
        ? 'persistence_conflict'
        : 'authority_conflict',
      'Paid interview unlock rejected the start',
      error,
    )
  }
  throw failure(
    'persistence_unavailable',
    'Consumer interview start could not be persisted',
    error,
  )
}

export async function startConsumerInterviewSession(
  input: ConsumerInterviewStartInput,
  dependencies: ConsumerInterviewStartDependencies = {},
): Promise<ConsumerInterviewStartResult> {
  const hasTestOverrides = Object.entries(dependencies).some(
    ([key, value]) =>
      key !== 'commercialAnalyticsProducer' &&
      key !== 'firstPaidInterviewAnalyticsProducer' &&
      key !== 'subscriptionGraceConsumptionPort' &&
      value !== undefined,
  )
  if (hasTestOverrides && process.env.NODE_ENV !== 'test') {
    throw failure(
      'invalid_request',
      'Consumer interview start overrides are test-only',
    )
  }
  if (
    (dependencies.ready ??
      PR8_INTERVIEW_ENTITLEMENT_ENFORCEMENT_READY) !== true
  ) {
    throw failure(
      'not_ready',
      'Authoritative consumer interview start is not ready',
    )
  }

  const userId = exactObjectId(input.userId, 'userId')
  const sessionId = exactObjectId(input.sessionId, 'sessionId')
  const now = observedNow(dependencies.now)
  const identity = sessionStartIdentity({ userId, sessionId })
  const store = dependencies.store ?? mongoConsumerInterviewStartStore
  const runner =
    dependencies.transactionRunner ?? defaultTransactionRunner
  const consumePaidUnlock =
    dependencies.consumePaidUnlock ??
    consumePaidInterviewUnlockInSession
  const establishRuntime =
    dependencies.establishRuntime ??
    establishAuthoritativeInterviewRuntimeInSession

  try {
    return await runner.run(
      { userId, sessionId },
      async (session, claimedUserId, claimedSessionId) => {
        if (
          claimedUserId.toHexString() !== userId ||
          claimedSessionId.toHexString() !== sessionId ||
          typeof session.inTransaction !== 'function' ||
          session.inTransaction() !== true
        ) {
          throw failure(
            'persistence_conflict',
            'Consumer interview start transaction claim is invalid',
          )
        }
        const before = exactConsumerAuthority(
          await store.load({
            session,
            userId: claimedUserId,
            sessionId: claimedSessionId,
          }),
          { userId, sessionId, phase: 'before' },
        )

        if (before.source === 'paid_interview') {
          const consumed = await consumePaidUnlock(
            {
              userId,
              sessionId,
              providerMode: before.providerMode!,
              normalizedDurationMinutes: before.config.duration,
            },
            session,
            claimedUserId,
            {
              now: () => new Date(now),
              commercialAnalyticsProducer:
                dependencies.commercialAnalyticsProducer,
            },
          )
          if (
            consumed.state !== 'consumed' ||
            consumed.sessionId !== sessionId ||
            consumed.usageId !== before.usageId ||
            consumed.unlockId !== before.sourceId ||
            !exactDate(consumed.consumedAt)
          ) {
            throw failure(
              'persistence_conflict',
              'Paid interview consumption postcondition failed',
            )
          }
        } else if (
          before.source === 'subscription_grace' &&
          before.consumedAt === undefined
        ) {
          if (
            !before.providerMode ||
            !before.periodKey ||
            !dependencies.subscriptionGraceConsumptionPort
          ) {
            throw failure(
              'not_ready',
              'Subscription grace interview consumption is not ready',
            )
          }
          const consumed =
            await dependencies.subscriptionGraceConsumptionPort.consume({
              userId,
              sessionId,
              usageId: before.usageId,
              providerMode: before.providerMode,
              occurredAt: new Date(now),
              authority: {
                sourceId: before.sourceId,
                periodKey: before.periodKey,
                entitlementSnapshotDigest:
                  before.entitlementSnapshotDigest,
                entitlementSnapshot:
                  before.entitlementSnapshot,
              },
            }, session)
          const expectedConsumedAt =
            before.consumedAt ?? now
          if (
            consumed.caseId !== before.subscriptionGraceCaseId ||
            consumed.grantId !== before.sourceId ||
            consumed.state !== 'consumed' ||
            consumed.reservedSessionId !== sessionId ||
            consumed.usageReferenceId !== before.usageId ||
            !exactDate(consumed.consumedAt) ||
            consumed.consumedAt.getTime() !==
              expectedConsumedAt.getTime()
          ) {
            throw failure(
              'persistence_conflict',
              'Subscription grace consumption postcondition failed',
            )
          }
        }

        const established = await establishRuntime(
          {
            userId,
            sessionId,
            operationId: identity.operationId,
            requestDigest: identity.requestDigest,
          },
          {
            session,
            claimedUserId,
            claimedSessionId,
          },
          {
            now: () => new Date(now),
            writesReady: dependencies.runtimeWritesReady,
          },
        )
        exactEstablishedResult(established, {
          operationId: identity.operationId,
          authority: before,
        })

        const after = exactConsumerAuthority(
          await store.load({
            session,
            userId: claimedUserId,
            sessionId: claimedSessionId,
          }),
          { userId, sessionId, phase: 'after' },
        )
        if (
          after.source !== before.source ||
          after.runtimeId !== before.runtimeId ||
          after.plannedMainQuestionCount !==
            before.plannedMainQuestionCount ||
          after.sourceId !== before.sourceId ||
          after.usageId !== before.usageId ||
          after.entitlementSnapshotDigest !==
            before.entitlementSnapshotDigest ||
          after.subscriptionGraceCaseId !==
            before.subscriptionGraceCaseId ||
          after.periodKey !== before.periodKey ||
          after.providerMode !== before.providerMode ||
          after.config.role !== before.config.role ||
          after.config.interviewType !== before.config.interviewType ||
          after.config.experience !== before.config.experience ||
          after.config.duration !== before.config.duration
        ) {
          throw failure(
            'persistence_conflict',
            'Consumer interview authority changed during start',
          )
        }
        if (
          before.source === 'subscription_grace' &&
          !sameDate(after.consumedAt, before.consumedAt ?? now)
        ) {
          throw failure(
            'persistence_conflict',
            'Subscription grace usage consumption was not persisted',
          )
        }

        if (
          before.startedAt === undefined &&
          after.startedAt !== undefined &&
          after.source !== 'free_period'
        ) {
          if (!after.providerMode) {
            throw failure(
              'persistence_conflict',
              'Paid interview provider mode is unavailable',
            )
          }
          await dependencies.firstPaidInterviewAnalyticsProducer
            ?.appendFirstPaidInterviewStartedInSession(() => ({
              subjectId: userId,
              authority: after as ExactConsumerAuthority & {
                providerMode: ProviderMode
                startedAt: Date
              },
            }), session)
        }

        return {
          sessionId,
          status: 'in_progress',
          config: after.config,
        }
      },
    )
  } catch (error) {
    translateFailure(error)
  }
}
