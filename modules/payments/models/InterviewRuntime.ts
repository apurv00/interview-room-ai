import { createHash } from 'node:crypto'
import mongoose, { Document, Model, Schema } from 'mongoose'
import {
  INTERVIEW_USAGE_SOURCES,
  NORMALIZED_INTERVIEW_DURATIONS_MINUTES,
  type InterviewUsageSource,
  type NormalizedInterviewDurationMinutes,
} from './InterviewUsage'

export const INTERVIEW_RUNTIME_AUTHORITY_KINDS = [
  'consumer_usage',
  'organization_invite',
] as const
export type InterviewRuntimeAuthorityKind =
  (typeof INTERVIEW_RUNTIME_AUTHORITY_KINDS)[number]

export const INTERVIEW_RUNTIME_STATES = [
  'reserved',
  'active',
  'completing',
  'completed',
  'abandoned',
  'expired',
] as const
export type InterviewRuntimeState = (typeof INTERVIEW_RUNTIME_STATES)[number]

export const INTERVIEW_RUNTIME_OPERATION_KINDS = [
  'session_start',
  'present_question',
  'generate_question',
  'evaluate_answer',
  'turn_router',
  'clarify_coding',
  'clarify_case_context',
  'answer_candidate_question',
  'evaluate_code',
  'evaluate_design',
  'complete_session',
  'abandon_session',
] as const
export type InterviewRuntimeOperationKind =
  (typeof INTERVIEW_RUNTIME_OPERATION_KINDS)[number]

export const INTERVIEW_TURN_STATES = [
  'claimed',
  'completed',
  'failed',
] as const
export type InterviewTurnState = (typeof INTERVIEW_TURN_STATES)[number]

export const INTERVIEW_TURN_FAILURE_CODES = [
  'operation_handler_failed',
  'operation_result_invalid',
  'provider_reservation_failed',
  'provider_timeout',
  'model_timeout',
  'superseded_by_terminal',
] as const
export type InterviewTurnFailureCode =
  (typeof INTERVIEW_TURN_FAILURE_CODES)[number]

export const INTERVIEW_RESULT_ARTIFACT_MAX_BYTES = 128 * 1024
export const INTERVIEW_RESULT_ARTIFACT_MAX_DEPTH = 20
export const INTERVIEW_RESULT_ARTIFACT_MAX_NODES = 4_096

export type InterviewResultArtifactJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly InterviewResultArtifactJsonValue[]
  | {
      readonly [key: string]: InterviewResultArtifactJsonValue
    }

export type InterviewResultArtifact = Readonly<
  Record<string, InterviewResultArtifactJsonValue>
>

export interface IInterviewRuntime extends Document {
  _id: mongoose.Types.ObjectId
  sessionId: mongoose.Types.ObjectId
  userId: mongoose.Types.ObjectId
  authorityKind: InterviewRuntimeAuthorityKind

  usageId?: mongoose.Types.ObjectId
  entitlementSource?: InterviewUsageSource
  entitlementSourceId?: mongoose.Types.ObjectId
  periodKey?: string
  entitlementSnapshotDigest?: string

  organizationId?: mongoose.Types.ObjectId
  inviteAuthorityId?: string
  recruiterUserId?: mongoose.Types.ObjectId
  recruiterReferenceErasedAt?: Date
  inviteVerifiedAt?: Date
  inviteProvenanceDigest?: string

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
  firstTurnId?: mongoose.Types.ObjectId
  restorationRecoveryReviewedAt?: Date
  restorationRecoveryReviewCode?: 'evidence_denied' | 'period_mismatch'
  lastActivityAt?: Date
  createdAt: Date
  updatedAt: Date
}

export interface IInterviewTurn extends Document {
  _id: mongoose.Types.ObjectId
  runtimeId: mongoose.Types.ObjectId
  sessionId: mongoose.Types.ObjectId
  userId: mongoose.Types.ObjectId
  operationId: string
  operationKind: InterviewRuntimeOperationKind
  state: InterviewTurnState
  ordinal: number
  mainQuestionOrdinal?: number
  parentTurnId?: mongoose.Types.ObjectId
  requestDigest: string
  resultDigest?: string
  resultArtifactCanonical?: string
  claimTokenDigest: string
  claimExpiresAt: Date
  attemptCount: number
  claimedAt: Date
  completedAt?: Date
  failedAt?: Date
  failureCode?: InterviewTurnFailureCode
  createdAt: Date
  updatedAt: Date
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/
const UUID_V4_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/
const RESULT_ARTIFACT_MAX_KEYS_PER_OBJECT = 256
const RESULT_ARTIFACT_MAX_ARRAY_LENGTH = 1_024
const RESULT_ARTIFACT_MAX_KEY_BYTES = 256
const RESULT_ARTIFACT_MAX_STRING_BYTES = 64 * 1024
const FORBIDDEN_RESULT_ARTIFACT_KEYS = new Set([
  '__proto__',
  'constructor',
  'prototype',
  'claimtoken',
  'claimtokendigest',
  'requestdigest',
])

interface ResultArtifactCanonicalizationState {
  nodes: number
  seen: Set<object>
}

function normalizedArtifactKey(key: string): string {
  return key.replace(/[-_\s]/g, '').toLowerCase()
}

function canonicalResultArtifactValue(
  value: unknown,
  depth: number,
  state: ResultArtifactCanonicalizationState,
): InterviewResultArtifactJsonValue {
  if (depth > INTERVIEW_RESULT_ARTIFACT_MAX_DEPTH) {
    throw new Error('Result artifact nesting exceeds the runtime bound')
  }
  state.nodes += 1
  if (state.nodes > INTERVIEW_RESULT_ARTIFACT_MAX_NODES) {
    throw new Error('Result artifact contains too many JSON values')
  }
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'string') {
    if (Buffer.byteLength(value, 'utf8') > RESULT_ARTIFACT_MAX_STRING_BYTES) {
      throw new Error('Result artifact string exceeds the runtime bound')
    }
    return value
  }
  if (typeof value === 'number') {
    if (
      !Number.isFinite(value) ||
      (Number.isInteger(value) && !Number.isSafeInteger(value))
    ) {
      throw new Error('Result artifact number is not safe JSON')
    }
    return Object.is(value, -0) ? 0 : value
  }
  if (!value || typeof value !== 'object') {
    throw new Error('Result artifact contains a non-JSON value')
  }
  if (state.seen.has(value)) {
    throw new Error('Result artifact contains a cycle')
  }
  state.seen.add(value)
  try {
    if (Array.isArray(value)) {
      if (value.length > RESULT_ARTIFACT_MAX_ARRAY_LENGTH) {
        throw new Error('Result artifact array exceeds the runtime bound')
      }
      const ownKeys = Reflect.ownKeys(value)
      if (
        ownKeys.some(
          (key) =>
            typeof key !== 'string' ||
            (key !== 'length' && !/^(0|[1-9]\d*)$/.test(key)),
        )
      ) {
        throw new Error('Result artifact array has unsupported properties')
      }
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) {
          throw new Error('Result artifact arrays cannot be sparse')
        }
      }
      return value.map((entry) =>
        canonicalResultArtifactValue(entry, depth + 1, state),
      )
    }

    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error('Result artifact objects must be plain JSON objects')
    }
    const ownKeys = Reflect.ownKeys(value)
    if (
      ownKeys.length > RESULT_ARTIFACT_MAX_KEYS_PER_OBJECT ||
      ownKeys.some((key) => typeof key !== 'string')
    ) {
      throw new Error('Result artifact object keys exceed the runtime bound')
    }
    const source = value as Record<string, unknown>
    const canonical: Record<string, InterviewResultArtifactJsonValue> = {}
    for (const key of (ownKeys as string[]).sort()) {
      if (
        Buffer.byteLength(key, 'utf8') > RESULT_ARTIFACT_MAX_KEY_BYTES ||
        FORBIDDEN_RESULT_ARTIFACT_KEYS.has(normalizedArtifactKey(key))
      ) {
        throw new Error('Result artifact contains a forbidden key')
      }
      const descriptor = Object.getOwnPropertyDescriptor(source, key)
      if (
        !descriptor ||
        !descriptor.enumerable ||
        !('value' in descriptor) ||
        descriptor.value === undefined
      ) {
        throw new Error('Result artifact object is not strict JSON')
      }
      canonical[key] = canonicalResultArtifactValue(
        descriptor.value,
        depth + 1,
        state,
      )
    }
    return canonical
  } finally {
    state.seen.delete(value)
  }
}

export function canonicalizeInterviewResultArtifact(
  value: unknown,
): string {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    (
      Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null
    )
  ) {
    throw new Error('Result artifact must be a plain JSON object')
  }
  const canonical = canonicalResultArtifactValue(value, 0, {
    nodes: 0,
    seen: new Set(),
  })
  const serialized = JSON.stringify(canonical)
  if (
    Buffer.byteLength(serialized, 'utf8') >
      INTERVIEW_RESULT_ARTIFACT_MAX_BYTES
  ) {
    throw new Error('Result artifact exceeds the runtime byte bound')
  }
  return serialized
}

export function parseCanonicalInterviewResultArtifact(
  serialized: unknown,
): InterviewResultArtifact {
  if (
    typeof serialized !== 'string' ||
    Buffer.byteLength(serialized, 'utf8') >
      INTERVIEW_RESULT_ARTIFACT_MAX_BYTES
  ) {
    throw new Error('Canonical result artifact is invalid')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(serialized)
  } catch {
    throw new Error('Canonical result artifact is invalid JSON')
  }
  if (canonicalizeInterviewResultArtifact(parsed) !== serialized) {
    throw new Error('Result artifact is not in canonical form')
  }
  return parsed as InterviewResultArtifact
}

function artifactContainsExactString(
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
      artifactContainsExactString(entry, sensitive),
    )
  }
  if (value && typeof value === 'object') {
    return Object.values(value).some((entry) =>
      artifactContainsExactString(entry, sensitive),
    )
  }
  return false
}

const InterviewRuntimeSchema = new Schema<IInterviewRuntime>(
  {
    sessionId: {
      type: Schema.Types.ObjectId,
      ref: 'InterviewSession',
      required: true,
      immutable: true,
    },
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      immutable: true,
    },
    authorityKind: {
      type: String,
      enum: INTERVIEW_RUNTIME_AUTHORITY_KINDS,
      required: true,
      immutable: true,
    },
    usageId: {
      type: Schema.Types.ObjectId,
      ref: 'InterviewUsage',
      immutable: true,
    },
    entitlementSource: {
      type: String,
      enum: INTERVIEW_USAGE_SOURCES,
      immutable: true,
    },
    entitlementSourceId: {
      type: Schema.Types.ObjectId,
      immutable: true,
    },
    periodKey: {
      type: String,
      trim: true,
      minlength: 1,
      maxlength: 255,
      immutable: true,
    },
    entitlementSnapshotDigest: {
      type: String,
      match: SHA256_PATTERN,
      immutable: true,
    },
    organizationId: {
      type: Schema.Types.ObjectId,
      ref: 'Organization',
      immutable: true,
    },
    inviteAuthorityId: {
      type: String,
      match: UUID_V4_PATTERN,
      immutable: true,
    },
    recruiterUserId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
    },
    recruiterReferenceErasedAt: { type: Date },
    inviteVerifiedAt: { type: Date, immutable: true },
    inviteProvenanceDigest: {
      type: String,
      match: SHA256_PATTERN,
      immutable: true,
    },
    sessionConfigDigest: {
      type: String,
      required: true,
      match: SHA256_PATTERN,
      immutable: true,
    },
    normalizedDurationMinutes: {
      type: Number,
      enum: NORMALIZED_INTERVIEW_DURATIONS_MINUTES,
      required: true,
      immutable: true,
    },
    plannedMainQuestionCount: {
      type: Number,
      min: 1,
      max: 500,
      required: true,
      immutable: true,
    },
    state: {
      type: String,
      enum: INTERVIEW_RUNTIME_STATES,
      required: true,
      default: 'reserved',
    },
    startedAt: { type: Date },
    deadlineAt: { type: Date },
    restoreUntil: { type: Date },
    terminalAt: { type: Date },
    runtimeVersion: { type: Number, min: 0, default: 0 },
    nextTurnOrdinal: { type: Number, min: 0, default: 0 },
    nextMainQuestionOrdinal: { type: Number, min: 0, default: 0 },
    mainQuestionReservationOperationId: {
      type: String,
      match: UUID_V4_PATTERN,
    },
    firstTurnRecordedAt: { type: Date },
    firstTurnOperationId: {
      type: String,
      match: UUID_V4_PATTERN,
    },
    firstTurnId: {
      type: Schema.Types.ObjectId,
      ref: 'InterviewTurn',
    },
    restorationRecoveryReviewedAt: { type: Date },
    restorationRecoveryReviewCode: {
      type: String,
      enum: ['evidence_denied', 'period_mismatch'],
    },
    lastActivityAt: { type: Date },
  },
  { timestamps: true },
)

InterviewRuntimeSchema.pre('validate', function validateAuthorityLinkage() {
  const consumer = this.authorityKind === 'consumer_usage'
  const periodOwned =
    this.entitlementSource === 'free_period' ||
    this.entitlementSource === 'subscription_cycle' ||
    this.entitlementSource === 'subscription_grace'

  if (consumer) {
    if (
      !this.usageId ||
      !this.entitlementSource ||
      !this.entitlementSourceId ||
      !this.entitlementSnapshotDigest
    ) {
      this.invalidate(
        'authorityKind',
        'Consumer runtime authority requires exact usage linkage',
      )
    }
    if (periodOwned && !this.periodKey) {
      this.invalidate(
        'periodKey',
        'Period-backed runtime authority requires periodKey',
      )
    }
    if (
      this.organizationId ||
      this.inviteAuthorityId ||
      this.recruiterUserId ||
      this.recruiterReferenceErasedAt ||
      this.inviteVerifiedAt ||
      this.inviteProvenanceDigest
    ) {
      this.invalidate(
        'authorityKind',
        'Consumer runtime authority cannot carry invite provenance',
      )
    }
  } else {
    if (
      !this.organizationId ||
      !this.inviteAuthorityId ||
      !this.inviteVerifiedAt ||
      !this.inviteProvenanceDigest
    ) {
      this.invalidate(
        'authorityKind',
        'Organization runtime authority requires verified invite provenance',
      )
    }
    const hasRecruiter = Boolean(this.recruiterUserId)
    const hasErasureMarker =
      this.recruiterReferenceErasedAt instanceof Date &&
      Number.isFinite(this.recruiterReferenceErasedAt.getTime())
    if (hasRecruiter === hasErasureMarker) {
      this.invalidate(
        'recruiterUserId',
        'Organization runtime authority requires recruiter attribution or its erasure marker',
      )
    }
    if (
      this.usageId ||
      this.entitlementSource ||
      this.entitlementSourceId ||
      this.periodKey ||
      this.entitlementSnapshotDigest
    ) {
      this.invalidate(
        'authorityKind',
        'Organization runtime authority cannot carry consumer usage linkage',
      )
    }
  }

  const hasStarted = this.startedAt instanceof Date
  const hasDeadline = this.deadlineAt instanceof Date
  if (hasStarted !== hasDeadline) {
    this.invalidate(
      'deadlineAt',
      'Runtime start and deadline must be recorded together',
    )
  }
  if (
    hasStarted &&
    hasDeadline &&
    this.deadlineAt!.getTime() <= this.startedAt!.getTime()
  ) {
    this.invalidate('deadlineAt', 'Runtime deadline must follow its start')
  }
  if (
    this.restoreUntil &&
    hasDeadline &&
    this.restoreUntil.getTime() < this.deadlineAt!.getTime()
  ) {
    this.invalidate(
      'restoreUntil',
      'Runtime restore window cannot end before its deadline',
    )
  }
  if (
    !Number.isInteger(this.nextTurnOrdinal) ||
    !Number.isInteger(this.nextMainQuestionOrdinal) ||
    !Number.isInteger(this.plannedMainQuestionCount) ||
    this.nextMainQuestionOrdinal > this.plannedMainQuestionCount
  ) {
    this.invalidate(
      'nextMainQuestionOrdinal',
      'Runtime question counters must stay within the captured plan',
    )
  }
  if (
    this.mainQuestionReservationOperationId &&
    (
      this.state !== 'active' ||
      this.nextMainQuestionOrdinal >= this.plannedMainQuestionCount
    )
  ) {
    this.invalidate(
      'mainQuestionReservationOperationId',
      'Main-question reservation must reference an available active slot',
    )
  }

  const firstTurnLinkCount = [
    this.firstTurnRecordedAt,
    this.firstTurnOperationId,
    this.firstTurnId,
  ].filter(Boolean).length
  if (firstTurnLinkCount !== 0 && firstTurnLinkCount !== 3) {
    this.invalidate(
      'firstTurnRecordedAt',
      'First-turn evidence must be recorded as one complete linkage',
    )
  }
  const reviewLinkCount = [
    this.restorationRecoveryReviewedAt,
    this.restorationRecoveryReviewCode,
  ].filter(Boolean).length
  if (reviewLinkCount !== 0 && (reviewLinkCount !== 2 || !consumer)) {
    this.invalidate(
      'restorationRecoveryReviewedAt',
      'Restoration recovery review requires complete consumer linkage',
    )
  }
})

InterviewRuntimeSchema.index(
  { sessionId: 1 },
  { unique: true, name: 'interview_runtime_session_unique_v1' },
)
InterviewRuntimeSchema.index(
  { usageId: 1 },
  {
    unique: true,
    partialFilterExpression: { usageId: { $type: 'objectId' } },
    name: 'interview_runtime_usage_unique_v1',
  },
)
InterviewRuntimeSchema.index(
  { userId: 1, state: 1, updatedAt: -1 },
  { name: 'interview_runtime_user_state_v1' },
)
InterviewRuntimeSchema.index(
  { state: 1, deadlineAt: 1 },
  { name: 'interview_runtime_deadline_v1' },
)
InterviewRuntimeSchema.index(
  { organizationId: 1, state: 1, updatedAt: -1 },
  {
    partialFilterExpression: { organizationId: { $type: 'objectId' } },
    name: 'interview_runtime_org_state_v1',
  },
)
InterviewRuntimeSchema.index(
  { recruiterUserId: 1, updatedAt: -1 },
  {
    partialFilterExpression: {
      recruiterUserId: { $type: 'objectId' },
    },
    name: 'interview_runtime_recruiter_reference_v1',
  },
)

const InterviewTurnSchema = new Schema<IInterviewTurn>(
  {
    runtimeId: {
      type: Schema.Types.ObjectId,
      ref: 'InterviewRuntime',
      required: true,
      immutable: true,
    },
    sessionId: {
      type: Schema.Types.ObjectId,
      ref: 'InterviewSession',
      required: true,
      immutable: true,
    },
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      immutable: true,
    },
    operationId: {
      type: String,
      required: true,
      match: UUID_V4_PATTERN,
      immutable: true,
    },
    operationKind: {
      type: String,
      enum: INTERVIEW_RUNTIME_OPERATION_KINDS,
      required: true,
      immutable: true,
    },
    state: {
      type: String,
      enum: INTERVIEW_TURN_STATES,
      required: true,
      default: 'claimed',
    },
    ordinal: { type: Number, min: 0, required: true, immutable: true },
    mainQuestionOrdinal: {
      type: Number,
      min: 0,
      immutable: true,
    },
    parentTurnId: {
      type: Schema.Types.ObjectId,
      ref: 'InterviewTurn',
      immutable: true,
    },
    requestDigest: {
      type: String,
      required: true,
      match: SHA256_PATTERN,
      immutable: true,
    },
    resultDigest: { type: String, match: SHA256_PATTERN },
    resultArtifactCanonical: {
      type: String,
    },
    claimTokenDigest: {
      type: String,
      required: true,
      match: SHA256_PATTERN,
    },
    claimExpiresAt: { type: Date, required: true },
    attemptCount: { type: Number, min: 1, default: 1 },
    claimedAt: { type: Date, required: true },
    completedAt: { type: Date },
    failedAt: { type: Date },
    failureCode: {
      type: String,
      enum: INTERVIEW_TURN_FAILURE_CODES,
    },
  },
  { timestamps: true },
)

InterviewTurnSchema.pre('validate', function validateTurnState() {
  if (
    !Number.isInteger(this.ordinal) ||
    (
      this.mainQuestionOrdinal !== undefined &&
      !Number.isInteger(this.mainQuestionOrdinal)
    ) ||
    !Number.isInteger(this.attemptCount)
  ) {
    this.invalidate('ordinal', 'Turn counters must be integers')
  }
  if (this.claimExpiresAt <= this.claimedAt) {
    this.invalidate(
      'claimExpiresAt',
      'Turn claim expiry must follow its claim time',
    )
  }
  if (
    this.state === 'claimed' &&
    (
      this.resultDigest ||
      this.resultArtifactCanonical ||
      this.completedAt ||
      this.failureCode ||
      this.failedAt
    )
  ) {
    this.invalidate('state', 'Claimed turns cannot carry terminal state')
  }
  if (
    this.state === 'completed' &&
    (
      !this.resultDigest ||
      !this.completedAt ||
      this.failureCode ||
      this.failedAt
    )
  ) {
    this.invalidate(
      'state',
      'Completed turns require only completed result evidence',
    )
  }
  if (
    this.state === 'failed' &&
    (
      !this.failureCode ||
      !this.failedAt ||
      this.resultDigest ||
      this.resultArtifactCanonical ||
      this.completedAt
    )
  ) {
    this.invalidate(
      'state',
      'Failed turns require only stable failure evidence',
    )
  }
  const isQuestionGeneration =
    this.operationKind === 'generate_question'
  if (
    (isQuestionGeneration && this.mainQuestionOrdinal === undefined) ||
    (!isQuestionGeneration && this.mainQuestionOrdinal !== undefined)
  ) {
    this.invalidate(
      'mainQuestionOrdinal',
      'Main-question ordinal must belong only to question generation',
    )
  }
  const requiresResultArtifact =
    this.state === 'completed' &&
    this.operationKind !== 'session_start'
  if (
    requiresResultArtifact !==
      (this.resultArtifactCanonical !== undefined)
  ) {
    this.invalidate(
      'resultArtifactCanonical',
      'Completed operations require exactly one durable response artifact',
    )
  } else if (requiresResultArtifact) {
    try {
      const artifact = parseCanonicalInterviewResultArtifact(
        this.resultArtifactCanonical,
      )
      const artifactDigest = createHash('sha256')
        .update(this.resultArtifactCanonical!, 'utf8')
        .digest('hex')
      if (
        artifactDigest !== this.resultDigest ||
        artifactContainsExactString(
          artifact,
          new Set([this.requestDigest, this.claimTokenDigest]),
        )
      ) {
        this.invalidate(
          'resultArtifactCanonical',
          'Response artifact linkage is invalid',
        )
      }
    } catch {
      this.invalidate(
        'resultArtifactCanonical',
        'Response artifact linkage is invalid',
      )
    }
  }
})

InterviewTurnSchema.index(
  { sessionId: 1, operationId: 1 },
  { unique: true, name: 'interview_turn_operation_unique_v1' },
)
InterviewTurnSchema.index(
  { runtimeId: 1, ordinal: 1 },
  { unique: true, name: 'interview_turn_ordinal_unique_v1' },
)
InterviewTurnSchema.index(
  { sessionId: 1, state: 1, claimExpiresAt: 1 },
  { name: 'interview_turn_claim_recovery_v1' },
)
InterviewTurnSchema.index(
  { userId: 1, createdAt: -1 },
  { name: 'interview_turn_user_created_v1' },
)
InterviewTurnSchema.index(
  { parentTurnId: 1, operationKind: 1 },
  {
    partialFilterExpression: { parentTurnId: { $type: 'objectId' } },
    name: 'interview_turn_parent_kind_v1',
  },
)

export const InterviewRuntime: Model<IInterviewRuntime> =
  mongoose.models.InterviewRuntime ||
  mongoose.model<IInterviewRuntime>(
    'InterviewRuntime',
    InterviewRuntimeSchema,
  )

export const InterviewTurn: Model<IInterviewTurn> =
  mongoose.models.InterviewTurn ||
  mongoose.model<IInterviewTurn>('InterviewTurn', InterviewTurnSchema)
