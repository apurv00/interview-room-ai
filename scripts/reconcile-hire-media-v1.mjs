#!/usr/bin/env node

import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import {
  DeleteObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3'
import { MongoClient, ObjectId } from 'mongodb'
import {
  CONFORMANCE_ROOT,
  PRODUCTION_V2_PREFIX,
} from './check-hire-media-r2-protocol.mjs'

const PRODUCTION_MEDIA_PREFIX = 'hire-media/'
const MEDIA_COLLECTION = 'hiremediaassets'
export const HIRE_MEDIA_V1_SENTINEL_COLLECTION =
  '__deployment_environment_identity'
export const HIRE_MEDIA_V1_SENTINEL_ID =
  'hire-media-v1-production-reconciliation-v1'
const HIRE_MEDIA_V1_SENTINEL_ENVIRONMENT = 'production'
const HIRE_MEDIA_V1_SENTINEL_SCHEMA_VERSION = 1
const HIRE_MEDIA_V1_SENTINEL_TOKEN_MINIMUM_BYTES = 32
const HIRE_MEDIA_V1_BINDING_DOMAIN = 'hire-media-v1-production-binding-v2'
const HIRE_MEDIA_V1_R2_JURISDICTION = 'default'
const CANONICAL_V1_KEY = /^hire-media\/([a-f0-9]{24})\/([a-f0-9]{24})\/([a-f0-9]{24})\/([a-f0-9]{24})\/([a-f0-9]{24})-(identity-photo\.jpg|camera-recording\.webm|screen-recording\.webm|audio-recording\.webm|facial-landmarks\.json)$/
const CANONICAL_V2_KEY = /^hire-media\/v2\/[a-f0-9]{64}$/
const CANONICAL_V2_NONCE = /^[a-f0-9]{64}$/

const FILE_KIND = Object.freeze({
  'identity-photo.jpg': 'identity_photo',
  'camera-recording.webm': 'camera_recording',
  'screen-recording.webm': 'screen_recording',
  'audio-recording.webm': 'audio_recording',
  'facial-landmarks.json': 'facial_landmarks',
})

export const HIRE_MEDIA_V1_DESTRUCTIVE_ACK =
  'delete-exact-canonical-v1-orphans-and-logically-purged-objects'

const DESTRUCTIVE_ASSERTIONS = Object.freeze({
  HIRE_MEDIA_V1_ENVIRONMENT_BINDING_ACK:
    'exact-production-control-bucket-and-database-pair-reviewed',
  HIRE_MEDIA_V1_FREEZE_ACK: 'hire-control-write-freeze-active',
  HIRE_MEDIA_V1_OLD_WORKERS_ACK: 'zero-old-hire-media-writers-and-deleters',
  HIRE_MEDIA_V1_EXTERNAL_PRINCIPALS_ACK:
    'all-credentialed-r2-writer-and-cleanup-principals-inventoried-and-frozen',
  HIRE_MEDIA_V1_STAGING_ACK: 'zero-staging-asserted',
  HIRE_MEDIA_V1_PURGE_CLAIMED_ACK: 'zero-purge-claimed-asserted',
  HIRE_MEDIA_V1_LATE_WRITE_EVIDENCE_ACK:
    'provider-barrier-or-old-write-namespace-retirement-evidence-recorded',
})

const LATE_WRITE_SAFETY_MODES = new Set([
  'provider-enforced-write-barrier-completed',
  'provider-documented-settlement-bound-completed',
  'old-v1-write-namespace-or-bucket-retired',
])

const SAFE_STATUS = new Set([
  'read-only-clean',
  'reconciliation-required',
  'blocked-malformed',
  'blocked-existing-v2',
  'blocked-active-database-work',
  'destructive-reconciled-observation',
  'blocked-post-delete-rescan',
])

class ReconciliationRefusal extends Error {
  constructor(code) {
    super(code)
    this.name = 'ReconciliationRefusal'
    this.code = code
  }
}

function refuse(code) {
  throw new ReconciliationRefusal(code)
}

function usage(write = console.log) {
  write(`Hire media legacy-v1 R2/Mongo reconciliation

Usage:
  npm run reconcile:hire-media-v1
  HIRE_MEDIA_V1_DESTRUCTIVE_ACK=${HIRE_MEDIA_V1_DESTRUCTIVE_ACK} \\
    npm run reconcile:hire-media-v1 -- --delete

The default mode is read-only. It fully scans the exact production control
bucket below ${PRODUCTION_MEDIA_PREFIX}, excludes ${PRODUCTION_V2_PREFIX} and
${CONFORMANCE_ROOT}, and reports aggregate counts only. It never prints object
keys, Mongo IDs, nonces, database URIs, bucket names, or credentials.

--delete requires every freeze, ownership, database-drain, credentialed-
principal, immutable live-replica identity, and late-write-safety assertion
documented in the cold-cutover runbook. A clean rescan is an observation, not
proof that an unbounded old unconditional PUT cannot complete later.
`)
}

function parseArguments(argv) {
  const options = { delete: false, help: false }
  for (const argument of argv) {
    if (argument === '--delete') options.delete = true
    else if (argument === '--help' || argument === '-h') options.help = true
    else refuse('unknown_argument')
  }
  return options
}

function requiredEnvironmentValue(environment, name) {
  const value = environment[name]
  if (typeof value !== 'string' || value.length === 0) {
    refuse(`missing_environment_${name}`)
  }
  if (value !== value.trim()) {
    refuse(`invalid_environment_${name}`)
  }
  return value
}

export function hireMediaV1SentinelTokenSha256(token) {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

function updateLengthFramed(hmac, value) {
  const bytes = Buffer.from(value, 'utf8')
  const length = Buffer.allocUnsafe(4)
  length.writeUInt32BE(bytes.length)
  hmac.update(length)
  hmac.update(bytes)
}

export function hireMediaV1ProductionBindingHmacSha256({
  token,
  environment,
  surface,
  databaseName,
  replicaSetName,
  replicaSetId,
  mongoScheme,
  mongoAuthority,
  mongoSrvServiceName,
  mongoReplicaSetOption,
  mongoTls,
  mongoDirectConnection,
  mongoLoadBalanced,
  r2Jurisdiction,
  r2Endpoint,
  r2AccountId,
  r2Bucket,
  r2Prefix,
}) {
  const hmac = createHmac('sha256', token)
  const fields = [
    ['domain', HIRE_MEDIA_V1_BINDING_DOMAIN],
    ['environment', environment],
    ['surface', surface],
    ['databaseName', databaseName],
    ['replicaSetName', replicaSetName],
    ['replicaSetId', replicaSetId],
    ['mongoScheme', mongoScheme],
    ['mongoAuthority', mongoAuthority],
    ['mongoSrvServiceName', mongoSrvServiceName],
    ['mongoReplicaSetOption', mongoReplicaSetOption],
    ['mongoTls', mongoTls],
    ['mongoDirectConnection', mongoDirectConnection],
    ['mongoLoadBalanced', mongoLoadBalanced],
    ['r2Jurisdiction', r2Jurisdiction],
    ['r2Endpoint', r2Endpoint],
    ['r2AccountId', r2AccountId],
    ['r2Bucket', r2Bucket],
    ['r2Prefix', r2Prefix],
  ]
  for (const [name, value] of fields) {
    updateLengthFramed(hmac, name)
    updateLengthFramed(hmac, value)
  }
  return hmac.digest('hex')
}

function digestMatches(actual, expected) {
  if (
    typeof actual !== 'string' ||
    !/^[a-f0-9]{64}$/.test(actual) ||
    typeof expected !== 'string' ||
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

function readConfiguration(environment, destructive) {
  const expectedEnvironment = requiredEnvironmentValue(
    environment,
    'HIRE_MEDIA_V1_EXPECTED_ENVIRONMENT',
  )
  const nodeEnvironment = requiredEnvironmentValue(environment, 'NODE_ENV')
  const surface = requiredEnvironmentValue(environment, 'IPG_SURFACE')
  const expectedSurface = requiredEnvironmentValue(
    environment,
    'HIRE_MEDIA_V1_EXPECTED_SURFACE',
  )
  const controlDatabase = requiredEnvironmentValue(
    environment,
    'HIRE_CONTROL_DATABASE_NAME',
  )
  const runtimeDatabase = requiredEnvironmentValue(
    environment,
    'HIRE_RUNTIME_DATABASE_NAME',
  )
  const b2cDatabase = requiredEnvironmentValue(
    environment,
    'B2C_DATABASE_NAME',
  )
  const expectedDatabase = requiredEnvironmentValue(
    environment,
    'HIRE_MEDIA_V1_EXPECTED_DATABASE_NAME',
  )
  const bucket = requiredEnvironmentValue(environment, 'R2_BUCKET_NAME')
  const expectedBucket = requiredEnvironmentValue(
    environment,
    'HIRE_MEDIA_V1_EXPECTED_BUCKET_NAME',
  )
  const accountId = requiredEnvironmentValue(environment, 'R2_ACCOUNT_ID')
  const expectedAccountId = requiredEnvironmentValue(
    environment,
    'HIRE_MEDIA_V1_EXPECTED_R2_ACCOUNT_ID',
  )
  const r2Endpoint = `https://${accountId}.r2.cloudflarestorage.com`

  if (
    expectedEnvironment !== 'production' ||
    nodeEnvironment !== 'production' ||
    surface !== 'hire-control' ||
    expectedSurface !== 'hire-control' ||
    controlDatabase !== expectedDatabase ||
    new Set([controlDatabase, runtimeDatabase, b2cDatabase]).size !== 3 ||
    bucket !== expectedBucket ||
    accountId !== expectedAccountId
  ) {
    refuse('environment_identity_mismatch')
  }

  let sentinelToken
  if (destructive) {
    if (
      environment.HIRE_MEDIA_V1_DESTRUCTIVE_ACK !==
      HIRE_MEDIA_V1_DESTRUCTIVE_ACK
    ) {
      refuse('destructive_ack_missing')
    }
    for (const [name, literal] of Object.entries(DESTRUCTIVE_ASSERTIONS)) {
      if (environment[name] !== literal) refuse('destructive_assertion_missing')
    }
    if (
      !LATE_WRITE_SAFETY_MODES.has(
        environment.HIRE_MEDIA_V1_LATE_WRITE_SAFETY_MODE,
      )
    ) {
      refuse('late_write_safety_barrier_missing')
    }
    sentinelToken = requiredEnvironmentValue(
      environment,
      'HIRE_MEDIA_V1_SENTINEL_TOKEN',
    )
    if (
      Buffer.byteLength(sentinelToken, 'utf8') <
      HIRE_MEDIA_V1_SENTINEL_TOKEN_MINIMUM_BYTES
    ) {
      refuse('production_identity_sentinel_token_too_short')
    }
  }

  return {
    accountId,
    accessKeyId: requiredEnvironmentValue(environment, 'R2_ACCESS_KEY_ID'),
    secretAccessKey: requiredEnvironmentValue(
      environment,
      'R2_SECRET_ACCESS_KEY',
    ),
    bucket,
    mongoUri: requiredEnvironmentValue(environment, 'MONGODB_URI'),
    expectedDatabase,
    sentinelToken,
    environment: expectedEnvironment,
    surface: expectedSurface,
    r2Jurisdiction: HIRE_MEDIA_V1_R2_JURISDICTION,
    r2Endpoint,
  }
}

function makeR2Client(configuration) {
  return new S3Client({
    region: 'auto',
    endpoint: configuration.r2Endpoint,
    credentials: {
      accessKeyId: configuration.accessKeyId,
      secretAccessKey: configuration.secretAccessKey,
    },
  })
}

function makeMongoClient(uri) {
  return new MongoClient(uri, {
    readPreference: 'primary',
    serverSelectionTimeoutMS: 15_000,
    connectTimeoutMS: 15_000,
  })
}

function assertCanonicalAuthorityPart(value) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    /[\s,@/?#]/.test(value)
  ) {
    refuse('mongo_connection_authority_invalid')
  }
  return value.toLowerCase()
}

function canonicalMongoAuthority(mongoClient) {
  const options = mongoClient?.options
  if (!options || typeof options !== 'object') {
    refuse('mongo_connection_authority_invalid')
  }
  const srvHost = options.srvHost
  let scheme
  let authority
  if (typeof srvHost === 'string' && srvHost.length > 0) {
    scheme = 'mongodb+srv'
    authority = assertCanonicalAuthorityPart(srvHost)
  } else {
    scheme = 'mongodb'
    const hosts = Array.from(new Set(
      (options.hosts ?? []).map((host) =>
        assertCanonicalAuthorityPart(String(host)),
      ),
    )).sort()
    if (hosts.length === 0) refuse('mongo_connection_authority_invalid')
    authority = hosts.join(',')
  }

  const replicaSetOption = options.replicaSet
  if (
    replicaSetOption !== undefined &&
    (typeof replicaSetOption !== 'string' || replicaSetOption.length === 0)
  ) {
    refuse('mongo_connection_authority_invalid')
  }
  const srvServiceName = assertCanonicalAuthorityPart(
    options.srvServiceName ?? 'mongodb',
  )
  return {
    scheme,
    authority,
    srvServiceName,
    replicaSetOption: replicaSetOption ?? '',
    tls: options.tls === true ? 'true' : 'false',
    directConnection: options.directConnection === true ? 'true' : 'false',
    loadBalanced: options.loadBalanced === true ? 'true' : 'false',
  }
}

async function verifyProductionIdentitySentinel(
  database,
  configuration,
  mongoAuthority,
) {
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
    replicaSetName.length === 0 ||
    !/^[a-f0-9]{24}$/.test(replicaSetId ?? '')
  ) {
    refuse('production_replica_set_identity_invalid')
  }
  if (
    mongoAuthority.replicaSetOption &&
    mongoAuthority.replicaSetOption !== replicaSetName
  ) {
    refuse('mongo_connection_authority_invalid')
  }

  const sentinel = await database
    .collection(HIRE_MEDIA_V1_SENTINEL_COLLECTION)
    .findOne(
      { _id: HIRE_MEDIA_V1_SENTINEL_ID },
      {
        projection: {
          _id: 1,
          environment: 1,
          databaseName: 1,
          schemaVersion: 1,
          immutable: 1,
          replicaSetName: 1,
          replicaSetId: 1,
          tokenSha256: 1,
          bindingHmacSha256: 1,
        },
        readConcern: { level: 'majority' },
        readPreference: 'primary',
      },
    )

  const expectedTokenSha256 = hireMediaV1SentinelTokenSha256(
    configuration.sentinelToken,
  )
  const expectedBindingHmacSha256 =
    hireMediaV1ProductionBindingHmacSha256({
      token: configuration.sentinelToken,
      environment: configuration.environment,
      surface: configuration.surface,
      databaseName: configuration.expectedDatabase,
      replicaSetName,
      replicaSetId,
      mongoScheme: mongoAuthority.scheme,
      mongoAuthority: mongoAuthority.authority,
      mongoSrvServiceName: mongoAuthority.srvServiceName,
      mongoReplicaSetOption: mongoAuthority.replicaSetOption,
      mongoTls: mongoAuthority.tls,
      mongoDirectConnection: mongoAuthority.directConnection,
      mongoLoadBalanced: mongoAuthority.loadBalanced,
      r2Jurisdiction: configuration.r2Jurisdiction,
      r2Endpoint: configuration.r2Endpoint,
      r2AccountId: configuration.accountId,
      r2Bucket: configuration.bucket,
      r2Prefix: PRODUCTION_MEDIA_PREFIX,
    })
  if (
    !sentinel ||
    sentinel._id !== HIRE_MEDIA_V1_SENTINEL_ID ||
    sentinel.environment !== HIRE_MEDIA_V1_SENTINEL_ENVIRONMENT ||
    sentinel.databaseName !== configuration.expectedDatabase ||
    sentinel.schemaVersion !== HIRE_MEDIA_V1_SENTINEL_SCHEMA_VERSION ||
    sentinel.immutable !== true ||
    sentinel.replicaSetName !== replicaSetName ||
    sentinel.replicaSetId !== replicaSetId ||
    !digestMatches(sentinel.tokenSha256, expectedTokenSha256) ||
    !digestMatches(
      sentinel.bindingHmacSha256,
      expectedBindingHmacSha256,
    )
  ) {
    refuse('production_identity_sentinel_invalid')
  }
}

function parseCanonicalV1Key(key) {
  const match = CANONICAL_V1_KEY.exec(key)
  if (!match) return null
  const kind = FILE_KIND[match[6]]
  if (!kind) return null
  return {
    workspaceId: match[1],
    applicationId: match[2],
    roundId: match[3],
    attemptId: match[4],
    assetId: match[5],
    kind,
  }
}

function objectIdHex(value) {
  if (value && typeof value.toHexString === 'function') {
    return value.toHexString()
  }
  return null
}

function rowExactlyMatchesEntry(row, entry) {
  return Boolean(
    row &&
      objectIdHex(row._id) === entry.parsed.assetId &&
      objectIdHex(row.workspaceId) === entry.parsed.workspaceId &&
      objectIdHex(row.applicationId) === entry.parsed.applicationId &&
      objectIdHex(row.roundId) === entry.parsed.roundId &&
      objectIdHex(row.attemptId) === entry.parsed.attemptId &&
      row.kind === entry.parsed.kind &&
      row.objectKey === entry.key,
  )
}

function emptyInventorySummary() {
  return {
    pages: 0,
    objectsSeen: 0,
    matchedLive: 0,
    matchedPurged: 0,
    unmatchedCanonicalOrphan: 0,
    malformedOrUnrecognized: 0,
    productionV2Excluded: 0,
    conformanceExcluded: 0,
  }
}

async function exactRowsForPage(collection, entries) {
  if (entries.length === 0) return new Map()
  const rows = await collection
    .find(
      { objectKey: { $in: entries.map((entry) => entry.key) } },
      {
        projection: {
          _id: 1,
          workspaceId: 1,
          applicationId: 1,
          roundId: 1,
          attemptId: 1,
          kind: 1,
          objectKey: 1,
          state: 1,
        },
        readConcern: { level: 'majority' },
        readPreference: 'primary',
      },
    )
    .toArray()

  const entryByKey = new Map(entries.map((entry) => [entry.key, entry]))
  const rowsByKey = new Map()
  for (const row of rows) {
    const entry = entryByKey.get(row?.objectKey)
    if (!entry || !rowExactlyMatchesEntry(row, entry)) {
      refuse('database_exact_join_mismatch')
    }
    if (rowsByKey.has(row.objectKey)) refuse('database_exact_join_ambiguous')
    rowsByKey.set(row.objectKey, row)
  }
  return rowsByKey
}

async function collectInventory(r2Client, bucket, collection) {
  const summary = emptyInventorySummary()
  const deleteCandidates = []
  const seenContinuationTokens = new Set()
  let continuationToken

  do {
    const response = await r2Client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: PRODUCTION_MEDIA_PREFIX,
        MaxKeys: 1000,
        ...(continuationToken
          ? { ContinuationToken: continuationToken }
          : {}),
      }),
    )
    summary.pages += 1

    const canonicalEntries = []
    for (const object of response.Contents ?? []) {
      summary.objectsSeen += 1
      const key = object?.Key
      if (typeof key !== 'string') {
        summary.malformedOrUnrecognized += 1
        continue
      }
      if (key.startsWith(PRODUCTION_V2_PREFIX)) {
        summary.productionV2Excluded += 1
        continue
      }
      if (key.startsWith(CONFORMANCE_ROOT)) {
        summary.conformanceExcluded += 1
        continue
      }
      const parsed = parseCanonicalV1Key(key)
      if (!parsed) {
        summary.malformedOrUnrecognized += 1
        continue
      }
      canonicalEntries.push({ key, parsed })
    }

    const rowsByKey = await exactRowsForPage(collection, canonicalEntries)
    for (const entry of canonicalEntries) {
      const row = rowsByKey.get(entry.key)
      if (!row) {
        summary.unmatchedCanonicalOrphan += 1
        deleteCandidates.push({ ...entry, disposition: 'unmatched' })
      } else if (row.state === 'purged') {
        summary.matchedPurged += 1
        deleteCandidates.push({ ...entry, disposition: 'purged' })
      } else {
        summary.matchedLive += 1
      }
    }

    if (!response.IsTruncated) {
      continuationToken = undefined
      continue
    }
    const nextToken = response.NextContinuationToken
    if (
      typeof nextToken !== 'string' ||
      nextToken.length === 0 ||
      seenContinuationTokens.has(nextToken)
    ) {
      refuse('invalid_list_pagination')
    }
    seenContinuationTokens.add(nextToken)
    continuationToken = nextToken
  } while (continuationToken)

  return { summary, deleteCandidates }
}

async function databaseCounts(collection) {
  const counts = {
    mongoV1Rows: 0,
    mongoV1InconsistentRows: 0,
    mongoV2Rows: 0,
    malformedOrUnrecognizedRows: 0,
    stagingRows: 0,
    purgeClaimedRows: 0,
  }
  const cursor = collection
    .find(
      {},
      {
        projection: {
          _id: 1,
          workspaceId: 1,
          applicationId: 1,
          roundId: 1,
          attemptId: 1,
          kind: 1,
          state: 1,
          objectKey: 1,
          objectKeyNonce: 1,
        },
        readConcern: { level: 'majority' },
        readPreference: 'primary',
      },
    )
    .sort({ _id: 1 })
    .batchSize(500)

  for await (const row of cursor) {
    if (row.state === 'staging') counts.stagingRows += 1
    if (row.state === 'purge_claimed') counts.purgeClaimedRows += 1

    if (typeof row.objectKey !== 'string') {
      counts.malformedOrUnrecognizedRows += 1
      continue
    }
    if (row.objectKey.startsWith(PRODUCTION_V2_PREFIX)) {
      counts.mongoV2Rows += 1
      if (
        !CANONICAL_V2_KEY.test(row.objectKey) ||
        typeof row.objectKeyNonce !== 'string' ||
        !CANONICAL_V2_NONCE.test(row.objectKeyNonce)
      ) {
        counts.malformedOrUnrecognizedRows += 1
      }
      continue
    }

    const parsed = parseCanonicalV1Key(row.objectKey)
    if (!parsed) {
      counts.malformedOrUnrecognizedRows += 1
      continue
    }
    counts.mongoV1Rows += 1
    const entry = { key: row.objectKey, parsed }
    if (
      !rowExactlyMatchesEntry(row, entry) ||
      Object.prototype.hasOwnProperty.call(row, 'objectKeyNonce')
    ) {
      counts.mongoV1InconsistentRows += 1
    }
  }
  return counts
}

function initialStatus(summary, counts) {
  if (
    summary.malformedOrUnrecognized > 0 ||
    counts.malformedOrUnrecognizedRows > 0 ||
    counts.mongoV1InconsistentRows > 0
  ) {
    return 'blocked-malformed'
  }
  if (summary.productionV2Excluded > 0 || counts.mongoV2Rows > 0) {
    return 'blocked-existing-v2'
  }
  if (counts.stagingRows > 0 || counts.purgeClaimedRows > 0) {
    return 'blocked-active-database-work'
  }
  if (
    summary.matchedPurged > 0 ||
    summary.unmatchedCanonicalOrphan > 0
  ) {
    return 'reconciliation-required'
  }
  return 'read-only-clean'
}

function assertOwnedDeletionCandidate(candidate) {
  if (
    candidate?.disposition !== 'unmatched' &&
    candidate?.disposition !== 'purged'
  ) {
    refuse('delete_candidate_not_owned')
  }
  if (
    typeof candidate.key !== 'string' ||
    candidate.key.startsWith(PRODUCTION_V2_PREFIX) ||
    candidate.key.startsWith(CONFORMANCE_ROOT)
  ) {
    refuse('delete_candidate_not_owned')
  }
  const reparsed = parseCanonicalV1Key(candidate.key)
  if (
    !reparsed ||
    reparsed.workspaceId !== candidate.parsed.workspaceId ||
    reparsed.applicationId !== candidate.parsed.applicationId ||
    reparsed.roundId !== candidate.parsed.roundId ||
    reparsed.attemptId !== candidate.parsed.attemptId ||
    reparsed.assetId !== candidate.parsed.assetId ||
    reparsed.kind !== candidate.parsed.kind
  ) {
    refuse('delete_candidate_not_owned')
  }
}

function isMissingObject(error) {
  return (
    error?.$metadata?.httpStatusCode === 404 ||
    error?.name === 'NotFound' ||
    error?.name === 'NoSuchKey'
  )
}

async function revalidateDeletionCandidate(collection, candidate) {
  const row = await collection.findOne({ objectKey: candidate.key }, {
    projection: {
      _id: 1,
      workspaceId: 1,
      applicationId: 1,
      roundId: 1,
      attemptId: 1,
      kind: 1,
      objectKey: 1,
      state: 1,
    },
    readConcern: { level: 'majority' },
    readPreference: 'primary',
  })
  if (candidate.disposition === 'unmatched') {
    if (row !== null) refuse('delete_ownership_changed')
    return
  }
  if (!rowExactlyMatchesEntry(row, candidate) || row.state !== 'purged') {
    refuse('delete_ownership_changed')
  }
}

async function deleteAndVerifyCandidates({
  r2Client,
  observer,
  bucket,
  collection,
  candidates,
  reverifyProductionIdentity,
}) {
  let verified = 0
  let productionIdentityReverified = false
  for (const candidate of candidates) {
    assertOwnedDeletionCandidate(candidate)
    await revalidateDeletionCandidate(collection, candidate)
    if (!productionIdentityReverified) {
      await reverifyProductionIdentity()
      productionIdentityReverified = true
    }
    await r2Client.send(
      new DeleteObjectCommand({ Bucket: bucket, Key: candidate.key }),
    )
    try {
      await observer.send(
        new HeadObjectCommand({ Bucket: bucket, Key: candidate.key }),
      )
    } catch (error) {
      if (isMissingObject(error)) {
        verified += 1
        continue
      }
      throw error
    }
    refuse('legacy_delete_not_observed')
  }
  return verified
}

function postDeleteIsClean(summary, counts) {
  return Boolean(
    summary.matchedPurged === 0 &&
      summary.unmatchedCanonicalOrphan === 0 &&
      summary.malformedOrUnrecognized === 0 &&
      summary.productionV2Excluded === 0 &&
      counts.mongoV2Rows === 0 &&
      counts.malformedOrUnrecognizedRows === 0 &&
      counts.mongoV1InconsistentRows === 0 &&
      counts.stagingRows === 0 &&
      counts.purgeClaimedRows === 0,
  )
}

export async function runHireMediaV1Reconciliation({
  environment = process.env,
  destructive = false,
  createR2Client = makeR2Client,
  createMongoClient = makeMongoClient,
} = {}) {
  const configuration = readConfiguration(environment, destructive)
  const r2Configuration = {
    accountId: configuration.accountId,
    accessKeyId: configuration.accessKeyId,
    secretAccessKey: configuration.secretAccessKey,
    bucket: configuration.bucket,
    r2Endpoint: configuration.r2Endpoint,
  }
  const r2Client = createR2Client(r2Configuration, 'inventory-delete')
  const observer = createR2Client(r2Configuration, 'absence-observer')
  const mongoClient = createMongoClient(configuration.mongoUri)

  try {
    const database = mongoClient.db()
    if (database.databaseName !== configuration.expectedDatabase) {
      refuse('environment_identity_mismatch')
    }
    await mongoClient.connect()
    if (mongoClient.db().databaseName !== configuration.expectedDatabase) {
      refuse('environment_identity_mismatch')
    }
    if (destructive) {
      await verifyProductionIdentitySentinel(
        database,
        configuration,
        canonicalMongoAuthority(mongoClient),
      )
    }

    const collection = database.collection(MEDIA_COLLECTION)
    const counts = await databaseCounts(collection)
    const initial = await collectInventory(
      r2Client,
      configuration.bucket,
      collection,
    )
    const status = initialStatus(initial.summary, counts)

    if (!destructive || status.startsWith('blocked-')) {
      return {
        status,
        mode: destructive ? 'destructive' : 'read-only',
        database: counts,
        initial: initial.summary,
        postDelete: null,
        deletion: { attempted: 0, verifiedAbsent: 0 },
        lateWriteSafetyOperatorAssertion: destructive,
      }
    }

    const verifiedAbsent = await deleteAndVerifyCandidates({
      r2Client,
      observer,
      bucket: configuration.bucket,
      collection,
      candidates: initial.deleteCandidates,
      reverifyProductionIdentity: () =>
        verifyProductionIdentitySentinel(
          database,
          configuration,
          canonicalMongoAuthority(mongoClient),
        ),
    })
    const postDeleteCounts = await databaseCounts(collection)
    const postDelete = await collectInventory(
      observer,
      configuration.bucket,
      collection,
    )
    const clean = postDeleteIsClean(postDelete.summary, postDeleteCounts)

    return {
      status: clean
        ? 'destructive-reconciled-observation'
        : 'blocked-post-delete-rescan',
      mode: 'destructive',
      database: postDeleteCounts,
      initial: initial.summary,
      postDelete: postDelete.summary,
      deletion: {
        attempted: initial.deleteCandidates.length,
        verifiedAbsent,
      },
      lateWriteSafetyOperatorAssertion: true,
    }
  } finally {
    await mongoClient.close().catch(() => {})
    r2Client.destroy?.()
    observer.destroy?.()
  }
}

function summaryLine(label, summary) {
  return [
    `[counts] ${label}`,
    `pages=${summary.pages}`,
    `objects=${summary.objectsSeen}`,
    `matched_live=${summary.matchedLive}`,
    `matched_purged=${summary.matchedPurged}`,
    `unmatched_canonical_orphan=${summary.unmatchedCanonicalOrphan}`,
    `malformed_or_unrecognized=${summary.malformedOrUnrecognized}`,
    `production_v2_excluded=${summary.productionV2Excluded}`,
    `conformance_excluded=${summary.conformanceExcluded}`,
  ].join(' ')
}

export function publicFailureMessage(error) {
  if (error instanceof ReconciliationRefusal) {
    return `[blocked] Hire media v1 reconciliation refused (${error.code}).`
  }
  return '[fail] Hire media v1 reconciliation failed (unexpected_error).'
}

export async function executeHireMediaV1ReconciliationCli({
  argv = process.argv.slice(2),
  environment = process.env,
  stdout = console.log,
  stderr = console.error,
  dependencies = {},
} = {}) {
  try {
    const options = parseArguments(argv)
    if (options.help) {
      usage(stdout)
      return 0
    }
    const result = await runHireMediaV1Reconciliation({
      environment,
      destructive: options.delete,
      ...dependencies,
    })
    stdout(summaryLine('initial', result.initial))
    stdout(
      `[counts] database mongo_v1=${result.database.mongoV1Rows} mongo_v1_inconsistent=${result.database.mongoV1InconsistentRows} mongo_v2=${result.database.mongoV2Rows} malformed_or_unrecognized=${result.database.malformedOrUnrecognizedRows} staging=${result.database.stagingRows} purge_claimed=${result.database.purgeClaimedRows}`,
    )
    if (result.postDelete) stdout(summaryLine('post_delete_rescan', result.postDelete))
    stdout(
      `[counts] deletion attempted=${result.deletion.attempted} verified_absent=${result.deletion.verifiedAbsent}`,
    )
    const safeStatus = SAFE_STATUS.has(result.status) ? result.status : 'blocked'
    stdout(`[status] ${safeStatus}`)
    if (result.status === 'destructive-reconciled-observation') {
      stdout(
        '[notice] Clean rescan observed; this is not proof against a previously accepted unbounded legacy PUT.',
      )
    }
    return result.status === 'read-only-clean' ||
      result.status === 'destructive-reconciled-observation'
      ? 0
      : 2
  } catch (error) {
    stderr(publicFailureMessage(error))
    return 1
  }
}

const isDirectExecution = Boolean(
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href,
)

if (isDirectExecution) {
  const exitCode = await executeHireMediaV1ReconciliationCli()
  process.exitCode = exitCode
}
