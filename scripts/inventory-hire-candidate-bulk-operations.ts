#!/usr/bin/env tsx
/**
 * Read-only, privacy-minimized inventory for candidate bulk-operation rollback.
 *
 * This command deliberately has no dotenv preload and no apply mode. Operators
 * must inject an independently provisioned production-identity sentinel token.
 */

import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import mongoose from 'mongoose'
import { connectDB } from '../shared/db/connection'
import {
  HIRE_CANDIDATE_BULK_DISPATCH_STATUSES,
  HIRE_CANDIDATE_BULK_OPERATION_IDEMPOTENCY_INDEX,
  HIRE_CANDIDATE_BULK_OPERATION_JOB_HISTORY_INDEX,
  HIRE_CANDIDATE_BULK_OPERATION_RECOVERY_INDEX,
  HIRE_CANDIDATE_BULK_OPERATION_RETENTION_MS,
  HIRE_CANDIDATE_BULK_OPERATION_STATUSES,
  HIRE_CANDIDATE_BULK_OPERATION_TTL_INDEX,
  HireCandidateBulkOperation,
  type HireCandidateBulkDispatchStatus,
  type HireCandidateBulkOperationStatus,
} from '../modules/hire-candidate-actions/models/HireCandidateBulkOperation'

const INVENTORY_MAX_TIME_MS = 60_000
export const HIRE_CANDIDATE_BULK_INVENTORY_SENTINEL_COLLECTION =
  '__deployment_environment_identity'
export const HIRE_CANDIDATE_BULK_INVENTORY_SENTINEL_ID =
  'hire-candidate-bulk-operations-production-inventory-v1'
const INVENTORY_SENTINEL_ENVIRONMENT = 'production'
const INVENTORY_SENTINEL_SCHEMA_VERSION = 1
const INVENTORY_SENTINEL_TOKEN_MINIMUM_BYTES = 32
const INVENTORY_BINDING_DOMAIN =
  'hire-candidate-bulk-operations-production-inventory-binding-v1'

const INVENTORY_PROJECTION = {
  _id: 1,
  status: 1,
  dispatchStatus: 1,
  totalCount: 1,
  queuedCount: 1,
  processingCount: 1,
  succeededCount: 1,
  conflictCount: 1,
  failedCount: 1,
} as const

const REQUIRED_INDEXES = [
  {
    name: HIRE_CANDIDATE_BULK_OPERATION_IDEMPOTENCY_INDEX,
    key: { workspaceId: 1, requestedByMemberId: 1, clientOperationId: 1 },
    unique: true,
  },
  {
    name: HIRE_CANDIDATE_BULK_OPERATION_RECOVERY_INDEX,
    key: { workspaceId: 1, status: 1, nextRecoveryAt: 1, updatedAt: 1, _id: 1 },
  },
  {
    name: HIRE_CANDIDATE_BULK_OPERATION_JOB_HISTORY_INDEX,
    key: { workspaceId: 1, jobId: 1, createdAt: -1, _id: -1 },
  },
  {
    name: HIRE_CANDIDATE_BULK_OPERATION_TTL_INDEX,
    key: { purgeAt: 1 },
    expireAfterSeconds: 0,
  },
] as const

interface InventoryIndexDescription {
  name?: string
  key?: Record<string, unknown>
  unique?: boolean
  expireAfterSeconds?: number
  partialFilterExpression?: unknown
  sparse?: boolean
  hidden?: boolean
  collation?: unknown
}

interface InventoryConfiguration {
  environment: 'production'
  surface: 'hire-control'
  expectedDatabaseName: string
  sentinelToken: string
}

interface CanonicalMongoAuthority {
  scheme: 'mongodb' | 'mongodb+srv'
  authority: string
  srvServiceName: string
  replicaSetOption: string
  tls: 'true' | 'false'
  directConnection: 'true' | 'false'
  loadBalanced: 'true' | 'false'
}

interface InventorySentinelDocument {
  _id: string
  environment?: unknown
  surface?: unknown
  databaseName?: unknown
  schemaVersion?: unknown
  immutable?: unknown
  replicaSetName?: unknown
  replicaSetId?: unknown
  bulkOperationCollectionUuid?: unknown
  tokenSha256?: unknown
  bindingHmacSha256?: unknown
}

type InventoryDatabase = NonNullable<typeof mongoose.connection.db>

interface RawInventoryRow extends Record<string, unknown> {
  _id?: unknown
  status?: unknown
  dispatchStatus?: unknown
  totalCount?: unknown
  queuedCount?: unknown
  processingCount?: unknown
  succeededCount?: unknown
  conflictCount?: unknown
  failedCount?: unknown
}

export interface HireCandidateBulkOperationInventoryEntry {
  operationId: string
  status: HireCandidateBulkOperationStatus
  dispatchStatus: HireCandidateBulkDispatchStatus
  totalCount: number
  queuedCount: number
  processingCount: number
  succeededCount: number
  conflictCount: number
  failedCount: number
}

export interface HireCandidateBulkOperationInventorySummary {
  retainedOperationCount: number
  unresolvedOperationCount: number
  completenessInvariant: {
    expectedRetainedOperationCount: number
    enumeratedRetainedOperationCount: number
    exact: true
  }
  rollbackDisposition:
    | 'FIX_FORWARD_REQUIRED'
    | 'ROLLBACK_ELIGIBILITY_REQUIRES_RETAINED_ZERO_BASELINE'
  unresolvedOperations: HireCandidateBulkOperationInventoryEntry[]
}

export interface HireCandidateBulkOperationInventoryReport
  extends HireCandidateBulkOperationInventorySummary {
  schemaVersion: 1
  scope: 'retained-hire-candidate-bulk-operations'
  generatedAt: string
  targetIdentityVerified: true
  collection: string
  readPreference: 'primary'
  readConcern: 'snapshot'
  snapshotCommitWriteConcern: 'majority'
  terminalRetentionDays: number
}

interface InventoryAccumulator {
  retainedOperationCount: number
  unresolvedOperations: HireCandidateBulkOperationInventoryEntry[]
}

export interface HireCandidateBulkInventoryDependencies {
  environment?: NodeJS.ProcessEnv
  connect?: typeof connectDB
  now?: () => Date
}

function exactKey(
  actual: Record<string, unknown> | undefined,
  expected: Record<string, number>,
): boolean {
  if (!actual) return false
  const actualEntries = Object.entries(actual)
  const expectedEntries = Object.entries(expected)
  return (
    actualEntries.length === expectedEntries.length &&
    expectedEntries.every(
      ([field, direction], index) =>
        actualEntries[index]?.[0] === field &&
        actualEntries[index]?.[1] === direction,
    )
  )
}

export function assertExactHireCandidateBulkOperationInventoryIndexes(
  indexes: InventoryIndexDescription[],
): void {
  for (const expected of REQUIRED_INDEXES) {
    const matching = indexes.filter(
      (index) => index.name === expected.name || exactKey(index.key, expected.key),
    )
    const actual = matching[0]
    const expireAfterSeconds =
      'expireAfterSeconds' in expected
        ? expected.expireAfterSeconds
        : undefined
    if (
      matching.length !== 1 ||
      !actual ||
      actual.name !== expected.name ||
      !exactKey(actual.key, expected.key) ||
      Boolean(actual.unique) !== Boolean('unique' in expected && expected.unique) ||
      actual.expireAfterSeconds !== expireAfterSeconds ||
      actual.partialFilterExpression !== undefined ||
      actual.sparse === true ||
      actual.hidden === true ||
      actual.collation !== undefined
    ) {
      throw new Error(
        `candidate bulk-operation inventory requires exact index ${expected.name}`,
      )
    }
  }
}

function requiredEnvironmentValue(
  environment: NodeJS.ProcessEnv,
  name: string,
): string {
  const value = environment[name]
  if (typeof value !== 'string' || !value || value !== value.trim()) {
    throw new Error(
      `candidate bulk-operation inventory requires exact environment ${name}`,
    )
  }
  return value
}

export function hireCandidateBulkInventoryConfiguration(
  environment: NodeJS.ProcessEnv,
): InventoryConfiguration {
  const expectedEnvironment = requiredEnvironmentValue(
    environment,
    'HIRE_CANDIDATE_BULK_INVENTORY_EXPECTED_ENVIRONMENT',
  )
  const nodeEnvironment = requiredEnvironmentValue(environment, 'NODE_ENV')
  const surface = requiredEnvironmentValue(environment, 'IPG_SURFACE')
  const controlDatabase = requiredEnvironmentValue(
    environment,
    'HIRE_CONTROL_DATABASE_NAME',
  )
  const runtimeDatabase = requiredEnvironmentValue(
    environment,
    'HIRE_RUNTIME_DATABASE_NAME',
  )
  const b2cDatabase = requiredEnvironmentValue(environment, 'B2C_DATABASE_NAME')
  const expectedDatabaseName = requiredEnvironmentValue(
    environment,
    'HIRE_CANDIDATE_BULK_INVENTORY_EXPECTED_DATABASE_NAME',
  )
  const sentinelToken = requiredEnvironmentValue(
    environment,
    'HIRE_CANDIDATE_BULK_INVENTORY_SENTINEL_TOKEN',
  )
  if (
    expectedEnvironment !== INVENTORY_SENTINEL_ENVIRONMENT ||
    nodeEnvironment !== INVENTORY_SENTINEL_ENVIRONMENT ||
    surface !== 'hire-control' ||
    controlDatabase !== expectedDatabaseName ||
    new Set([controlDatabase, runtimeDatabase, b2cDatabase]).size !== 3 ||
    Buffer.byteLength(sentinelToken, 'utf8') <
      INVENTORY_SENTINEL_TOKEN_MINIMUM_BYTES
  ) {
    throw new Error(
      'candidate bulk-operation inventory production identity is not configured',
    )
  }
  return {
    environment: 'production',
    surface: 'hire-control',
    expectedDatabaseName,
    sentinelToken,
  }
}

function canonicalAuthorityPart(value: unknown): string {
  const normalized = typeof value === 'string' ? value.toLowerCase() : ''
  if (!normalized || /[\s,@/?#]/.test(normalized)) {
    throw new Error(
      'candidate bulk-operation inventory Mongo authority is invalid',
    )
  }
  return normalized
}

function canonicalMongoAuthority(mongoClient: {
  options?: {
    srvHost?: unknown
    hosts?: Iterable<unknown>
    replicaSet?: unknown
    srvServiceName?: unknown
    tls?: unknown
    directConnection?: unknown
    loadBalanced?: unknown
  }
}): CanonicalMongoAuthority {
  const options = mongoClient.options
  if (!options) {
    throw new Error(
      'candidate bulk-operation inventory Mongo authority is unavailable',
    )
  }
  let scheme: CanonicalMongoAuthority['scheme']
  let authority: string
  if (typeof options.srvHost === 'string' && options.srvHost) {
    scheme = 'mongodb+srv'
    authority = canonicalAuthorityPart(options.srvHost)
  } else {
    scheme = 'mongodb'
    const hosts = Array.from(
      new Set(
        Array.from(options.hosts ?? []).map((host) =>
          canonicalAuthorityPart(String(host)),
        ),
      ),
    ).sort()
    if (hosts.length === 0) {
      throw new Error(
        'candidate bulk-operation inventory Mongo authority is unavailable',
      )
    }
    authority = hosts.join(',')
  }
  if (
    options.replicaSet !== undefined &&
    (typeof options.replicaSet !== 'string' || !options.replicaSet)
  ) {
    throw new Error(
      'candidate bulk-operation inventory Mongo replica option is invalid',
    )
  }
  return {
    scheme,
    authority,
    srvServiceName: canonicalAuthorityPart(options.srvServiceName ?? 'mongodb'),
    replicaSetOption:
      typeof options.replicaSet === 'string' ? options.replicaSet : '',
    tls: options.tls === true ? 'true' : 'false',
    directConnection: options.directConnection === true ? 'true' : 'false',
    loadBalanced: options.loadBalanced === true ? 'true' : 'false',
  }
}

export function hireCandidateBulkInventorySentinelTokenSha256(
  sentinelToken: string,
): string {
  return createHash('sha256').update(sentinelToken, 'utf8').digest('hex')
}

function updateLengthFramed(
  hmac: ReturnType<typeof createHmac>,
  value: string,
): void {
  const bytes = Buffer.from(value, 'utf8')
  const length = Buffer.allocUnsafe(4)
  length.writeUInt32BE(bytes.length)
  hmac.update(length)
  hmac.update(bytes)
}

export function hireCandidateBulkInventoryBindingHmacSha256(input: {
  sentinelToken: string
  environment: string
  surface: string
  databaseName: string
  replicaSetName: string
  replicaSetId: string
  bulkOperationCollectionUuid: string
  mongoAuthority: CanonicalMongoAuthority
}): string {
  const hmac = createHmac('sha256', input.sentinelToken)
  const fields = [
    ['domain', INVENTORY_BINDING_DOMAIN],
    ['environment', input.environment],
    ['surface', input.surface],
    ['databaseName', input.databaseName],
    ['replicaSetName', input.replicaSetName],
    ['replicaSetId', input.replicaSetId],
    ['bulkOperationCollectionUuid', input.bulkOperationCollectionUuid],
    ['mongoScheme', input.mongoAuthority.scheme],
    ['mongoAuthority', input.mongoAuthority.authority],
    ['mongoSrvServiceName', input.mongoAuthority.srvServiceName],
    ['mongoReplicaSetOption', input.mongoAuthority.replicaSetOption],
    ['mongoTls', input.mongoAuthority.tls],
    ['mongoDirectConnection', input.mongoAuthority.directConnection],
    ['mongoLoadBalanced', input.mongoAuthority.loadBalanced],
  ] as const
  for (const [name, value] of fields) {
    updateLengthFramed(hmac, name)
    updateLengthFramed(hmac, value)
  }
  return hmac.digest('hex')
}

function digestMatches(actual: unknown, expected: string): boolean {
  if (
    typeof actual !== 'string' ||
    !/^[a-f0-9]{64}$/.test(actual) ||
    !/^[a-f0-9]{64}$/.test(expected)
  ) {
    return false
  }
  const actualBytes = Buffer.from(actual, 'hex')
  const expectedBytes = Buffer.from(expected, 'hex')
  return (
    actualBytes.length === expectedBytes.length &&
    timingSafeEqual(actualBytes, expectedBytes)
  )
}

function objectIdHex(value: unknown): string | null {
  const coordinate =
    value &&
    typeof value === 'object' &&
    'toHexString' in value &&
    typeof value.toHexString === 'function'
      ? value.toHexString()
      : typeof value === 'string'
        ? value
        : ''
  return /^[0-9a-f]{24}$/.test(coordinate) ? coordinate : null
}

function collectionUuidHex(value: unknown): string | null {
  if (typeof value === 'string') {
    return /^[0-9a-f]{32}$/.test(value) ? value : null
  }
  if (!value || typeof value !== 'object') return null
  const subtype =
    'sub_type' in value ? (value as { sub_type?: unknown }).sub_type : undefined
  if (subtype !== undefined && subtype !== 4) return null
  if (!('toString' in value) || typeof value.toString !== 'function') return null
  let coordinate = ''
  try {
    coordinate = (value.toString as (encoding?: string) => string)('hex')
  } catch {
    return null
  }
  return /^[0-9a-f]{32}$/.test(coordinate) ? coordinate : null
}

interface InventoryCollectionIdentity {
  uuid: string
  indexSignatureSha256: string
}

async function captureHireCandidateBulkOperationCollectionIdentity(input: {
  database: InventoryDatabase
  collectionName: string
  readIndexes: () => Promise<InventoryIndexDescription[]>
}): Promise<InventoryCollectionIdentity> {
  const namespace = (await input.database
    .listCollections({ name: input.collectionName }, { nameOnly: false })
    .toArray()) as Array<{
    name?: unknown
    type?: unknown
    info?: { uuid?: unknown }
  }>
  const uuid = collectionUuidHex(namespace[0]?.info?.uuid)
  if (
    namespace.length !== 1 ||
    namespace[0]?.name !== input.collectionName ||
    namespace[0]?.type !== 'collection' ||
    !uuid
  ) {
    throw new Error(
      'candidate bulk-operation inventory collection identity is invalid',
    )
  }
  const indexes = await input.readIndexes()
  assertExactHireCandidateBulkOperationInventoryIndexes(indexes)
  const normalizedIndexes = indexes
    .map((index) => ({
      name: index.name ?? null,
      key: Object.entries(index.key ?? {}),
      unique: index.unique === true,
      expireAfterSeconds: index.expireAfterSeconds ?? null,
      partialFilterExpression: index.partialFilterExpression ?? null,
      sparse: index.sparse === true,
      hidden: index.hidden === true,
      collation: index.collation ?? null,
    }))
    .sort((left, right) => String(left.name).localeCompare(String(right.name)))
  return {
    uuid,
    indexSignatureSha256: createHash('sha256')
      .update(JSON.stringify(normalizedIndexes))
      .digest('hex'),
  }
}

async function verifyHireCandidateBulkInventoryProductionIdentity(input: {
  database: InventoryDatabase
  configuration: InventoryConfiguration
  mongoAuthority: CanonicalMongoAuthority
  bulkOperationCollectionUuid: string
}): Promise<void> {
  const {
    database,
    configuration,
    mongoAuthority,
    bulkOperationCollectionUuid,
  } = input
  const replicaConfiguration = await database.admin().command(
    { replSetGetConfig: 1, commitmentStatus: true },
    { readPreference: 'primary' },
  )
  const replicaSetName = replicaConfiguration?.config?._id
  const replicaSetId = objectIdHex(
    replicaConfiguration?.config?.settings?.replicaSetId,
  )
  if (
    replicaConfiguration?.commitmentStatus !== true ||
    typeof replicaSetName !== 'string' ||
    !replicaSetName ||
    !replicaSetId ||
    (mongoAuthority.replicaSetOption &&
      mongoAuthority.replicaSetOption !== replicaSetName)
  ) {
    throw new Error(
      'candidate bulk-operation inventory live replica identity is invalid',
    )
  }
  const sentinel = await database
    .collection<InventorySentinelDocument>(
      HIRE_CANDIDATE_BULK_INVENTORY_SENTINEL_COLLECTION,
    )
    .findOne(
      { _id: HIRE_CANDIDATE_BULK_INVENTORY_SENTINEL_ID },
      {
        projection: {
          _id: 1,
          environment: 1,
          surface: 1,
          databaseName: 1,
          schemaVersion: 1,
          immutable: 1,
          replicaSetName: 1,
          replicaSetId: 1,
          bulkOperationCollectionUuid: 1,
          tokenSha256: 1,
          bindingHmacSha256: 1,
        },
        readConcern: { level: 'majority' },
        readPreference: 'primary',
        maxTimeMS: INVENTORY_MAX_TIME_MS,
      },
    )
  const expectedTokenSha256 = hireCandidateBulkInventorySentinelTokenSha256(
    configuration.sentinelToken,
  )
  const expectedBindingHmacSha256 =
    hireCandidateBulkInventoryBindingHmacSha256({
      sentinelToken: configuration.sentinelToken,
      environment: configuration.environment,
      surface: configuration.surface,
      databaseName: configuration.expectedDatabaseName,
      replicaSetName,
      replicaSetId,
      bulkOperationCollectionUuid,
      mongoAuthority,
    })
  if (
    !sentinel ||
    sentinel._id !== HIRE_CANDIDATE_BULK_INVENTORY_SENTINEL_ID ||
    sentinel.environment !== configuration.environment ||
    sentinel.surface !== configuration.surface ||
    sentinel.databaseName !== configuration.expectedDatabaseName ||
    sentinel.schemaVersion !== INVENTORY_SENTINEL_SCHEMA_VERSION ||
    sentinel.immutable !== true ||
    sentinel.replicaSetName !== replicaSetName ||
    sentinel.replicaSetId !== replicaSetId ||
    sentinel.bulkOperationCollectionUuid !== bulkOperationCollectionUuid ||
    !digestMatches(sentinel.tokenSha256, expectedTokenSha256) ||
    !digestMatches(
      sentinel.bindingHmacSha256,
      expectedBindingHmacSha256,
    )
  ) {
    throw new Error(
      'candidate bulk-operation inventory production identity sentinel is invalid',
    )
  }
}

function objectIdOf(value: unknown): string {
  const coordinate = objectIdHex(value)
  if (!coordinate) {
    throw new Error('candidate bulk-operation inventory found a malformed operation id')
  }
  return coordinate
}

function counterOf(
  row: RawInventoryRow,
  field: keyof Pick<
    RawInventoryRow,
    | 'totalCount'
    | 'queuedCount'
    | 'processingCount'
    | 'succeededCount'
    | 'conflictCount'
    | 'failedCount'
  >,
  totalCount?: number,
): number {
  const value = row[field]
  const maximum = totalCount ?? 5000
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > maximum) {
    throw new Error(`candidate bulk-operation inventory found malformed ${field}`)
  }
  return Number(value)
}

function enumValueOf<const T extends readonly string[]>(
  values: T,
  value: unknown,
  field: string,
): T[number] {
  if (typeof value !== 'string' || !values.includes(value)) {
    throw new Error(`candidate bulk-operation inventory found malformed ${field}`)
  }
  return value as T[number]
}

function inspectInventoryRow(row: RawInventoryRow): {
  entry: HireCandidateBulkOperationInventoryEntry
  unresolved: boolean
} {
  const operationId = objectIdOf(row._id)
  const status = enumValueOf(
    HIRE_CANDIDATE_BULK_OPERATION_STATUSES,
    row.status,
    'status',
  )
  const dispatchStatus = enumValueOf(
    HIRE_CANDIDATE_BULK_DISPATCH_STATUSES,
    row.dispatchStatus,
    'dispatchStatus',
  )
  const totalCount = counterOf(row, 'totalCount')
  if (totalCount < 1) {
    throw new Error(
      `candidate bulk-operation inventory found malformed counters for ${operationId}`,
    )
  }
  const queuedCount = counterOf(row, 'queuedCount', totalCount)
  const processingCount = counterOf(row, 'processingCount', totalCount)
  const succeededCount = counterOf(row, 'succeededCount', totalCount)
  const conflictCount = counterOf(row, 'conflictCount', totalCount)
  const failedCount = counterOf(row, 'failedCount', totalCount)
  const remainingCount = queuedCount + processingCount
  const settledCount = succeededCount + conflictCount + failedCount
  if (remainingCount + settledCount !== totalCount) {
    throw new Error(
      `candidate bulk-operation inventory found malformed counters for ${operationId}`,
    )
  }
  const statusCountersAreValid =
    (status === 'queued' &&
      queuedCount === totalCount &&
      processingCount === 0 &&
      settledCount === 0) ||
    (status === 'processing' && remainingCount > 0) ||
    (status === 'completed' &&
      remainingCount === 0 &&
      succeededCount === totalCount &&
      conflictCount === 0 &&
      failedCount === 0) ||
    (status === 'partial' &&
      remainingCount === 0 &&
      succeededCount > 0 &&
      conflictCount + failedCount > 0) ||
    (status === 'failed' &&
      remainingCount === 0 &&
      succeededCount === 0 &&
      conflictCount + failedCount === totalCount)
  if (!statusCountersAreValid) {
    throw new Error(
      `candidate bulk-operation inventory found malformed status counters for ${operationId}`,
    )
  }
  return {
    entry: {
      operationId,
      status,
      dispatchStatus,
      totalCount,
      queuedCount,
      processingCount,
      succeededCount,
      conflictCount,
      failedCount,
    },
    unresolved:
      status === 'queued' ||
      status === 'processing' ||
      remainingCount > 0 ||
      settledCount !== totalCount,
  }
}

function accumulateInventoryRow(
  accumulator: InventoryAccumulator,
  row: RawInventoryRow,
): void {
  const inspected = inspectInventoryRow(row)
  accumulator.retainedOperationCount += 1
  if (inspected.unresolved) {
    accumulator.unresolvedOperations.push(inspected.entry)
  }
}

function finalizeInventorySummary(
  accumulator: InventoryAccumulator,
  expectedRetainedOperationCount: number,
): HireCandidateBulkOperationInventorySummary {
  if (
    !Number.isSafeInteger(expectedRetainedOperationCount) ||
    expectedRetainedOperationCount < 0 ||
    accumulator.retainedOperationCount !== expectedRetainedOperationCount
  ) {
    throw new Error(
      'candidate bulk-operation inventory completeness invariant failed',
    )
  }
  accumulator.unresolvedOperations.sort((left, right) =>
    left.operationId.localeCompare(right.operationId),
  )
  return {
    retainedOperationCount: accumulator.retainedOperationCount,
    unresolvedOperationCount: accumulator.unresolvedOperations.length,
    completenessInvariant: {
      expectedRetainedOperationCount,
      enumeratedRetainedOperationCount: accumulator.retainedOperationCount,
      exact: true,
    },
    rollbackDisposition:
      accumulator.retainedOperationCount > 0
        ? 'FIX_FORWARD_REQUIRED'
        : 'ROLLBACK_ELIGIBILITY_REQUIRES_RETAINED_ZERO_BASELINE',
    unresolvedOperations: accumulator.unresolvedOperations,
  }
}

export function summarizeHireCandidateBulkOperationInventory(
  rows: ReadonlyArray<RawInventoryRow>,
  expectedRetainedOperationCount: number,
): HireCandidateBulkOperationInventorySummary {
  const accumulator: InventoryAccumulator = {
    retainedOperationCount: 0,
    unresolvedOperations: [],
  }
  for (const row of rows) accumulateInventoryRow(accumulator, row)
  return finalizeInventorySummary(accumulator, expectedRetainedOperationCount)
}

async function summarizeAsyncHireCandidateBulkOperationInventory(
  rows: AsyncIterable<RawInventoryRow>,
  expectedRetainedOperationCount: number,
): Promise<HireCandidateBulkOperationInventorySummary> {
  const accumulator: InventoryAccumulator = {
    retainedOperationCount: 0,
    unresolvedOperations: [],
  }
  for await (const row of rows) accumulateInventoryRow(accumulator, row)
  return finalizeInventorySummary(accumulator, expectedRetainedOperationCount)
}

export async function inventoryHireCandidateBulkOperations(
  dependencies: HireCandidateBulkInventoryDependencies = {},
): Promise<HireCandidateBulkOperationInventoryReport> {
  const environment = dependencies.environment ?? process.env
  const configuration = hireCandidateBulkInventoryConfiguration(environment)
  const connection = await (dependencies.connect ?? connectDB)({
    schemaInitialization: 'disabled',
  })
  const database = connection.connection.db
  if (!database) {
    throw new Error('candidate bulk-operation inventory database is unavailable')
  }
  if (connection.connection.name !== configuration.expectedDatabaseName) {
    throw new Error(
      'candidate bulk-operation inventory connected database is not approved',
    )
  }
  const mongoClient = connection.connection.getClient()
  const mongoAuthority = canonicalMongoAuthority(mongoClient)
  const collectionName = HireCandidateBulkOperation.collection.name
  const collection = database.collection<RawInventoryRow>(collectionName)
  const collectionIdentityBefore =
    await captureHireCandidateBulkOperationCollectionIdentity({
      database,
      collectionName,
      readIndexes: () => collection.indexes(),
    })
  await verifyHireCandidateBulkInventoryProductionIdentity({
    database,
    configuration,
    mongoAuthority,
    bulkOperationCollectionUuid: collectionIdentityBefore.uuid,
  })

  const session = mongoClient.startSession()
  try {
    session.startTransaction({
      readConcern: { level: 'snapshot' },
      readPreference: 'primary',
      writeConcern: { w: 'majority' },
    })
    const expectedRetainedOperationCount = await collection.countDocuments(
      {},
      { session, maxTimeMS: INVENTORY_MAX_TIME_MS },
    )
    const rows = collection.find(
      {},
      {
        projection: INVENTORY_PROJECTION,
        sort: { _id: 1 },
        session,
        batchSize: 250,
        maxTimeMS: INVENTORY_MAX_TIME_MS,
      },
    )
    const summary = await summarizeAsyncHireCandidateBulkOperationInventory(
      rows,
      expectedRetainedOperationCount,
    )
    await session.commitTransaction()
    const collectionIdentityAfter =
      await captureHireCandidateBulkOperationCollectionIdentity({
        database,
        collectionName,
        readIndexes: () => collection.indexes(),
      })
    if (
      collectionIdentityAfter.uuid !== collectionIdentityBefore.uuid ||
      collectionIdentityAfter.indexSignatureSha256 !==
        collectionIdentityBefore.indexSignatureSha256
    ) {
      throw new Error(
        'candidate bulk-operation inventory collection identity changed',
      )
    }
    await verifyHireCandidateBulkInventoryProductionIdentity({
      database,
      configuration,
      mongoAuthority,
      bulkOperationCollectionUuid: collectionIdentityAfter.uuid,
    })
    return {
      schemaVersion: 1,
      scope: 'retained-hire-candidate-bulk-operations',
      generatedAt: (dependencies.now ?? (() => new Date()))().toISOString(),
      targetIdentityVerified: true,
      collection: collectionName,
      readPreference: 'primary',
      readConcern: 'snapshot',
      snapshotCommitWriteConcern: 'majority',
      terminalRetentionDays:
        HIRE_CANDIDATE_BULK_OPERATION_RETENTION_MS / (24 * 60 * 60 * 1000),
      ...summary,
    }
  } finally {
    if (session.inTransaction()) await session.abortTransaction()
    await session.endSession()
  }
}

async function main(): Promise<void> {
  try {
    const report = await inventoryHireCandidateBulkOperations()
    console.log(JSON.stringify(report, null, 2))
  } finally {
    await mongoose.disconnect()
  }
}

const isMain =
  !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  main().catch((error) => {
    console.error(
      'Hire candidate bulk-operation inventory failed closed:',
      error instanceof Error ? error.message : 'unknown error',
    )
    process.exit(1)
  })
}
