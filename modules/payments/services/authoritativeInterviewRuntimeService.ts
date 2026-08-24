import { createHash, randomUUID } from 'node:crypto'
import mongoose, { type ClientSession } from 'mongoose'
import { connectDB } from '@shared/db/connection'
import { InterviewSession } from '@shared/db/models/InterviewSession'
import { User } from '@shared/db/models/User'
import {
  SESSION_PERSONAL_DATA_CAPABILITY_MS,
  withSessionPersonalDataWriteTransaction,
} from '@shared/services/accountDeletion'
import {
  PR8_AUTHORITATIVE_INTERVIEW_RUNTIME_WRITES_READY,
  PR8_INTERVIEW_ENTITLEMENT_ENFORCEMENT_READY,
  PR8_INTERVIEW_RUNTIME_POLICY_READY,
} from '@shared/services/pr8InterviewRollout'
import {
  INTERVIEW_AUTHORITY_DIGEST_DOMAINS,
  digestInterviewAuthority,
} from '@shared/services/interviewAuthorityDigest'
import {
  InterviewUsage,
  type InterviewUsageSource,
  type NormalizedInterviewDurationMinutes,
} from '../models/InterviewUsage'
import {
  canonicalizeInterviewResultArtifact,
  InterviewRuntime,
  InterviewTurn,
  INTERVIEW_RUNTIME_OPERATION_KINDS,
  INTERVIEW_TURN_FAILURE_CODES,
  parseCanonicalInterviewResultArtifact,
  type InterviewResultArtifact,
  type InterviewResultArtifactJsonValue,
  type InterviewRuntimeAuthorityKind,
  type InterviewRuntimeOperationKind,
  type InterviewRuntimeState,
  type InterviewTurnState,
} from '../models/InterviewRuntime'

export { PR8_AUTHORITATIVE_INTERVIEW_RUNTIME_WRITES_READY }
export const PR8_AUTHORITATIVE_INTERVIEW_RUNTIME_ENFORCEMENT_READY =
  PR8_INTERVIEW_RUNTIME_POLICY_READY &&
  PR8_AUTHORITATIVE_INTERVIEW_RUNTIME_WRITES_READY

export const AUTHORITATIVE_INTERVIEW_CLAIM_LEASE_MS = 90_000
export const AUTHORITATIVE_INTERVIEW_RESTORE_GRACE_MS = 60 * 60 * 1000

const OBJECT_ID_PATTERN = /^[a-f0-9]{24}$/
const UUID_V4_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/
const SHA256_PATTERN = /^[a-f0-9]{64}$/
const INTERVIEW_TURN_FAILURE_CODE_SET =
  new Set<string>(INTERVIEW_TURN_FAILURE_CODES)
const ACTIVE_SESSION_STATUSES = new Set(['created', 'in_progress'])
const TERMINAL_OPERATION_KINDS = new Set<InterviewRuntimeOperationKind>([
  'complete_session',
  'abandon_session',
])
const FIRST_TURN_OPERATION_KINDS = new Set<InterviewRuntimeOperationKind>([
  'present_question',
  'generate_question',
  'evaluate_answer',
  'turn_router',
  'clarify_coding',
  'clarify_case_context',
  'answer_candidate_question',
  'evaluate_code',
  'evaluate_design',
])
const PARENT_OPERATION_KINDS = new Map<
  InterviewRuntimeOperationKind,
  ReadonlySet<InterviewRuntimeOperationKind>
>([
  ['evaluate_answer', new Set<InterviewRuntimeOperationKind>([
    'present_question',
    'generate_question',
    'turn_router',
    'evaluate_answer',
    'evaluate_code',
    'evaluate_design',
  ])],
  ['turn_router', new Set<InterviewRuntimeOperationKind>([
    'present_question',
    'generate_question',
    'turn_router',
    'evaluate_answer',
    'evaluate_code',
    'evaluate_design',
  ])],
  ['clarify_coding', new Set<InterviewRuntimeOperationKind>(['generate_question'])],
  ['clarify_case_context', new Set<InterviewRuntimeOperationKind>([
    'present_question',
    'generate_question',
    'turn_router',
    'evaluate_answer',
  ])],
  ['answer_candidate_question', new Set<InterviewRuntimeOperationKind>([
    'present_question',
    'generate_question',
    'turn_router',
    'evaluate_answer',
    'evaluate_code',
    'evaluate_design',
  ])],
  ['evaluate_code', new Set<InterviewRuntimeOperationKind>(['generate_question'])],
  ['evaluate_design', new Set<InterviewRuntimeOperationKind>(['generate_question'])],
])

export type AuthoritativeInterviewRuntimeErrorCode =
  | 'not_ready'
  | 'invalid_user_id'
  | 'invalid_session_id'
  | 'invalid_usage_id'
  | 'invalid_operation_id'
  | 'invalid_operation_kind'
  | 'invalid_parent_turn_id'
  | 'invalid_digest'
  | 'invalid_claim_token'
  | 'invalid_failure_code'
  | 'invalid_result_artifact'
  | 'session_not_found'
  | 'runtime_not_found'
  | 'runtime_linkage_invalid'
  | 'usage_linkage_invalid'
  | 'persisted_config_invalid'
  | 'runtime_state_invalid'
  | 'runtime_expired'
  | 'question_budget_exhausted'
  | 'parent_turn_invalid'
  | 'idempotency_conflict'
  | 'claim_lost'
  | 'runtime_conflict'
  | 'turn_persistence_conflict'
  | 'result_artifact_linkage_invalid'
  | 'question_generation_in_flight'
  | 'invalid_transaction_context'
  | 'authority_conflict'
  | 'authority_persistence_conflict'

export class AuthoritativeInterviewRuntimeError extends Error {
  readonly code: AuthoritativeInterviewRuntimeErrorCode

  constructor(
    code: AuthoritativeInterviewRuntimeErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'AuthoritativeInterviewRuntimeError'
    this.code = code
  }
}

export interface AuthoritativeInterviewConfig {
  role: string
  interviewType: string
  experience: '0-2' | '3-6' | '7+'
  duration: NormalizedInterviewDurationMinutes
}

export interface RuntimeSessionRecord {
  id: string
  userId: string
  organizationId?: string
  status: string
  deletionPendingAt?: Date
  startedAt?: Date
  completedAt?: Date
  config: unknown
  plannedQuestionCount?: number
}

export interface RuntimeAuthorityRecord {
  id: string
  sessionId: string
  userId: string
  authorityKind: InterviewRuntimeAuthorityKind
  usageId?: string
  entitlementSource?: InterviewUsageSource
  entitlementSourceId?: string
  periodKey?: string
  entitlementSnapshotDigest?: string
  sessionConfigDigest: string
  normalizedDurationMinutes: NormalizedInterviewDurationMinutes
  plannedMainQuestionCount: number
  state: InterviewRuntimeState
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
  firstTurnId?: string
}

export interface RuntimeUsageRecord {
  id: string
  sessionId: string
  userId: string
  source: InterviewUsageSource
  sourceId: string
  periodKey?: string
  normalizedDurationMinutes: NormalizedInterviewDurationMinutes
  entitlementSnapshot: unknown
  entitlementSnapshotDigest?: string
  reservedAt: Date
  consumedAt?: Date
  restorationId?: string
}

export interface RuntimeTurnRecord {
  id: string
  runtimeId: string
  sessionId: string
  userId: string
  operationId: string
  operationKind: InterviewRuntimeOperationKind
  state: InterviewTurnState
  ordinal: number
  mainQuestionOrdinal?: number
  parentTurnId?: string
  requestDigest: string
  resultDigest?: string
  resultArtifactCanonical?: string
  claimTokenDigest: string
  claimExpiresAt: Date
  attemptCount: number
  failureCode?: string
}

interface NewTurnClaim {
  runtimeId: string
  sessionId: string
  userId: string
  operationId: string
  operationKind: InterviewRuntimeOperationKind
  ordinal: number
  mainQuestionOrdinal?: number
  parentTurnId?: string
  requestDigest: string
  claimTokenDigest: string
  claimExpiresAt: Date
  claimedAt: Date
}

interface RuntimeClaimTransition {
  expectedRuntimeVersion: number
  expectedState: InterviewRuntimeState
  nextState?: InterviewRuntimeState
  startedAt?: Date
  deadlineAt?: Date
  restoreUntil?: Date
  mainQuestionReservationOperationId?: string
}

export interface AuthoritativeInterviewRuntimeTransaction {
  loadSession(): Promise<RuntimeSessionRecord | null>
  loadRuntime(): Promise<RuntimeAuthorityRecord | null>
  loadUsage(usageId: string): Promise<RuntimeUsageRecord | null>
  loadTurnByOperationId(operationId: string): Promise<RuntimeTurnRecord | null>
  loadTurnById(turnId: string): Promise<RuntimeTurnRecord | null>
  markSessionEstablished(input: {
    startedAt: Date
  }): Promise<boolean>
  insertClaimAndAdvanceRuntime(
    claim: NewTurnClaim,
    transition: RuntimeClaimTransition,
  ): Promise<{
    runtime: RuntimeAuthorityRecord
    turn: RuntimeTurnRecord
  } | null>
  reclaimExpiredTurn(input: {
    turnId: string
    priorClaimTokenDigest: string
    claimTokenDigest: string
    claimExpiresAt: Date
    now: Date
  }): Promise<RuntimeTurnRecord | null>
  supersedeClaimedTurnsForTerminal(input: {
    runtime: RuntimeAuthorityRecord
    now: Date
  }): Promise<RuntimeAuthorityRecord | null>
  completeTurn(input: {
    runtime: RuntimeAuthorityRecord
    turn: RuntimeTurnRecord
    claimTokenDigest: string
    resultDigest: string
    resultArtifactCanonical?: string
    now: Date
    recordFirstTurn: boolean
  }): Promise<{
    runtime: RuntimeAuthorityRecord
    turn: RuntimeTurnRecord
  } | null>
  failTurn(input: {
    runtime: RuntimeAuthorityRecord
    turn: RuntimeTurnRecord
    claimTokenDigest: string
    failureCode: string
    now: Date
  }): Promise<RuntimeTurnRecord | null>
}

export interface AuthoritativeInterviewRuntimeStore {
  withOwnedSessionWrite<T>(
    input: { userId: string; sessionId: string },
    work: (
      transaction: AuthoritativeInterviewRuntimeTransaction,
    ) => Promise<T>,
  ): Promise<T>
}

interface NewRuntimeAuthority {
  sessionId: string
  userId: string
  authorityKind: InterviewRuntimeAuthorityKind
  usageId?: string
  entitlementSource?: InterviewUsageSource
  entitlementSourceId?: string
  periodKey?: string
  entitlementSnapshotDigest?: string
  sessionConfigDigest: string
  normalizedDurationMinutes: NormalizedInterviewDurationMinutes
  plannedMainQuestionCount: number
  state: 'reserved'
  runtimeVersion: 0
  nextTurnOrdinal: 0
  nextMainQuestionOrdinal: 0
}

export interface AuthoritativeInterviewRuntimeCreationStore {
  loadSession(input: {
    session: ClientSession
    userId: mongoose.Types.ObjectId
    sessionId: mongoose.Types.ObjectId
  }): Promise<RuntimeSessionRecord | null>
  loadUsage(input: {
    session: ClientSession
    userId: mongoose.Types.ObjectId
    sessionId: mongoose.Types.ObjectId
    usageId: mongoose.Types.ObjectId
  }): Promise<RuntimeUsageRecord | null>
  loadRuntime(input: {
    session: ClientSession
    userId: mongoose.Types.ObjectId
    sessionId: mongoose.Types.ObjectId
  }): Promise<RuntimeAuthorityRecord | null>
  insertRuntime(
    input: NewRuntimeAuthority,
    session: ClientSession,
  ): Promise<RuntimeAuthorityRecord>
}

export interface AuthoritativeInterviewRuntimeDependencies {
  store?: AuthoritativeInterviewRuntimeStore
  now?: () => Date
  randomId?: () => string
  writesReady?: boolean
}

export interface AuthoritativeInterviewRuntimeReadStore {
  withOwnedSessionRead<T>(
    input: { userId: string; sessionId: string },
    work: (
      transaction: AuthoritativeInterviewRuntimeTransaction,
    ) => Promise<T>,
  ): Promise<T>
}

export interface AuthoritativeInterviewProviderAccessDependencies {
  store?: AuthoritativeInterviewRuntimeReadStore
  now?: () => Date
  enforcementReady?: boolean
}

export interface CreateAuthoritativeInterviewRuntimeInput {
  userId: unknown
  sessionId: unknown
  authorityKind: unknown
  usageId?: unknown
}

export interface CreateAuthoritativeInterviewRuntimeContext {
  session: ClientSession
  claimedUserId: mongoose.Types.ObjectId
  claimedSessionId: mongoose.Types.ObjectId
}

export interface CreateAuthoritativeInterviewRuntimeDependencies {
  store?: AuthoritativeInterviewRuntimeCreationStore
  writesReady?: boolean
}

export interface CreateAuthoritativeInterviewRuntimeResult {
  created: boolean
  runtimeId: string
  authorityKind: InterviewRuntimeAuthorityKind
  authoritativeConfig: AuthoritativeInterviewConfig
  plannedMainQuestionCount: number
  usageId?: string
  entitlementSource?: InterviewUsageSource
  entitlementSourceId?: string
  periodKey?: string
}

export interface ClaimAuthoritativeInterviewOperationInput {
  userId: unknown
  sessionId: unknown
  operationId: unknown
  operationKind: unknown
  requestDigest: unknown
  parentTurnId?: unknown
  parentResultDigest?: unknown
  parentBindingDigest?: unknown
}

export interface EstablishAuthoritativeInterviewRuntimeInput {
  userId: unknown
  sessionId: unknown
  operationId: unknown
  requestDigest: unknown
}

export interface SettleAuthoritativeInterviewRuntimeInput {
  userId: unknown
  sessionId: unknown
  operationId: unknown
  operationKind: unknown
  requestDigest: unknown
}

export interface SettleAuthoritativeInterviewRuntimeInSessionInput
  extends SettleAuthoritativeInterviewRuntimeInput {
  resultArtifact: unknown
}

export interface EstablishAuthoritativeInterviewRuntimeDependencies {
  transaction?: AuthoritativeInterviewRuntimeTransaction
  now?: () => Date
  randomId?: () => string
  writesReady?: boolean
}

export interface FinalizeAuthoritativeInterviewOperationInput {
  userId: unknown
  sessionId: unknown
  operationId: unknown
  claimToken: unknown
  resultDigest: unknown
  resultArtifact: unknown
}

export interface FailAuthoritativeInterviewOperationInput {
  userId: unknown
  sessionId: unknown
  operationId: unknown
  claimToken: unknown
  failureCode: unknown
}

export interface AuthoritativeInterviewRuntimeView {
  id: string
  authorityKind: InterviewRuntimeAuthorityKind
  state: InterviewRuntimeState
  normalizedDurationMinutes: NormalizedInterviewDurationMinutes
  plannedMainQuestionCount: number
  nextTurnOrdinal: number
  nextMainQuestionOrdinal: number
  mainQuestionGenerationReserved: boolean
  startedAt?: Date
  deadlineAt?: Date
  restoreUntil?: Date
  remainingSeconds: number
  periodKey?: string
}

export type ClaimAuthoritativeInterviewOperationResult = {
  state: 'claimed' | 'pending' | 'completed' | 'failed'
  operationId: string
  turnId: string
  operationKind: InterviewRuntimeOperationKind
  ordinal: number
  mainQuestionOrdinal?: number
  attemptCount: number
  claimToken?: string
  claimExpiresAt?: Date
  resultDigest?: string
  resultArtifact?: InterviewResultArtifact
  parentTurn?: Readonly<{
    id: string
    operationKind: InterviewRuntimeOperationKind
    resultDigest: string
    resultArtifact: InterviewResultArtifact
  }>
  failureCode?: string
  authoritativeConfig: AuthoritativeInterviewConfig
  runtime: AuthoritativeInterviewRuntimeView
}

export interface AuthoritativeFirstTurnEvidence {
  verified: true
  userId: string
  sessionId: string
  runtimeId: string
  authorityKind: InterviewRuntimeAuthorityKind
  usageId?: string
  entitlementSource?: InterviewUsageSource
  entitlementSourceId?: string
  periodKey?: string
  firstTurnRecordedAt: Date | null
  firstTurnOperationId: string | null
  firstTurnId: string | null
}

export interface AuthoritativeInterviewProviderAccess {
  verified: true
  userId: string
  sessionId: string
  runtimeId: string
  normalizedDurationMinutes: NormalizedInterviewDurationMinutes
  authorizedAt: Date
  deadlineAt: Date
}

function failure(
  code: AuthoritativeInterviewRuntimeErrorCode,
  message: string,
  cause?: unknown,
): AuthoritativeInterviewRuntimeError {
  return new AuthoritativeInterviewRuntimeError(
    code,
    message,
    cause === undefined ? undefined : { cause },
  )
}

function exactObjectId(
  value: unknown,
  code:
    | 'invalid_user_id'
    | 'invalid_session_id'
    | 'invalid_usage_id'
    | 'invalid_parent_turn_id',
  label: string,
): string {
  if (typeof value !== 'string' || !OBJECT_ID_PATTERN.test(value)) {
    throw failure(code, `${label} must be a canonical ObjectId`)
  }
  return value
}

function exactUuid(
  value: unknown,
  code: 'invalid_operation_id' | 'invalid_claim_token',
  label: string,
): string {
  if (typeof value !== 'string' || !UUID_V4_PATTERN.test(value)) {
    throw failure(code, `${label} must be a canonical UUID v4`)
  }
  return value
}

function exactDigest(value: unknown): string {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    throw failure('invalid_digest', 'Digest must be lowercase SHA-256 hex')
  }
  return value
}

function exactOperationKind(value: unknown): InterviewRuntimeOperationKind {
  if (
    typeof value !== 'string' ||
    !INTERVIEW_RUNTIME_OPERATION_KINDS.includes(
      value as InterviewRuntimeOperationKind,
    )
  ) {
    throw failure('invalid_operation_kind', 'Runtime operation kind is invalid')
  }
  return value as InterviewRuntimeOperationKind
}

function exactAuthorityKind(value: unknown): InterviewRuntimeAuthorityKind {
  if (value !== 'consumer_usage') {
    throw failure(
      'authority_conflict',
      'Interview runtime authority kind is invalid',
    )
  }
  return value
}

function observedNow(provider?: () => Date): Date {
  const now = provider ? provider() : new Date()
  if (
    !(now instanceof Date) ||
    !Number.isFinite(now.getTime())
  ) {
    throw new Error('Runtime clock returned an invalid date')
  }
  return new Date(now)
}

function assertWritesReady(
  dependencies: { writesReady?: boolean },
): void {
  if (
    dependencies.writesReady !== undefined &&
    process.env.NODE_ENV !== 'test'
  ) {
    throw failure(
      'not_ready',
      'Runtime readiness overrides are test-only',
    )
  }
  if (
    (
      process.env.NODE_ENV === 'test'
        ? dependencies.writesReady ??
          PR8_AUTHORITATIVE_INTERVIEW_RUNTIME_WRITES_READY
        : PR8_AUTHORITATIVE_INTERVIEW_RUNTIME_WRITES_READY
    ) !== true
  ) {
    throw failure(
      'not_ready',
      'Authoritative interview runtime writes are not enabled',
    )
  }
}

function exactActiveTransactionContext(
  context: CreateAuthoritativeInterviewRuntimeContext,
  userId: string,
  sessionId: string,
): void {
  if (
    !(context.claimedUserId instanceof mongoose.Types.ObjectId) ||
    !(context.claimedSessionId instanceof mongoose.Types.ObjectId) ||
    context.claimedUserId.toHexString() !== userId ||
    context.claimedSessionId.toHexString() !== sessionId ||
    !context.session ||
    typeof context.session.inTransaction !== 'function' ||
    context.session.inTransaction() !== true
  ) {
    throw failure(
      'invalid_transaction_context',
      'Runtime authority requires the caller active claimed transaction',
    )
  }
}

function canonicalValue(
  value: unknown,
  depth = 0,
  seen = new Set<object>(),
): unknown {
  if (depth > 20) throw new Error('Snapshot nesting exceeds the runtime bound')
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Snapshot number is invalid')
    return value
  }
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) throw new Error('Snapshot date is invalid')
    return value.toISOString()
  }
  if (value instanceof mongoose.Types.ObjectId) return value.toHexString()
  if (Array.isArray(value)) {
    return value.map((entry) => canonicalValue(entry, depth + 1, seen))
  }
  if (typeof value !== 'object' || value === undefined) {
    throw new Error('Snapshot contains an unsupported value')
  }
  if (seen.has(value)) throw new Error('Snapshot contains a cycle')
  seen.add(value)
  const source = value as Record<string, unknown>
  const result: Record<string, unknown> = {}
  for (const key of Object.keys(source).sort()) {
    if (source[key] !== undefined) {
      result[key] = canonicalValue(source[key], depth + 1, seen)
    }
  }
  seen.delete(value)
  return result
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

export function digestAuthoritativeInterviewResultArtifact(
  value: unknown,
): string {
  return sha256(canonicalizeInterviewResultArtifact(value))
}

function artifactContainsSensitiveString(
  value: InterviewResultArtifactJsonValue,
  sensitive: ReadonlySet<string>,
): boolean {
  if (typeof value === 'string') {
    return Array.from(sensitive).some(
      (secret) => secret.length > 0 && value.includes(secret),
    )
  }
  if (Array.isArray(value)) {
    return value.some((entry) =>
      artifactContainsSensitiveString(entry, sensitive),
    )
  }
  if (value && typeof value === 'object') {
    return Object.values(value).some((entry) =>
      artifactContainsSensitiveString(entry, sensitive),
    )
  }
  return false
}

function normalizedResultArtifact(value: unknown): {
  canonical: string
  digest: string
  artifact: InterviewResultArtifact
} {
  try {
    const canonical = canonicalizeInterviewResultArtifact(value)
    return {
      canonical,
      digest: sha256(canonical),
      artifact: parseCanonicalInterviewResultArtifact(canonical),
    }
  } catch (error) {
    throw failure(
      'invalid_result_artifact',
      'Result artifact is outside the durable runtime contract',
      error,
    )
  }
}

function exactCompletedResultArtifact(
  turn: RuntimeTurnRecord,
): InterviewResultArtifact | undefined {
  if (turn.operationKind === 'session_start') {
    if (turn.resultArtifactCanonical !== undefined) {
      throw failure(
        'result_artifact_linkage_invalid',
        'Session start cannot carry a response artifact',
      )
    }
    return undefined
  }
  if (!turn.resultDigest || !turn.resultArtifactCanonical) {
    throw failure(
      'result_artifact_linkage_invalid',
      'Completed operation response artifact is missing',
    )
  }
  try {
    const artifact = parseCanonicalInterviewResultArtifact(
      turn.resultArtifactCanonical,
    )
    if (
      sha256(turn.resultArtifactCanonical) !== turn.resultDigest ||
      artifactContainsSensitiveString(
        artifact,
        new Set([turn.requestDigest, turn.claimTokenDigest]),
      )
    ) {
      throw new Error('Response artifact hash or secrecy linkage is invalid')
    }
    return artifact
  } catch (error) {
    throw failure(
      'result_artifact_linkage_invalid',
      'Completed operation response artifact linkage is invalid',
      error,
    )
  }
}

export function digestOpaqueInterviewRuntimeSnapshot(value: unknown): string {
  const serialized = JSON.stringify(canonicalValue(value))
  if (serialized.length > 65_536) {
    throw new Error('Snapshot exceeds the runtime digest bound')
  }
  return sha256(serialized)
}

export function normalizeAuthoritativeInterviewConfig(
  value: unknown,
): AuthoritativeInterviewConfig {
  if (!value || typeof value !== 'object') {
    throw failure('persisted_config_invalid', 'Persisted interview config is missing')
  }
  const config = value as Record<string, unknown>
  const role = config.role
  const interviewType = config.interviewType ?? 'screening'
  const experience = config.experience
  const duration = config.duration
  if (
    typeof role !== 'string' ||
    role.length < 1 ||
    role.length > 50 ||
    typeof interviewType !== 'string' ||
    interviewType.length < 1 ||
    interviewType.length > 50 ||
    !['0-2', '3-6', '7+'].includes(String(experience)) ||
    ![10, 20, 30].includes(Number(duration))
  ) {
    throw failure(
      'persisted_config_invalid',
      'Persisted interview config is outside the authoritative runtime contract',
    )
  }
  return Object.freeze({
    role,
    interviewType,
    experience: experience as AuthoritativeInterviewConfig['experience'],
    duration: duration as NormalizedInterviewDurationMinutes,
  })
}

export function digestAuthoritativeInterviewConfig(
  config: AuthoritativeInterviewConfig,
): string {
  return digestInterviewAuthority(
    INTERVIEW_AUTHORITY_DIGEST_DOMAINS
      .authoritativeConfig,
    {
      schemaVersion: 1,
      role: config.role,
      interviewType: config.interviewType,
      experience: config.experience,
      duration: config.duration,
    },
  )
}

function authoritativeMainQuestionCount(
  config: AuthoritativeInterviewConfig,
  persistedPlannedQuestionCount: number,
): number {
  return (
    config.interviewType === 'coding' ||
    config.interviewType === 'system-design'
  )
    ? persistedPlannedQuestionCount
    : Math.max(1, persistedPlannedQuestionCount - 1)
}

function consumerUsageAuthority(
  usage: RuntimeUsageRecord | null,
  input: {
    userId: string
    sessionId: string
    usageId: string
    duration: NormalizedInterviewDurationMinutes
    allowReservedPaidUsage: boolean
  },
): {
  usageId: string
  entitlementSource: InterviewUsageSource
  entitlementSourceId: string
  periodKey?: string
  entitlementSnapshotDigest: string
} {
  let calculatedSnapshotDigest = ''
  try {
    calculatedSnapshotDigest = usage
      ? digestOpaqueInterviewRuntimeSnapshot(usage.entitlementSnapshot)
      : ''
  } catch (error) {
    throw failure(
      'usage_linkage_invalid',
      'Runtime usage snapshot is invalid',
      error,
    )
  }
  const validReservedAt =
    usage?.reservedAt instanceof Date &&
    Number.isFinite(usage.reservedAt.getTime())
  const validConsumedAt =
    usage?.consumedAt instanceof Date &&
    Number.isFinite(usage.consumedAt.getTime()) &&
    validReservedAt &&
    usage.consumedAt.getTime() >= usage.reservedAt.getTime()
  const reservedStartUsage =
    (
      usage?.source === 'paid_interview' ||
      usage?.source === 'subscription_grace'
    ) &&
    usage.consumedAt === undefined &&
    input.allowReservedPaidUsage
  if (
    !usage ||
    usage.id !== input.usageId ||
    usage.sessionId !== input.sessionId ||
    usage.userId !== input.userId ||
    usage.normalizedDurationMinutes !== input.duration ||
    !validReservedAt ||
    (!validConsumedAt && !reservedStartUsage) ||
    usage.restorationId !== undefined ||
    !usage.entitlementSnapshotDigest ||
    usage.entitlementSnapshotDigest !== calculatedSnapshotDigest ||
    (
      (
        usage.source === 'free_period' ||
        usage.source === 'subscription_cycle' ||
        usage.source === 'subscription_grace'
      ) &&
      !usage.periodKey
    )
  ) {
    throw failure(
      'usage_linkage_invalid',
      'Interview usage does not match runtime authority',
    )
  }
  return {
    usageId: usage.id,
    entitlementSource: usage.source,
    entitlementSourceId: usage.sourceId,
    periodKey: usage.periodKey,
    entitlementSnapshotDigest: calculatedSnapshotDigest,
  }
}

function exactRuntimeAuthority(
  existing: RuntimeAuthorityRecord,
  expected: NewRuntimeAuthority,
): RuntimeAuthorityRecord {
  if (
    existing.sessionId !== expected.sessionId ||
    existing.userId !== expected.userId ||
    existing.authorityKind !== expected.authorityKind ||
    existing.usageId !== expected.usageId ||
    existing.entitlementSource !== expected.entitlementSource ||
    existing.entitlementSourceId !== expected.entitlementSourceId ||
    existing.periodKey !== expected.periodKey ||
    existing.entitlementSnapshotDigest !==
      expected.entitlementSnapshotDigest ||
    existing.sessionConfigDigest !== expected.sessionConfigDigest ||
    existing.normalizedDurationMinutes !==
      expected.normalizedDurationMinutes ||
    existing.plannedMainQuestionCount !==
      expected.plannedMainQuestionCount ||
    existing.state !== 'reserved' ||
    existing.startedAt !== undefined ||
    existing.deadlineAt !== undefined ||
    existing.restoreUntil !== undefined ||
    existing.terminalAt !== undefined ||
    existing.runtimeVersion !== 0 ||
    existing.nextTurnOrdinal !== 0 ||
    existing.nextMainQuestionOrdinal !== 0 ||
    existing.mainQuestionReservationOperationId !== undefined ||
    existing.firstTurnRecordedAt !== undefined ||
    existing.firstTurnOperationId !== undefined ||
    existing.firstTurnId !== undefined
  ) {
    throw failure(
      'authority_conflict',
      'Existing interview runtime authority does not match the request',
    )
  }
  return existing
}

function runtimeCreationResult(
  runtime: RuntimeAuthorityRecord,
  config: AuthoritativeInterviewConfig,
  created: boolean,
): CreateAuthoritativeInterviewRuntimeResult {
  return {
    created,
    runtimeId: runtime.id,
    authorityKind: runtime.authorityKind,
    authoritativeConfig: config,
    plannedMainQuestionCount: runtime.plannedMainQuestionCount,
    usageId: runtime.usageId,
    entitlementSource: runtime.entitlementSource,
    entitlementSourceId: runtime.entitlementSourceId,
    periodKey: runtime.periodKey,
  }
}

export async function createAuthoritativeInterviewRuntimeInSession(
  input: CreateAuthoritativeInterviewRuntimeInput,
  context: CreateAuthoritativeInterviewRuntimeContext,
  dependencies: CreateAuthoritativeInterviewRuntimeDependencies = {},
): Promise<CreateAuthoritativeInterviewRuntimeResult> {
  assertWritesReady(dependencies)
  const userId = exactObjectId(input.userId, 'invalid_user_id', 'userId')
  const sessionId = exactObjectId(
    input.sessionId,
    'invalid_session_id',
    'sessionId',
  )
  const authorityKind = exactAuthorityKind(input.authorityKind)
  exactActiveTransactionContext(context, userId, sessionId)
  const store =
    dependencies.store ?? mongoAuthoritativeInterviewRuntimeCreationStore
  const identifiers = {
    session: context.session,
    userId: context.claimedUserId,
    sessionId: context.claimedSessionId,
  }
  const session = await store.loadSession(identifiers)
  if (
    !session ||
    session.id !== sessionId ||
    session.userId !== userId ||
    session.deletionPendingAt ||
    session.status !== 'created' ||
    session.startedAt !== undefined
  ) {
    throw failure('session_not_found', 'Owned interview session was not found')
  }
  const authoritativeConfig = normalizeAuthoritativeInterviewConfig(
    session.config,
  )
  if (
    !Number.isInteger(session.plannedQuestionCount) ||
    session.plannedQuestionCount! < 1 ||
    session.plannedQuestionCount! > 500
  ) {
    throw failure(
      'persisted_config_invalid',
      'Persisted main-question budget is invalid',
    )
  }

  const usageId = exactObjectId(
    input.usageId,
    'invalid_usage_id',
    'usageId',
  )
  const usage = await store.loadUsage({
    ...identifiers,
    usageId: new mongoose.Types.ObjectId(usageId),
  })
  const authority = consumerUsageAuthority(usage, {
    userId,
    sessionId,
    usageId,
    duration: authoritativeConfig.duration,
    allowReservedPaidUsage: true,
  })

  const expected: NewRuntimeAuthority = {
    sessionId,
    userId,
    authorityKind,
    ...authority,
    sessionConfigDigest:
      digestAuthoritativeInterviewConfig(authoritativeConfig),
    normalizedDurationMinutes: authoritativeConfig.duration,
    plannedMainQuestionCount:
      authoritativeMainQuestionCount(
        authoritativeConfig,
        session.plannedQuestionCount!,
      ),
    state: 'reserved',
    runtimeVersion: 0,
    nextTurnOrdinal: 0,
    nextMainQuestionOrdinal: 0,
  }
  const existing = await store.loadRuntime(identifiers)
  if (existing) {
    return runtimeCreationResult(
      exactRuntimeAuthority(existing, expected),
      authoritativeConfig,
      false,
    )
  }
  let created: RuntimeAuthorityRecord
  try {
    created = await store.insertRuntime(expected, context.session)
  } catch (error) {
    throw failure(
      'authority_persistence_conflict',
      'Interview runtime authority could not be persisted',
      error,
    )
  }
  return runtimeCreationResult(
    exactRuntimeAuthority(created, expected),
    authoritativeConfig,
    true,
  )
}

function runtimeView(
  runtime: RuntimeAuthorityRecord,
  now: Date,
): AuthoritativeInterviewRuntimeView {
  const deadlineMs = runtime.deadlineAt?.getTime()
  return {
    id: runtime.id,
    authorityKind: runtime.authorityKind,
    state: runtime.state,
    normalizedDurationMinutes: runtime.normalizedDurationMinutes,
    plannedMainQuestionCount: runtime.plannedMainQuestionCount,
    nextTurnOrdinal: runtime.nextTurnOrdinal,
    nextMainQuestionOrdinal: runtime.nextMainQuestionOrdinal,
    mainQuestionGenerationReserved:
      runtime.mainQuestionReservationOperationId !== undefined,
    startedAt: runtime.startedAt && new Date(runtime.startedAt),
    deadlineAt: runtime.deadlineAt && new Date(runtime.deadlineAt),
    restoreUntil: runtime.restoreUntil && new Date(runtime.restoreUntil),
    remainingSeconds: deadlineMs === undefined
      ? runtime.normalizedDurationMinutes * 60
      : Math.max(0, Math.ceil((deadlineMs - now.getTime()) / 1000)),
    periodKey: runtime.periodKey,
  }
}

async function validatedAuthority(
  transaction: AuthoritativeInterviewRuntimeTransaction,
  userId: string,
  sessionId: string,
): Promise<{
  session: RuntimeSessionRecord
  runtime: RuntimeAuthorityRecord
  config: AuthoritativeInterviewConfig
  usage?: RuntimeUsageRecord
}> {
  // MongoDB does not support parallel operations on one ClientSession.
  const session = await transaction.loadSession()
  const runtime = await transaction.loadRuntime()
  if (
    !session ||
    session.id !== sessionId ||
    session.userId !== userId ||
    session.deletionPendingAt
  ) {
    throw failure('session_not_found', 'Owned interview session was not found')
  }
  if (
    !runtime ||
    runtime.sessionId !== sessionId ||
    runtime.userId !== userId
  ) {
    throw failure('runtime_not_found', 'Interview runtime authority was not found')
  }

  const config = normalizeAuthoritativeInterviewConfig(session.config)
  if (
    runtime.sessionConfigDigest !== digestAuthoritativeInterviewConfig(config) ||
    runtime.normalizedDurationMinutes !== config.duration ||
    !Number.isInteger(session.plannedQuestionCount) ||
    session.plannedQuestionCount! < 1 ||
    session.plannedQuestionCount! > 500 ||
    !Number.isInteger(runtime.plannedMainQuestionCount) ||
    runtime.plannedMainQuestionCount < 1 ||
    runtime.plannedMainQuestionCount > 500 ||
    !Number.isInteger(runtime.nextTurnOrdinal) ||
    runtime.nextTurnOrdinal < 0 ||
    !Number.isInteger(runtime.nextMainQuestionOrdinal) ||
    runtime.nextMainQuestionOrdinal < 0 ||
    runtime.nextMainQuestionOrdinal > runtime.plannedMainQuestionCount ||
    (
      runtime.mainQuestionReservationOperationId !== undefined &&
      (
        !UUID_V4_PATTERN.test(
          runtime.mainQuestionReservationOperationId,
        ) ||
        runtime.state !== 'active' ||
        runtime.nextMainQuestionOrdinal >=
          runtime.plannedMainQuestionCount
      )
    ) ||
    runtime.plannedMainQuestionCount !==
      authoritativeMainQuestionCount(
        config,
        session.plannedQuestionCount!,
      )
  ) {
    throw failure(
      'runtime_linkage_invalid',
      'Interview runtime configuration linkage is invalid',
    )
  }
  const reservedRuntime = runtime.state === 'reserved'
  const terminalRuntime =
    runtime.state === 'completed' || runtime.state === 'abandoned'
  const expectedSessionStatus =
    runtime.state === 'reserved'
      ? 'created'
      : runtime.state === 'completed'
        ? 'completed'
        : runtime.state === 'abandoned'
          ? 'abandoned'
          : 'in_progress'
  if (
    session.status !== expectedSessionStatus ||
    (
      reservedRuntime &&
      (
        runtime.startedAt !== undefined ||
        runtime.deadlineAt !== undefined ||
        runtime.terminalAt !== undefined ||
        session.startedAt !== undefined ||
        session.completedAt !== undefined
      )
    ) ||
    (
      !reservedRuntime &&
      (
        !runtime.startedAt ||
        !runtime.deadlineAt ||
        !session.startedAt ||
        session.startedAt.getTime() !== runtime.startedAt.getTime()
      )
    ) ||
    (
      terminalRuntime &&
      (
        !runtime.terminalAt ||
        !session.completedAt ||
        runtime.terminalAt.getTime() !== session.completedAt.getTime()
      )
    ) ||
    (
      !terminalRuntime &&
      (
        runtime.terminalAt !== undefined ||
        session.completedAt !== undefined
      )
    )
  ) {
    throw failure(
      'runtime_linkage_invalid',
      'Interview session start does not match runtime authority',
    )
  }

  if (
    runtime.authorityKind !== 'consumer_usage' ||
    !runtime.usageId ||
    !runtime.entitlementSource ||
    !runtime.entitlementSourceId ||
    !runtime.entitlementSnapshotDigest
  ) {
    throw failure(
      'usage_linkage_invalid',
      'Runtime usage linkage is incomplete',
    )
  }
  const usage = await transaction.loadUsage(runtime.usageId)
  const exactUsage = consumerUsageAuthority(usage, {
    userId,
    sessionId,
    usageId: runtime.usageId,
    duration: runtime.normalizedDurationMinutes,
    allowReservedPaidUsage: false,
  })
  if (
    exactUsage.entitlementSource !== runtime.entitlementSource ||
    exactUsage.entitlementSourceId !== runtime.entitlementSourceId ||
    exactUsage.periodKey !== runtime.periodKey ||
    exactUsage.entitlementSnapshotDigest !==
      runtime.entitlementSnapshotDigest
  ) {
    throw failure(
      'usage_linkage_invalid',
      'Interview usage does not match runtime authority',
    )
  }
  return { session, runtime, config, usage: usage! }
}

function assertNewOperationAllowed(
  runtime: RuntimeAuthorityRecord,
  session: RuntimeSessionRecord,
  kind: InterviewRuntimeOperationKind,
  now: Date,
): void {
  if (!ACTIVE_SESSION_STATUSES.has(session.status)) {
    throw failure('runtime_state_invalid', 'Interview session is terminal')
  }
  if (kind === 'session_start') {
    if (runtime.state !== 'reserved' || session.status !== 'created') {
      throw failure('runtime_state_invalid', 'Interview runtime is not reserved')
    }
    return
  }
  if (runtime.state !== 'active') {
    throw failure('runtime_state_invalid', 'Interview runtime is not active')
  }
  if (
    !runtime.startedAt ||
    !runtime.deadlineAt ||
    runtime.deadlineAt.getTime() - runtime.startedAt.getTime() !==
      runtime.normalizedDurationMinutes * 60_000
  ) {
    throw failure('runtime_linkage_invalid', 'Runtime deadline is invalid')
  }
  if (
    !TERMINAL_OPERATION_KINDS.has(kind) &&
    now.getTime() >= runtime.deadlineAt.getTime()
  ) {
    throw failure('runtime_expired', 'Interview runtime duration has expired')
  }
  if (
    kind === 'generate_question' &&
    runtime.nextMainQuestionOrdinal >= runtime.plannedMainQuestionCount
  ) {
    throw failure(
      'question_budget_exhausted',
      'Interview main-question budget is exhausted',
    )
  }
  if (
    kind === 'present_question' &&
    runtime.nextTurnOrdinal !== 1
  ) {
    throw failure(
      'runtime_conflict',
      'The introductory interview question has already been presented',
    )
  }
  if (
    kind === 'generate_question' &&
    runtime.mainQuestionReservationOperationId
  ) {
    throw failure(
      'question_generation_in_flight',
      'Another main-question generation already owns the next slot',
    )
  }
  if (
    TERMINAL_OPERATION_KINDS.has(kind) &&
    runtime.mainQuestionReservationOperationId
  ) {
    throw failure(
      'runtime_conflict',
      'Interview cannot become terminal while question generation is reserved',
    )
  }
}

function assertTurnRuntimeLinkage(
  turn: RuntimeTurnRecord,
  runtime: RuntimeAuthorityRecord,
): void {
  const questionGeneration =
    turn.operationKind === 'generate_question'
  if (
    !OBJECT_ID_PATTERN.test(turn.id) ||
    !OBJECT_ID_PATTERN.test(turn.runtimeId) ||
    !OBJECT_ID_PATTERN.test(turn.sessionId) ||
    !OBJECT_ID_PATTERN.test(turn.userId) ||
    !UUID_V4_PATTERN.test(turn.operationId) ||
    !INTERVIEW_RUNTIME_OPERATION_KINDS.includes(
      turn.operationKind,
    ) ||
    !['claimed', 'completed', 'failed'].includes(turn.state) ||
    !SHA256_PATTERN.test(turn.requestDigest) ||
    !SHA256_PATTERN.test(turn.claimTokenDigest) ||
    !Number.isInteger(turn.ordinal) ||
    turn.ordinal < 0 ||
    !Number.isInteger(turn.attemptCount) ||
    turn.attemptCount < 1 ||
    !(turn.claimExpiresAt instanceof Date) ||
    !Number.isFinite(turn.claimExpiresAt.getTime()) ||
    (
      turn.parentTurnId !== undefined &&
      !OBJECT_ID_PATTERN.test(turn.parentTurnId)
    ) ||
    (
      questionGeneration !==
      (turn.mainQuestionOrdinal !== undefined)
    ) ||
    (
      questionGeneration &&
      (
        !Number.isInteger(turn.mainQuestionOrdinal) ||
        turn.mainQuestionOrdinal! < 0 ||
        turn.mainQuestionOrdinal! >=
          runtime.plannedMainQuestionCount
      )
    )
  ) {
    throw failure(
      'runtime_linkage_invalid',
      'Interview operation persistence linkage is invalid',
    )
  }
  if (
    turn.state === 'claimed' &&
    (
      turn.resultDigest !== undefined ||
      turn.resultArtifactCanonical !== undefined ||
      turn.failureCode !== undefined ||
      (
        questionGeneration &&
        (
          runtime.state !== 'active' ||
          runtime.mainQuestionReservationOperationId !==
            turn.operationId ||
          runtime.nextMainQuestionOrdinal !==
            turn.mainQuestionOrdinal
        )
      )
    )
  ) {
    throw failure(
      'runtime_linkage_invalid',
      'Claimed interview operation linkage is invalid',
    )
  }
  if (
    turn.state === 'completed' &&
    (
      !turn.resultDigest ||
      !SHA256_PATTERN.test(turn.resultDigest) ||
      turn.failureCode !== undefined ||
      (
        questionGeneration &&
        turn.mainQuestionOrdinal! >=
          runtime.nextMainQuestionOrdinal
      )
    )
  ) {
    throw failure(
      'runtime_linkage_invalid',
      'Completed interview operation linkage is invalid',
    )
  }
  if (
    turn.state === 'failed' &&
    (
      !turn.failureCode ||
      !INTERVIEW_TURN_FAILURE_CODE_SET.has(
        turn.failureCode,
      ) ||
      turn.resultDigest !== undefined ||
      turn.resultArtifactCanonical !== undefined ||
      (
        questionGeneration &&
        turn.mainQuestionOrdinal! >
          runtime.nextMainQuestionOrdinal
      )
    )
  ) {
    throw failure(
      'runtime_linkage_invalid',
      'Failed interview operation linkage is invalid',
    )
  }
}

function exactExistingTurn(
  turn: RuntimeTurnRecord,
  input: {
    runtime: RuntimeAuthorityRecord
    userId: string
    sessionId: string
    operationId: string
    operationKind: InterviewRuntimeOperationKind
    requestDigest: string
    parentTurnId?: string
  },
): RuntimeTurnRecord {
  if (
    turn.runtimeId !== input.runtime.id ||
    turn.userId !== input.userId ||
    turn.sessionId !== input.sessionId ||
    turn.operationId !== input.operationId ||
    turn.operationKind !== input.operationKind ||
    turn.requestDigest !== input.requestDigest ||
    turn.parentTurnId !== input.parentTurnId
  ) {
    throw failure(
      'idempotency_conflict',
      'Operation id is already bound to a different request',
    )
  }
  assertTurnRuntimeLinkage(turn, input.runtime)
  return turn
}

function claimResult(
  turn: RuntimeTurnRecord,
  config: AuthoritativeInterviewConfig,
  runtime: RuntimeAuthorityRecord,
  now: Date,
  state: ClaimAuthoritativeInterviewOperationResult['state'],
  claimToken?: string,
  parentTurn?: ClaimAuthoritativeInterviewOperationResult['parentTurn'],
): ClaimAuthoritativeInterviewOperationResult {
  return {
    state,
    operationId: turn.operationId,
    turnId: turn.id,
    operationKind: turn.operationKind,
    ordinal: turn.ordinal,
    mainQuestionOrdinal: turn.mainQuestionOrdinal,
    attemptCount: turn.attemptCount,
    claimToken,
    claimExpiresAt:
      state === 'claimed' || state === 'pending'
        ? new Date(turn.claimExpiresAt)
        : undefined,
    resultDigest: state === 'completed' ? turn.resultDigest : undefined,
    resultArtifact:
      state === 'completed'
        ? exactCompletedResultArtifact(turn)
        : undefined,
    parentTurn,
    failureCode: state === 'failed' ? turn.failureCode : undefined,
    authoritativeConfig: config,
    runtime: runtimeView(runtime, now),
  }
}

function sessionStartResultDigest(
  runtime: RuntimeAuthorityRecord,
  operationId: string,
): string {
  if (
    !runtime.startedAt ||
    !runtime.deadlineAt ||
    !runtime.restoreUntil ||
    runtime.deadlineAt.getTime() - runtime.startedAt.getTime() !==
      runtime.normalizedDurationMinutes * 60_000 ||
    runtime.restoreUntil.getTime() - runtime.deadlineAt.getTime() !==
      AUTHORITATIVE_INTERVIEW_RESTORE_GRACE_MS
  ) {
    throw failure(
      'runtime_linkage_invalid',
      'Established interview runtime timing is invalid',
    )
  }
  return sha256(JSON.stringify([
    'authoritative_session_start_v1',
    runtime.id,
    runtime.sessionId,
    operationId,
    runtime.normalizedDurationMinutes,
    runtime.startedAt.toISOString(),
    runtime.deadlineAt.toISOString(),
    runtime.restoreUntil.toISOString(),
  ]))
}

interface NormalizedRuntimeOperationClaim {
  userId: string
  sessionId: string
  operationId: string
  operationKind: InterviewRuntimeOperationKind
  requestDigest: string
  parentTurnId?: string
  parentResultDigest?: string
  parentBindingDigest?: string
}

function normalizeRuntimeOperationClaim(
  input: ClaimAuthoritativeInterviewOperationInput,
): NormalizedRuntimeOperationClaim {
  const userId = exactObjectId(input.userId, 'invalid_user_id', 'userId')
  const sessionId = exactObjectId(
    input.sessionId,
    'invalid_session_id',
    'sessionId',
  )
  const operationId = exactUuid(
    input.operationId,
    'invalid_operation_id',
    'operationId',
  )
  const operationKind = exactOperationKind(input.operationKind)
  const requestDigest = exactDigest(input.requestDigest)
  const parentTurnId = input.parentTurnId === undefined
    ? undefined
    : exactObjectId(
        input.parentTurnId,
        'invalid_parent_turn_id',
        'parentTurnId',
      )
  const parentResultDigest =
    input.parentResultDigest === undefined
      ? undefined
      : exactDigest(input.parentResultDigest)
  const parentBindingDigest =
    input.parentBindingDigest === undefined
      ? undefined
      : exactDigest(input.parentBindingDigest)
  const requiresParent =
    PARENT_OPERATION_KINDS.has(operationKind)
  if (
    requiresParent !== (
      parentTurnId !== undefined &&
      parentResultDigest !== undefined &&
      parentBindingDigest !== undefined
    ) ||
    (
      !requiresParent &&
      (
        parentTurnId !== undefined ||
        parentResultDigest !== undefined ||
        parentBindingDigest !== undefined
      )
    )
  ) {
    throw failure(
      'parent_turn_invalid',
      'Operation parent lineage is incomplete or unexpected',
    )
  }
  return {
    userId,
    sessionId,
    operationId,
    operationKind,
    requestDigest,
    parentTurnId,
    parentResultDigest,
    parentBindingDigest,
  }
}

async function exactOperationParent(
  transaction: AuthoritativeInterviewRuntimeTransaction,
  runtime: RuntimeAuthorityRecord,
  input: NormalizedRuntimeOperationClaim,
): Promise<ClaimAuthoritativeInterviewOperationResult['parentTurn']> {
  const allowedKinds =
    PARENT_OPERATION_KINDS.get(input.operationKind)
  if (!allowedKinds) return undefined
  const parent = await transaction.loadTurnById(
    input.parentTurnId!,
  )
  if (
    !parent ||
    parent.id !== input.parentTurnId ||
    parent.runtimeId !== runtime.id ||
    parent.sessionId !== input.sessionId ||
    parent.userId !== input.userId ||
    parent.state !== 'completed' ||
    parent.ordinal >= runtime.nextTurnOrdinal ||
    !allowedKinds.has(parent.operationKind) ||
    parent.resultDigest !== input.parentResultDigest
  ) {
    throw failure(
      'parent_turn_invalid',
      'Operation parent is not the exact allowed completed turn',
    )
  }
  assertTurnRuntimeLinkage(parent, runtime)
  const artifact = exactCompletedResultArtifact(parent)
  const body = artifact?.body
  const bodyRecord =
    body && typeof body === 'object' && !Array.isArray(body)
      ? body as Record<string, unknown>
      : undefined
  const bindings =
    bodyRecord?.lineageBindings
  if (
    bodyRecord?.turnId !== parent.id ||
    !Array.isArray(bindings) ||
    bindings.length < 1 ||
    bindings.length > 24 ||
    !bindings.every((entry) => {
      if (
        !entry ||
        typeof entry !== 'object' ||
        Array.isArray(entry)
      ) return false
      const keys = Object.keys(entry)
      return (
        keys.length === 2 &&
        keys.includes('operationKind') &&
        keys.includes('digest') &&
        typeof entry.operationKind === 'string' &&
        INTERVIEW_RUNTIME_OPERATION_KINDS.includes(
          entry.operationKind as InterviewRuntimeOperationKind,
        ) &&
        typeof entry.digest === 'string' &&
        SHA256_PATTERN.test(entry.digest)
      )
    }) ||
    !bindings.some(
      (entry) =>
        entry.operationKind === input.operationKind &&
        entry.digest === input.parentBindingDigest,
    )
  ) {
    throw failure(
      'parent_turn_invalid',
      'Operation parent artifact does not bind this child request',
    )
  }
  return Object.freeze({
    id: parent.id,
    operationKind: parent.operationKind,
    resultDigest: parent.resultDigest!,
    resultArtifact: artifact!,
  })
}

async function claimRuntimeOperationInTransaction(
  input: NormalizedRuntimeOperationClaim,
  transaction: AuthoritativeInterviewRuntimeTransaction,
  now: Date,
  randomId: () => string,
  options: {
    autoCompleteTerminal?: boolean
    terminalResultArtifact?: unknown
  } = {},
): Promise<ClaimAuthoritativeInterviewOperationResult> {
  const {
    userId,
    sessionId,
    operationId,
    operationKind,
    requestDigest,
    parentTurnId,
  } = input
  const authority = await validatedAuthority(
    transaction,
    userId,
    sessionId,
  )
  let { runtime } = authority
  const { session, config } = authority
  const parentTurn = await exactOperationParent(
    transaction,
    runtime,
    input,
  )
  const existing = await transaction.loadTurnByOperationId(operationId)
  if (existing) {
    const turn = exactExistingTurn(existing, {
      runtime,
      userId,
      sessionId,
      operationId,
      operationKind,
      requestDigest,
      parentTurnId,
    })
    if (turn.state === 'completed') {
      if (
        operationKind === 'session_start' &&
        turn.resultDigest !==
          sessionStartResultDigest(runtime, operationId)
      ) {
        throw failure(
          'runtime_linkage_invalid',
          'Completed session start evidence is invalid',
        )
      }
      return claimResult(
        turn,
        config,
        runtime,
        now,
        'completed',
        undefined,
        parentTurn,
      )
    }
    if (turn.state === 'failed') {
      return claimResult(
        turn,
        config,
        runtime,
        now,
        'failed',
        undefined,
        parentTurn,
      )
    }
    if (turn.claimExpiresAt.getTime() > now.getTime()) {
      return claimResult(
        turn,
        config,
        runtime,
        now,
        'pending',
        undefined,
        parentTurn,
      )
    }
    const claimToken = exactUuid(
      randomId(),
      'invalid_claim_token',
      'generated claim token',
    )
    const reclaimed = await transaction.reclaimExpiredTurn({
      turnId: turn.id,
      priorClaimTokenDigest: turn.claimTokenDigest,
      claimTokenDigest: sha256(claimToken),
      claimExpiresAt: new Date(
        now.getTime() + AUTHORITATIVE_INTERVIEW_CLAIM_LEASE_MS,
      ),
      now,
    })
    if (!reclaimed) {
      throw failure(
        'runtime_conflict',
        'Interview operation claim raced with another request',
      )
    }
    return claimResult(
      reclaimed,
      config,
      runtime,
      now,
      'claimed',
      claimToken,
      parentTurn,
    )
  }

  if (
    options.autoCompleteTerminal &&
    TERMINAL_OPERATION_KINDS.has(operationKind)
  ) {
    const superseded =
      await transaction.supersedeClaimedTurnsForTerminal({
        runtime,
        now,
      })
    if (!superseded) {
      throw failure(
        'runtime_conflict',
        'Open interview operations could not be superseded for terminal settlement',
      )
    }
    runtime = superseded
  }

  assertNewOperationAllowed(runtime, session, operationKind, now)
  const claimToken = exactUuid(
    randomId(),
    'invalid_claim_token',
    'generated claim token',
  )
  const mainQuestionOrdinal =
    operationKind === 'generate_question'
      ? runtime.nextMainQuestionOrdinal
      : undefined
  const transition: RuntimeClaimTransition = {
    expectedRuntimeVersion: runtime.runtimeVersion,
    expectedState: runtime.state,
    mainQuestionReservationOperationId:
      operationKind === 'generate_question'
        ? operationId
        : undefined,
  }
  if (operationKind === 'session_start') {
    transition.nextState = 'active'
    transition.startedAt = now
    transition.deadlineAt = new Date(
      now.getTime() + runtime.normalizedDurationMinutes * 60_000,
    )
    transition.restoreUntil = new Date(
      transition.deadlineAt.getTime() +
        AUTHORITATIVE_INTERVIEW_RESTORE_GRACE_MS,
    )
    if (!await transaction.markSessionEstablished({ startedAt: now })) {
      throw failure(
        'runtime_conflict',
        'Interview session changed while establishing its runtime',
      )
    }
  } else if (TERMINAL_OPERATION_KINDS.has(operationKind)) {
    transition.nextState = 'completing'
  }
  const persisted = await transaction.insertClaimAndAdvanceRuntime(
    {
      runtimeId: runtime.id,
      sessionId,
      userId,
      operationId,
      operationKind,
      ordinal: runtime.nextTurnOrdinal,
      mainQuestionOrdinal,
      parentTurnId,
      requestDigest,
      claimTokenDigest: sha256(claimToken),
      claimExpiresAt: new Date(
        now.getTime() + AUTHORITATIVE_INTERVIEW_CLAIM_LEASE_MS,
      ),
      claimedAt: now,
    },
    transition,
  )
  if (!persisted) {
    throw failure(
      'runtime_conflict',
      'Interview runtime changed while claiming the operation',
    )
  }
  if (operationKind === 'session_start') {
    const completed = await transaction.completeTurn({
      runtime: persisted.runtime,
      turn: persisted.turn,
      claimTokenDigest: sha256(claimToken),
      resultDigest: sessionStartResultDigest(
        persisted.runtime,
        operationId,
      ),
      resultArtifactCanonical: undefined,
      now,
      recordFirstTurn: false,
    })
    if (!completed) {
      throw failure(
        'turn_persistence_conflict',
        'Interview session start could not be completed atomically',
      )
    }
    return claimResult(
      completed.turn,
      config,
      completed.runtime,
      now,
      'completed',
    )
  }
  if (
    options.autoCompleteTerminal &&
    TERMINAL_OPERATION_KINDS.has(operationKind)
  ) {
    const expectedStatus =
      operationKind === 'complete_session'
        ? 'completed'
        : 'abandoned'
    const resultArtifact = normalizedResultArtifact(
      options.terminalResultArtifact ?? {
        status: expectedStatus,
      },
    )
    if (
      resultArtifact.artifact.status !== expectedStatus ||
      artifactContainsSensitiveString(
        resultArtifact.artifact,
        new Set([
          claimToken,
          sha256(claimToken),
          requestDigest,
        ]),
      )
    ) {
      throw failure(
        'invalid_result_artifact',
        'Terminal response artifact is invalid',
      )
    }
    const completed = await transaction.completeTurn({
      runtime: persisted.runtime,
      turn: persisted.turn,
      claimTokenDigest: sha256(claimToken),
      resultDigest: resultArtifact.digest,
      resultArtifactCanonical: resultArtifact.canonical,
      now,
      recordFirstTurn: false,
    })
    if (!completed) {
      throw failure(
        'turn_persistence_conflict',
        'Interview terminal state could not be completed atomically',
      )
    }
    return claimResult(
      completed.turn,
      config,
      completed.runtime,
      now,
      'completed',
    )
  }
  return claimResult(
    persisted.turn,
    config,
    persisted.runtime,
    now,
    'claimed',
    claimToken,
    parentTurn,
  )
}

export async function settleAuthoritativeInterviewRuntimeInSession(
  input: SettleAuthoritativeInterviewRuntimeInSessionInput,
  context: CreateAuthoritativeInterviewRuntimeContext,
  dependencies: EstablishAuthoritativeInterviewRuntimeDependencies = {},
): Promise<ClaimAuthoritativeInterviewOperationResult> {
  assertWritesReady(dependencies)
  const normalized = normalizeRuntimeOperationClaim(input)
  if (!TERMINAL_OPERATION_KINDS.has(normalized.operationKind)) {
    throw failure(
      'invalid_operation_kind',
      'Runtime settlement must be a terminal operation',
    )
  }
  exactActiveTransactionContext(
    context,
    normalized.userId,
    normalized.sessionId,
  )
  return claimRuntimeOperationInTransaction(
    normalized,
    dependencies.transaction ?? mongoTransaction(
      context.session,
      context.claimedUserId,
      context.claimedSessionId,
    ),
    observedNow(dependencies.now),
    dependencies.randomId ?? randomUUID,
    {
      autoCompleteTerminal: true,
      terminalResultArtifact: input.resultArtifact,
    },
  )
}

export async function settleAuthoritativeInterviewRuntime(
  input: SettleAuthoritativeInterviewRuntimeInput,
  dependencies: AuthoritativeInterviewRuntimeDependencies = {},
): Promise<ClaimAuthoritativeInterviewOperationResult> {
  assertWritesReady(dependencies)
  const normalized = normalizeRuntimeOperationClaim(input)
  if (!TERMINAL_OPERATION_KINDS.has(normalized.operationKind)) {
    throw failure(
      'invalid_operation_kind',
      'Runtime settlement must be a terminal operation',
    )
  }
  const now = observedNow(dependencies.now)
  const randomId = dependencies.randomId ?? randomUUID
  const store =
    dependencies.store ?? mongoAuthoritativeInterviewRuntimeStore
  return store.withOwnedSessionWrite(
    {
      userId: normalized.userId,
      sessionId: normalized.sessionId,
    },
    (transaction) =>
      claimRuntimeOperationInTransaction(
        normalized,
        transaction,
        now,
        randomId,
        { autoCompleteTerminal: true },
      ),
  )
}

export async function claimAuthoritativeInterviewOperation(
  input: ClaimAuthoritativeInterviewOperationInput,
  dependencies: AuthoritativeInterviewRuntimeDependencies = {},
): Promise<ClaimAuthoritativeInterviewOperationResult> {
  assertWritesReady(dependencies)
  const normalized = normalizeRuntimeOperationClaim(input)
  const now = observedNow(dependencies.now)
  const randomId = dependencies.randomId ?? randomUUID
  const store = dependencies.store ?? mongoAuthoritativeInterviewRuntimeStore

  return store.withOwnedSessionWrite(
    { userId: normalized.userId, sessionId: normalized.sessionId },
    (transaction) => claimRuntimeOperationInTransaction(
      normalized,
      transaction,
      now,
      randomId,
    ),
  )
}

export async function establishAuthoritativeInterviewRuntimeInSession(
  input: EstablishAuthoritativeInterviewRuntimeInput,
  context: CreateAuthoritativeInterviewRuntimeContext,
  dependencies: EstablishAuthoritativeInterviewRuntimeDependencies = {},
): Promise<ClaimAuthoritativeInterviewOperationResult> {
  assertWritesReady(dependencies)
  const normalized = normalizeRuntimeOperationClaim({
    ...input,
    operationKind: 'session_start',
  })
  exactActiveTransactionContext(
    context,
    normalized.userId,
    normalized.sessionId,
  )
  return claimRuntimeOperationInTransaction(
    normalized,
    dependencies.transaction ?? mongoTransaction(
      context.session,
      context.claimedUserId,
      context.claimedSessionId,
    ),
    observedNow(dependencies.now),
    dependencies.randomId ?? randomUUID,
  )
}

async function exactClaimedTurn(
  transaction: AuthoritativeInterviewRuntimeTransaction,
  input: {
    userId: string
    sessionId: string
    operationId: string
    claimTokenDigest: string
  },
): Promise<{
  authority: Awaited<ReturnType<typeof validatedAuthority>>
  turn: RuntimeTurnRecord
}> {
  const authority = await validatedAuthority(
    transaction,
    input.userId,
    input.sessionId,
  )
  const turn = await transaction.loadTurnByOperationId(input.operationId)
  if (
    !turn ||
    turn.runtimeId !== authority.runtime.id ||
    turn.sessionId !== input.sessionId ||
    turn.userId !== input.userId
  ) {
    throw failure('claim_lost', 'Interview operation claim was not found')
  }
  if (turn.claimTokenDigest !== input.claimTokenDigest) {
    throw failure('claim_lost', 'Interview operation claim token is stale')
  }
  assertTurnRuntimeLinkage(turn, authority.runtime)
  return { authority, turn }
}

export async function finalizeAuthoritativeInterviewOperation(
  input: FinalizeAuthoritativeInterviewOperationInput,
  dependencies: AuthoritativeInterviewRuntimeDependencies = {},
): Promise<ClaimAuthoritativeInterviewOperationResult> {
  assertWritesReady(dependencies)
  const userId = exactObjectId(input.userId, 'invalid_user_id', 'userId')
  const sessionId = exactObjectId(
    input.sessionId,
    'invalid_session_id',
    'sessionId',
  )
  const operationId = exactUuid(
    input.operationId,
    'invalid_operation_id',
    'operationId',
  )
  const claimToken = exactUuid(
    input.claimToken,
    'invalid_claim_token',
    'claimToken',
  )
  const resultDigest = exactDigest(input.resultDigest)
  const resultArtifact = normalizedResultArtifact(input.resultArtifact)
  if (resultArtifact.digest !== resultDigest) {
    throw failure(
      'invalid_result_artifact',
      'Result digest does not match the canonical response artifact',
    )
  }
  const claimTokenDigest = sha256(claimToken)
  const now = observedNow(dependencies.now)
  const store = dependencies.store ?? mongoAuthoritativeInterviewRuntimeStore

  return store.withOwnedSessionWrite(
    { userId, sessionId },
    async (transaction) => {
      const { authority, turn } = await exactClaimedTurn(transaction, {
        userId,
        sessionId,
        operationId,
        claimTokenDigest,
      })
      if (
        artifactContainsSensitiveString(
          resultArtifact.artifact,
          new Set([
            claimToken,
            claimTokenDigest,
            turn.requestDigest,
          ]),
        )
      ) {
        throw failure(
          'invalid_result_artifact',
          'Result artifact cannot contain request or claim credentials',
        )
      }
      if (turn.state === 'completed') {
        if (
          turn.resultDigest !== resultDigest ||
          turn.resultArtifactCanonical !== resultArtifact.canonical
        ) {
          throw failure(
            'idempotency_conflict',
            'Completed operation is bound to a different response artifact',
          )
        }
        return claimResult(
          turn,
          authority.config,
          authority.runtime,
          now,
          'completed',
        )
      }
      if (turn.state !== 'claimed') {
        throw failure('claim_lost', 'Interview operation is no longer claimed')
      }
      if (turn.claimExpiresAt.getTime() <= now.getTime()) {
        throw failure('claim_lost', 'Interview operation claim has expired')
      }
      const completed = await transaction.completeTurn({
        runtime: authority.runtime,
        turn,
        claimTokenDigest,
        resultDigest,
        resultArtifactCanonical: resultArtifact.canonical,
        now,
        recordFirstTurn: FIRST_TURN_OPERATION_KINDS.has(
          turn.operationKind,
        ),
      })
      if (!completed) {
        throw failure(
          'turn_persistence_conflict',
          'Interview operation finalization raced with another request',
        )
      }
      return claimResult(
        completed.turn,
        authority.config,
        completed.runtime,
        now,
        'completed',
      )
    },
  )
}

export async function failAuthoritativeInterviewOperation(
  input: FailAuthoritativeInterviewOperationInput,
  dependencies: AuthoritativeInterviewRuntimeDependencies = {},
): Promise<ClaimAuthoritativeInterviewOperationResult> {
  assertWritesReady(dependencies)
  const userId = exactObjectId(input.userId, 'invalid_user_id', 'userId')
  const sessionId = exactObjectId(
    input.sessionId,
    'invalid_session_id',
    'sessionId',
  )
  const operationId = exactUuid(
    input.operationId,
    'invalid_operation_id',
    'operationId',
  )
  const claimToken = exactUuid(
    input.claimToken,
    'invalid_claim_token',
    'claimToken',
  )
  if (
    typeof input.failureCode !== 'string' ||
    !INTERVIEW_TURN_FAILURE_CODE_SET.has(
      input.failureCode,
    )
  ) {
    throw failure('invalid_failure_code', 'Failure code is invalid')
  }
  const failureCode = input.failureCode
  const claimTokenDigest = sha256(claimToken)
  const now = observedNow(dependencies.now)
  const store = dependencies.store ?? mongoAuthoritativeInterviewRuntimeStore

  return store.withOwnedSessionWrite(
    { userId, sessionId },
    async (transaction) => {
      const { authority, turn } = await exactClaimedTurn(transaction, {
        userId,
        sessionId,
        operationId,
        claimTokenDigest,
      })
      if (turn.state === 'failed') {
        if (turn.failureCode !== failureCode) {
          throw failure(
            'idempotency_conflict',
            'Failed operation is bound to a different failure code',
          )
        }
        return claimResult(
          turn,
          authority.config,
          authority.runtime,
          now,
          'failed',
        )
      }
      if (turn.state !== 'claimed') {
        throw failure('claim_lost', 'Interview operation is no longer claimed')
      }
      if (turn.claimExpiresAt.getTime() <= now.getTime()) {
        throw failure('claim_lost', 'Interview operation claim has expired')
      }
      const failed = await transaction.failTurn({
        runtime: authority.runtime,
        turn,
        claimTokenDigest,
        failureCode,
        now,
      })
      if (!failed) {
        throw failure(
          'turn_persistence_conflict',
          'Interview operation failure raced with another request',
        )
      }
      const runtime = await transaction.loadRuntime()
      if (!runtime) {
        throw failure('runtime_not_found', 'Interview runtime authority was lost')
      }
      return claimResult(
        failed,
        authority.config,
        runtime,
        now,
        'failed',
      )
    },
  )
}

export async function getAuthoritativeFirstTurnEvidence(
  input: { userId: unknown; sessionId: unknown },
  dependencies: AuthoritativeInterviewRuntimeDependencies = {},
): Promise<AuthoritativeFirstTurnEvidence> {
  const userId = exactObjectId(input.userId, 'invalid_user_id', 'userId')
  const sessionId = exactObjectId(
    input.sessionId,
    'invalid_session_id',
    'sessionId',
  )
  const store = dependencies.store ?? mongoAuthoritativeInterviewRuntimeStore
  return store.withOwnedSessionWrite(
    { userId, sessionId },
    async (transaction) => {
      const { runtime } = await validatedAuthority(
        transaction,
        userId,
        sessionId,
      )
      const linked =
        runtime.firstTurnRecordedAt &&
        runtime.firstTurnOperationId &&
        runtime.firstTurnId
      return {
        verified: true,
        userId,
        sessionId,
        runtimeId: runtime.id,
        authorityKind: runtime.authorityKind,
        usageId: runtime.usageId,
        entitlementSource: runtime.entitlementSource,
        entitlementSourceId: runtime.entitlementSourceId,
        periodKey: runtime.periodKey,
        firstTurnRecordedAt: linked
          ? new Date(runtime.firstTurnRecordedAt!)
          : null,
        firstTurnOperationId: linked
          ? runtime.firstTurnOperationId!
          : null,
        firstTurnId: linked ? runtime.firstTurnId! : null,
      }
    },
  )
}

/**
 * Authorizes one external provider/cache access without creating an
 * InterviewTurn or advancing any runtime/question ordinal.
 *
 * This read snapshot is intentionally separate from the durable operation
 * ledger: TTS can be prefetched or retried several times for one spoken turn,
 * so treating speech as an interview operation would consume and contend with
 * the canonical question flow. Callers must still acquire the shared
 * session-deletion provider drain before leaving MongoDB authority.
 */
export async function authorizeAuthoritativeInterviewProviderAccess(
  input: { userId: unknown; sessionId: unknown },
  dependencies:
    AuthoritativeInterviewProviderAccessDependencies = {},
): Promise<AuthoritativeInterviewProviderAccess> {
  if (
    process.env.NODE_ENV !== 'test' &&
    (
      dependencies.store !== undefined ||
      dependencies.now !== undefined ||
      dependencies.enforcementReady !== undefined
    )
  ) {
    throw failure(
      'not_ready',
      'Authoritative provider-access overrides are test-only',
    )
  }
  if (
    (dependencies.enforcementReady ??
      PR8_INTERVIEW_ENTITLEMENT_ENFORCEMENT_READY) !== true
  ) {
    throw failure(
      'not_ready',
      'Authoritative interview provider access is not enabled',
    )
  }

  const userId = exactObjectId(input.userId, 'invalid_user_id', 'userId')
  const sessionId = exactObjectId(
    input.sessionId,
    'invalid_session_id',
    'sessionId',
  )
  const now = observedNow(dependencies.now)
  const store =
    dependencies.store ??
    mongoAuthoritativeInterviewRuntimeReadStore

  return store.withOwnedSessionRead(
    { userId, sessionId },
    async (transaction) => {
      const { session, runtime } = await validatedAuthority(
        transaction,
        userId,
        sessionId,
      )
      if (
        session.status !== 'in_progress' ||
        runtime.state !== 'active'
      ) {
        throw failure(
          'runtime_state_invalid',
          'Interview runtime is not active',
        )
      }
      if (
        !runtime.startedAt ||
        !runtime.deadlineAt ||
        runtime.deadlineAt.getTime() -
          runtime.startedAt.getTime() !==
          runtime.normalizedDurationMinutes * 60_000
      ) {
        throw failure(
          'runtime_linkage_invalid',
          'Runtime deadline is invalid',
        )
      }
      if (now.getTime() >= runtime.deadlineAt.getTime()) {
        throw failure(
          'runtime_expired',
          'Interview runtime duration has expired',
        )
      }
      return Object.freeze({
        verified: true,
        userId,
        sessionId,
        runtimeId: runtime.id,
        normalizedDurationMinutes: runtime.normalizedDurationMinutes,
        authorizedAt: new Date(now),
        deadlineAt: new Date(runtime.deadlineAt),
      })
    },
  )
}

function asDate(value: unknown): Date | undefined {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    return undefined
  }
  return new Date(value)
}

function sessionRecord(value: Record<string, unknown>): RuntimeSessionRecord {
  return {
    id: String(value._id),
    userId: String(value.userId),
    organizationId: value.organizationId
      ? String(value.organizationId)
      : undefined,
    status: String(value.status ?? ''),
    deletionPendingAt: asDate(value.deletionPendingAt),
    startedAt: asDate(value.startedAt),
    completedAt: asDate(value.completedAt),
    config: value.config,
    plannedQuestionCount:
      typeof value.plannedQuestionCount === 'number'
        ? value.plannedQuestionCount
        : undefined,
  }
}

function runtimeRecord(value: Record<string, unknown>): RuntimeAuthorityRecord {
  return {
    id: String(value._id),
    sessionId: String(value.sessionId),
    userId: String(value.userId),
    authorityKind: value.authorityKind as InterviewRuntimeAuthorityKind,
    usageId: value.usageId ? String(value.usageId) : undefined,
    entitlementSource: value.entitlementSource as
      | InterviewUsageSource
      | undefined,
    entitlementSourceId: value.entitlementSourceId
      ? String(value.entitlementSourceId)
      : undefined,
    periodKey:
      typeof value.periodKey === 'string' ? value.periodKey : undefined,
    entitlementSnapshotDigest:
      typeof value.entitlementSnapshotDigest === 'string'
        ? value.entitlementSnapshotDigest
        : undefined,
    sessionConfigDigest: String(value.sessionConfigDigest ?? ''),
    normalizedDurationMinutes:
      value.normalizedDurationMinutes as NormalizedInterviewDurationMinutes,
    plannedMainQuestionCount: Number(value.plannedMainQuestionCount),
    state: value.state as InterviewRuntimeState,
    startedAt: asDate(value.startedAt),
    deadlineAt: asDate(value.deadlineAt),
    restoreUntil: asDate(value.restoreUntil),
    terminalAt: asDate(value.terminalAt),
    runtimeVersion: Number(value.runtimeVersion),
    nextTurnOrdinal: Number(value.nextTurnOrdinal),
    nextMainQuestionOrdinal: Number(value.nextMainQuestionOrdinal),
    mainQuestionReservationOperationId:
      typeof value.mainQuestionReservationOperationId === 'string'
        ? value.mainQuestionReservationOperationId
        : undefined,
    firstTurnRecordedAt: asDate(value.firstTurnRecordedAt),
    firstTurnOperationId:
      typeof value.firstTurnOperationId === 'string'
        ? value.firstTurnOperationId
        : undefined,
    firstTurnId: value.firstTurnId
      ? String(value.firstTurnId)
      : undefined,
  }
}

function usageRecord(value: Record<string, unknown>): RuntimeUsageRecord {
  return {
    id: String(value._id),
    sessionId: String(value.sessionId),
    userId: String(value.userId),
    source: value.source as InterviewUsageSource,
    sourceId: String(value.sourceId),
    periodKey:
      typeof value.periodKey === 'string' ? value.periodKey : undefined,
    normalizedDurationMinutes:
      value.normalizedDurationMinutes as NormalizedInterviewDurationMinutes,
    entitlementSnapshot: value.entitlementSnapshot,
    entitlementSnapshotDigest:
      typeof value.entitlementSnapshotDigest === 'string'
        ? value.entitlementSnapshotDigest
        : undefined,
    reservedAt: new Date(value.reservedAt as Date),
    consumedAt: asDate(value.consumedAt),
    restorationId: value.restorationId
      ? String(value.restorationId)
      : undefined,
  }
}

function turnRecord(value: Record<string, unknown>): RuntimeTurnRecord {
  return {
    id: String(value._id),
    runtimeId: String(value.runtimeId),
    sessionId: String(value.sessionId),
    userId: String(value.userId),
    operationId: String(value.operationId),
    operationKind: value.operationKind as InterviewRuntimeOperationKind,
    state: value.state as InterviewTurnState,
    ordinal: Number(value.ordinal),
    mainQuestionOrdinal:
      typeof value.mainQuestionOrdinal === 'number'
        ? value.mainQuestionOrdinal
        : undefined,
    parentTurnId: value.parentTurnId
      ? String(value.parentTurnId)
      : undefined,
    requestDigest: String(value.requestDigest),
    resultDigest:
      typeof value.resultDigest === 'string' ? value.resultDigest : undefined,
    resultArtifactCanonical:
      typeof value.resultArtifactCanonical === 'string'
        ? value.resultArtifactCanonical
        : undefined,
    claimTokenDigest: String(value.claimTokenDigest),
    claimExpiresAt: new Date(value.claimExpiresAt as Date),
    attemptCount: Number(value.attemptCount),
    failureCode:
      typeof value.failureCode === 'string' ? value.failureCode : undefined,
  }
}

export const mongoAuthoritativeInterviewRuntimeCreationStore:
  AuthoritativeInterviewRuntimeCreationStore = {
    async loadSession(input) {
      const row = await InterviewSession.findOne({
        _id: input.sessionId,
        userId: input.userId,
        deletionPendingAt: { $exists: false },
      })
        .select(
          'userId organizationId status deletionPendingAt startedAt completedAt config ' +
            'plannedQuestionCount',
        )
        .session(input.session)
        .lean()
      return row
        ? sessionRecord(row as unknown as Record<string, unknown>)
        : null
    },
    async loadUsage(input) {
      const row = await InterviewUsage.findOne({
        _id: input.usageId,
        sessionId: input.sessionId,
        userId: input.userId,
      }).session(input.session).lean()
      return row
        ? usageRecord(row as unknown as Record<string, unknown>)
        : null
    },
    async loadRuntime(input) {
      const row = await InterviewRuntime.findOne({
        sessionId: input.sessionId,
        userId: input.userId,
      }).session(input.session).lean()
      return row
        ? runtimeRecord(row as unknown as Record<string, unknown>)
        : null
    },
    async insertRuntime(input, session) {
      const [created] = await InterviewRuntime.create([{
        ...input,
        sessionId: new mongoose.Types.ObjectId(input.sessionId),
        userId: new mongoose.Types.ObjectId(input.userId),
        usageId: input.usageId
          ? new mongoose.Types.ObjectId(input.usageId)
          : undefined,
        entitlementSourceId: input.entitlementSourceId
          ? new mongoose.Types.ObjectId(input.entitlementSourceId)
          : undefined,
      }], { session })
      return runtimeRecord(
        created.toObject() as unknown as Record<string, unknown>,
      )
    },
  }

function mongoTransaction(
  session: ClientSession,
  userId: mongoose.Types.ObjectId,
  sessionId: mongoose.Types.ObjectId,
): AuthoritativeInterviewRuntimeTransaction {
  return {
    async loadSession() {
      const row = await InterviewSession.findOne({
        _id: sessionId,
        userId,
        deletionPendingAt: { $exists: false },
      })
        .select(
          'userId organizationId status deletionPendingAt startedAt completedAt config ' +
            'plannedQuestionCount',
        )
        .session(session)
        .lean()
      return row
        ? sessionRecord(row as unknown as Record<string, unknown>)
        : null
    },
    async loadRuntime() {
      const row = await InterviewRuntime.findOne({
        sessionId,
        userId,
      }).session(session).lean()
      return row
        ? runtimeRecord(row as unknown as Record<string, unknown>)
        : null
    },
    async loadUsage(usageId) {
      const row = await InterviewUsage.findOne({
        _id: new mongoose.Types.ObjectId(usageId),
        sessionId,
        userId,
      }).session(session).lean()
      return row
        ? usageRecord(row as unknown as Record<string, unknown>)
        : null
    },
    async loadTurnByOperationId(operationId) {
      const row = await InterviewTurn.findOne({
        sessionId,
        userId,
        operationId,
      }).session(session).lean()
      return row
        ? turnRecord(row as unknown as Record<string, unknown>)
        : null
    },
    async loadTurnById(turnId) {
      const row = await InterviewTurn.findOne({
        _id: new mongoose.Types.ObjectId(turnId),
        sessionId,
        userId,
      }).session(session).lean()
      return row
        ? turnRecord(row as unknown as Record<string, unknown>)
        : null
    },
    async markSessionEstablished(input) {
      const capabilityExpiresAt =
        new Date(
          input.startedAt.getTime() +
            SESSION_PERSONAL_DATA_CAPABILITY_MS,
        )
      const result = await InterviewSession.updateOne(
        {
          _id: sessionId,
          userId,
          deletionPendingAt: { $exists: false },
          status: 'created',
          startedAt: { $exists: false },
        },
        {
          $set: {
            status: 'in_progress',
            startedAt: input.startedAt,
            personalDataWriteCapabilityExpiresAt:
              capabilityExpiresAt,
          },
        },
        { session, runValidators: true },
      )
      if (
        result.matchedCount !== 1 ||
        result.modifiedCount !== 1
      ) return false
      const userDrain = await User.updateOne(
        { _id: userId },
        {
          $max: {
            externalDataWriteDrainUntil:
              capabilityExpiresAt,
          },
        },
        { session },
      )
      return userDrain.matchedCount === 1
    },
    async insertClaimAndAdvanceRuntime(claim, transition) {
      const update: Record<string, unknown> = {
        $inc: {
          runtimeVersion: 1,
          nextTurnOrdinal: 1,
        },
        $set: {
          lastActivityAt: claim.claimedAt,
          ...(transition.mainQuestionReservationOperationId
            ? {
                mainQuestionReservationOperationId:
                  transition.mainQuestionReservationOperationId,
              }
            : {}),
          ...(transition.nextState ? { state: transition.nextState } : {}),
          ...(transition.startedAt ? { startedAt: transition.startedAt } : {}),
          ...(transition.deadlineAt ? { deadlineAt: transition.deadlineAt } : {}),
          ...(transition.restoreUntil
            ? { restoreUntil: transition.restoreUntil }
            : {}),
        },
      }
      const updatedRuntime = await InterviewRuntime.findOneAndUpdate(
        {
          _id: new mongoose.Types.ObjectId(claim.runtimeId),
          sessionId,
          userId,
          runtimeVersion: transition.expectedRuntimeVersion,
          state: transition.expectedState,
          ...(transition.mainQuestionReservationOperationId
            ? {
                mainQuestionReservationOperationId: {
                  $exists: false,
                },
                nextMainQuestionOrdinal: claim.mainQuestionOrdinal,
                $expr: {
                  $lt: [
                    '$nextMainQuestionOrdinal',
                    '$plannedMainQuestionCount',
                  ],
                },
              }
            : {}),
        },
        update,
        { returnDocument: 'after', session, runValidators: true },
      ).lean()
      if (!updatedRuntime) return null
      const [created] = await InterviewTurn.create(
        [{
          ...claim,
          runtimeId: new mongoose.Types.ObjectId(claim.runtimeId),
          sessionId,
          userId,
          parentTurnId: claim.parentTurnId
            ? new mongoose.Types.ObjectId(claim.parentTurnId)
            : undefined,
          state: 'claimed',
          attemptCount: 1,
        }],
        { session },
      )
      return {
        runtime: runtimeRecord(
          updatedRuntime as unknown as Record<string, unknown>,
        ),
        turn: turnRecord(
          created.toObject() as unknown as Record<string, unknown>,
        ),
      }
    },
    async reclaimExpiredTurn(input) {
      const row = await InterviewTurn.findOneAndUpdate(
        {
          _id: new mongoose.Types.ObjectId(input.turnId),
          sessionId,
          userId,
          state: 'claimed',
          claimTokenDigest: input.priorClaimTokenDigest,
          claimExpiresAt: { $lte: input.now },
        },
        {
          $set: {
            claimTokenDigest: input.claimTokenDigest,
            claimExpiresAt: input.claimExpiresAt,
          },
          $inc: { attemptCount: 1 },
        },
        { returnDocument: 'after', session, runValidators: true },
      ).lean()
      return row
        ? turnRecord(row as unknown as Record<string, unknown>)
        : null
    },
    async supersedeClaimedTurnsForTerminal(input) {
      const rows = await InterviewTurn.find({
        runtimeId: new mongoose.Types.ObjectId(input.runtime.id),
        sessionId,
        userId,
        state: 'claimed',
        operationKind: {
          $nin: [
            'session_start',
            'complete_session',
            'abandon_session',
          ],
        },
      })
        .select('_id operationId operationKind mainQuestionOrdinal')
        .session(session)
        .lean()
      const questionRows = rows.filter(
        (row) => row.operationKind === 'generate_question',
      )
      const reservedOperationId =
        input.runtime.mainQuestionReservationOperationId
      if (
        reservedOperationId
          ? (
              questionRows.length !== 1 ||
              questionRows[0]?.operationId !==
                reservedOperationId ||
              questionRows[0]?.mainQuestionOrdinal !==
                input.runtime.nextMainQuestionOrdinal
            )
          : questionRows.length !== 0
      ) {
        return null
      }
      if (rows.length === 0) return input.runtime

      const turnResult = await InterviewTurn.updateMany(
        {
          _id: { $in: rows.map((row) => row._id) },
          runtimeId: new mongoose.Types.ObjectId(input.runtime.id),
          sessionId,
          userId,
          state: 'claimed',
        },
        {
          $set: {
            state: 'failed',
            failedAt: input.now,
            failureCode: 'superseded_by_terminal',
          },
          $unset: {
            resultDigest: '',
            resultArtifactCanonical: '',
            completedAt: '',
          },
        },
        { session, runValidators: true },
      )
      if (turnResult.matchedCount !== rows.length) return null

      const updatedRuntime = await InterviewRuntime.findOneAndUpdate(
        {
          _id: new mongoose.Types.ObjectId(input.runtime.id),
          sessionId,
          userId,
          state: 'active',
          runtimeVersion: input.runtime.runtimeVersion,
          terminalAt: { $exists: false },
          ...(reservedOperationId
            ? {
                mainQuestionReservationOperationId:
                  reservedOperationId,
              }
            : {
                mainQuestionReservationOperationId: {
                  $exists: false,
                },
              }),
        },
        {
          $set: { lastActivityAt: input.now },
          $inc: { runtimeVersion: 1 },
          ...(reservedOperationId
            ? {
                $unset: {
                  mainQuestionReservationOperationId: '',
                },
              }
            : {}),
        },
        { returnDocument: 'after', session, runValidators: true },
      ).lean()
      return updatedRuntime
        ? runtimeRecord(
            updatedRuntime as unknown as Record<string, unknown>,
          )
        : null
    },
    async completeTurn(input) {
      const terminalStatus =
        input.turn.operationKind === 'complete_session'
          ? 'completed'
          : input.turn.operationKind === 'abandon_session'
            ? 'abandoned'
            : undefined
      if (terminalStatus) {
        const sessionResult = await InterviewSession.updateOne(
          {
            _id: sessionId,
            userId,
            status: 'in_progress',
            startedAt: input.runtime.startedAt,
            completedAt: { $exists: false },
            deletionPendingAt: { $exists: false },
          },
          {
            $set: {
              status: terminalStatus,
              completedAt: input.now,
            },
          },
          { session, runValidators: true },
        )
        if (sessionResult.matchedCount !== 1) return null
      }
      const row = await InterviewTurn.findOneAndUpdate(
        {
          _id: new mongoose.Types.ObjectId(input.turn.id),
          sessionId,
          userId,
          state: 'claimed',
          claimTokenDigest: input.claimTokenDigest,
        },
        {
          $set: {
            state: 'completed',
            resultDigest: input.resultDigest,
            ...(input.resultArtifactCanonical
              ? {
                  resultArtifactCanonical:
                    input.resultArtifactCanonical,
                }
              : {}),
            completedAt: input.now,
          },
          $unset: { failureCode: '', failedAt: '' },
        },
        { returnDocument: 'after', session, runValidators: true },
      ).lean()
      if (!row) return null

      const runtimeFilter: Record<string, unknown> = {
        _id: new mongoose.Types.ObjectId(input.runtime.id),
        sessionId,
        userId,
        state: 'active',
        runtimeVersion: input.runtime.runtimeVersion,
      }
      const runtimeSet: Record<string, unknown> = {
        lastActivityAt: input.now,
      }
      const questionGeneration =
        input.turn.operationKind === 'generate_question'
      if (questionGeneration) {
        runtimeFilter.mainQuestionReservationOperationId =
          input.turn.operationId
        runtimeFilter.nextMainQuestionOrdinal =
          input.turn.mainQuestionOrdinal
      }
      if (input.turn.operationKind === 'complete_session') {
        runtimeFilter.state = 'completing'
        runtimeSet.state = 'completed'
        runtimeSet.terminalAt = input.now
      } else if (input.turn.operationKind === 'abandon_session') {
        runtimeFilter.state = 'completing'
        runtimeSet.state = 'abandoned'
        runtimeSet.terminalAt = input.now
      }
      const runtimeIncrement: Record<string, number> = {
        runtimeVersion: 1,
        ...(questionGeneration
          ? { nextMainQuestionOrdinal: 1 }
          : {}),
      }
      const runtimeUpdate = (
        set: Record<string, unknown>,
      ): Record<string, unknown> => ({
        $set: set,
        $inc: runtimeIncrement,
        ...(questionGeneration
          ? {
              $unset: {
                mainQuestionReservationOperationId: '',
              },
            }
          : {}),
      })
      let updatedRuntime
      if (input.recordFirstTurn) {
        updatedRuntime = await InterviewRuntime.findOneAndUpdate(
          {
            ...runtimeFilter,
            firstTurnRecordedAt: { $exists: false },
          },
          runtimeUpdate({
            ...runtimeSet,
            firstTurnRecordedAt: input.now,
            firstTurnOperationId: input.turn.operationId,
            firstTurnId: new mongoose.Types.ObjectId(input.turn.id),
          }),
          { returnDocument: 'after', session, runValidators: true },
        ).lean()
      }
      if (!updatedRuntime) {
        updatedRuntime = await InterviewRuntime.findOneAndUpdate(
          runtimeFilter,
          runtimeUpdate(runtimeSet),
          { returnDocument: 'after', session, runValidators: true },
        ).lean()
      }
      if (!updatedRuntime) return null
      return {
        runtime: runtimeRecord(
          updatedRuntime as unknown as Record<string, unknown>,
        ),
        turn: turnRecord(row as unknown as Record<string, unknown>),
      }
    },
    async failTurn(input) {
      const row = await InterviewTurn.findOneAndUpdate(
        {
          _id: new mongoose.Types.ObjectId(input.turn.id),
          sessionId,
          userId,
          state: 'claimed',
          claimTokenDigest: input.claimTokenDigest,
        },
        {
          $set: {
            state: 'failed',
            failureCode: input.failureCode,
            failedAt: input.now,
          },
        },
        { returnDocument: 'after', session, runValidators: true },
      ).lean()
      if (!row) return null
      const terminalClaim = TERMINAL_OPERATION_KINDS.has(
        input.turn.operationKind,
      )
      const questionGeneration =
        input.turn.operationKind === 'generate_question'
      const nextState =
        input.runtime.deadlineAt &&
        input.runtime.deadlineAt.getTime() <= input.now.getTime()
          ? 'expired'
          : 'active'
      const updated = await InterviewRuntime.updateOne(
        {
          _id: new mongoose.Types.ObjectId(input.runtime.id),
          sessionId,
          userId,
          state: terminalClaim ? 'completing' : 'active',
          runtimeVersion: input.runtime.runtimeVersion,
          ...(questionGeneration
            ? {
                mainQuestionReservationOperationId:
                  input.turn.operationId,
                nextMainQuestionOrdinal:
                  input.turn.mainQuestionOrdinal,
              }
            : {}),
        },
        {
          $set: {
            lastActivityAt: input.now,
            ...(terminalClaim ? { state: nextState } : {}),
          },
          $inc: { runtimeVersion: 1 },
          ...(questionGeneration
            ? {
                $unset: {
                  mainQuestionReservationOperationId: '',
                },
              }
            : {}),
        },
        { session, runValidators: true },
      )
      if (updated.matchedCount !== 1) return null
      return turnRecord(row as unknown as Record<string, unknown>)
    },
  }
}

export const mongoAuthoritativeInterviewRuntimeStore:
  AuthoritativeInterviewRuntimeStore = {
    async withOwnedSessionWrite(input, work) {
      await connectDB()
      return withSessionPersonalDataWriteTransaction(
        input.userId,
        input.sessionId,
        async (session, userId, sessionId) =>
          work(mongoTransaction(session, userId, sessionId)),
      )
    },
  }

const mongoAuthoritativeInterviewRuntimeReadStore:
  AuthoritativeInterviewRuntimeReadStore = {
    async withOwnedSessionRead(input, work) {
      await connectDB()
      const mongoSession = await mongoose.startSession()
      try {
        let completed = false
        let result!: Awaited<ReturnType<typeof work>>
        await mongoSession.withTransaction(async () => {
          result = await work(mongoTransaction(
            mongoSession,
            new mongoose.Types.ObjectId(input.userId),
            new mongoose.Types.ObjectId(input.sessionId),
          ))
          completed = true
        }, {
          readConcern: { level: 'snapshot' },
          writeConcern: { w: 'majority' },
          readPreference: 'primary',
        })
        if (!completed) {
          throw failure(
            'runtime_conflict',
            'Authoritative provider-access snapshot returned no result',
          )
        }
        return result
      } finally {
        await mongoSession.endSession()
      }
    },
  }
