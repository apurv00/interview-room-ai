import mongoose, {
  type ClientSession,
  Types,
} from 'mongoose'
import { connectDB } from '@shared/db/connection'
import {
  BILLING_ROLLOUT_ACTIVATION_SCHEMA_VERSION,
  BILLING_ROLLOUT_APPROVAL_SCHEMA_VERSION,
  BILLING_ROLLOUT_EMERGENCY_STOP_SCHEMA_VERSION,
  BILLING_ROLLOUT_OWNER_ROLES,
  BILLING_ROLLOUT_PHASE_IDS,
  BILLING_ROLLOUT_PHASE_REQUEST_SCHEMA_VERSION,
  type BillingRolloutOwnerRole,
  type BillingRolloutPhaseId,
  type PreparedBillingRolloutApproval,
  type PreparedBillingRolloutRequest,
} from './contracts'
import {
  BillingRolloutActivationModel,
  BillingRolloutApprovalModel,
  BillingRolloutAuthorityModel,
  BillingRolloutEmergencyStopModel,
  BillingRolloutPhaseRequestModel,
} from './models'
import {
  type BillingRolloutActivationView,
  type BillingRolloutApprovalView,
  type BillingRolloutAuthorityView,
  type BillingRolloutControlRepository,
  type BillingRolloutEmergencyStopView,
  type BillingRolloutRequestStatus,
  type BillingRolloutRequestView,
} from './service'

const DIGEST_PATTERN = /^[a-f0-9]{64}$/
const OBJECT_ID_PATTERN = /^[a-f0-9]{24}$/
const AUTHORITY_KEY = 'singleton' as const
const OPEN_REQUEST_STATUSES = [
  'pending_approval',
  'approved',
] as const
const INITIAL_AUTHORITY_ACTOR_ID = '000000000000000000000000'

const TRANSACTION_OPTIONS = Object.freeze({
  readConcern: { level: 'snapshot' as const },
  writeConcern: { w: 'majority' as const, j: true },
  readPreference: 'primary' as const,
  maxCommitTimeMS: 5_000,
})

const INITIAL_AUTHORITY_WRITE_CONCERN = Object.freeze({
  w: 'majority' as const,
  j: true,
})

const REQUEST_PROJECTION = Object.freeze({
  _id: 1,
  schemaVersion: 1,
  commandId: 1,
  correlationId: 1,
  phaseId: 1,
  requestDigest: 1,
  requestCanonicalJson: 1,
  requestedStateHash: 1,
  evidenceBundleHash: 1,
  requesterUserId: 1,
  requesterCmsRole: 1,
  requiredApprovalRoles: 1,
  expectedAuthorityRevision: 1,
  expectedCurrentActivationSequence: 1,
  expectedConfigRevision: 1,
  configBeforeHash: 1,
  configAfterPreviewHash: 1,
  notBefore: 1,
  expiresAt: 1,
  status: 1,
  revision: 1,
  createdAt: 1,
})

const APPROVAL_PROJECTION = Object.freeze({
  _id: 1,
  schemaVersion: 1,
  commandId: 1,
  correlationId: 1,
  requestId: 1,
  requestDigest: 1,
  ownerRole: 1,
  decision: 1,
  actorUserId: 1,
  actorCmsRole: 1,
  reason: 1,
  recordedAt: 1,
})

const ACTIVATION_PROJECTION = Object.freeze({
  _id: 1,
  schemaVersion: 1,
  commandId: 1,
  correlationId: 1,
  sequence: 1,
  authorityRevision: 1,
  stopEpoch: 1,
  phaseId: 1,
  requestId: 1,
  requestDigest: 1,
  requestedStateHash: 1,
  configBeforeHash: 1,
  configAfterHash: 1,
  configRevision: 1,
  deploymentId: 1,
  commitSha: 1,
  activeCatalogVersion: 1,
  activeCatalogHash: 1,
  providerBindingHash: 1,
  couponPolicyHash: 1,
  copyBundleHash: 1,
  rolloutPolicyHash: 1,
  cohortOrAllowlistHash: 1,
  cohortContinuityHash: 1,
  recoveryPreserved: 1,
  activatedByUserId: 1,
  activatedAt: 1,
})

const AUTHORITY_PROJECTION = Object.freeze({
  _id: 0,
  revision: 1,
  currentActivationSequence: 1,
  activeActivationId: 1,
  lastActivationId: 1,
  stopEpoch: 1,
  state: 1,
})

const STOP_PROJECTION = Object.freeze({
  _id: 1,
  schemaVersion: 1,
  commandId: 1,
  correlationId: 1,
  stopEpoch: 1,
  authorityRevision: 1,
  previousActivationId: 1,
  previousActivationSequence: 1,
  incidentReference: 1,
  reason: 1,
  configBeforeHash: 1,
  configAfterHash: 1,
  webhookProcessingPreserved: 1,
  reconciliationPreserved: 1,
  stoppedByUserId: 1,
  stoppedAt: 1,
})

const REQUEST_STATUSES = new Set<BillingRolloutRequestStatus>([
  'pending_approval',
  'approved',
  'rejected',
  'activated',
  'expired',
  'superseded',
])
const PHASE_IDS = new Set<string>(BILLING_ROLLOUT_PHASE_IDS)
const OWNER_ROLES = new Set<string>(BILLING_ROLLOUT_OWNER_ROLES)

interface RequestLean {
  readonly _id: unknown
  readonly schemaVersion: unknown
  readonly commandId: unknown
  readonly correlationId: unknown
  readonly phaseId: unknown
  readonly requestDigest: unknown
  readonly requestCanonicalJson: unknown
  readonly requestedStateHash: unknown
  readonly evidenceBundleHash: unknown
  readonly requesterUserId: unknown
  readonly requesterCmsRole: unknown
  readonly requiredApprovalRoles: unknown
  readonly expectedAuthorityRevision: unknown
  readonly expectedCurrentActivationSequence: unknown
  readonly expectedConfigRevision: unknown
  readonly configBeforeHash: unknown
  readonly configAfterPreviewHash: unknown
  readonly notBefore: unknown
  readonly expiresAt: unknown
  readonly status: unknown
  readonly revision: unknown
  readonly createdAt: unknown
}

interface ApprovalLean {
  readonly _id: unknown
  readonly schemaVersion: unknown
  readonly commandId: unknown
  readonly correlationId: unknown
  readonly requestId: unknown
  readonly requestDigest: unknown
  readonly ownerRole: unknown
  readonly decision: unknown
  readonly actorUserId: unknown
  readonly actorCmsRole: unknown
  readonly reason: unknown
  readonly recordedAt: unknown
}

interface ActivationLean {
  readonly _id: unknown
  readonly schemaVersion: unknown
  readonly commandId: unknown
  readonly correlationId: unknown
  readonly sequence: unknown
  readonly authorityRevision: unknown
  readonly stopEpoch: unknown
  readonly phaseId: unknown
  readonly requestId: unknown
  readonly requestDigest: unknown
  readonly requestedStateHash: unknown
  readonly configBeforeHash: unknown
  readonly configAfterHash: unknown
  readonly configRevision: unknown
  readonly deploymentId: unknown
  readonly commitSha: unknown
  readonly activeCatalogVersion: unknown
  readonly activeCatalogHash: unknown
  readonly providerBindingHash: unknown
  readonly couponPolicyHash: unknown
  readonly copyBundleHash: unknown
  readonly rolloutPolicyHash: unknown
  readonly cohortOrAllowlistHash: unknown
  readonly cohortContinuityHash: unknown
  readonly recoveryPreserved: unknown
  readonly activatedByUserId: unknown
  readonly activatedAt: unknown
}

interface AuthorityLean {
  readonly revision: unknown
  readonly currentActivationSequence: unknown
  readonly activeActivationId?: unknown
  readonly lastActivationId?: unknown
  readonly stopEpoch: unknown
  readonly state: unknown
}

interface EmergencyStopLean {
  readonly _id: unknown
  readonly schemaVersion: unknown
  readonly commandId: unknown
  readonly correlationId: unknown
  readonly stopEpoch: unknown
  readonly authorityRevision: unknown
  readonly previousActivationId: unknown
  readonly previousActivationSequence: unknown
  readonly incidentReference: unknown
  readonly reason: unknown
  readonly configBeforeHash: unknown
  readonly configAfterHash: unknown
  readonly webhookProcessingPreserved: unknown
  readonly reconciliationPreserved: unknown
  readonly stoppedByUserId: unknown
  readonly stoppedAt: unknown
}

const DEFAULT_MODELS = Object.freeze({
  phaseRequest: BillingRolloutPhaseRequestModel,
  approval: BillingRolloutApprovalModel,
  activation: BillingRolloutActivationModel,
  authority: BillingRolloutAuthorityModel,
  emergencyStop: BillingRolloutEmergencyStopModel,
})

type BillingRolloutMongoModels = typeof DEFAULT_MODELS

export interface MongoBillingRolloutControlRepositoryDependencies {
  readonly connect?: () => Promise<unknown>
  readonly startSession?: () => Promise<ClientSession>
  readonly models?: BillingRolloutMongoModels
  readonly clock?: () => Date
}

function persistedError(field: string): never {
  throw new Error(
    `Persisted billing rollout authority field is invalid: ${field}`,
  )
}

function exactString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    return persistedError(field)
  }
  return value
}

function exactDigest(value: unknown, field: string): string {
  const digest = exactString(value, field)
  if (!DIGEST_PATTERN.test(digest)) return persistedError(field)
  return digest
}

function exactObjectId(value: unknown, field: string): string {
  const serialized =
    value instanceof Types.ObjectId
      ? value.toHexString()
      : typeof value === 'string'
        ? value.toLowerCase()
        : ''
  if (!OBJECT_ID_PATTERN.test(serialized)) {
    return persistedError(field)
  }
  return serialized
}

function exactDate(value: unknown, field: string): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    return persistedError(field)
  }
  return new Date(value)
}

function exactInteger(
  value: unknown,
  field: string,
  minimum: number,
): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < minimum
  ) {
    return persistedError(field)
  }
  return value
}

function exactPhaseId(
  value: unknown,
  field: string,
): BillingRolloutPhaseId {
  if (typeof value !== 'string' || !PHASE_IDS.has(value)) {
    return persistedError(field)
  }
  return value as BillingRolloutPhaseId
}

function exactOwnerRole(
  value: unknown,
  field: string,
): BillingRolloutOwnerRole {
  if (typeof value !== 'string' || !OWNER_ROLES.has(value)) {
    return persistedError(field)
  }
  return value as BillingRolloutOwnerRole
}

function exactOptionalDigest(
  value: unknown,
  field: string,
): string | undefined {
  if (value === null || value === undefined) return undefined
  return exactDigest(value, field)
}

function toRequestView(
  record: RequestLean,
): BillingRolloutRequestView {
  if (
    record.schemaVersion !==
      BILLING_ROLLOUT_PHASE_REQUEST_SCHEMA_VERSION ||
    record.requesterCmsRole !== 'platform_admin' ||
    typeof record.status !== 'string' ||
    !REQUEST_STATUSES.has(
      record.status as BillingRolloutRequestStatus,
    ) ||
    !Array.isArray(record.requiredApprovalRoles)
  ) {
    return persistedError('phase_request')
  }
  const requestId = exactDigest(record._id, 'phase_request._id')
  const requestDigest = exactDigest(
    record.requestDigest,
    'phase_request.requestDigest',
  )
  if (requestId !== requestDigest) {
    return persistedError('phase_request.requestDigest')
  }
  const requiredApprovalRoles = record.requiredApprovalRoles.map(
    (role, index) => exactOwnerRole(
      role,
      `phase_request.requiredApprovalRoles.${index}`,
    ),
  )
  if (
    requiredApprovalRoles.some(
      (role, index) =>
        index > 0 && requiredApprovalRoles[index - 1]! >= role,
    )
  ) {
    return persistedError('phase_request.requiredApprovalRoles')
  }
  return Object.freeze({
    schemaVersion: BILLING_ROLLOUT_PHASE_REQUEST_SCHEMA_VERSION,
    requestId,
    requestDigest,
    commandId: exactString(
      record.commandId,
      'phase_request.commandId',
    ),
    correlationId: exactString(
      record.correlationId,
      'phase_request.correlationId',
    ),
    phaseId: exactPhaseId(
      record.phaseId,
      'phase_request.phaseId',
    ),
    requestCanonicalJson: exactString(
      record.requestCanonicalJson,
      'phase_request.requestCanonicalJson',
    ),
    requestedStateHash: exactDigest(
      record.requestedStateHash,
      'phase_request.requestedStateHash',
    ),
    evidenceBundleHash: exactDigest(
      record.evidenceBundleHash,
      'phase_request.evidenceBundleHash',
    ),
    requesterUserId: exactObjectId(
      record.requesterUserId,
      'phase_request.requesterUserId',
    ),
    requesterCmsRole: 'platform_admin',
    requiredApprovalRoles: Object.freeze(requiredApprovalRoles),
    expectedAuthorityRevision: exactInteger(
      record.expectedAuthorityRevision,
      'phase_request.expectedAuthorityRevision',
      0,
    ),
    expectedCurrentActivationSequence: exactInteger(
      record.expectedCurrentActivationSequence,
      'phase_request.expectedCurrentActivationSequence',
      0,
    ),
    expectedConfigRevision: exactInteger(
      record.expectedConfigRevision,
      'phase_request.expectedConfigRevision',
      0,
    ),
    configBeforeHash: exactDigest(
      record.configBeforeHash,
      'phase_request.configBeforeHash',
    ),
    configAfterPreviewHash: exactDigest(
      record.configAfterPreviewHash,
      'phase_request.configAfterPreviewHash',
    ),
    notBefore: exactDate(
      record.notBefore,
      'phase_request.notBefore',
    ),
    expiresAt: exactDate(
      record.expiresAt,
      'phase_request.expiresAt',
    ),
    status: record.status as BillingRolloutRequestStatus,
    revision: exactInteger(
      record.revision,
      'phase_request.revision',
      1,
    ),
    createdAt: exactDate(
      record.createdAt,
      'phase_request.createdAt',
    ),
  })
}

function toApprovalView(
  record: ApprovalLean,
): BillingRolloutApprovalView {
  if (
    record.schemaVersion !== BILLING_ROLLOUT_APPROVAL_SCHEMA_VERSION ||
    record.actorCmsRole !== 'platform_admin' ||
    (
      record.decision !== 'approved' &&
      record.decision !== 'rejected'
    )
  ) {
    return persistedError('approval')
  }
  const approvalId = exactDigest(record._id, 'approval._id')
  return Object.freeze({
    schemaVersion: BILLING_ROLLOUT_APPROVAL_SCHEMA_VERSION,
    approvalId,
    approvalDigest: approvalId,
    commandId: exactString(record.commandId, 'approval.commandId'),
    correlationId: exactString(
      record.correlationId,
      'approval.correlationId',
    ),
    requestId: exactDigest(
      record.requestId,
      'approval.requestId',
    ),
    requestDigest: exactDigest(
      record.requestDigest,
      'approval.requestDigest',
    ),
    ownerRole: exactOwnerRole(
      record.ownerRole,
      'approval.ownerRole',
    ),
    decision: record.decision,
    actorUserId: exactObjectId(
      record.actorUserId,
      'approval.actorUserId',
    ),
    actorCmsRole: 'platform_admin',
    reason: exactString(record.reason, 'approval.reason'),
    recordedAt: exactDate(
      record.recordedAt,
      'approval.recordedAt',
    ),
  })
}

function toActivationView(
  record: ActivationLean,
): BillingRolloutActivationView {
  if (
    record.schemaVersion !==
      BILLING_ROLLOUT_ACTIVATION_SCHEMA_VERSION ||
    record.recoveryPreserved !== true
  ) {
    return persistedError('activation')
  }
  return Object.freeze({
    schemaVersion: BILLING_ROLLOUT_ACTIVATION_SCHEMA_VERSION,
    activationId: exactDigest(record._id, 'activation._id'),
    commandId: exactString(
      record.commandId,
      'activation.commandId',
    ),
    correlationId: exactString(
      record.correlationId,
      'activation.correlationId',
    ),
    sequence: exactInteger(
      record.sequence,
      'activation.sequence',
      1,
    ),
    authorityRevision: exactInteger(
      record.authorityRevision,
      'activation.authorityRevision',
      1,
    ),
    stopEpoch: exactInteger(
      record.stopEpoch,
      'activation.stopEpoch',
      0,
    ),
    kind: 'activated',
    phaseId: exactPhaseId(record.phaseId, 'activation.phaseId'),
    requestId: exactDigest(
      record.requestId,
      'activation.requestId',
    ),
    requestDigest: exactDigest(
      record.requestDigest,
      'activation.requestDigest',
    ),
    requestedStateHash: exactDigest(
      record.requestedStateHash,
      'activation.requestedStateHash',
    ),
    configBeforeHash: exactDigest(
      record.configBeforeHash,
      'activation.configBeforeHash',
    ),
    configAfterHash: exactDigest(
      record.configAfterHash,
      'activation.configAfterHash',
    ),
    configRevision: exactInteger(
      record.configRevision,
      'activation.configRevision',
      1,
    ),
    deploymentId: exactString(
      record.deploymentId,
      'activation.deploymentId',
    ),
    commitSha: exactString(
      record.commitSha,
      'activation.commitSha',
    ),
    activeCatalogVersion: exactString(
      record.activeCatalogVersion,
      'activation.activeCatalogVersion',
    ),
    activeCatalogHash: exactDigest(
      record.activeCatalogHash,
      'activation.activeCatalogHash',
    ),
    providerBindingHash: exactDigest(
      record.providerBindingHash,
      'activation.providerBindingHash',
    ),
    couponPolicyHash: exactDigest(
      record.couponPolicyHash,
      'activation.couponPolicyHash',
    ),
    copyBundleHash: exactDigest(
      record.copyBundleHash,
      'activation.copyBundleHash',
    ),
    rolloutPolicyHash: exactDigest(
      record.rolloutPolicyHash,
      'activation.rolloutPolicyHash',
    ),
    cohortOrAllowlistHash: exactDigest(
      record.cohortOrAllowlistHash,
      'activation.cohortOrAllowlistHash',
    ),
    cohortContinuityHash: exactDigest(
      record.cohortContinuityHash,
      'activation.cohortContinuityHash',
    ),
    recoveryPreserved: true,
    activatedByUserId: exactObjectId(
      record.activatedByUserId,
      'activation.activatedByUserId',
    ),
    activatedAt: exactDate(
      record.activatedAt,
      'activation.activatedAt',
    ),
  })
}

function toAuthorityView(
  record: AuthorityLean,
): BillingRolloutAuthorityView {
  if (
    record.state !== 'inert' &&
    record.state !== 'active' &&
    record.state !== 'stopped'
  ) {
    return persistedError('authority.state')
  }
  const activeActivationId = exactOptionalDigest(
    record.activeActivationId,
    'authority.activeActivationId',
  )
  const lastActivationId = exactOptionalDigest(
    record.lastActivationId,
    'authority.lastActivationId',
  )
  if (
    (record.state === 'active' && !activeActivationId) ||
    (record.state !== 'active' && activeActivationId) ||
    (record.state === 'inert' && lastActivationId)
  ) {
    return persistedError('authority.pointer_state')
  }
  return Object.freeze({
    revision: exactInteger(
      record.revision,
      'authority.revision',
      0,
    ),
    currentActivationSequence: exactInteger(
      record.currentActivationSequence,
      'authority.currentActivationSequence',
      0,
    ),
    ...(activeActivationId ? { activeActivationId } : {}),
    ...(lastActivationId ? { lastActivationId } : {}),
    stopEpoch: exactInteger(
      record.stopEpoch,
      'authority.stopEpoch',
      0,
    ),
    state: record.state,
  })
}

function toEmergencyStopView(
  record: EmergencyStopLean,
): BillingRolloutEmergencyStopView {
  if (
    record.schemaVersion !==
      BILLING_ROLLOUT_EMERGENCY_STOP_SCHEMA_VERSION ||
    record.webhookProcessingPreserved !== true ||
    record.reconciliationPreserved !== true
  ) {
    return persistedError('emergency_stop')
  }
  return Object.freeze({
    schemaVersion: BILLING_ROLLOUT_EMERGENCY_STOP_SCHEMA_VERSION,
    stopId: exactDigest(record._id, 'emergency_stop._id'),
    commandId: exactString(
      record.commandId,
      'emergency_stop.commandId',
    ),
    correlationId: exactString(
      record.correlationId,
      'emergency_stop.correlationId',
    ),
    stopEpoch: exactInteger(
      record.stopEpoch,
      'emergency_stop.stopEpoch',
      1,
    ),
    authorityRevision: exactInteger(
      record.authorityRevision,
      'emergency_stop.authorityRevision',
      1,
    ),
    previousActivationId: exactDigest(
      record.previousActivationId,
      'emergency_stop.previousActivationId',
    ),
    previousActivationSequence: exactInteger(
      record.previousActivationSequence,
      'emergency_stop.previousActivationSequence',
      1,
    ),
    incidentReference: exactString(
      record.incidentReference,
      'emergency_stop.incidentReference',
    ),
    reason: exactString(record.reason, 'emergency_stop.reason'),
    configBeforeHash: exactDigest(
      record.configBeforeHash,
      'emergency_stop.configBeforeHash',
    ),
    configAfterHash: exactDigest(
      record.configAfterHash,
      'emergency_stop.configAfterHash',
    ),
    webhookProcessingPreserved: true,
    reconciliationPreserved: true,
    stoppedByUserId: exactObjectId(
      record.stoppedByUserId,
      'emergency_stop.stoppedByUserId',
    ),
    stoppedAt: exactDate(
      record.stoppedAt,
      'emergency_stop.stoppedAt',
    ),
  })
}

function exactExpectedAuthorityFilter(
  expected: BillingRolloutAuthorityView,
) {
  return {
    key: AUTHORITY_KEY,
    revision: expected.revision,
    currentActivationSequence:
      expected.currentActivationSequence,
    activeActivationId: expected.activeActivationId ?? null,
    lastActivationId: expected.lastActivationId ?? null,
    stopEpoch: expected.stopEpoch,
    state: expected.state,
  } as const
}

function objectId(value: string, field: string): Types.ObjectId {
  if (!OBJECT_ID_PATTERN.test(value.toLowerCase())) {
    return persistedError(field)
  }
  return new Types.ObjectId(value)
}

function isDuplicateKeyError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  if ('code' in error && error.code === 11000) return true
  return 'cause' in error && isDuplicateKeyError(error.cause)
}

async function ensureInitialAuthority(
  models: BillingRolloutMongoModels,
  clock: () => Date,
): Promise<void> {
  const now = clock()
  if (!Number.isFinite(now.getTime())) {
    throw new Error('Billing rollout authority clock is invalid')
  }
  try {
    const result = await models.authority.updateOne(
      { key: AUTHORITY_KEY },
      {
        $setOnInsert: {
          key: AUTHORITY_KEY,
          revision: 0,
          currentActivationSequence: 0,
          activeActivationId: null,
          lastActivationId: null,
          stopEpoch: 0,
          state: 'inert',
          updatedByUserId: new Types.ObjectId(
            INITIAL_AUTHORITY_ACTOR_ID,
          ),
          createdAt: now,
          updatedAt: now,
        },
      },
      {
        upsert: true,
        runValidators: true,
        setDefaultsOnInsert: false,
        timestamps: false,
        writeConcern: INITIAL_AUTHORITY_WRITE_CONCERN,
      },
    ).exec()
    if (!result.acknowledged) {
      throw new Error(
        'Initial billing rollout authority write was not acknowledged',
      )
    }
  } catch (error) {
    // Concurrent first-use upserts can race on the singleton index. The
    // winning write is already majority-acknowledged; the following
    // snapshot transaction will read that same primary.
    if (!isDuplicateKeyError(error)) throw error
  }
}

function validActiveTransition(input: {
  readonly expected: BillingRolloutAuthorityView
  readonly activation: BillingRolloutActivationView
  readonly actorUserId: string
}): boolean {
  return (
    input.activation.kind === 'activated' &&
    input.activation.authorityRevision ===
      input.expected.revision + 1 &&
    Number.isSafeInteger(input.activation.authorityRevision) &&
    input.activation.sequence ===
      input.expected.currentActivationSequence + 1 &&
    Number.isSafeInteger(input.activation.sequence) &&
    input.activation.stopEpoch === input.expected.stopEpoch &&
    input.activation.activatedByUserId ===
      input.actorUserId.toLowerCase()
  )
}

function validStoppedTransition(input: {
  readonly expected: BillingRolloutAuthorityView
  readonly stop: BillingRolloutEmergencyStopView
  readonly actorUserId: string
}): boolean {
  return (
    input.expected.state === 'active' &&
    input.expected.activeActivationId !== undefined &&
    input.stop.authorityRevision === input.expected.revision + 1 &&
    Number.isSafeInteger(input.stop.authorityRevision) &&
    input.stop.stopEpoch === input.expected.stopEpoch + 1 &&
    Number.isSafeInteger(input.stop.stopEpoch) &&
    input.stop.previousActivationId ===
      input.expected.activeActivationId &&
    input.stop.previousActivationSequence ===
      input.expected.currentActivationSequence &&
    input.stop.stoppedByUserId === input.actorUserId.toLowerCase()
  )
}

export function createMongoBillingRolloutControlRepository(
  dependencies: MongoBillingRolloutControlRepositoryDependencies = {},
): BillingRolloutControlRepository<ClientSession> {
  const connect = dependencies.connect ?? connectDB
  const startSession =
    dependencies.startSession ?? (() => mongoose.startSession())
  const models = dependencies.models ?? DEFAULT_MODELS
  const clock = dependencies.clock ?? (() => new Date())

  return Object.freeze({
    async withTransaction<T>(
      work: (transaction: ClientSession) => Promise<T>,
    ): Promise<T> {
      await connect()
      await ensureInitialAuthority(models, clock)
      const session = await startSession()
      let completed = false
      let result: T | undefined
      try {
        await session.withTransaction(async () => {
          // The Mongo driver may replay this callback after a transient
          // transaction abort. Never reuse a result from an earlier attempt.
          completed = false
          result = undefined
          result = await work(session)
          completed = true
          return result
        }, TRANSACTION_OPTIONS)
        if (!completed) {
          throw new Error(
            'Billing rollout authority transaction did not complete',
          )
        }
        return result as T
      } finally {
        await session.endSession()
      }
    },

    async loadAuthority(
      transaction: ClientSession,
    ): Promise<BillingRolloutAuthorityView> {
      const record = await models.authority.findOne(
        { key: AUTHORITY_KEY },
        AUTHORITY_PROJECTION,
      )
        .session(transaction)
        .lean<AuthorityLean>()
        .exec()
      if (!record) {
        throw new Error('Billing rollout authority is missing')
      }
      return toAuthorityView(record)
    },

    async findRequestByCommandId(
      commandId: string,
      transaction: ClientSession,
    ): Promise<BillingRolloutRequestView | null> {
      const record = await models.phaseRequest.findOne(
        { commandId },
        REQUEST_PROJECTION,
      )
        .session(transaction)
        .lean<RequestLean>()
        .exec()
      return record ? toRequestView(record) : null
    },

    async findRequestById(
      requestId: string,
      transaction: ClientSession,
    ): Promise<BillingRolloutRequestView | null> {
      const record = await models.phaseRequest.findOne(
        { _id: requestId },
        REQUEST_PROJECTION,
      )
        .session(transaction)
        .lean<RequestLean>()
        .exec()
      return record ? toRequestView(record) : null
    },

    async findOpenRequest(
      transaction: ClientSession,
    ): Promise<BillingRolloutRequestView | null> {
      const record = await models.phaseRequest.findOne(
        {
          singletonKey: 'billing-rollout',
          status: { $in: OPEN_REQUEST_STATUSES },
        },
        REQUEST_PROJECTION,
      )
        .session(transaction)
        .lean<RequestLean>()
        .exec()
      return record ? toRequestView(record) : null
    },

    async insertRequest(
      request: PreparedBillingRolloutRequest,
      transaction: ClientSession,
    ): Promise<void> {
      await models.phaseRequest.create([{
        _id: request.requestId,
        singletonKey: 'billing-rollout',
        schemaVersion: request.schemaVersion,
        commandId: request.commandId,
        correlationId: request.correlationId,
        phaseId: request.phaseId,
        requestDigest: request.requestDigest,
        requestCanonicalJson: request.requestCanonicalJson,
        requestedStateHash: request.requestedStateHash,
        evidenceBundleHash: request.evidenceBundleHash,
        requesterUserId: objectId(
          request.requesterUserId,
          'request.requesterUserId',
        ),
        requesterCmsRole: request.requesterCmsRole,
        requiredApprovalRoles: [...request.requiredApprovalRoles],
        expectedAuthorityRevision:
          request.expectedAuthorityRevision,
        expectedCurrentActivationSequence:
          request.expectedCurrentActivationSequence,
        expectedConfigRevision: request.expectedConfigRevision,
        configBeforeHash: request.configBeforeHash,
        configAfterPreviewHash: request.configAfterPreviewHash,
        notBefore: new Date(request.notBefore),
        expiresAt: new Date(request.expiresAt),
        status: request.status,
        revision: request.revision,
        createdAt: new Date(request.createdAt),
      }], { session: transaction })
    },

    async compareAndSetRequestStatus(
      input: {
        readonly requestId: string
        readonly expectedStatus: BillingRolloutRequestStatus
        readonly expectedRevision: number
        readonly nextStatus: BillingRolloutRequestStatus
      },
      transaction: ClientSession,
    ): Promise<boolean> {
      if (
        !REQUEST_STATUSES.has(input.expectedStatus) ||
        !REQUEST_STATUSES.has(input.nextStatus) ||
        !Number.isSafeInteger(input.expectedRevision) ||
        input.expectedRevision < 1 ||
        input.expectedRevision >= Number.MAX_SAFE_INTEGER
      ) return false
      const result = await models.phaseRequest.updateOne(
        {
          _id: input.requestId,
          status: input.expectedStatus,
          revision: input.expectedRevision,
        },
        {
          $set: { status: input.nextStatus },
          $inc: { revision: 1 },
        },
        {
          session: transaction,
          runValidators: true,
        },
      ).exec()
      return result.modifiedCount === 1
    },

    async findApprovalByCommandId(
      commandId: string,
      transaction: ClientSession,
    ): Promise<BillingRolloutApprovalView | null> {
      const record = await models.approval.findOne(
        { commandId },
        APPROVAL_PROJECTION,
      )
        .session(transaction)
        .lean<ApprovalLean>()
        .exec()
      return record ? toApprovalView(record) : null
    },

    async listApprovals(
      requestId: string,
      transaction: ClientSession,
    ): Promise<readonly BillingRolloutApprovalView[]> {
      const records = await models.approval.find(
        { requestId },
        APPROVAL_PROJECTION,
      )
        .sort({ recordedAt: 1, _id: 1 })
        .session(transaction)
        .lean<ApprovalLean[]>()
        .exec()
      return Object.freeze(records.map(toApprovalView))
    },

    async insertApproval(
      approval: PreparedBillingRolloutApproval,
      transaction: ClientSession,
    ): Promise<void> {
      if (approval.approvalId !== approval.approvalDigest) {
        throw new Error(
          'Billing rollout approval ID must equal its digest',
        )
      }
      await models.approval.create([{
        _id: approval.approvalId,
        schemaVersion: approval.schemaVersion,
        commandId: approval.commandId,
        correlationId: approval.correlationId,
        requestId: approval.requestId,
        requestDigest: approval.requestDigest,
        ownerRole: approval.ownerRole,
        decision: approval.decision,
        actorUserId: objectId(
          approval.actorUserId,
          'approval.actorUserId',
        ),
        actorCmsRole: approval.actorCmsRole,
        reason: approval.reason,
        recordedAt: new Date(approval.recordedAt),
      }], { session: transaction })
    },

    async findActivationByCommandId(
      commandId: string,
      transaction: ClientSession,
    ): Promise<BillingRolloutActivationView | null> {
      const record = await models.activation.findOne(
        { commandId },
        ACTIVATION_PROJECTION,
      )
        .session(transaction)
        .lean<ActivationLean>()
        .exec()
      return record ? toActivationView(record) : null
    },

    async findActivationById(
      activationId: string,
      transaction: ClientSession,
    ): Promise<BillingRolloutActivationView | null> {
      const record = await models.activation.findOne(
        { _id: activationId },
        ACTIVATION_PROJECTION,
      )
        .session(transaction)
        .lean<ActivationLean>()
        .exec()
      return record ? toActivationView(record) : null
    },

    async insertActivation(
      activation: BillingRolloutActivationView,
      transaction: ClientSession,
    ): Promise<void> {
      if (activation.kind !== 'activated') {
        throw new Error(
          'Only activated rollout evidence may be persisted',
        )
      }
      await models.activation.create([{
        _id: activation.activationId,
        schemaVersion: activation.schemaVersion,
        commandId: activation.commandId,
        correlationId: activation.correlationId,
        sequence: activation.sequence,
        authorityRevision: activation.authorityRevision,
        stopEpoch: activation.stopEpoch,
        phaseId: activation.phaseId,
        requestId: activation.requestId,
        requestDigest: activation.requestDigest,
        requestedStateHash: activation.requestedStateHash,
        configBeforeHash: activation.configBeforeHash,
        configAfterHash: activation.configAfterHash,
        configRevision: activation.configRevision,
        deploymentId: activation.deploymentId,
        commitSha: activation.commitSha,
        activeCatalogVersion: activation.activeCatalogVersion,
        activeCatalogHash: activation.activeCatalogHash,
        providerBindingHash: activation.providerBindingHash,
        couponPolicyHash: activation.couponPolicyHash,
        copyBundleHash: activation.copyBundleHash,
        rolloutPolicyHash: activation.rolloutPolicyHash,
        cohortOrAllowlistHash: activation.cohortOrAllowlistHash,
        cohortContinuityHash: activation.cohortContinuityHash,
        recoveryPreserved: activation.recoveryPreserved,
        activatedByUserId: objectId(
          activation.activatedByUserId,
          'activation.activatedByUserId',
        ),
        activatedAt: new Date(activation.activatedAt),
      }], { session: transaction })
    },

    async compareAndSetAuthorityActive(
      input: {
        readonly expected: BillingRolloutAuthorityView
        readonly activation: BillingRolloutActivationView
        readonly actorUserId: string
      },
      transaction: ClientSession,
    ): Promise<boolean> {
      if (!validActiveTransition(input)) return false
      const result = await models.authority.updateOne(
        exactExpectedAuthorityFilter(input.expected),
        {
          $set: {
            revision: input.activation.authorityRevision,
            currentActivationSequence: input.activation.sequence,
            activeActivationId: input.activation.activationId,
            lastActivationId: input.activation.activationId,
            stopEpoch: input.activation.stopEpoch,
            state: 'active',
            updatedByUserId: objectId(
              input.actorUserId,
              'authority.actorUserId',
            ),
          },
        },
        {
          session: transaction,
          runValidators: true,
        },
      ).exec()
      return result.modifiedCount === 1
    },

    async findEmergencyStopByCommandId(
      commandId: string,
      transaction: ClientSession,
    ): Promise<BillingRolloutEmergencyStopView | null> {
      const record = await models.emergencyStop.findOne(
        { commandId },
        STOP_PROJECTION,
      )
        .session(transaction)
        .lean<EmergencyStopLean>()
        .exec()
      return record ? toEmergencyStopView(record) : null
    },

    async insertEmergencyStop(
      stop: BillingRolloutEmergencyStopView,
      transaction: ClientSession,
    ): Promise<void> {
      await models.emergencyStop.create([{
        _id: stop.stopId,
        schemaVersion: stop.schemaVersion,
        commandId: stop.commandId,
        correlationId: stop.correlationId,
        stopEpoch: stop.stopEpoch,
        authorityRevision: stop.authorityRevision,
        previousActivationId: stop.previousActivationId,
        previousActivationSequence:
          stop.previousActivationSequence,
        incidentReference: stop.incidentReference,
        reason: stop.reason,
        configBeforeHash: stop.configBeforeHash,
        configAfterHash: stop.configAfterHash,
        webhookProcessingPreserved:
          stop.webhookProcessingPreserved,
        reconciliationPreserved:
          stop.reconciliationPreserved,
        stoppedByUserId: objectId(
          stop.stoppedByUserId,
          'emergency_stop.stoppedByUserId',
        ),
        stoppedAt: new Date(stop.stoppedAt),
      }], { session: transaction })
    },

    async compareAndSetAuthorityStopped(
      input: {
        readonly expected: BillingRolloutAuthorityView
        readonly stop: BillingRolloutEmergencyStopView
        readonly actorUserId: string
      },
      transaction: ClientSession,
    ): Promise<boolean> {
      if (!validStoppedTransition(input)) return false
      const result = await models.authority.updateOne(
        exactExpectedAuthorityFilter(input.expected),
        {
          $set: {
            revision: input.stop.authorityRevision,
            currentActivationSequence:
              input.stop.previousActivationSequence,
            activeActivationId: null,
            lastActivationId: input.stop.previousActivationId,
            stopEpoch: input.stop.stopEpoch,
            state: 'stopped',
            updatedByUserId: objectId(
              input.actorUserId,
              'authority.actorUserId',
            ),
          },
        },
        {
          session: transaction,
          runValidators: true,
        },
      ).exec()
      return result.modifiedCount === 1
    },
  })
}
