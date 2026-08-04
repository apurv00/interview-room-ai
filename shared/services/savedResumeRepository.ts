import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import mongoose, { type ClientSession } from 'mongoose'
import { BSON } from 'mongodb'
import { connectDB } from '@shared/db/connection'
import {
  SavedResume,
  type SavedResumeLegacyPayload,
} from '@shared/db/models/SavedResume'
import {
  SAVED_RESUME_STORAGE_MODES,
  User,
  type SavedResumeMigrationIssueCode,
  type SavedResumeStorageMode,
} from '@shared/db/models/User'
import { withPersonalDataWriteTransaction } from '@shared/services/accountDeletion'
import {
  PR7A_SAVED_RESUME_COLLECTION_READY,
} from '@shared/services/pr7EntitlementRollout'

/**
 * Shared foundation only. No production consumer may select a dual/collection
 * mode until
 * the migration rollout has its own explicit approval.
 */
export { PR7A_SAVED_RESUME_COLLECTION_READY }
export const DEFAULT_SAVED_RESUME_STORAGE_MODE = 'embedded' as const
export const SHADOW_SAVED_RESUME_STORAGE_MODE =
  'dual_embedded_primary' as const
export const SAVED_RESUME_COLLECTION_PRIMARY_MIN_SOAK_MS =
  7 * 24 * 60 * 60 * 1_000

export const SAVED_RESUME_REPOSITORY_ERROR_CODES = [
  'invalid_payload',
  'invalid_storage_state',
  'persistence_conflict',
  'collection_fence_mismatch',
  'shadow_parity_mismatch',
  'contract_evidence_missing_or_stale',
] as const
export type SavedResumeRepositoryErrorCode =
  (typeof SAVED_RESUME_REPOSITORY_ERROR_CODES)[number]

export class SavedResumeRepositoryError extends Error {
  readonly code: SavedResumeRepositoryErrorCode

  constructor(
    code: SavedResumeRepositoryErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'SavedResumeRepositoryError'
    this.code = code
  }
}

export interface SavedResumeUserStorageState {
  mode: SavedResumeStorageMode
  libraryVersion: number
  collectionCount: number
  embeddedPayloads: readonly SavedResumeLegacyPayload[]
  migration?: SavedResumeMigrationEvidence
}

export interface SavedResumeMigrationEvidence {
  sourceHash?: string
  rowCount?: number
  storageVersion?: number
  verifiedVersion?: number
  verifiedAt?: Date
  collectionActivatedAt?: Date
  embeddedContractedAt?: Date
  issueCodes?: readonly SavedResumeMigrationIssueCode[]
}

export interface SavedResumeCollectionRecord {
  resumeId: string
  ordinal: number
  payload: SavedResumeLegacyPayload
}

export interface SavedResumeParityDiagnostics {
  embeddedCount: number
  collectionDocumentCount: number
  fencedCollectionCount: number
  missingFromCollectionCount: number
  unexpectedInCollectionCount: number
  payloadMismatchCount: number
  orderMismatchCount: number
  collectionFenceMatches: boolean
  sourceHash: string
  collectionHash: string
  mismatches: readonly SavedResumeParityMismatch[]
  inParity: boolean
}

export interface SavedResumeParityMismatch {
  resumeId?: string
  issueCodes: readonly SavedResumeMigrationIssueCode[]
  embeddedHash?: string
  collectionHash?: string
}

export interface SavedResumeListResult {
  mode: SavedResumeStorageMode
  libraryVersion: number
  collectionCount: number
  payloads: readonly SavedResumeLegacyPayload[]
  /**
   * Present only in dual modes. It contains opaque resume ids, counts, hashes,
   * and issue codes, but never resume content or contact details.
   */
  parity?: SavedResumeParityDiagnostics
}

export interface SavedResumeGetResult {
  mode: SavedResumeStorageMode
  libraryVersion: number
  payload: SavedResumeLegacyPayload
  secondaryCopyMatches?: boolean
}

export interface SavedResumeMetadata {
  id: string
  name?: string
  template?: string
  targetRole?: string
  targetCompany?: string
  atsScore?: number | null
  atsScoreFromCheck?: boolean
  createdAt?: string
  updatedAt?: string
}

export interface SavedResumeMetadataListResult {
  mode: SavedResumeStorageMode
  libraryVersion: number
  collectionCount: number
  metadata: readonly SavedResumeMetadata[]
}

export interface SavedResumeRepositoryReadOptions {
  /**
   * Reuses a caller-owned session. The repository never starts, commits, or
   * aborts a transaction for a read.
   */
  session?: ClientSession
  /**
   * Optional fail-closed Mongo read budget. This is especially important for
   * ownership checks performed inside a caller-owned payment transaction.
   */
  maxTimeMS?: number
}

export interface SavedResumeIdentityExpectedState {
  mode: SavedResumeStorageMode
  libraryVersion: number
  collectionCount: number
}

export type SavedResumeIdentityStatus =
  | 'absent'
  | 'exact'
  | 'ambiguous'

export interface SavedResumeIdentityInspection {
  mode: SavedResumeStorageMode
  libraryVersion: number
  collectionCount: number
  matchingIdentityCount: number
  status: SavedResumeIdentityStatus
}

export interface SavedResumeIdentityInspectionOptions
  extends SavedResumeRepositoryReadOptions {
  /**
   * Optional caller snapshot. A mismatch is a persistence conflict rather
   * than permission to inspect another storage authority.
   */
  expectedState?: SavedResumeIdentityExpectedState
}

export interface SavedResumeIdentityMutationOptions
  extends SavedResumeIdentityInspectionOptions {
  /**
   * Paid ownership mutations must join the caller's active transaction so
   * the identity decision and payment/entitlement write share one commit.
   */
  session: ClientSession
}

export interface SavedResumeAccountErasureResult {
  mode: SavedResumeStorageMode | null
  libraryVersion: number | null
  collectionCount: number | null
  authorityDiagnosticsValid: boolean
  discoveredCollectionCount: number
  deletedCollectionCount: number
  embeddedCleared: boolean
  collectionFenceMatched: boolean | null
}

export interface SavedResumeAccountErasureOptions {
  session: ClientSession
  maxTimeMS?: number
}

export interface SavedResumeCreateOptions {
  /**
   * Optional authoritative-library ceiling. Omission preserves legacy
   * behavior; zero deliberately rejects every new identity.
   */
  maxCount?: number
  /**
   * Selects the ceiling only after the transaction has loaded and fenced the
   * authoritative mode. This prevents a concurrent storage-mode transition
   * from applying a collection-only ceiling to an embedded dual-write.
   */
  maxCountByMode?: Partial<Record<SavedResumeStorageMode, number>>
}

export interface SavedResumeRemoveGuardContext {
  userId: string
  resumeId: string
  mode: SavedResumeStorageMode
  libraryVersion: number
}

export interface SavedResumeRemoveOptions {
  /**
   * Runs after authoritative ownership is confirmed and before any storage
   * write. Throwing aborts the personal-data transaction.
   */
  beforeMutation?: (
    session: ClientSession,
    context: SavedResumeRemoveGuardContext,
  ) => void | Promise<void>
}

export type SavedResumeMutationOutcome =
  | 'created'
  | 'updated'
  | 'deleted'
  | 'already_exists'
  | 'limit_reached'
  | 'not_found'
  | 'user_not_found'

export interface SavedResumeMutationResult {
  outcome: SavedResumeMutationOutcome
  mode?: SavedResumeStorageMode
  resumeId?: string
  libraryVersion?: number
  collectionCount?: number
}

export interface SavedResumeBackfillResult {
  outcome: 'backfilled' | 'user_not_found'
  copied: number
  updated: number
  libraryVersion?: number
  collectionCount?: number
  parity?: SavedResumeParityDiagnostics
}

export interface SavedResumeVerificationResult {
  outcome: 'verified' | 'mismatch' | 'user_not_found'
  mode?: SavedResumeStorageMode
  libraryVersion?: number
  parity?: SavedResumeParityDiagnostics
}

export interface SavedResumeStorageTransitionResult {
  outcome: 'transitioned' | 'user_not_found'
  previousMode?: SavedResumeStorageMode
  mode?: SavedResumeStorageMode
  libraryVersion?: number
  collectionCount?: number
}

export interface SavedResumeStorageTransitionOptions {
  /**
   * Required only for the irreversible collection-only transition. The
   * migration service obtains this version from the independently verified
   * exact-user report; checking it inside the transaction closes the
   * report-to-contract time-of-check/time-of-use window.
   */
  expectedVerifiedLibraryVersion?: number
}

export interface SavedResumeFenceInput {
  userId: string
  expectedMode: SavedResumeStorageMode
  expectedLibraryVersion: number
  expectedCollectionCount: number
  nextCollectionCount: number
  nextMode?: SavedResumeStorageMode
  migrationEvidence?: SavedResumeMigrationEvidence
}

export interface SavedResumeUserReadState {
  mode: SavedResumeStorageMode
  libraryVersion: number
  collectionCount: number
  embeddedMetadata: readonly SavedResumeMetadata[]
}

export interface SavedResumeUserErasureState {
  mode: SavedResumeStorageMode | null
  libraryVersion: number | null
  collectionCount: number | null
  authorityDiagnosticsValid: boolean
}

export interface SavedResumeRawErasureState {
  savedResumeStorageMode?: unknown
  savedResumeLibraryVersion?: unknown
  savedResumeCollectionCount?: unknown
}

export interface SavedResumeRepositoryTransaction {
  /**
   * Present for repository mutations and for reads that receive an existing
   * session. Consumers never control its lifecycle through this repository.
   */
  readonly session?: ClientSession
  loadUserState(
    userId: string,
  ): Promise<SavedResumeUserStorageState | null>
  loadUserReadState(
    userId: string,
  ): Promise<SavedResumeUserReadState | null>
  /**
   * Reads only non-PII fence fields. Erasure must not deserialize malformed
   * legacy payloads because corrupt personal data still has to be deletable.
   */
  loadUserErasureState(
    userId: string,
  ): Promise<SavedResumeUserErasureState | null>
  listCollection(
    userId: string,
  ): Promise<readonly SavedResumeCollectionRecord[]>
  /** Counts collection rows without projecting any resume payload. */
  countCollection(userId: string): Promise<number>
  /** Counts exact identity rows so a missing unique index fails ambiguous. */
  countCollectionIdentity(
    userId: string,
    resumeId: string,
  ): Promise<number>
  /** Reads only the matching row's ordinal; null means no such identity. */
  findCollectionOrdinal(
    userId: string,
    resumeId: string,
  ): Promise<number | null>
  /** Finds max(ordinal) + 1 without projecting resume payloads. */
  nextCollectionOrdinal(userId: string): Promise<number>
  findEmbedded(
    userId: string,
    resumeId: string,
  ): Promise<SavedResumeLegacyPayload | null>
  findCollection(
    userId: string,
    resumeId: string,
  ): Promise<SavedResumeLegacyPayload | null>
  collectionExists(
    userId: string,
    resumeId: string,
  ): Promise<boolean>
  listCollectionMetadata(
    userId: string,
  ): Promise<readonly SavedResumeMetadata[]>
  appendEmbedded(
    userId: string,
    payload: SavedResumeLegacyPayload,
  ): Promise<boolean>
  replaceEmbedded(
    userId: string,
    resumeId: string,
    payload: SavedResumeLegacyPayload,
  ): Promise<boolean>
  removeEmbedded(
    userId: string,
    resumeId: string,
  ): Promise<boolean>
  contractEmbedded(userId: string): Promise<boolean>
  insertCollection(
    userId: string,
    record: SavedResumeCollectionRecord,
  ): Promise<boolean>
  replaceCollection(
    userId: string,
    record: SavedResumeCollectionRecord,
  ): Promise<boolean>
  removeCollection(
    userId: string,
    resumeId: string,
  ): Promise<boolean>
  removeAllCollection(userId: string): Promise<number>
  reindexCollection(
    userId: string,
    orderedResumeIds: readonly string[],
  ): Promise<boolean>
  compareAndSetFence(input: SavedResumeFenceInput): Promise<boolean>
  /**
   * Serializes an already-confirmed identity with storage migration and
   * account deletion without changing the saved-resume library version.
   */
  touchIdentityFence(
    userId: string,
    expected: SavedResumeIdentityExpectedState,
  ): Promise<boolean>
}

export interface SavedResumeRepositoryStore {
  read<T>(
    work: (transaction: SavedResumeRepositoryTransaction) => Promise<T>,
    options?: SavedResumeRepositoryReadOptions,
  ): Promise<T>
  transact<T>(
    userId: string,
    work: (transaction: SavedResumeRepositoryTransaction) => Promise<T>,
  ): Promise<T>
}

export interface SavedResumeRepository {
  list(
    userId: string,
    options?: SavedResumeRepositoryReadOptions,
  ): Promise<SavedResumeListResult | null>
  get(
    userId: string,
    resumeId: string,
    options?: SavedResumeRepositoryReadOptions,
  ): Promise<SavedResumeGetResult | null>
  find(
    userId: string,
    resumeId: string,
    options?: SavedResumeRepositoryReadOptions,
  ): Promise<SavedResumeGetResult | null>
  exists(
    userId: string,
    resumeId: string,
    options?: SavedResumeRepositoryReadOptions,
  ): Promise<boolean>
  inspectIdentity(
    userId: string | mongoose.Types.ObjectId,
    resumeId: string,
    options?: SavedResumeIdentityInspectionOptions,
  ): Promise<SavedResumeIdentityInspection | null>
  fenceOwnedIdentityForMutation(
    userId: string | mongoose.Types.ObjectId,
    resumeId: string,
    options: SavedResumeIdentityMutationOptions,
  ): Promise<SavedResumeIdentityInspection | null>
  listMetadata(
    userId: string,
    options?: SavedResumeRepositoryReadOptions,
  ): Promise<SavedResumeMetadataListResult | null>
  create(
    userId: string,
    payload: SavedResumeLegacyPayload,
    options?: SavedResumeCreateOptions,
  ): Promise<SavedResumeMutationResult>
  update(
    userId: string,
    resumeId: string,
    payload: SavedResumeLegacyPayload,
  ): Promise<SavedResumeMutationResult>
  remove(
    userId: string,
    resumeId: string,
    options?: SavedResumeRemoveOptions,
  ): Promise<SavedResumeMutationResult>
  backfillEmbeddedToCollection(
    userId: string,
  ): Promise<SavedResumeBackfillResult>
  verifyDualParity(
    userId: string,
  ): Promise<SavedResumeVerificationResult>
  transitionStorageMode(
    userId: string,
    targetMode: SavedResumeStorageMode,
    options?: SavedResumeStorageTransitionOptions,
  ): Promise<SavedResumeStorageTransitionResult>
  eraseAccountData(
    userId: string | mongoose.Types.ObjectId,
    options: SavedResumeAccountErasureOptions,
  ): Promise<SavedResumeAccountErasureResult | null>
}

export interface SavedResumeRepositoryDependencies {
  now?: () => Date
}

interface RawUserStorageState {
  savedResumeStorageMode?: unknown
  savedResumeLibraryVersion?: unknown
  savedResumeCollectionCount?: unknown
  savedResumes?: unknown
  savedResumeMigration?: unknown
}

const SAVED_RESUME_ID_MAX_LENGTH = 255

function repositoryError(
  code: SavedResumeRepositoryErrorCode,
  message: string,
  cause?: unknown,
): SavedResumeRepositoryError {
  return new SavedResumeRepositoryError(
    code,
    message,
    cause === undefined ? undefined : { cause },
  )
}

function isStorageMode(value: unknown): value is SavedResumeStorageMode {
  return (
    typeof value === 'string' &&
    SAVED_RESUME_STORAGE_MODES.includes(
      value as SavedResumeStorageMode,
    )
  )
}

function nonNegativeSafeInteger(
  value: unknown,
  field: string,
): number {
  if (
    value === undefined ||
    value === null
  ) {
    return 0
  }
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 0
  ) {
    throw repositoryError(
      'invalid_storage_state',
      `${field} must be a non-negative safe integer`,
    )
  }
  return value as number
}

function asLegacyPayload(
  value: unknown,
): SavedResumeLegacyPayload {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    typeof (value as { id?: unknown }).id !== 'string' ||
    (value as { id: string }).id.length === 0 ||
    (value as { id: string }).id.length >
      SAVED_RESUME_ID_MAX_LENGTH
  ) {
    throw repositoryError(
      'invalid_payload',
      'Legacy saved resume payload id must be a string between 1 and 255 characters',
    )
  }
  return value as SavedResumeLegacyPayload
}

const SAVED_RESUME_METADATA_FIELDS = [
  'id',
  'name',
  'template',
  'targetRole',
  'targetCompany',
  'atsScore',
  'atsScoreFromCheck',
  'createdAt',
  'updatedAt',
] as const

function toSavedResumeMetadata(
  rawPayload: SavedResumeLegacyPayload,
): SavedResumeMetadata {
  const payload = asLegacyPayload(rawPayload)
  const metadata: SavedResumeMetadata = { id: payload.id }
  if (typeof payload.name === 'string') metadata.name = payload.name
  if (typeof payload.template === 'string') {
    metadata.template = payload.template
  }
  if (typeof payload.targetRole === 'string') {
    metadata.targetRole = payload.targetRole
  }
  if (typeof payload.targetCompany === 'string') {
    metadata.targetCompany = payload.targetCompany
  }
  if (
    payload.atsScore === null ||
    typeof payload.atsScore === 'number'
  ) {
    metadata.atsScore = payload.atsScore
  }
  if (typeof payload.atsScoreFromCheck === 'boolean') {
    metadata.atsScoreFromCheck = payload.atsScoreFromCheck
  }
  if (typeof payload.createdAt === 'string') {
    metadata.createdAt = payload.createdAt
  }
  if (typeof payload.updatedAt === 'string') {
    metadata.updatedAt = payload.updatedAt
  }
  return metadata
}

function validatedMaxCount(
  value: number | undefined,
): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isSafeInteger(value) || value < 0) {
    throw repositoryError(
      'invalid_payload',
      'maxCount must be a non-negative safe integer when present',
    )
  }
  return value
}

function validatedMaxCountByMode(
  value: SavedResumeCreateOptions['maxCountByMode'],
): Partial<Record<SavedResumeStorageMode, number>> | undefined {
  if (value === undefined) return undefined
  const limits: Partial<Record<SavedResumeStorageMode, number>> = {}
  for (const [mode, limit] of Object.entries(value)) {
    if (!isStorageMode(mode)) {
      throw repositoryError(
        'invalid_payload',
        'maxCountByMode contains an invalid storage mode',
      )
    }
    limits[mode] = validatedMaxCount(limit)
  }
  return limits
}

function validatedResumeId(resumeId: string): string {
  if (
    typeof resumeId !== 'string' ||
    resumeId.length === 0 ||
    resumeId.length > SAVED_RESUME_ID_MAX_LENGTH
  ) {
    throw repositoryError(
      'invalid_payload',
      'Saved resume id must be a string between 1 and 255 characters',
    )
  }
  return resumeId
}

function assertExpectedIdentityState(
  state: SavedResumeUserReadState,
  expected: SavedResumeIdentityExpectedState | undefined,
): void {
  if (!expected) return
  if (
    state.mode !== expected.mode ||
    state.libraryVersion !== expected.libraryVersion ||
    state.collectionCount !== expected.collectionCount
  ) {
    throw repositoryError(
      'persistence_conflict',
      'Saved resume storage authority changed concurrently',
    )
  }
}

function identityStatus(
  matchingIdentityCount: number,
): SavedResumeIdentityStatus {
  if (matchingIdentityCount === 0) return 'absent'
  if (matchingIdentityCount === 1) return 'exact'
  return 'ambiguous'
}

function assertActiveCallerTransaction(
  session: ClientSession,
): void {
  if (
    typeof session.inTransaction !== 'function' ||
    !session.inTransaction()
  ) {
    throw repositoryError(
      'persistence_conflict',
      'Saved resume ownership mutation requires an active caller transaction',
    )
  }
}

function canonicalizeEjson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalizeEjson)
  }
  if (
    value &&
    typeof value === 'object'
  ) {
    const source = value as Record<string, unknown>
    return Object.fromEntries(
      Object.keys(source)
        .sort()
        .map((key) => [key, canonicalizeEjson(source[key])]),
    )
  }
  return value
}

function sha256CanonicalEjson(value: unknown): string {
  const extendedJson = BSON.EJSON.serialize(value, {
    relaxed: false,
  })
  return createHash('sha256')
    .update(JSON.stringify(canonicalizeEjson(extendedJson)))
    .digest('hex')
}

/**
 * Deterministic across object-key insertion order while retaining BSON type
 * distinctions and array order. Only the digest is safe for diagnostics.
 */
export function hashSavedResumeLegacyPayload(
  rawPayload: SavedResumeLegacyPayload,
): string {
  return sha256CanonicalEjson(asLegacyPayload(rawPayload))
}

export function hashSavedResumeLibrary(
  records: readonly SavedResumeCollectionRecord[],
): string {
  return sha256CanonicalEjson(
    [...records]
      .sort((left, right) => (
        left.ordinal - right.ordinal ||
        (
          left.resumeId < right.resumeId
            ? -1
            : left.resumeId > right.resumeId
              ? 1
              : 0
        )
      ))
      .map((record) => ({
        resumeId: record.resumeId,
        ordinal: record.ordinal,
        payloadHash: hashSavedResumeLegacyPayload(record.payload),
      })),
  )
}

function migrationEvidence(
  value: unknown,
): SavedResumeMigrationEvidence | undefined {
  if (value === undefined || value === null) return undefined
  if (
    typeof value !== 'object' ||
    Array.isArray(value)
  ) {
    throw repositoryError(
      'invalid_storage_state',
      'savedResumeMigration must be an object when present',
    )
  }
  return value as SavedResumeMigrationEvidence
}

/**
 * Resolves only explicit User metadata. Missing fields mean a legacy embedded
 * user; collection emptiness or presence is never consulted.
 */
export function resolveSavedResumeUserStorageState(
  raw: RawUserStorageState,
): SavedResumeUserStorageState {
  const rawMode = raw.savedResumeStorageMode
  const mode =
    rawMode === undefined || rawMode === null
      ? DEFAULT_SAVED_RESUME_STORAGE_MODE
      : rawMode

  if (!isStorageMode(mode)) {
    throw repositoryError(
      'invalid_storage_state',
      'savedResumeStorageMode is invalid',
    )
  }

  const embeddedValues =
    raw.savedResumes === undefined || raw.savedResumes === null
      ? []
      : raw.savedResumes
  if (!Array.isArray(embeddedValues)) {
    throw repositoryError(
      'invalid_storage_state',
      'savedResumes must be an array when present',
    )
  }

  return {
    mode,
    libraryVersion: nonNegativeSafeInteger(
      raw.savedResumeLibraryVersion,
      'savedResumeLibraryVersion',
    ),
    collectionCount: nonNegativeSafeInteger(
      raw.savedResumeCollectionCount,
      'savedResumeCollectionCount',
    ),
    embeddedPayloads: embeddedValues.map(asLegacyPayload),
    migration: migrationEvidence(raw.savedResumeMigration),
  }
}

function resolveSavedResumeUserReadState(
  raw: RawUserStorageState,
): SavedResumeUserReadState {
  const state = resolveSavedResumeUserStorageState(raw)
  return {
    mode: state.mode,
    libraryVersion: state.libraryVersion,
    collectionCount: state.collectionCount,
    embeddedMetadata: state.embeddedPayloads.map(
      toSavedResumeMetadata,
    ),
  }
}

export function resolveSavedResumeUserErasureState(
  raw: SavedResumeRawErasureState,
): SavedResumeUserErasureState {
  const rawMode = raw.savedResumeStorageMode
  const defaultedMode =
    rawMode === undefined || rawMode === null
      ? DEFAULT_SAVED_RESUME_STORAGE_MODE
      : rawMode
  const mode = isStorageMode(defaultedMode)
    ? defaultedMode
    : null
  const rawLibraryVersion = raw.savedResumeLibraryVersion
  const libraryVersion =
    rawLibraryVersion === undefined || rawLibraryVersion === null
      ? 0
      : Number.isSafeInteger(rawLibraryVersion) &&
          (rawLibraryVersion as number) >= 0
        ? rawLibraryVersion as number
        : null
  const rawCollectionCount = raw.savedResumeCollectionCount
  const collectionCount =
    rawCollectionCount === undefined || rawCollectionCount === null
      ? 0
      : Number.isSafeInteger(rawCollectionCount) &&
          (rawCollectionCount as number) >= 0
        ? rawCollectionCount as number
        : null
  return {
    mode,
    libraryVersion,
    collectionCount,
    authorityDiagnosticsValid:
      mode !== null &&
      libraryVersion !== null &&
      collectionCount !== null,
  }
}

/**
 * Builds collection rows without spreading, normalizing, serializing, or
 * round-tripping the legacy payload. `payload` is the exact input object.
 */
export function prepareSavedResumeMigrationRecords(
  payloads: readonly SavedResumeLegacyPayload[],
): SavedResumeCollectionRecord[] {
  const seen = new Set<string>()
  return payloads.map((rawPayload, ordinal) => {
    const payload = asLegacyPayload(rawPayload)
    if (seen.has(payload.id)) {
      throw repositoryError(
        'invalid_payload',
        'Legacy saved resume ids must be unique per user',
      )
    }
    seen.add(payload.id)
    return {
      resumeId: payload.id,
      ordinal,
      payload,
    }
  })
}

/**
 * Collection storage is an envelope only; returning the legacy payload does
 * not rename fields, add defaults, or remove unknown keys.
 */
export function restoreLegacySavedResumePayload(
  record: SavedResumeCollectionRecord,
): SavedResumeLegacyPayload {
  return record.payload
}

export function buildSavedResumeParityDiagnostics(
  embeddedPayloads: readonly SavedResumeLegacyPayload[],
  collectionRecords: readonly SavedResumeCollectionRecord[],
  fencedCollectionCount: number,
): SavedResumeParityDiagnostics {
  const embeddedRecords = prepareSavedResumeMigrationRecords(
    embeddedPayloads,
  )
  const embeddedById = new Map(
    embeddedRecords.map((record) => [record.resumeId, record]),
  )
  const collectionById = new Map(
    collectionRecords.map((record) => [record.resumeId, record]),
  )

  let missingFromCollectionCount = 0
  let payloadMismatchCount = 0
  let orderMismatchCount = 0
  const mismatches: SavedResumeParityMismatch[] = []
  embeddedById.forEach((embedded, resumeId) => {
    const collection = collectionById.get(resumeId)
    if (!collection) {
      missingFromCollectionCount += 1
      mismatches.push({
        resumeId,
        issueCodes: ['missing_collection_row'],
        embeddedHash: hashSavedResumeLegacyPayload(embedded.payload),
      })
      return
    }
    const embeddedHash = hashSavedResumeLegacyPayload(embedded.payload)
    const collectionHash = hashSavedResumeLegacyPayload(
      collection.payload,
    )
    const issueCodes: SavedResumeMigrationIssueCode[] = []
    if (embeddedHash !== collectionHash) {
      payloadMismatchCount += 1
      issueCodes.push('payload_hash_mismatch')
    }
    if (embedded.ordinal !== collection.ordinal) {
      orderMismatchCount += 1
      issueCodes.push('order_mismatch')
    }
    if (issueCodes.length > 0) {
      mismatches.push({
        resumeId,
        issueCodes,
        embeddedHash,
        collectionHash,
      })
    }
  })

  let unexpectedInCollectionCount = 0
  collectionById.forEach((collection, resumeId) => {
    if (!embeddedById.has(resumeId)) {
      unexpectedInCollectionCount += 1
      mismatches.push({
        resumeId,
        issueCodes: ['unexpected_collection_row'],
        collectionHash: hashSavedResumeLegacyPayload(
          collection.payload,
        ),
      })
    }
  })

  const collectionFenceMatches =
    fencedCollectionCount === collectionRecords.length
  if (!collectionFenceMatches) {
    mismatches.push({
      issueCodes: ['collection_fence_mismatch'],
    })
  }
  const sourceHash = hashSavedResumeLibrary(embeddedRecords)
  const collectionHash = hashSavedResumeLibrary(collectionRecords)
  const inParity =
    collectionFenceMatches &&
    missingFromCollectionCount === 0 &&
    unexpectedInCollectionCount === 0 &&
    payloadMismatchCount === 0 &&
    orderMismatchCount === 0

  return {
    embeddedCount: embeddedPayloads.length,
    collectionDocumentCount: collectionRecords.length,
    fencedCollectionCount,
    missingFromCollectionCount,
    unexpectedInCollectionCount,
    payloadMismatchCount,
    orderMismatchCount,
    collectionFenceMatches,
    sourceHash,
    collectionHash,
    mismatches,
    inParity,
  }
}

function assertCollectionFence(
  state: SavedResumeUserStorageState,
  records: readonly SavedResumeCollectionRecord[],
): void {
  assertCollectionCountFence(state, records.length)
}

function assertCollectionCountFence(
  state: Pick<SavedResumeUserStorageState, 'collectionCount'>,
  documentCount: number,
): void {
  if (state.collectionCount !== documentCount) {
    throw repositoryError(
      'collection_fence_mismatch',
      'Saved resume collection count does not match the User fence',
    )
  }
}

function writesEmbedded(mode: SavedResumeStorageMode): boolean {
  return mode !== 'collection_only'
}

function writesCollection(mode: SavedResumeStorageMode): boolean {
  return mode !== 'embedded'
}

function isDualMode(mode: SavedResumeStorageMode): boolean {
  return (
    mode === 'dual_embedded_primary' ||
    mode === 'dual_collection_primary'
  )
}

function collectionIsPrimary(mode: SavedResumeStorageMode): boolean {
  return (
    mode === 'dual_collection_primary' ||
    mode === 'collection_only'
  )
}

function nextOrdinal(
  records: readonly SavedResumeCollectionRecord[],
): number {
  return records.reduce(
    (maximum, record) => Math.max(maximum, record.ordinal),
    -1,
  ) + 1
}

function parityIssueCodes(
  parity: SavedResumeParityDiagnostics,
): SavedResumeMigrationIssueCode[] {
  return Array.from(
    new Set(
      parity.mismatches.flatMap(
        (mismatch) => mismatch.issueCodes,
      ),
    ),
  )
}

function hasCurrentDurableParityEvidence(
  state: SavedResumeUserStorageState,
  parity: SavedResumeParityDiagnostics,
): boolean {
  const evidence = state.migration
  return Boolean(
    parity.inParity &&
    evidence &&
    evidence.sourceHash === parity.sourceHash &&
    evidence.rowCount === parity.embeddedCount &&
    evidence.storageVersion === state.libraryVersion &&
    evidence.verifiedVersion === state.libraryVersion &&
    evidence.verifiedAt instanceof Date &&
    Number.isFinite(evidence.verifiedAt.getTime()) &&
    (evidence.issueCodes?.length ?? 0) === 0,
  )
}

function hasPostSoakContractEvidence(
  state: SavedResumeUserStorageState,
  transitionAt: Date,
): boolean {
  const evidence = state.migration
  const activatedAt = evidence?.collectionActivatedAt
  const verifiedAt = evidence?.verifiedAt
  return Boolean(
    evidence &&
    activatedAt instanceof Date &&
    Number.isFinite(activatedAt.getTime()) &&
    verifiedAt instanceof Date &&
    Number.isFinite(verifiedAt.getTime()) &&
    Number.isFinite(transitionAt.getTime()) &&
    transitionAt.getTime() >= verifiedAt.getTime() &&
    verifiedAt.getTime() >=
      activatedAt.getTime() +
        SAVED_RESUME_COLLECTION_PRIMARY_MIN_SOAK_MS,
  )
}

function transitionAllowed(
  current: SavedResumeStorageMode,
  target: SavedResumeStorageMode,
): boolean {
  return (
    (
      current === 'embedded' &&
      target === 'dual_embedded_primary'
    ) ||
    (
      current === 'dual_embedded_primary' &&
      target === 'dual_collection_primary'
    ) ||
    (
      current === 'dual_collection_primary' &&
      (
        target === 'dual_embedded_primary' ||
        target === 'collection_only'
      )
    )
  )
}

async function commitFence(
  transaction: SavedResumeRepositoryTransaction,
  userId: string,
  state: SavedResumeUserStorageState,
  nextCollectionCount: number,
  evidence?: SavedResumeMigrationEvidence,
  nextMode?: SavedResumeStorageMode,
): Promise<number> {
  const updated = await transaction.compareAndSetFence({
    userId,
    expectedMode: state.mode,
    expectedLibraryVersion: state.libraryVersion,
    expectedCollectionCount: state.collectionCount,
    nextCollectionCount,
    ...(nextMode ? { nextMode } : {}),
    ...(evidence ? { migrationEvidence: evidence } : {}),
  })
  if (!updated) {
    throw repositoryError(
      'persistence_conflict',
      'Saved resume storage changed concurrently',
    )
  }
  return state.libraryVersion + 1
}

function mutationResult(
  outcome: SavedResumeMutationOutcome,
  state: SavedResumeUserStorageState,
  resumeId: string,
  libraryVersion = state.libraryVersion,
  collectionCount = state.collectionCount,
): SavedResumeMutationResult {
  return {
    outcome,
    mode: state.mode,
    resumeId,
    libraryVersion,
    collectionCount,
  }
}

export function createSavedResumeRepository(
  store: SavedResumeRepositoryStore,
  dependencies: SavedResumeRepositoryDependencies = {},
): SavedResumeRepository {
  const now = dependencies.now ?? (() => new Date())
  const inspectIdentityInTransaction = async (
    transaction: SavedResumeRepositoryTransaction,
    userId: string,
    resumeId: string,
    expectedState?: SavedResumeIdentityExpectedState,
  ): Promise<SavedResumeIdentityInspection | null> => {
    const state = await transaction.loadUserReadState(userId)
    if (!state) return null
    assertExpectedIdentityState(state, expectedState)

    let matchingIdentityCount: number
    if (collectionIsPrimary(state.mode)) {
      const documentCount = await transaction.countCollection(userId)
      assertCollectionCountFence(state, documentCount)
      matchingIdentityCount =
        await transaction.countCollectionIdentity(userId, resumeId)
    } else {
      matchingIdentityCount = state.embeddedMetadata.filter(
        (candidate) => candidate.id === resumeId,
      ).length
    }
    if (
      !Number.isSafeInteger(matchingIdentityCount) ||
      matchingIdentityCount < 0
    ) {
      throw repositoryError(
        'invalid_storage_state',
        'Saved resume identity count is invalid',
      )
    }
    return {
      mode: state.mode,
      libraryVersion: state.libraryVersion,
      collectionCount: state.collectionCount,
      matchingIdentityCount,
      status: identityStatus(matchingIdentityCount),
    }
  }

  return {
    async list(userId, options) {
      return store.read(async (transaction) => {
        const state = await transaction.loadUserState(userId)
        if (!state) return null

        if (state.mode === 'embedded') {
          return {
            mode: state.mode,
            libraryVersion: state.libraryVersion,
            collectionCount: state.collectionCount,
            payloads: state.embeddedPayloads,
          }
        }

        const collectionRecords =
          await transaction.listCollection(userId)
        if (state.mode === 'collection_only') {
          return {
            mode: state.mode,
            libraryVersion: state.libraryVersion,
            collectionCount: state.collectionCount,
            payloads: collectionRecords.map(
              restoreLegacySavedResumePayload,
            ),
          }
        }

        const parity = buildSavedResumeParityDiagnostics(
          state.embeddedPayloads,
          collectionRecords,
          state.collectionCount,
        )
        return {
          mode: state.mode,
          libraryVersion: state.libraryVersion,
          collectionCount: state.collectionCount,
          payloads:
            state.mode === 'dual_collection_primary'
              ? collectionRecords.map(
                  restoreLegacySavedResumePayload,
                )
              : state.embeddedPayloads,
          parity,
        }
      }, options)
    },

    async get(userId, resumeId, options) {
      const listed = await this.list(userId, options)
      if (!listed) return null
      const payload = listed.payloads.find(
        (candidate) => candidate.id === resumeId,
      )
      if (!payload) return null

      let secondaryCopyMatches: boolean | undefined
      if (isDualMode(listed.mode)) {
        const parity = listed.parity
        secondaryCopyMatches = Boolean(
          parity &&
          parity.missingFromCollectionCount === 0 &&
          parity.payloadMismatchCount === 0 &&
          parity.orderMismatchCount === 0,
        )
      }

      return {
        mode: listed.mode,
        libraryVersion: listed.libraryVersion,
        payload,
        ...(secondaryCopyMatches === undefined
          ? {}
          : { secondaryCopyMatches }),
      }
    },

    async find(userId, resumeId, options) {
      return store.read(async (transaction) => {
        const state = await transaction.loadUserReadState(userId)
        if (!state) return null

        let payload: SavedResumeLegacyPayload | null
        if (collectionIsPrimary(state.mode)) {
          const documentCount =
            await transaction.countCollection(userId)
          assertCollectionCountFence(state, documentCount)
          payload = await transaction.findCollection(
            userId,
            resumeId,
          )
        } else {
          payload = state.embeddedMetadata.some(
              (metadata) => metadata.id === resumeId,
            )
            ? await transaction.findEmbedded(userId, resumeId)
            : null
        }
        if (!payload) return null

        return {
          mode: state.mode,
          libraryVersion: state.libraryVersion,
          payload,
        }
      }, options)
    },

    async exists(userId, resumeId, options) {
      return store.read(async (transaction) => {
        const state = await transaction.loadUserReadState(userId)
        if (!state) return false
        if (!collectionIsPrimary(state.mode)) {
          return state.embeddedMetadata.some(
            (metadata) => metadata.id === resumeId,
          )
        }
        const documentCount =
          await transaction.countCollection(userId)
        assertCollectionCountFence(state, documentCount)
        return transaction.collectionExists(userId, resumeId)
      }, options)
    },

    async inspectIdentity(userId, rawResumeId, options) {
      const normalizedUserId = userId.toString()
      const resumeId = validatedResumeId(rawResumeId)
      return store.read(
        (transaction) => inspectIdentityInTransaction(
          transaction,
          normalizedUserId,
          resumeId,
          options?.expectedState,
        ),
        options,
      )
    },

    async fenceOwnedIdentityForMutation(
      userId,
      rawResumeId,
      options,
    ) {
      assertActiveCallerTransaction(options.session)
      const normalizedUserId = userId.toString()
      const resumeId = validatedResumeId(rawResumeId)
      return store.read(async (transaction) => {
        if (transaction.session !== options.session) {
          throw repositoryError(
            'persistence_conflict',
            'Saved resume ownership fence lost the caller session',
          )
        }
        const inspection = await inspectIdentityInTransaction(
          transaction,
          normalizedUserId,
          resumeId,
          options.expectedState,
        )
        if (!inspection || inspection.status !== 'exact') {
          return inspection
        }
        const touched = await transaction.touchIdentityFence(
          normalizedUserId,
          {
            mode: inspection.mode,
            libraryVersion: inspection.libraryVersion,
            collectionCount: inspection.collectionCount,
          },
        )
        if (!touched) {
          throw repositoryError(
            'persistence_conflict',
            'Saved resume ownership changed concurrently',
          )
        }
        return inspection
      }, options)
    },

    async listMetadata(userId, options) {
      return store.read(async (transaction) => {
        const state = await transaction.loadUserReadState(userId)
        if (!state) return null

        const metadata = collectionIsPrimary(state.mode)
          ? await transaction.listCollectionMetadata(userId)
          : state.embeddedMetadata
        if (
          collectionIsPrimary(state.mode) &&
          metadata.length !== state.collectionCount
        ) {
          throw repositoryError(
            'collection_fence_mismatch',
            'Saved resume metadata count does not match the User fence',
          )
        }
        return {
          mode: state.mode,
          libraryVersion: state.libraryVersion,
          collectionCount: state.collectionCount,
          metadata,
        }
      }, options)
    },

    async create(userId, rawPayload, options) {
      const payload = asLegacyPayload(rawPayload)
      const maxCount = validatedMaxCount(options?.maxCount)
      const maxCountByMode = validatedMaxCountByMode(
        options?.maxCountByMode,
      )
      if (
        maxCount !== undefined &&
        maxCountByMode !== undefined
      ) {
        throw repositoryError(
          'invalid_payload',
          'Use maxCount or maxCountByMode, not both',
        )
      }
      return store.transact(userId, async (transaction) => {
        const state = await transaction.loadUserState(userId)
        if (!state) return { outcome: 'user_not_found' }

        if (state.mode === 'collection_only') {
          const documentCount =
            await transaction.countCollection(userId)
          assertCollectionCountFence(state, documentCount)
          const existingOrdinal =
            await transaction.findCollectionOrdinal(
              userId,
              payload.id,
            )
          if (existingOrdinal !== null) {
            return mutationResult(
              'already_exists',
              state,
              payload.id,
            )
          }

          const authoritativeMaxCount =
            maxCountByMode?.[state.mode] ?? maxCount
          if (
            authoritativeMaxCount !== undefined &&
            documentCount >= authoritativeMaxCount
          ) {
            return mutationResult(
              'limit_reached',
              state,
              payload.id,
            )
          }

          const ordinal =
            await transaction.nextCollectionOrdinal(userId)
          const inserted = await transaction.insertCollection(
            userId,
            {
              resumeId: payload.id,
              ordinal,
              payload,
            },
          )
          if (!inserted) {
            throw repositoryError(
              'persistence_conflict',
              'Collection saved resume create conflicted',
            )
          }

          const nextCollectionCount = documentCount + 1
          const libraryVersion = await commitFence(
            transaction,
            userId,
            state,
            nextCollectionCount,
          )
          return mutationResult(
            'created',
            state,
            payload.id,
            libraryVersion,
            nextCollectionCount,
          )
        }

        const embeddedExists = state.embeddedPayloads.some(
          (candidate) => candidate.id === payload.id,
        )
        if (
          !collectionIsPrimary(state.mode) &&
          embeddedExists
        ) {
          return mutationResult(
            'already_exists',
            state,
            payload.id,
          )
        }

        let collectionRecords:
          | readonly SavedResumeCollectionRecord[]
          | undefined
        if (writesCollection(state.mode)) {
          collectionRecords = await transaction.listCollection(userId)
          assertCollectionFence(state, collectionRecords)
          const collectionExists = collectionRecords.some(
            (record) => record.resumeId === payload.id,
          )
          if (collectionIsPrimary(state.mode) && collectionExists) {
            return mutationResult(
              'already_exists',
              state,
              payload.id,
            )
          }
          if (
            isDualMode(state.mode) &&
            (
              collectionIsPrimary(state.mode)
                ? embeddedExists
                : collectionExists
            )
          ) {
            throw repositoryError(
              'shadow_parity_mismatch',
              'Saved resume exists only in the secondary store',
            )
          }
        }

        const authoritativeCount = collectionIsPrimary(state.mode)
          ? (collectionRecords?.length ?? 0)
          : state.embeddedPayloads.length
        const authoritativeMaxCount =
          maxCountByMode?.[state.mode] ?? maxCount
        if (
          authoritativeMaxCount !== undefined &&
          authoritativeCount >= authoritativeMaxCount
        ) {
          return mutationResult(
            'limit_reached',
            state,
            payload.id,
          )
        }

        if (writesEmbedded(state.mode)) {
          const appended = await transaction.appendEmbedded(
            userId,
            payload,
          )
          if (!appended) {
            throw repositoryError(
              'persistence_conflict',
              'Embedded saved resume create conflicted',
            )
          }
        }

        let nextCollectionCount = state.collectionCount
        if (writesCollection(state.mode)) {
          const inserted = await transaction.insertCollection(
            userId,
            {
              resumeId: payload.id,
              ordinal:
                isDualMode(state.mode)
                  ? state.embeddedPayloads.length
                  : nextOrdinal(collectionRecords ?? []),
              payload,
            },
          )
          if (!inserted) {
            throw repositoryError(
              'persistence_conflict',
              'Collection saved resume create conflicted',
            )
          }
          nextCollectionCount += 1
        }

        const libraryVersion = await commitFence(
          transaction,
          userId,
          state,
          nextCollectionCount,
        )
        return mutationResult(
          'created',
          state,
          payload.id,
          libraryVersion,
          nextCollectionCount,
        )
      })
    },

    async update(userId, resumeId, rawPayload) {
      const payload = asLegacyPayload(rawPayload)
      if (payload.id !== resumeId) {
        throw repositoryError(
          'invalid_payload',
          'Updated payload id must exactly match resumeId',
        )
      }

      return store.transact(userId, async (transaction) => {
        const state = await transaction.loadUserState(userId)
        if (!state) return { outcome: 'user_not_found' }

        if (state.mode === 'collection_only') {
          const documentCount =
            await transaction.countCollection(userId)
          assertCollectionCountFence(state, documentCount)
          const ordinal =
            await transaction.findCollectionOrdinal(
              userId,
              resumeId,
            )
          if (ordinal === null) {
            return mutationResult('not_found', state, resumeId)
          }

          const replaced = await transaction.replaceCollection(
            userId,
            {
              resumeId,
              ordinal,
              payload,
            },
          )
          if (!replaced) {
            throw repositoryError(
              'persistence_conflict',
              'Collection saved resume update conflicted',
            )
          }

          const libraryVersion = await commitFence(
            transaction,
            userId,
            state,
            documentCount,
          )
          return mutationResult(
            'updated',
            state,
            resumeId,
            libraryVersion,
            documentCount,
          )
        }

        const embeddedOrdinal = state.embeddedPayloads.findIndex(
          (candidate) => candidate.id === resumeId,
        )
        if (
          !collectionIsPrimary(state.mode) &&
          embeddedOrdinal === -1
        ) {
          return mutationResult('not_found', state, resumeId)
        }

        let collectionRecords:
          | readonly SavedResumeCollectionRecord[]
          | undefined
        let collectionRecord:
          | SavedResumeCollectionRecord
          | undefined
        if (writesCollection(state.mode)) {
          collectionRecords = await transaction.listCollection(userId)
          assertCollectionFence(state, collectionRecords)
          collectionRecord = collectionRecords.find(
            (record) => record.resumeId === resumeId,
          )
          if (collectionIsPrimary(state.mode) && !collectionRecord) {
            return mutationResult('not_found', state, resumeId)
          }
          if (
            state.mode === 'dual_collection_primary' &&
            embeddedOrdinal === -1
          ) {
            throw repositoryError(
              'shadow_parity_mismatch',
              'Saved resume is missing from embedded rollback storage',
            )
          }
        }

        if (writesEmbedded(state.mode)) {
          const replaced = await transaction.replaceEmbedded(
            userId,
            resumeId,
            payload,
          )
          if (!replaced) {
            throw repositoryError(
              'persistence_conflict',
              'Embedded saved resume update conflicted',
            )
          }
        }

        let nextCollectionCount = state.collectionCount
        if (writesCollection(state.mode)) {
          const record = {
            resumeId,
            ordinal:
              isDualMode(state.mode)
                ? embeddedOrdinal
                : (collectionRecord?.ordinal ??
                  nextOrdinal(collectionRecords ?? [])),
            payload,
          }
          const replaced = collectionRecord
            ? await transaction.replaceCollection(userId, record)
            : await transaction.insertCollection(userId, record)
          if (!replaced) {
            throw repositoryError(
              'persistence_conflict',
              'Collection saved resume update conflicted',
            )
          }
          if (!collectionRecord) nextCollectionCount += 1
        }

        const libraryVersion = await commitFence(
          transaction,
          userId,
          state,
          nextCollectionCount,
        )
        return mutationResult(
          'updated',
          state,
          resumeId,
          libraryVersion,
          nextCollectionCount,
        )
      })
    },

    async remove(userId, resumeId, options) {
      return store.transact(userId, async (transaction) => {
        const state = await transaction.loadUserState(userId)
        if (!state) return { outcome: 'user_not_found' }

        if (state.mode === 'collection_only') {
          const documentCount =
            await transaction.countCollection(userId)
          assertCollectionCountFence(state, documentCount)
          const ordinal =
            await transaction.findCollectionOrdinal(
              userId,
              resumeId,
            )
          if (ordinal === null) {
            return mutationResult('not_found', state, resumeId)
          }

          if (options?.beforeMutation) {
            if (!transaction.session) {
              throw repositoryError(
                'invalid_storage_state',
                'beforeMutation requires a transactional ClientSession',
              )
            }
            await options.beforeMutation(
              transaction.session,
              {
                userId,
                resumeId,
                mode: state.mode,
                libraryVersion: state.libraryVersion,
              },
            )
          }

          const removed = await transaction.removeCollection(
            userId,
            resumeId,
          )
          if (!removed || documentCount === 0) {
            throw repositoryError(
              'persistence_conflict',
              'Collection saved resume delete conflicted',
            )
          }

          const nextCollectionCount = documentCount - 1
          const libraryVersion = await commitFence(
            transaction,
            userId,
            state,
            nextCollectionCount,
          )
          return mutationResult(
            'deleted',
            state,
            resumeId,
            libraryVersion,
            nextCollectionCount,
          )
        }

        const embeddedExists = state.embeddedPayloads.some(
          (candidate) => candidate.id === resumeId,
        )
        if (
          !collectionIsPrimary(state.mode) &&
          !embeddedExists
        ) {
          return mutationResult('not_found', state, resumeId)
        }

        let collectionRecords:
          | readonly SavedResumeCollectionRecord[]
          | undefined
        let collectionExists = false
        if (writesCollection(state.mode)) {
          collectionRecords = await transaction.listCollection(userId)
          assertCollectionFence(state, collectionRecords)
          collectionExists = collectionRecords.some(
            (record) => record.resumeId === resumeId,
          )
          if (collectionIsPrimary(state.mode) && !collectionExists) {
            return mutationResult('not_found', state, resumeId)
          }
        }

        if (options?.beforeMutation) {
          if (!transaction.session) {
            throw repositoryError(
              'invalid_storage_state',
              'beforeMutation requires a transactional ClientSession',
            )
          }
          await options.beforeMutation(
            transaction.session,
            {
              userId,
              resumeId,
              mode: state.mode,
              libraryVersion: state.libraryVersion,
            },
          )
        }

        if (writesEmbedded(state.mode) && embeddedExists) {
          const removed = await transaction.removeEmbedded(
            userId,
            resumeId,
          )
          if (!removed) {
            throw repositoryError(
              'persistence_conflict',
              'Embedded saved resume delete conflicted',
            )
          }
        }

        let nextCollectionCount = state.collectionCount
        if (collectionExists) {
          const removed = await transaction.removeCollection(
            userId,
            resumeId,
          )
          if (!removed || nextCollectionCount === 0) {
            throw repositoryError(
              'persistence_conflict',
              'Collection saved resume delete conflicted',
            )
          }
          nextCollectionCount -= 1
        }
        if (isDualMode(state.mode)) {
          const orderedResumeIds = state.embeddedPayloads
            .filter((payload) => payload.id !== resumeId)
            .map((payload) => payload.id)
          const reindexed = await transaction.reindexCollection(
            userId,
            orderedResumeIds,
          )
          if (!reindexed) {
            throw repositoryError(
              'persistence_conflict',
              'Collection saved resume reindex conflicted',
            )
          }
        }

        const libraryVersion = await commitFence(
          transaction,
          userId,
          state,
          nextCollectionCount,
        )
        return mutationResult(
          'deleted',
          state,
          resumeId,
          libraryVersion,
          nextCollectionCount,
        )
      })
    },

    async backfillEmbeddedToCollection(userId) {
      return store.transact(userId, async (transaction) => {
        const state = await transaction.loadUserState(userId)
        if (!state) {
          return {
            outcome: 'user_not_found',
            copied: 0,
            updated: 0,
          }
        }
        if (state.mode !== 'dual_embedded_primary') {
          throw repositoryError(
            'invalid_storage_state',
            'Backfill requires explicit dual_embedded_primary mode',
          )
        }

        const existing = await transaction.listCollection(userId)
        assertCollectionFence(state, existing)
        const records = prepareSavedResumeMigrationRecords(
          state.embeddedPayloads,
        )
        const expectedIds = new Set(
          records.map((record) => record.resumeId),
        )
        if (
          existing.some(
            (record) => !expectedIds.has(record.resumeId),
          )
        ) {
          throw repositoryError(
            'shadow_parity_mismatch',
            'Collection contains rows not present in embedded storage',
          )
        }

        const existingById = new Map(
          existing.map((record) => [record.resumeId, record]),
        )
        let copied = 0
        for (const record of records) {
          const current = existingById.get(record.resumeId)
          if (current) {
            if (
              current.ordinal !== record.ordinal ||
              !isDeepStrictEqual(current.payload, record.payload)
            ) {
              throw repositoryError(
                'shadow_parity_mismatch',
                'Existing collection row conflicts with embedded source',
              )
            }
            continue
          }

          const inserted =
            await transaction.insertCollection(userId, record)
          if (!inserted) {
            throw repositoryError(
              'persistence_conflict',
              'Collection backfill insert conflicted',
            )
          }
          copied += 1
        }

        const nextCollectionCount = records.length
        const nextLibraryVersion = state.libraryVersion + 1
        const parity = buildSavedResumeParityDiagnostics(
          state.embeddedPayloads,
          records,
          nextCollectionCount,
        )
        const libraryVersion = await commitFence(
          transaction,
          userId,
          state,
          nextCollectionCount,
          {
            sourceHash: parity.sourceHash,
            rowCount: records.length,
            storageVersion: nextLibraryVersion,
            verifiedVersion: nextLibraryVersion,
            verifiedAt: now(),
            issueCodes: [],
          },
        )
        return {
          outcome: 'backfilled',
          copied,
          updated: 0,
          libraryVersion,
          collectionCount: nextCollectionCount,
          parity,
        }
      })
    },

    async verifyDualParity(userId) {
      return store.transact(userId, async (transaction) => {
        const state = await transaction.loadUserState(userId)
        if (!state) return { outcome: 'user_not_found' }
        if (!isDualMode(state.mode)) {
          throw repositoryError(
            'invalid_storage_state',
            'Parity verification requires an explicit dual mode',
          )
        }

        const records = await transaction.listCollection(userId)
        const parity = buildSavedResumeParityDiagnostics(
          state.embeddedPayloads,
          records,
          state.collectionCount,
        )
        const nextLibraryVersion = state.libraryVersion + 1
        const commonEvidence: SavedResumeMigrationEvidence = {
          ...(state.migration ?? {}),
          sourceHash: parity.sourceHash,
          rowCount: parity.embeddedCount,
          verifiedAt: now(),
          issueCodes: parityIssueCodes(parity),
        }
        const evidence = parity.inParity
          ? {
              ...commonEvidence,
              storageVersion: nextLibraryVersion,
              verifiedVersion: nextLibraryVersion,
            }
          : {
              ...commonEvidence,
              storageVersion:
                state.migration?.storageVersion,
              verifiedVersion: undefined,
            }
        const libraryVersion = await commitFence(
          transaction,
          userId,
          state,
          state.collectionCount,
          evidence,
        )
        return {
          outcome: parity.inParity ? 'verified' : 'mismatch',
          mode: state.mode,
          libraryVersion,
          parity,
        }
      })
    },

    async transitionStorageMode(userId, targetMode, options) {
      if (!isStorageMode(targetMode)) {
        throw repositoryError(
          'invalid_storage_state',
          'Target saved resume storage mode is invalid',
        )
      }
      if (
        targetMode === 'collection_only' &&
        (
          !Number.isSafeInteger(
            options?.expectedVerifiedLibraryVersion,
          ) ||
          options!.expectedVerifiedLibraryVersion! < 1
        )
      ) {
        throw repositoryError(
          'contract_evidence_missing_or_stale',
          'Collection-only contraction requires an exact verified library version',
        )
      }
      if (
        targetMode !== 'collection_only' &&
        options?.expectedVerifiedLibraryVersion !== undefined
      ) {
        throw repositoryError(
          'invalid_payload',
          'Verified library version is accepted only for collection-only contraction',
        )
      }
      return store.transact(userId, async (transaction) => {
        const transitionAt = now()
        if (!Number.isFinite(transitionAt.getTime())) {
          throw repositoryError(
            'invalid_storage_state',
            'Saved resume storage transition time is invalid',
          )
        }
        const state = await transaction.loadUserState(userId)
        if (!state) return { outcome: 'user_not_found' }
        if (
          targetMode === 'collection_only' &&
          state.libraryVersion !==
            options!.expectedVerifiedLibraryVersion
        ) {
          throw repositoryError(
            'contract_evidence_missing_or_stale',
            'Saved resume verification version changed before contraction',
          )
        }
        if (!transitionAllowed(state.mode, targetMode)) {
          throw repositoryError(
            'invalid_storage_state',
            `Saved resume storage cannot transition from ${state.mode} to ${targetMode}`,
          )
        }

        const records = await transaction.listCollection(userId)
        assertCollectionFence(state, records)
        let parity: SavedResumeParityDiagnostics | undefined
        if (state.mode !== 'embedded') {
          parity = buildSavedResumeParityDiagnostics(
            state.embeddedPayloads,
            records,
            state.collectionCount,
          )
          if (!hasCurrentDurableParityEvidence(state, parity)) {
            throw repositoryError(
              'shadow_parity_mismatch',
              'Current durable parity evidence is required for cutover',
            )
          }
        } else if (
          state.collectionCount !== 0 ||
          records.length !== 0
        ) {
          throw repositoryError(
            'shadow_parity_mismatch',
            'Embedded-to-dual transition requires an empty collection',
          )
        }

        if (targetMode === 'collection_only') {
          if (!hasPostSoakContractEvidence(
            state,
            transitionAt,
          )) {
            throw repositoryError(
              'contract_evidence_missing_or_stale',
              'Collection-only contraction requires a post-soak collection-primary verification',
            )
          }
          const contracted =
            await transaction.contractEmbedded(userId)
          if (!contracted) {
            throw repositoryError(
              'persistence_conflict',
              'Embedded saved resume contraction conflicted',
            )
          }
        }

        const nextLibraryVersion = state.libraryVersion + 1
        const evidence = parity
          ? {
              ...(state.migration ?? {}),
              sourceHash: parity.sourceHash,
              rowCount: parity.embeddedCount,
              storageVersion: nextLibraryVersion,
              verifiedVersion: nextLibraryVersion,
              verifiedAt: transitionAt,
              issueCodes: [],
              ...(targetMode === 'dual_collection_primary'
                ? { collectionActivatedAt: transitionAt }
                : {}),
              ...(targetMode === 'collection_only'
                ? { embeddedContractedAt: transitionAt }
                : {}),
            }
          : state.migration
        const libraryVersion = await commitFence(
          transaction,
          userId,
          state,
          state.collectionCount,
          evidence,
          targetMode,
        )
        return {
          outcome: 'transitioned',
          previousMode: state.mode,
          mode: targetMode,
          libraryVersion,
          collectionCount: state.collectionCount,
        }
      })
    },

    async eraseAccountData(userId, options) {
      assertActiveCallerTransaction(options.session)
      const normalizedUserId = userId.toString()
      return store.read(async (transaction) => {
        if (transaction.session !== options.session) {
          throw repositoryError(
            'persistence_conflict',
            'Saved resume erasure lost the caller session',
          )
        }
        const state = await transaction.loadUserErasureState(
          normalizedUserId,
        )
        if (!state) return null
        const discoveredCollectionCount =
          await transaction.countCollection(normalizedUserId)
        const deletedCollectionCount =
          await transaction.removeAllCollection(normalizedUserId)
        if (deletedCollectionCount !== discoveredCollectionCount) {
          throw repositoryError(
            'persistence_conflict',
            'Saved resume collection changed during account erasure',
          )
        }
        const embeddedCleared =
          await transaction.contractEmbedded(normalizedUserId)
        if (!embeddedCleared) {
          throw repositoryError(
            'persistence_conflict',
            'Saved resume embedded data changed during account erasure',
          )
        }
        return {
          mode: state.mode,
          libraryVersion: state.libraryVersion,
          collectionCount: state.collectionCount,
          authorityDiagnosticsValid:
            state.authorityDiagnosticsValid,
          discoveredCollectionCount,
          deletedCollectionCount,
          embeddedCleared,
          collectionFenceMatched:
            state.collectionCount === null
              ? null
              : state.collectionCount === discoveredCollectionCount,
        }
      }, options)
    },
  }
}

function objectId(userId: string): mongoose.Types.ObjectId {
  if (!mongoose.Types.ObjectId.isValid(userId)) {
    throw repositoryError(
      'invalid_payload',
      'userId must be a valid ObjectId',
    )
  }
  return new mongoose.Types.ObjectId(userId)
}

function validatedReadMaxTimeMS(
  value: number | undefined,
): number | undefined {
  if (value === undefined) return undefined
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > 30_000
  ) {
    throw repositoryError(
      'invalid_payload',
      'maxTimeMS must be a safe integer between 1 and 30000',
    )
  }
  return value
}

function sessionQuery<
  T extends {
    session(session: ClientSession): T
    maxTimeMS(value: number): T
  },
>(
  query: T,
  session: ClientSession | undefined,
  maxTimeMS: number | undefined,
): T {
  let scoped = session ? query.session(session) : query
  if (maxTimeMS !== undefined) {
    scoped = scoped.maxTimeMS(maxTimeMS)
  }
  return scoped
}

function zeroOrMissing(field: string, expected: number) {
  return expected === 0
    ? {
        $or: [
          { [field]: 0 },
          { [field]: { $exists: false } },
        ],
      }
    : { [field]: expected }
}

function storageModeFence(mode: SavedResumeStorageMode) {
  return mode === 'embedded'
    ? {
        $or: [
          { savedResumeStorageMode: 'embedded' },
          { savedResumeStorageMode: { $exists: false } },
        ],
      }
    : { savedResumeStorageMode: mode }
}

function mongoTransaction(
  session?: ClientSession,
  maxTimeMS?: number,
): SavedResumeRepositoryTransaction {
  return {
    session,

    async loadUserState(userId) {
      const query = User.findById(objectId(userId))
        .select(
          'savedResumeStorageMode savedResumeLibraryVersion ' +
          'savedResumeCollectionCount savedResumeMigration savedResumes',
        )
        .lean()
      const raw = await sessionQuery(query, session, maxTimeMS)
      return raw
        ? resolveSavedResumeUserStorageState(
            raw as RawUserStorageState,
          )
        : null
    },

    async loadUserReadState(userId) {
      const embeddedMetadataSelection =
        SAVED_RESUME_METADATA_FIELDS.map(
          (field) => `savedResumes.${field}`,
        ).join(' ')
      const query = User.findById(objectId(userId))
        .select(
          'savedResumeStorageMode savedResumeLibraryVersion ' +
          `savedResumeCollectionCount ${embeddedMetadataSelection}`,
        )
        .lean()
      const raw = await sessionQuery(query, session, maxTimeMS)
      return raw
        ? resolveSavedResumeUserReadState(
            raw as RawUserStorageState,
          )
        : null
    },

    async loadUserErasureState(userId) {
      const query = User.findById(objectId(userId))
        .select(
          'savedResumeStorageMode savedResumeLibraryVersion ' +
          'savedResumeCollectionCount',
        )
        .lean()
      const raw = await sessionQuery(query, session, maxTimeMS)
      return raw
        ? resolveSavedResumeUserErasureState(
            raw as RawUserStorageState,
          )
        : null
    },

    async listCollection(userId) {
      const query = SavedResume.find({
        userId: objectId(userId),
      })
        .select('resumeId ordinal payload')
        .sort({ ordinal: 1, resumeId: 1 })
        .lean()
      const rows = await sessionQuery(query, session, maxTimeMS)
      return rows.map((row) => ({
        resumeId: row.resumeId,
        ordinal: row.ordinal,
        payload: asLegacyPayload(row.payload),
      }))
    },

    async countCollection(userId) {
      const query = SavedResume.countDocuments({
        userId: objectId(userId),
      })
      return sessionQuery(query, session, maxTimeMS)
    },

    async countCollectionIdentity(userId, resumeId) {
      const query = SavedResume.countDocuments({
        userId: objectId(userId),
        resumeId,
      })
      return sessionQuery(query, session, maxTimeMS)
    },

    async findCollectionOrdinal(userId, resumeId) {
      const query = SavedResume.findOne({
        userId: objectId(userId),
        resumeId,
      })
        .select('ordinal')
        .lean()
      const row = await sessionQuery(query, session, maxTimeMS)
      if (!row) return null
      if (
        !Number.isSafeInteger(row.ordinal) ||
        row.ordinal < 0
      ) {
        throw repositoryError(
          'invalid_storage_state',
          'Saved resume collection ordinal is invalid',
        )
      }
      return row.ordinal
    },

    async nextCollectionOrdinal(userId) {
      const query = SavedResume.findOne({
        userId: objectId(userId),
      })
        .select('ordinal')
        .sort({ ordinal: -1, resumeId: -1 })
        .lean()
      const row = await sessionQuery(query, session, maxTimeMS)
      if (!row) return 0
      if (
        !Number.isSafeInteger(row.ordinal) ||
        row.ordinal < 0 ||
        row.ordinal === Number.MAX_SAFE_INTEGER
      ) {
        throw repositoryError(
          'invalid_storage_state',
          'Saved resume collection ordinal cannot be advanced',
        )
      }
      return row.ordinal + 1
    },

    async findEmbedded(userId, resumeId) {
      const query = User.findOne({
        _id: objectId(userId),
        'savedResumes.id': resumeId,
      })
        .select({
          savedResumes: {
            $elemMatch: { id: resumeId },
          },
        })
        .lean()
      const raw = await sessionQuery(
        query,
        session,
        maxTimeMS,
      ) as unknown as {
        savedResumes?: unknown
      } | null
      if (
        !raw ||
        !Array.isArray(raw.savedResumes) ||
        raw.savedResumes.length === 0
      ) {
        return null
      }
      return asLegacyPayload(raw.savedResumes[0])
    },

    async findCollection(userId, resumeId) {
      const query = SavedResume.findOne({
        userId: objectId(userId),
        resumeId,
      })
        .select('payload')
        .lean()
      const row = await sessionQuery(query, session, maxTimeMS)
      return row ? asLegacyPayload(row.payload) : null
    },

    async collectionExists(userId, resumeId) {
      const query = SavedResume.exists({
        userId: objectId(userId),
        resumeId,
      })
      return Boolean(await sessionQuery(query, session, maxTimeMS))
    },

    async listCollectionMetadata(userId) {
      const payloadMetadataSelection =
        SAVED_RESUME_METADATA_FIELDS.map(
          (field) => `payload.${field}`,
        ).join(' ')
      const query = SavedResume.find({
        userId: objectId(userId),
      })
        .select(`ordinal ${payloadMetadataSelection}`)
        .sort({ ordinal: 1, resumeId: 1 })
        .lean()
      const rows = await sessionQuery(query, session, maxTimeMS)
      return rows.map((row) =>
        toSavedResumeMetadata(asLegacyPayload(row.payload)),
      )
    },

    async appendEmbedded(userId, payload) {
      const result = await User.collection.updateOne(
        {
          _id: objectId(userId),
          'savedResumes.id': { $ne: payload.id },
        },
        {
          $push: {
            savedResumes: payload,
          } as never,
        },
        { session },
      )
      return result.matchedCount === 1
    },

    async replaceEmbedded(userId, resumeId, payload) {
      const result = await User.collection.updateOne(
        {
          _id: objectId(userId),
          'savedResumes.id': resumeId,
        },
        {
          $set: {
            'savedResumes.$': payload,
          },
        },
        { session },
      )
      return result.matchedCount === 1
    },

    async removeEmbedded(userId, resumeId) {
      const result = await User.collection.updateOne(
        {
          _id: objectId(userId),
          'savedResumes.id': resumeId,
        },
        {
          $pull: {
            savedResumes: { id: resumeId },
          } as never,
        },
        { session },
      )
      return result.matchedCount === 1
    },

    async contractEmbedded(userId) {
      const result = await User.collection.updateOne(
        { _id: objectId(userId) },
        { $unset: { savedResumes: '' } },
        { session },
      )
      return result.matchedCount === 1
    },

    async insertCollection(userId, record) {
      try {
        await SavedResume.create(
          [{
            userId: objectId(userId),
            resumeId: record.resumeId,
            ordinal: record.ordinal,
            payload: record.payload,
          }],
          { session },
        )
        return true
      } catch (error) {
        if (
          error &&
          typeof error === 'object' &&
          'code' in error &&
          error.code === 11000
        ) {
          return false
        }
        throw error
      }
    },

    async replaceCollection(userId, record) {
      const result = await SavedResume.updateOne(
        {
          userId: objectId(userId),
          resumeId: record.resumeId,
        },
        {
          $set: {
            ordinal: record.ordinal,
            payload: record.payload,
            rowUpdatedAt: new Date(),
          },
        },
        { session, runValidators: true },
      )
      return result.matchedCount === 1
    },

    async removeCollection(userId, resumeId) {
      const result = await SavedResume.deleteOne(
        {
          userId: objectId(userId),
          resumeId,
        },
        { session },
      )
      return result.deletedCount === 1
    },

    async removeAllCollection(userId) {
      const result = await SavedResume.deleteMany(
        { userId: objectId(userId) },
        { session },
      )
      return result.deletedCount
    },

    async reindexCollection(userId, orderedResumeIds) {
      const userObjectId = objectId(userId)
      if (orderedResumeIds.length > 0) {
        const result = await SavedResume.bulkWrite(
          orderedResumeIds.map((resumeId, ordinal) => ({
            updateOne: {
              filter: {
                userId: userObjectId,
                resumeId,
              },
              update: {
                $set: {
                  ordinal,
                  rowUpdatedAt: new Date(),
                },
              },
            },
          })),
          { session },
        )
        if (result.matchedCount !== orderedResumeIds.length) {
          return false
        }
      }
      const countQuery = SavedResume.countDocuments({
        userId: userObjectId,
      })
      const count = await sessionQuery(
        countQuery,
        session,
        maxTimeMS,
      )
      return count === orderedResumeIds.length
    },

    async compareAndSetFence(input) {
      const cleanedEvidence = input.migrationEvidence
        ? Object.fromEntries(
            Object.entries(input.migrationEvidence).filter(
              ([, value]) => value !== undefined,
            ),
          )
        : undefined
      const result = await User.collection.updateOne(
        {
          _id: objectId(input.userId),
          $and: [
            storageModeFence(input.expectedMode),
            zeroOrMissing(
              'savedResumeLibraryVersion',
              input.expectedLibraryVersion,
            ),
            zeroOrMissing(
              'savedResumeCollectionCount',
              input.expectedCollectionCount,
            ),
          ],
        },
        {
          $set: {
            savedResumeStorageMode:
              input.nextMode ?? input.expectedMode,
            savedResumeLibraryVersion:
              input.expectedLibraryVersion + 1,
            savedResumeCollectionCount:
              input.nextCollectionCount,
            ...(cleanedEvidence
              ? { savedResumeMigration: cleanedEvidence }
              : {}),
          },
        },
        { session },
      )
      return result.matchedCount === 1
    },

    async touchIdentityFence(userId, expected) {
      const result = await User.collection.updateOne(
        {
          _id: objectId(userId),
          buyerState: { $ne: 'deletion_pending' },
          $and: [
            storageModeFence(expected.mode),
            zeroOrMissing(
              'savedResumeLibraryVersion',
              expected.libraryVersion,
            ),
            zeroOrMissing(
              'savedResumeCollectionCount',
              expected.collectionCount,
            ),
            {
              $or: [
                {
                  personalDataWriteVersion: {
                    $exists: false,
                  },
                },
                {
                  personalDataWriteVersion: {
                    $gte: 0,
                    $lt: Number.MAX_SAFE_INTEGER,
                  },
                },
              ],
            },
          ],
        },
        { $inc: { personalDataWriteVersion: 1 } },
        { session },
      )
      return result.matchedCount === 1
    },
  }
}

export const mongoSavedResumeRepositoryStore:
  SavedResumeRepositoryStore = {
    async read(work, options) {
      const maxTimeMS = validatedReadMaxTimeMS(options?.maxTimeMS)
      if (!options?.session) await connectDB()
      return work(mongoTransaction(options?.session, maxTimeMS))
    },

    async transact(userId, work) {
      return withPersonalDataWriteTransaction(
        userId,
        async (session) => work(mongoTransaction(session)),
      )
    },
  }

export const savedResumeRepository =
  createSavedResumeRepository(mongoSavedResumeRepositoryStore)
