import { createHash } from 'node:crypto'
import mongoose, { type ClientSession } from 'mongoose'
import { connectDB } from '@shared/db/connection'
import { InterviewSession } from '@shared/db/models/InterviewSession'
import { User } from '@shared/db/models/User'
import { withSessionPersonalDataWriteTransaction } from '@shared/services/accountDeletion'
import { PR8_INTERVIEW_ENTITLEMENT_ENFORCEMENT_READY } from '@shared/services/pr8InterviewRollout'
import {
  InterviewRuntime,
  InterviewTurn,
  type InterviewRuntimeState,
} from '../models/InterviewRuntime'
import { AdminEntitlementProjection } from '../models/AdminEntitlementProjection'
import {
  InterviewUsage,
  type InterviewUsageSource,
} from '../models/InterviewUsage'
import { PaidInterviewUnlock } from '../models/PaidInterviewUnlock'
import { SubscriptionCycle } from '../models/SubscriptionCycle'
import { sha256CanonicalJson } from '../lib/canonicalJson'
import {
  commitUserEntitlementProjectionUpdateInSession,
} from './entitlementService'
import { basicCalendarMonthPeriod } from './periodKeyService'
import { restorePaidInterviewUnlockInSession, type AuthoritativeInterviewRestorationEvidence } from './interviewUnlockService'
import { mongoPaidInterviewReservationReleaseEvidenceProvider, releasePaidInterviewReservationInSession, type ClaimedPaidInterviewSessionTransaction } from './paidInterviewReservationReleaseService'
const OBJECT_ID = /^[a-f0-9]{24}$/
const SHA256 = /^[a-f0-9]{64}$/
const RESTORE_GRACE_MS = 60 * 60 * 1000
const RESTORATION_BATCH_SIZE = 25
const CONTENT_KINDS = new Set([
  'present_question', 'generate_question', 'evaluate_answer', 'turn_router',
  'clarify_coding', 'clarify_case_context', 'answer_candidate_question', 'evaluate_code', 'evaluate_design'])
const PLATFORM_FAILURE_CODES = new Set([
  'operation_handler_failed', 'operation_result_invalid', 'provider_reservation_failed', 'provider_timeout', 'model_timeout'])
export type InterviewEntitlementRestorationErrorCode = 'not_ready' |
  'invalid_request' | 'evidence_pending' | 'evidence_denied' |
  'period_mismatch' | 'persistence_conflict'
export class InterviewEntitlementRestorationError extends Error {
  constructor(readonly code: InterviewEntitlementRestorationErrorCode, message: string, options?: ErrorOptions) {
    super(message, options); this.name = 'InterviewEntitlementRestorationError'
  }
}
export interface InterviewEntitlementRestorationResult {
  sessionId: string; usageId: string; source: 'free_period' | 'subscription_cycle' | 'paid_interview' | 'admin';
  restorationId: string; disposition: 'restored' | 'available' | 'expired';
  reused: boolean }
export interface InterviewEntitlementRestorationStepRunner {
  run(name: string, work: () => Promise<unknown> | unknown): Promise<unknown>
}
export interface InterviewEntitlementRestorationRecoveryDependencies {
  allowWhenReadinessDisabledForTests?: boolean
  listCandidates?: () => Promise<
    Array<{ userId: string; sessionId: string }>
  >
  restore?: typeof restoreConsumerInterviewAfterFailedFirstTurn
}
export interface InterviewEntitlementRestorationRecoveryResult {
  disabled: boolean
  inspected: number
  restored: number
  reused: number
  denied: number
}
export const paidRestorationDisposition = (result: string, status: string) => result === 'expired' || status === 'expired' ? 'expired' : 'available'
type Trigger = 'platform_start_failure' | 'failed_first_turn_recovery'
type Context = {
  session: ClientSession; claimedUserId: mongoose.Types.ObjectId; claimedSessionId: mongoose.Types.ObjectId }
type Runner = {
  run<T>(input: { userId: string; sessionId: string },
    work: (context: Context) => Promise<T>): Promise<T>
}
interface Dependencies {
  allowWhenReadinessDisabledForTests?: boolean;
  allowPaidReleaseWhenDisabledForTests?: boolean; now?: () => Date;
  transactionRunner?: Runner; restoreInTransaction?: typeof restoreInTransaction;
  releasePaid?: typeof releasePaidInterviewReservationInSession;
  restorePaid?: typeof restorePaidInterviewUnlockInSession
}
interface SessionRow {
  _id: mongoose.Types.ObjectId; userId: mongoose.Types.ObjectId; status: string; startedAt?: Date; completedAt?: Date;
  endReason?: string; deletionPendingAt?: Date
}
interface RuntimeRow {
  _id: mongoose.Types.ObjectId; sessionId: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId; authorityKind: string;
  state: InterviewRuntimeState;
  usageId?: mongoose.Types.ObjectId; entitlementSource?: string;
  entitlementSourceId?: mongoose.Types.ObjectId; periodKey?: string;
  entitlementSnapshotDigest?: string;
  startedAt?: Date; deadlineAt?: Date; restoreUntil?: Date; terminalAt?: Date;
  runtimeVersion: number; nextTurnOrdinal: number; nextMainQuestionOrdinal: number;
  mainQuestionReservationOperationId?: string;
  firstTurnRecordedAt?: Date; firstTurnOperationId?: string;
  firstTurnId?: mongoose.Types.ObjectId;
  restorationRecoveryReviewedAt?: Date;
  restorationRecoveryReviewCode?: 'evidence_denied' | 'period_mismatch'
}
interface UsageRow {
  _id: mongoose.Types.ObjectId; sessionId: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId; source: InterviewUsageSource;
  sourceId: mongoose.Types.ObjectId;
  periodKey?: string;
  reservedAt: Date; consumedAt?: Date; restorationId?: mongoose.Types.ObjectId;
  restorationDisposition?: 'restored' | 'available' | 'expired'
  entitlementSnapshot: unknown; entitlementSnapshotDigest?: string
  authorityEnvelope?: unknown
}
interface TurnRow {
  operationKind: string; state: string; failureCode?: string; failedAt?: Date
}
type Authority = {
  interview: SessionRow; runtime: RuntimeRow; usage: UsageRow; reason: AuthoritativeInterviewRestorationEvidence['reason']
}
function fail(
  code: InterviewEntitlementRestorationErrorCode, message: string,
  cause?: unknown,
) {
  return new InterviewEntitlementRestorationError(code, message,
    cause === undefined ? undefined : { cause })
}
function exactDate(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime()) }
function exactObjectId(value: unknown, label: string) {
  if (typeof value !== 'string' || !OBJECT_ID.test(value))
    throw fail('invalid_request', `${label} is invalid`)
  return new mongoose.Types.ObjectId(value) }
function observedNow(provider?: () => Date) {
  const now = (provider ?? (() => new Date()))()
  if (!exactDate(now)) throw fail('invalid_request', 'Clock is invalid')
  return new Date(now) }
function markerFor(usageId: mongoose.Types.ObjectId) {
  return new mongoose.Types.ObjectId(createHash('sha256')
    .update(`pr8-interview-entitlement-restoration:v1:${usageId.toHexString()}`)
    .digest('hex').slice(0, 24)) }
function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null }
function exactRecoveryCounts(
  value: unknown,
): Pick<InterviewEntitlementRestorationRecoveryResult,
  'restored' | 'reused' | 'denied'> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Restoration step returned invalid counts')
  const row = value as Record<string, unknown>
  if (Object.keys(row).sort().join(',') !== 'denied,restored,reused')
    throw new Error('Restoration step returned unexpected count fields')
  const counts = [row.restored, row.reused, row.denied]
  if (counts.some((count) => !Number.isSafeInteger(count) ||
      (count as number) < 0 || (count as number) > RESTORATION_BATCH_SIZE) ||
      (counts as number[]).reduce((sum, count) => sum + count, 0) >
        RESTORATION_BATCH_SIZE)
    throw new Error('Restoration step returned out-of-range counts')
  return row as Pick<InterviewEntitlementRestorationRecoveryResult,
    'restored' | 'reused' | 'denied'>
}
export function classifyInterviewEntitlementRestorationEvidence(
  rows: {
    sessions: SessionRow[]; runtimes: RuntimeRow[]
    usages: UsageRow[]; turns: TurnRow[]
  },
  input: {
    userId: mongoose.Types.ObjectId; sessionId: mongoose.Types.ObjectId
    trigger: Trigger; now: Date
  },
): Authority {
  if (rows.sessions.length !== 1 || rows.runtimes.length !== 1 ||
      rows.usages.length !== 1 || rows.turns.length >= 65) {
    throw fail('evidence_denied', 'Restoration authority is ambiguous')
  }
  const interview = rows.sessions[0]
  const runtime = rows.runtimes[0]
  const usage = rows.usages[0]
  const digest = usage.entitlementSnapshotDigest
  const contentCompleted = rows.turns.some((turn) => CONTENT_KINDS.has(
    turn.operationKind) && turn.state === 'completed')
  const contentClaimed = rows.turns.some((turn) => CONTENT_KINDS.has(
    turn.operationKind) && turn.state === 'claimed')
  const terminalEvidence = rows.turns.some((turn) => [
    'complete_session', 'abandon_session',
  ].includes(turn.operationKind))
  if (!interview._id.equals(input.sessionId) ||
      !interview.userId.equals(input.userId) || interview.deletionPendingAt ||
      !['created', 'in_progress'].includes(interview.status) ||
      interview.completedAt || interview.endReason ||
      !runtime.sessionId.equals(input.sessionId) ||
      !runtime.userId.equals(input.userId) ||
      runtime.authorityKind !== 'consumer_usage' ||
      !runtime.usageId?.equals(usage._id) ||
      runtime.entitlementSource !== usage.source ||
      !runtime.entitlementSourceId?.equals(usage.sourceId) ||
      runtime.periodKey !== usage.periodKey || !digest ||
      !SHA256.test(digest) || runtime.entitlementSnapshotDigest !== digest ||
      sha256CanonicalJson(usage.entitlementSnapshot) !== digest ||
      !usage.sessionId.equals(input.sessionId) ||
      !usage.userId.equals(input.userId) ||
      !['free_period', 'subscription_cycle', 'paid_interview', 'admin']
        .includes(usage.source) ||
      !exactDate(usage.reservedAt) ||
      usage.reservedAt > input.now ||
      (usage.consumedAt !== undefined &&
        (!exactDate(usage.consumedAt) ||
          usage.consumedAt > input.now)) ||
      runtime.firstTurnRecordedAt || runtime.firstTurnOperationId ||
      runtime.firstTurnId || runtime.terminalAt ||
      runtime.restorationRecoveryReviewedAt ||
      runtime.restorationRecoveryReviewCode ||
      contentCompleted || terminalEvidence) {
    throw fail('evidence_denied', 'Restoration evidence is not eligible')
  }
  if (contentClaimed)
    throw fail('evidence_pending', 'Authoritative content work is pending')
  const linkedStart = interview.status === 'in_progress' &&
    ['active', 'expired'].includes(runtime.state) &&
    exactDate(interview.startedAt) && exactDate(runtime.startedAt) &&
    interview.startedAt.getTime() === runtime.startedAt.getTime() &&
    runtime.startedAt <= input.now &&
    usage.reservedAt <= runtime.startedAt &&
    exactDate(runtime.deadlineAt) && exactDate(runtime.restoreUntil) &&
    runtime.deadlineAt >= runtime.startedAt &&
    runtime.restoreUntil.getTime() ===
      runtime.deadlineAt.getTime() + RESTORE_GRACE_MS
  if (input.trigger === 'platform_start_failure') {
    const reserved = interview.status === 'created' &&
      runtime.state === 'reserved' && !interview.startedAt &&
      !runtime.startedAt && !runtime.deadlineAt && !runtime.restoreUntil &&
      runtime.runtimeVersion === 0 && runtime.nextTurnOrdinal === 0 &&
      runtime.nextMainQuestionOrdinal === 0 &&
      !runtime.mainQuestionReservationOperationId
    if (!reserved && !linkedStart) {
      throw fail('evidence_denied', 'Start failure evidence is incoherent')
    }
    return { interview, runtime, usage,
      reason: 'platform_session_initialization_failed' }
  }
  const failed = rows.turns.find((turn) =>
    CONTENT_KINDS.has(turn.operationKind) && turn.state === 'failed' &&
    !!turn.failureCode && PLATFORM_FAILURE_CODES.has(turn.failureCode) &&
    exactDate(turn.failedAt) && turn.failedAt <= input.now)
  if (!linkedStart || runtime.restoreUntil! > input.now || !failed) {
    throw fail('evidence_denied', 'Verified recovery evidence is absent')
  }
  return { interview, runtime, usage,
    reason: ['generate_question', 'present_question'].includes(
      failed.operationKind) ? 'platform_first_turn_generation_failed'
      : 'platform_realtime_connection_failed' }
}
async function restoreIncluded(
  authority: Authority,
  marker: mongoose.Types.ObjectId,
  now: Date,
  session: ClientSession,
): Promise<InterviewEntitlementRestorationResult> {
  const usage = authority.usage
  const snapshot = record(usage.entitlementSnapshot)
  const entitlementSource = usage.source === 'free_period' ? 'free'
    : 'subscription'
  if (!usage.periodKey || !exactDate(usage.consumedAt) ||
      usage.consumedAt.getTime() !== usage.reservedAt.getTime() ||
      snapshot?.userId !== usage.userId.toHexString() ||
      snapshot?.source !== usage.source ||
      snapshot?.sourceId !== usage.sourceId.toHexString() ||
      snapshot?.periodKey !== usage.periodKey ||
      snapshot?.entitlementSource !== entitlementSource) {
    throw fail('evidence_denied', 'Included usage evidence is incoherent')
  }
  const sourceExists = usage.source === 'free_period' ?
    usage.sourceId.equals(usage.userId) &&
      basicCalendarMonthPeriod(now).key === usage.periodKey :
    Boolean(await SubscriptionCycle.exists({
        _id: usage.sourceId,
        userId: usage.userId,
        providerMode: snapshot?.providerMode as 'test' | 'live',
        periodKey: usage.periodKey,
        periodStart: { $lte: now },
        periodEnd: { $gt: now },
        fulfillmentStatus: 'captured',
        projectionDisposition: 'projected',
      }).session(session))
  if (!sourceExists)
    throw fail('evidence_denied', 'Entitlement source is invalid')
  const user = await User.findOne({
    _id: usage.userId,
    buyerState: { $ne: 'deletion_pending' },
    deletionPendingAt: { $exists: false },
    entitlementSource,
    usagePeriodKey: usage.periodKey,
  }).select('interviewsUsed interviewCount entitlementVersion').session(session)
    .lean<{ interviewsUsed: number; interviewCount: number;
      entitlementVersion: number }>()
  if (!user || !Number.isSafeInteger(user.interviewsUsed) ||
      user.interviewsUsed < 1 || !Number.isSafeInteger(user.interviewCount) ||
      user.interviewCount < 1 || !Number.isSafeInteger(user.entitlementVersion) ||
      user.entitlementVersion < 1) {
    throw fail('period_mismatch', 'Current entitlement period does not match')
  }
  const userUpdate =
    await commitUserEntitlementProjectionUpdateInSession(
      'interview_restoration',
      {
        _id: usage.userId,
        buyerState: { $ne: 'deletion_pending' },
        deletionPendingAt: { $exists: false },
        entitlementSource,
        usagePeriodKey: usage.periodKey,
        interviewsUsed: user.interviewsUsed,
        interviewCount: user.interviewCount,
        entitlementVersion: user.entitlementVersion,
      },
      {
        $inc: {
          interviewsUsed: -1,
          interviewCount: -1,
          entitlementVersion: 1,
        },
      },
      session,
    )
  const restored = await InterviewUsage.findOneAndUpdate({
    _id: usage._id,
    sessionId: usage.sessionId,
    userId: usage.userId,
    source: usage.source,
    sourceId: usage.sourceId,
    periodKey: usage.periodKey,
    consumedAt: usage.consumedAt,
    entitlementSnapshotDigest: usage.entitlementSnapshotDigest,
    restorationId: { $exists: false },
  }, { $set: { restorationId: marker } }, {
    session, returnDocument: 'after', runValidators: true,
  }).lean<UsageRow>()
  if (userUpdate.matchedCount !== 1 ||
      !restored?.restorationId?.equals(marker)) {
    throw fail('persistence_conflict', 'Included restoration raced')
  }
  return { sessionId: usage.sessionId.toHexString(),
    usageId: usage._id.toHexString(),
    source: usage.source as 'free_period' | 'subscription_cycle',
    restorationId: marker.toHexString(), disposition: 'restored', reused: false }
}
async function restoreAdmin(
  authority: Authority, marker: mongoose.Types.ObjectId, now: Date,
  session: ClientSession,
): Promise<InterviewEntitlementRestorationResult> {
  const usage = authority.usage
  const snapshot = record(usage.entitlementSnapshot)
  const envelope = record(usage.authorityEnvelope)
  const grantId = snapshot?.grantId
  if (!snapshot || snapshot.schemaVersion !== 2 ||
      snapshot.source !== 'admin' ||
      snapshot.sourceId !== usage.sourceId.toHexString() ||
      snapshot.entitlementSource !== 'admin_grant' ||
      typeof grantId !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(grantId) ||
      !Number.isSafeInteger(snapshot.grantVersion) ||
      Number(snapshot.grantVersion) < 1 ||
      envelope?.version !== 1 || envelope.adminGrantId !== grantId ||
      !exactDate(usage.consumedAt) ||
      usage.consumedAt.getTime() !== usage.reservedAt.getTime()) {
    throw fail('evidence_denied', 'Admin usage evidence is incoherent')
  }
  let disposition: 'restored' | 'available' | 'expired'
  if (snapshot.adminGrantKind === 'comp_period') {
    const epoch = record(snapshot.counterEpoch)
    const usageEpoch = record(envelope.counterEpoch)
    if (!usage.periodKey || snapshot.periodKey !== usage.periodKey ||
        usage.periodKey !== `admin-comp:${grantId}` || !epoch ||
        usageEpoch?.epochId !== epoch.epochId ||
        usageEpoch?.epochNumber !== epoch.epochNumber) {
      throw fail('evidence_denied', 'Admin comp lineage is incoherent')
    }
    const projection = await AdminEntitlementProjection.findOne({
        _id: usage.sourceId, userId: usage.userId, kind: 'comp_period',
        grantId, lifecycleState: 'active', periodKey: usage.periodKey,
        endsAt: { $gt: now },
        $or: [
          { revokeEffectiveAt: { $exists: false } },
          { revokeEffectiveAt: { $gt: now } },
        ],
        'authorityEnvelope.interviewCounterEpoch.epochId': epoch.epochId,
        'authorityEnvelope.interviewCounterEpoch.epochNumber':
          epoch.epochNumber,
      }).select('interviewsUsed').session(session)
        .lean<{ interviewsUsed: number }>()
    const user = await User.findOne({
        _id: usage.userId, buyerState: { $ne: 'deletion_pending' },
        deletionPendingAt: { $exists: false },
        entitlementSource: 'admin_grant', usagePeriodKey: usage.periodKey,
        'entitlementAuthority.adminGrantId': grantId,
        'entitlementAuthority.adminCompPeriodId': usage.sourceId,
        'entitlementAuthority.interviewCounterEpoch.epochId': epoch.epochId,
        'entitlementAuthority.interviewCounterEpoch.epochNumber':
          epoch.epochNumber,
      }).select('interviewsUsed interviewCount entitlementVersion')
        .session(session).lean<{ interviewsUsed: number;
          interviewCount: number; entitlementVersion: number }>()
    if (!projection || !user || projection.interviewsUsed < 1 ||
        projection.interviewsUsed !== user.interviewsUsed ||
        user.interviewCount < 1 || user.entitlementVersion < 1) {
      throw fail('period_mismatch', 'Admin comp period does not match')
    }
    const projected = await AdminEntitlementProjection.updateOne({
        _id: usage.sourceId, userId: usage.userId, kind: 'comp_period',
        grantId, lifecycleState: 'active', periodKey: usage.periodKey,
        endsAt: { $gt: now },
        $or: [
          { revokeEffectiveAt: { $exists: false } },
          { revokeEffectiveAt: { $gt: now } },
        ],
        interviewsUsed: projection.interviewsUsed,
        'authorityEnvelope.interviewCounterEpoch.epochId': epoch.epochId,
        'authorityEnvelope.interviewCounterEpoch.epochNumber':
          epoch.epochNumber,
      }, { $inc: { interviewsUsed: -1 } },
      { session, runValidators: true })
    const projectedUser =
      await commitUserEntitlementProjectionUpdateInSession(
        'interview_restoration',
        {
          _id: usage.userId, buyerState: { $ne: 'deletion_pending' },
          deletionPendingAt: { $exists: false },
          entitlementSource: 'admin_grant',
          usagePeriodKey: usage.periodKey,
          interviewsUsed: user.interviewsUsed,
          interviewCount: user.interviewCount,
          entitlementVersion: user.entitlementVersion,
          'entitlementAuthority.adminGrantId': grantId,
          'entitlementAuthority.adminCompPeriodId': usage.sourceId,
          'entitlementAuthority.interviewCounterEpoch.epochId': epoch.epochId,
          'entitlementAuthority.interviewCounterEpoch.epochNumber':
            epoch.epochNumber,
        },
        {
          $inc: {
            interviewsUsed: -1,
            interviewCount: -1,
            entitlementVersion: 1,
          },
        },
        session,
      )
    if (projected.matchedCount !== 1 || projectedUser.matchedCount !== 1)
      throw fail('persistence_conflict', 'Admin comp restoration raced')
    disposition = 'restored'
  } else if (snapshot.adminGrantKind === 'interview' &&
      usage.periodKey === undefined && envelope.counterEpoch === undefined) {
    const projection = await AdminEntitlementProjection.findOne({
      _id: usage.sourceId, userId: usage.userId, kind: 'interview',
      grantId, grantVersion: snapshot.grantVersion as number,
      interviewState: 'consumed', consumedSessionId: usage.sessionId,
      consumedUsageId: usage._id, consumedAt: usage.consumedAt,
      restorationId: { $exists: false }, restoredAt: { $exists: false },
    }).select('lifecycleState endsAt revokeEffectiveAt').session(session)
      .lean<{ lifecycleState: string; endsAt: Date;
        revokeEffectiveAt?: Date }>()
    if (!projection) throw fail(
      'evidence_denied', 'Admin interview grant is unavailable')
    const restored = await AdminEntitlementProjection.updateOne({
      _id: usage.sourceId, userId: usage.userId, kind: 'interview',
      grantId, grantVersion: snapshot.grantVersion as number,
      interviewState: 'consumed',
      consumedSessionId: usage.sessionId, consumedUsageId: usage._id,
      consumedAt: usage.consumedAt,
      restorationId: { $exists: false }, restoredAt: { $exists: false },
    }, { $set: { interviewState: 'restored', restorationId: marker,
      restoredAt: now } }, { session, runValidators: true })
    const user = await User.updateOne({
      _id: usage.userId, buyerState: { $ne: 'deletion_pending' },
      deletionPendingAt: { $exists: false }, interviewCount: { $gte: 1 },
    }, { $inc: { interviewCount: -1 } },
    { session, runValidators: true })
    if (restored.matchedCount !== 1 || user.matchedCount !== 1)
      throw fail('persistence_conflict', 'Admin interview restoration raced')
    disposition = projection.lifecycleState === 'active' &&
      projection.endsAt > now &&
      (!projection.revokeEffectiveAt || projection.revokeEffectiveAt > now)
      ? 'available' : 'expired'
  } else throw fail('evidence_denied', 'Admin grant kind is invalid')
  const restoredUsage = await InterviewUsage.findOneAndUpdate({
    _id: usage._id, sessionId: usage.sessionId, userId: usage.userId,
    source: 'admin', sourceId: usage.sourceId,
    consumedAt: usage.consumedAt, restorationId: { $exists: false },
    restorationDisposition: { $exists: false },
    entitlementSnapshotDigest: usage.entitlementSnapshotDigest,
    'authorityEnvelope.adminGrantId': grantId,
  }, { $set: {
    restorationId: marker,
    restorationDisposition: disposition,
  } }, {
    session, returnDocument: 'after', runValidators: true,
  }).lean<UsageRow>()
  if (!restoredUsage?.restorationId?.equals(marker))
    throw fail('persistence_conflict', 'Admin usage restoration raced')
  return { sessionId: usage.sessionId.toHexString(),
    usageId: usage._id.toHexString(), source: 'admin',
    restorationId: marker.toHexString(), disposition, reused: false }
}
async function restorePaid(
  authority: Authority,
  marker: mongoose.Types.ObjectId,
  now: Date,
  context: Context,
  dependencies: Dependencies,
): Promise<InterviewEntitlementRestorationResult> {
  const usage = authority.usage
  const unlock = await PaidInterviewUnlock.findOne({
    _id: usage.sourceId, userId: usage.userId,
  }).select('providerMode status').session(context.session).lean<{
    providerMode: 'test' | 'live'
    status: string
  }>()
  if (!unlock) throw fail('evidence_denied', 'Paid unlock is unavailable')
  let result: InterviewEntitlementRestorationResult
  if (!usage.consumedAt) {
    if (unlock.status !== 'reserved' && !usage.restorationId) throw fail(
      'evidence_denied', 'Paid reservation is incoherent')
    if (authority.runtime.state !== 'reserved' ||
        authority.interview.status !== 'created') {
      throw fail('evidence_denied', 'Reserved paid evidence is incoherent')
    }
    const released = await (dependencies.releasePaid ??
      releasePaidInterviewReservationInSession)({
      userId: usage.userId.toHexString(),
      sessionId: usage.sessionId.toHexString(),
      providerMode: unlock.providerMode,
      releaseId: marker.toHexString(),
    }, context as ClaimedPaidInterviewSessionTransaction, {
      now: () => new Date(now),
      allowWhenReadinessDisabledForTests:
        dependencies.allowPaidReleaseWhenDisabledForTests,
      evidenceProvider: mongoPaidInterviewReservationReleaseEvidenceProvider,
    })
    result = { sessionId: released.sessionId, usageId: released.usageId,
      source: 'paid_interview', restorationId: released.releaseId,
      disposition: paidRestorationDisposition(released.disposition, unlock.status),
      reused: released.reused }
  } else {
    if (!exactDate(usage.consumedAt) || (unlock.status !== 'consumed' &&
      !usage.restorationId)) {
      throw fail('evidence_denied', 'Paid consumption evidence is incoherent')
    }
    const evidence: AuthoritativeInterviewRestorationEvidence = {
      restorationId: marker.toHexString(),
      usageId: usage._id.toHexString(),
      userId: usage.userId.toHexString(),
      sessionId: usage.sessionId.toHexString(),
      source: 'paid_interview',
      sourceId: usage.sourceId.toHexString(),
      providerMode: unlock.providerMode,
      verified: true,
      verifiedAt: now,
      firstTurnRecordedAt: null,
      reason: authority.reason,
    }
    const restored = await (dependencies.restorePaid ??
      restorePaidInterviewUnlockInSession)({
      userId: usage.userId.toHexString(),
      sessionId: usage.sessionId.toHexString(),
      providerMode: unlock.providerMode,
      restorationId: marker.toHexString(),
    }, context.session, context.claimedUserId, {
      now: () => new Date(now),
      evidenceProvider: { load: async () => evidence },
    })
    result = { sessionId: restored.sessionId, usageId: restored.usageId,
      source: 'paid_interview', restorationId: restored.restorationId,
      disposition: paidRestorationDisposition(restored.disposition, unlock.status),
      reused: restored.reused }
  }
  if (result.reused !== Boolean(usage.restorationId))
    throw fail('persistence_conflict', 'Paid restoration replay disagrees')
  if (!result.reused) {
    const userUpdate = await User.updateOne({
      _id: usage.userId,
      buyerState: { $ne: 'deletion_pending' },
      deletionPendingAt: { $exists: false },
      interviewCount: { $gte: 1 },
    }, { $inc: { interviewCount: -1 } }, {
      session: context.session, runValidators: true,
    })
    if (userUpdate.matchedCount !== 1)
      throw fail('persistence_conflict', 'Paid interview count reversal raced')
  }
  return result
}
type ClosedReview = {
  denied: {
    code: 'evidence_denied' | 'period_mismatch'
    message: string
  }
}
function canCloseRecoveryReview(
  rows: {
    sessions: SessionRow[]; runtimes: RuntimeRow[];
    usages: UsageRow[]; turns: TurnRow[]
  },
  input: { userId: mongoose.Types.ObjectId;
    sessionId: mongoose.Types.ObjectId; now: Date },
) {
  if (rows.sessions.length !== 1 || rows.runtimes.length !== 1 ||
      rows.usages.length !== 1 || rows.turns.length >= 65) return false
  const interview = rows.sessions[0]
  const runtime = rows.runtimes[0]
  const usage = rows.usages[0]
  const approvedFailure = rows.turns.some((turn) =>
    CONTENT_KINDS.has(turn.operationKind) && turn.state === 'failed' &&
    !!turn.failureCode && PLATFORM_FAILURE_CODES.has(turn.failureCode) &&
    exactDate(turn.failedAt) && turn.failedAt <= input.now)
  const blockingTurn = rows.turns.some((turn) =>
    (CONTENT_KINDS.has(turn.operationKind) &&
      ['claimed', 'completed'].includes(turn.state)) ||
      ['complete_session', 'abandon_session'].includes(turn.operationKind))
  return interview._id.equals(input.sessionId) &&
    interview.userId.equals(input.userId) &&
    interview.status === 'in_progress' && !interview.deletionPendingAt &&
    !interview.completedAt && !interview.endReason &&
    exactDate(interview.startedAt) &&
    runtime.sessionId.equals(input.sessionId) &&
    runtime.userId.equals(input.userId) &&
    runtime.authorityKind === 'consumer_usage' &&
    ['active', 'expired'].includes(runtime.state) &&
    runtime.usageId?.equals(usage._id) &&
    runtime.entitlementSource === usage.source &&
    runtime.entitlementSourceId?.equals(usage.sourceId) &&
    runtime.periodKey === usage.periodKey &&
    exactDate(runtime.startedAt) &&
    runtime.startedAt.getTime() === interview.startedAt.getTime() &&
    exactDate(runtime.deadlineAt) && exactDate(runtime.restoreUntil) &&
    runtime.restoreUntil.getTime() ===
      runtime.deadlineAt.getTime() + RESTORE_GRACE_MS &&
    runtime.restoreUntil <= input.now && !runtime.terminalAt &&
    !runtime.firstTurnRecordedAt && !runtime.firstTurnOperationId &&
    !runtime.firstTurnId && !runtime.restorationRecoveryReviewedAt &&
    !runtime.restorationRecoveryReviewCode &&
    usage.sessionId.equals(input.sessionId) &&
    usage.userId.equals(input.userId) && !usage.restorationId &&
    approvedFailure && !blockingTurn
}
async function closeRecoveryReview(
  rows: {
    sessions: SessionRow[]; runtimes: RuntimeRow[];
    usages: UsageRow[]; turns: TurnRow[]
  },
  input: { userId: mongoose.Types.ObjectId;
    sessionId: mongoose.Types.ObjectId; now: Date },
  error: InterviewEntitlementRestorationError & {
    code: ClosedReview['denied']['code']
  },
  session: ClientSession,
): Promise<ClosedReview> {
  if (!canCloseRecoveryReview(rows, input)) throw error
  const runtime = rows.runtimes[0]
  const marked = await InterviewRuntime.updateOne({
    _id: runtime._id, sessionId: input.sessionId, userId: input.userId,
    authorityKind: 'consumer_usage', usageId: rows.usages[0]._id,
    state: runtime.state, runtimeVersion: runtime.runtimeVersion,
    terminalAt: { $exists: false },
    firstTurnRecordedAt: { $exists: false },
    firstTurnOperationId: { $exists: false },
    firstTurnId: { $exists: false },
    restorationRecoveryReviewedAt: { $exists: false },
    restorationRecoveryReviewCode: { $exists: false },
  }, {
    $set: {
      restorationRecoveryReviewedAt: input.now,
      restorationRecoveryReviewCode: error.code,
    },
    $inc: { runtimeVersion: 1 },
  }, { session, runValidators: true })
  if (marked.matchedCount !== 1)
    throw fail('persistence_conflict', 'Recovery review marker raced')
  return { denied: { code: error.code, message: error.message } }
}
async function restoreInTransaction(
  input: { trigger: Trigger; now: Date },
  context: Context,
  dependencies: Dependencies,
) {
  const sessions = await InterviewSession.find({
    _id: context.claimedSessionId, userId: context.claimedUserId,
  }).select('_id userId status startedAt completedAt endReason deletionPendingAt')
    .limit(2).session(context.session).lean<SessionRow[]>()
  const runtimes = await InterviewRuntime.find({
    sessionId: context.claimedSessionId, userId: context.claimedUserId,
  }).limit(2).session(context.session).lean<RuntimeRow[]>()
  const usages = await InterviewUsage.find({
    sessionId: context.claimedSessionId, userId: context.claimedUserId,
  }).limit(2).session(context.session).lean<UsageRow[]>()
  const turns = await InterviewTurn.find({
    sessionId: context.claimedSessionId, userId: context.claimedUserId,
  }).select('operationKind state failureCode failedAt').sort({ ordinal: 1 })
    .limit(65).session(context.session).lean<TurnRow[]>()
  const rows = { sessions, runtimes, usages, turns }
  const reviewInput = {
    userId: context.claimedUserId,
    sessionId: context.claimedSessionId,
    now: input.now,
  }
  const reviewed = runtimes[0]
  if (input.trigger === 'failed_first_turn_recovery' &&
      runtimes.length === 1 &&
      exactDate(reviewed.restorationRecoveryReviewedAt) &&
      (reviewed.restorationRecoveryReviewCode === 'evidence_denied' ||
       reviewed.restorationRecoveryReviewCode === 'period_mismatch')) {
    return { denied: {
      code: reviewed.restorationRecoveryReviewCode,
      message: 'Recovery evidence review is already closed',
    } }
  }
  try {
    const authority = classifyInterviewEntitlementRestorationEvidence(
      rows,
      { ...reviewInput, trigger: input.trigger },
    )
    const marker = markerFor(authority.usage._id)
    if (authority.usage.restorationId && !authority.usage.restorationId
        .equals(marker))
      throw fail('persistence_conflict', 'Usage has another restoration')
    if (authority.usage.source === 'paid_interview')
      return restorePaid(authority, marker, input.now, context, dependencies)
    if (authority.usage.source === 'admin' &&
        authority.usage.restorationId) {
      const disposition = authority.usage.restorationDisposition
      if (!disposition) throw fail(
        'persistence_conflict',
        'Admin restoration disposition is unavailable',
      )
      return { sessionId: authority.usage.sessionId.toHexString(),
        usageId: authority.usage._id.toHexString(), source: 'admin',
        restorationId: marker.toHexString(), disposition,
        reused: true } as InterviewEntitlementRestorationResult
    }
    if (authority.usage.restorationId) {
      return { sessionId: authority.usage.sessionId.toHexString(),
        usageId: authority.usage._id.toHexString(),
        source: authority.usage.source,
        restorationId: marker.toHexString(), disposition: 'restored',
        reused: true } as InterviewEntitlementRestorationResult
    }
    if (authority.usage.source === 'admin')
      return restoreAdmin(authority, marker, input.now, context.session)
    return restoreIncluded(authority, marker, input.now, context.session)
  } catch (error) {
    if (input.trigger === 'failed_first_turn_recovery' &&
        error instanceof InterviewEntitlementRestorationError &&
        (error.code === 'evidence_denied' ||
         error.code === 'period_mismatch')) {
      return closeRecoveryReview(
        rows, reviewInput,
        error as InterviewEntitlementRestorationError & {
          code: ClosedReview['denied']['code']
        },
        context.session,
      )
    }
    throw error
  }
}
const mongoRunner: Runner = {
  async run(input, work) {
    return withSessionPersonalDataWriteTransaction(
      input.userId, input.sessionId,
      (session, claimedUserId, claimedSessionId) =>
        work({ session, claimedUserId, claimedSessionId }))
  },
}
async function restoreOne(
  input: { userId: string; sessionId: string; trigger: Trigger },
  dependencies: Dependencies,
) {
  const testReady = process.env.NODE_ENV === 'test' &&
    dependencies.allowWhenReadinessDisabledForTests === true
  if (!PR8_INTERVIEW_ENTITLEMENT_ENFORCEMENT_READY && !testReady) {
    throw fail('not_ready', 'Interview restoration is not ready')
  }
  const userId = exactObjectId(input.userId, 'userId').toHexString()
  const sessionId = exactObjectId(input.sessionId, 'sessionId').toHexString()
  const now = observedNow(dependencies.now)
  const outcome = await (dependencies.transactionRunner ?? mongoRunner).run(
    { userId, sessionId },
    (context) => (dependencies.restoreInTransaction ?? restoreInTransaction)(
      { trigger: input.trigger, now }, context, dependencies),
  )
  if ('denied' in outcome)
    throw fail(outcome.denied.code, outcome.denied.message)
  return outcome
}
export function restoreConsumerInterviewAfterPlatformStartFailure(
  input: { userId: string; sessionId: string },
  dependencies: Dependencies = {},
) {
  return restoreOne({ ...input, trigger: 'platform_start_failure' }, dependencies)
}
export function restoreConsumerInterviewAfterFailedFirstTurn(
  input: { userId: string; sessionId: string },
  dependencies: Dependencies = {},
) {
  return restoreOne({ ...input, trigger: 'failed_first_turn_recovery' },
    dependencies)
}

type RecoveryCandidate = { userId: string; sessionId: string }
async function listRecoveryCandidates(now: Date): Promise<RecoveryCandidate[]> {
  await connectDB()
  const basicPeriodKey = basicCalendarMonthPeriod(now).key
  const rows = await InterviewRuntime.aggregate<{
    userId: { toString(): string }
    sessionId: { toString(): string }
  }>([
    {
      $match: {
        authorityKind: 'consumer_usage',
        state: { $in: ['active', 'expired'] },
        startedAt: { $type: 'date' },
        deadlineAt: { $type: 'date' },
        restoreUntil: { $lte: now },
        terminalAt: { $exists: false },
        firstTurnRecordedAt: { $exists: false },
        firstTurnOperationId: { $exists: false },
        firstTurnId: { $exists: false },
        restorationRecoveryReviewedAt: { $exists: false },
        restorationRecoveryReviewCode: { $exists: false },
        entitlementSnapshotDigest: { $type: 'string' },
        $expr: {
          $eq: [
            '$restoreUntil',
            {
              $dateAdd: {
                startDate: '$deadlineAt',
                unit: 'millisecond',
                amount: RESTORE_GRACE_MS,
              },
            },
          ],
        },
      },
    },
    {
      $lookup: {
        from: 'interviewsessions',
        let: { sessionId: '$sessionId', userId: '$userId' },
        as: 'interview',
        pipeline: [
          {
            $match: {
              status: 'in_progress',
              startedAt: { $type: 'date' },
              completedAt: { $exists: false },
              endReason: { $exists: false },
              deletionPendingAt: { $exists: false },
              $expr: {
                $and: [
                  { $eq: ['$_id', '$$sessionId'] },
                  { $eq: ['$userId', '$$userId'] },
                ],
              },
            },
          },
          { $project: { _id: 1, userId: 1, startedAt: 1 } },
          { $limit: 2 },
        ],
      },
    },
    {
      $match: {
        'interview.0': { $exists: true },
        'interview.1': { $exists: false },
      },
    },
    { $set: { interview: { $first: '$interview' } } },
    {
      $match: {
        $expr: { $eq: ['$startedAt', '$interview.startedAt'] },
      },
    },
    {
      $lookup: {
        from: 'interviewusages',
        localField: 'usageId',
        foreignField: '_id',
        as: 'usage',
        pipeline: [
          { $match: { restorationId: { $exists: false } } },
          { $limit: 2 },
        ],
      },
    },
    {
      $match: {
        'usage.0': { $exists: true },
        'usage.1': { $exists: false },
      },
    },
    { $set: { usage: { $first: '$usage' } } },
    {
      $match: {
        $expr: {
          $and: [
            { $eq: ['$usage.sessionId', '$sessionId'] },
            { $eq: ['$usage.userId', '$userId'] },
            { $eq: ['$usage.source', '$entitlementSource'] },
            { $eq: ['$usage.sourceId', '$entitlementSourceId'] },
            {
              $eq: [
                { $ifNull: ['$usage.periodKey', null] },
                { $ifNull: ['$periodKey', null] },
              ],
            },
            {
              $eq: [
                '$usage.entitlementSnapshotDigest',
                '$entitlementSnapshotDigest',
              ],
            },
            { $eq: [{ $type: '$usage.reservedAt' }, 'date'] },
            {
              $or: [
                {
                  $and: [
                    { $eq: ['$usage.source', 'paid_interview'] },
                    { $eq: [{ $type: '$usage.consumedAt' }, 'date'] },
                  ],
                },
                {
                  $and: [
                    { $ne: ['$usage.source', 'paid_interview'] },
                    { $eq: ['$usage.consumedAt', '$usage.reservedAt'] },
                  ],
                },
              ],
            },
            {
              $in: [
                '$usage.source',
                ['free_period', 'subscription_cycle', 'paid_interview', 'admin'],
              ],
            },
          ],
        },
      },
    },
    {
      $lookup: {
        from: 'interviewturns',
        let: { sessionId: '$sessionId', userId: '$userId' },
        as: 'turnEvidence',
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [
                  { $eq: ['$sessionId', '$$sessionId'] },
                  { $eq: ['$userId', '$$userId'] },
                ],
              },
            },
          },
          {
            $group: {
              _id: null,
              count: { $sum: 1 },
              approved: {
                $sum: {
                  $cond: [{
                    $and: [
                      { $in: ['$operationKind', Array.from(CONTENT_KINDS)] },
                      { $eq: ['$state', 'failed'] },
                      {
                        $in: [
                          '$failureCode',
                          Array.from(PLATFORM_FAILURE_CODES),
                        ],
                      },
                      { $eq: [{ $type: '$failedAt' }, 'date'] },
                      { $lte: ['$failedAt', now] },
                    ],
                  }, 1, 0],
                },
              },
              blocking: {
                $sum: {
                  $cond: [{
                    $or: [
                      {
                        $and: [
                          {
                            $in: [
                              '$operationKind',
                              Array.from(CONTENT_KINDS),
                            ],
                          },
                          { $in: ['$state', ['claimed', 'completed']] },
                        ],
                      },
                      {
                        $in: [
                          '$operationKind',
                          ['complete_session', 'abandon_session'],
                        ],
                      },
                    ],
                  }, 1, 0],
                },
              },
            },
          },
        ],
      },
    },
    {
      $match: {
        'turnEvidence.0.approved': { $gte: 1 },
        'turnEvidence.0.blocking': 0,
        'turnEvidence.0.count': { $lte: 64 },
      },
    },
    {
      $lookup: {
        from: 'users',
        let: {
          userId: '$userId',
          source: '$usage.source',
          sourceId: '$usage.sourceId',
          periodKey: '$usage.periodKey',
          grantId: '$usage.entitlementSnapshot.grantId',
        },
        as: 'entitlementUser',
        pipeline: [
          {
            $match: {
              buyerState: { $ne: 'deletion_pending' },
              deletionPendingAt: { $exists: false },
              $expr: {
                $and: [
                  { $eq: ['$_id', '$$userId'] },
                  { $gte: ['$interviewCount', 1] },
                  {
                    $or: [
                      { $eq: ['$$source', 'paid_interview'] },
                      {
                        $and: [
                          { $eq: ['$$source', 'admin'] },
                          {
                            $or: [
                              {
                                $eq: [
                                  { $ifNull: ['$$periodKey', null] },
                                  null,
                                ],
                              },
                              {
                                $and: [
                                  { $eq: ['$entitlementSource', 'admin_grant'] },
                                  { $eq: ['$usagePeriodKey', '$$periodKey'] },
                                  { $eq: [
                                    '$entitlementAuthority.adminGrantId',
                                    '$$grantId',
                                  ] },
                                  { $eq: [
                                    '$entitlementAuthority.adminCompPeriodId',
                                    '$$sourceId',
                                  ] },
                                  { $gte: ['$interviewsUsed', 1] },
                                  { $gte: ['$entitlementVersion', 1] },
                                ],
                              },
                            ],
                          },
                        ],
                      },
                      {
                        $and: [
                          { $eq: ['$$source', 'free_period'] },
                          { $eq: ['$$sourceId', '$$userId'] },
                          { $eq: ['$$periodKey', basicPeriodKey] },
                          { $eq: ['$entitlementSource', 'free'] },
                          { $eq: ['$usagePeriodKey', '$$periodKey'] },
                          { $gte: ['$interviewsUsed', 1] },
                          { $gte: ['$entitlementVersion', 1] },
                        ],
                      },
                      {
                        $and: [
                          { $eq: ['$$source', 'subscription_cycle'] },
                          { $eq: ['$entitlementSource', 'subscription'] },
                          { $eq: ['$usagePeriodKey', '$$periodKey'] },
                          { $gte: ['$interviewsUsed', 1] },
                          { $gte: ['$entitlementVersion', 1] },
                        ],
                      },
                    ],
                  },
                ],
              },
            },
          },
          { $project: { _id: 1 } },
          { $limit: 1 },
        ],
      },
    },
    { $match: { 'entitlementUser.0': { $exists: true } } },
    {
      $lookup: {
        from: 'subscriptioncycles',
        let: {
          source: '$usage.source',
          sourceId: '$usage.sourceId',
          userId: '$userId',
          periodKey: '$usage.periodKey',
          providerMode: '$usage.entitlementSnapshot.providerMode',
        },
        as: 'cycle',
        pipeline: [
          {
            $match: {
              fulfillmentStatus: 'captured',
              projectionDisposition: 'projected',
              $expr: {
                $and: [
                  { $eq: ['$$source', 'subscription_cycle'] },
                  { $eq: ['$_id', '$$sourceId'] },
                  { $eq: ['$userId', '$$userId'] },
                  { $eq: ['$periodKey', '$$periodKey'] },
                  { $eq: ['$providerMode', '$$providerMode'] },
                  { $lte: ['$periodStart', now] },
                  { $gt: ['$periodEnd', now] },
                ],
              },
            },
          },
          { $project: { _id: 1 } },
          { $limit: 1 },
        ],
      },
    },
    {
      $match: {
        $expr: {
          $or: [
            { $ne: ['$usage.source', 'subscription_cycle'] },
            { $eq: [{ $size: '$cycle' }, 1] },
          ],
        },
      },
    },
    {
      $lookup: {
        from: 'paidinterviewunlocks',
        let: {
          source: '$usage.source',
          sourceId: '$usage.sourceId',
          userId: '$userId',
          sessionId: '$sessionId',
          providerMode: '$usage.entitlementSnapshot.providerMode',
        },
        as: 'unlock',
        pipeline: [
          {
            $match: {
              status: 'consumed',
              $expr: {
                $and: [
                  { $eq: ['$$source', 'paid_interview'] },
                  { $eq: ['$_id', '$$sourceId'] },
                  { $eq: ['$userId', '$$userId'] },
                  { $eq: ['$providerMode', '$$providerMode'] },
                  { $eq: ['$reservedSessionId', '$$sessionId'] },
                  { $eq: ['$consumedSessionId', '$$sessionId'] },
                ],
              },
            },
          },
          { $project: { _id: 1 } },
          { $limit: 1 },
        ],
      },
    },
    {
      $match: {
        $expr: {
          $or: [
            { $ne: ['$usage.source', 'paid_interview'] },
            { $eq: [{ $size: '$unlock' }, 1] },
          ],
        },
      },
    },
    { $sort: { deadlineAt: 1, _id: 1 } },
    { $limit: RESTORATION_BATCH_SIZE },
    { $project: { userId: 1, sessionId: 1 } },
  ]).option({ maxTimeMS: 5_000 })
  return rows.map((row) => ({
    userId: row.userId.toString(),
    sessionId: row.sessionId.toString(),
  }))
}

export async function runInterviewEntitlementRestorationRecovery(
  step: InterviewEntitlementRestorationStepRunner,
  now = new Date(),
  dependencies: InterviewEntitlementRestorationRecoveryDependencies = {},
): Promise<InterviewEntitlementRestorationRecoveryResult> {
  const testReady = process.env.NODE_ENV === 'test' &&
    dependencies.allowWhenReadinessDisabledForTests === true
  if (!PR8_INTERVIEW_ENTITLEMENT_ENFORCEMENT_READY && !testReady) {
    return {
      disabled: true, inspected: 0, restored: 0, reused: 0, denied: 0,
    }
  }
  const candidateResult = await step.run(
    'find-restorable-interview-entitlements',
    dependencies.listCandidates ?? (() => listRecoveryCandidates(now)),
  )
  if (!Array.isArray(candidateResult))
    throw new Error('Restoration candidate step returned invalid data')
  const candidates = candidateResult
    .slice(0, RESTORATION_BATCH_SIZE)
    .map((candidate) => {
      if (!candidate || typeof candidate !== 'object' ||
          typeof candidate.userId !== 'string' ||
          typeof candidate.sessionId !== 'string')
        throw new Error('Restoration candidate step returned invalid data')
      return candidate as RecoveryCandidate
    })
  const restore = dependencies.restore ??
    restoreConsumerInterviewAfterFailedFirstTurn
  const counts = exactRecoveryCounts(await step.run(
    'restore-failed-first-turn-entitlements',
    async () => {
      const totals = { restored: 0, reused: 0, denied: 0 }
      for (const candidate of candidates) {
        try {
          const result = await restore(candidate)
          if (result.reused) totals.reused++
          else totals.restored++
        } catch (error) {
          if (error instanceof InterviewEntitlementRestorationError &&
              (error.code === 'evidence_pending' ||
               error.code === 'evidence_denied' ||
               error.code === 'period_mismatch')) {
            totals.denied++
            continue
          }
          throw error
        }
      }
      return totals
    },
  ))
  return { disabled: false, inspected: candidates.length, ...counts }
}
