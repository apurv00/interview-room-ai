#!/usr/bin/env node

import {
  createHash,
  createHmac,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto'
import { Readable } from 'node:stream'
import { pathToFileURL } from 'node:url'
import { MongoClient } from 'mongodb'
import {
  DeleteObjectCommand,
  GetBucketLifecycleConfigurationCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'

export const PRODUCTION_V2_PREFIX = 'hire-media/v2/'
export const RUNTIME_LANDMARK_V2_PREFIX = 'landmarks/v2/'
export const PRODUCTION_V2_PREFIXES = Object.freeze([
  PRODUCTION_V2_PREFIX,
  RUNTIME_LANDMARK_V2_PREFIX,
])
export const CONFORMANCE_ROOT = 'hire-media-conformance/v2/'
export const HIRE_MEDIA_R2_ACTIVATION_SENTINEL_COLLECTION =
  '__deployment_environment_identity'
export const HIRE_MEDIA_R2_ACTIVATION_SENTINEL_ID =
  'hire-media-r2-v2-production-activation-v1'
const HIRE_MEDIA_R2_ACTIVATION_SENTINEL_ENVIRONMENT = 'production'
const HIRE_MEDIA_R2_ACTIVATION_SENTINEL_SCHEMA_VERSION = 1
const HIRE_MEDIA_R2_ACTIVATION_SENTINEL_TOKEN_MINIMUM_BYTES = 32
const HIRE_MEDIA_R2_ACTIVATION_BINDING_DOMAIN =
  'hire-media-r2-v2-production-activation-binding-v1'
const R2_JURISDICTION = 'default'
const CONFORMANCE_RUN_PREFIX = /^hire-media-conformance\/v2\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/$/
const CANARY_NAMES = new Set([
  'conditional-then-seal',
  'seal-then-conditional',
  'in-flight-then-seal',
])
const WRITE_ACK = 'write-and-delete-random-canaries'
const SAME_KEY_SETTLE_MS = 1_250
const IN_FLIGHT_START_SETTLE_MS = 500
const REQUEST_DEADLINE_MS = 45_000

function usage() {
  console.log(`Hire media R2 protocol conformance

Usage:
  npm run check:hire-media-r2-protocol -- --first-activation
  HIRE_MEDIA_R2_CONFORMANCE_ACK=${WRITE_ACK} \\
    npm run check:hire-media-r2-protocol -- --first-activation --write

The default mode is read-only and audits bucket lifecycle rules.
--first-activation fails unless both production v2 inventories, runtime v2
references, and legacy runtime landmark objects/references are empty.
Release-authoritative --first-activation and every --write invocation also
require the immutable production runtime/database and dual-bucket identity
sentinel documented in docs/runbooks/hire-media-v2-cold-cutover.md.
--write also
creates three random objects below ${CONFORMANCE_ROOT} in each exact control and
runtime bucket, verifies conditional PUT and zero-byte seal behavior, and
deletes only those exact canary keys. It never writes to or deletes from
${PRODUCTION_V2_PREFIX} or ${RUNTIME_LANDMARK_V2_PREFIX}.
`)
}

function parseArguments(argv) {
  const options = { write: false, firstActivation: false }
  for (const argument of argv) {
    if (argument === '--write') options.write = true
    else if (argument === '--first-activation') options.firstActivation = true
    else if (argument === '--help' || argument === '-h') options.help = true
    else throw new Error(`Unknown argument: ${argument}`)
  }
  return options
}

function requiredEnvironmentValue(environment, name) {
  const value = environment[name]
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Missing required environment: ${name}`)
  }
  if (value !== value.trim()) {
    throw new Error(`Invalid surrounding whitespace in environment: ${name}`)
  }
  return value
}

export function requiredEnvironment(
  environment = process.env,
  { requireActivationIdentity = false } = {},
) {
  const names = [
    'R2_ACCOUNT_ID',
    'R2_ACCESS_KEY_ID',
    'R2_SECRET_ACCESS_KEY',
    'R2_BUCKET_NAME',
    'HIRE_RUNTIME_R2_ACCOUNT_ID',
    'HIRE_RUNTIME_R2_ACCESS_KEY_ID',
    'HIRE_RUNTIME_R2_SECRET_ACCESS_KEY',
    'HIRE_RUNTIME_R2_BUCKET_NAME',
    'MONGODB_URI',
    'HIRE_RUNTIME_DATABASE_NAME',
  ]
  const missing = names.filter((name) =>
    typeof environment[name] !== 'string' || environment[name].length === 0,
  )
  if (missing.length > 0) {
    throw new Error(`Missing required environment: ${missing.join(', ')}`)
  }
  const values = Object.fromEntries(
    names.map((name) => [name, requiredEnvironmentValue(environment, name)]),
  )
  const configuration = {
    control: {
      accountId: values.R2_ACCOUNT_ID,
      accessKeyId: values.R2_ACCESS_KEY_ID,
      secretAccessKey: values.R2_SECRET_ACCESS_KEY,
      bucket: values.R2_BUCKET_NAME,
    },
    runtime: {
      accountId: values.HIRE_RUNTIME_R2_ACCOUNT_ID,
      accessKeyId: values.HIRE_RUNTIME_R2_ACCESS_KEY_ID,
      secretAccessKey: values.HIRE_RUNTIME_R2_SECRET_ACCESS_KEY,
      bucket: values.HIRE_RUNTIME_R2_BUCKET_NAME,
    },
    runtimeMongoUri: values.MONGODB_URI,
    runtimeDatabaseName: values.HIRE_RUNTIME_DATABASE_NAME,
  }
  if (!requireActivationIdentity) return configuration

  const identityNames = [
    'NODE_ENV',
    'HIRE_MEDIA_R2_EXPECTED_ENVIRONMENT',
    'HIRE_MEDIA_R2_EXPECTED_RUNTIME_DATABASE_NAME',
    'HIRE_MEDIA_R2_EXPECTED_CONTROL_ACCOUNT_ID',
    'HIRE_MEDIA_R2_EXPECTED_CONTROL_BUCKET_NAME',
    'HIRE_MEDIA_R2_EXPECTED_RUNTIME_ACCOUNT_ID',
    'HIRE_MEDIA_R2_EXPECTED_RUNTIME_BUCKET_NAME',
    'HIRE_MEDIA_R2_ACTIVATION_SENTINEL_TOKEN',
  ]
  const identityValues = Object.fromEntries(
    identityNames.map((name) => [
      name,
      requiredEnvironmentValue(environment, name),
    ]),
  )
  const sentinelToken = identityValues.HIRE_MEDIA_R2_ACTIVATION_SENTINEL_TOKEN
  if (
    identityValues.NODE_ENV !== HIRE_MEDIA_R2_ACTIVATION_SENTINEL_ENVIRONMENT ||
    identityValues.HIRE_MEDIA_R2_EXPECTED_ENVIRONMENT !==
      HIRE_MEDIA_R2_ACTIVATION_SENTINEL_ENVIRONMENT ||
    identityValues.HIRE_MEDIA_R2_EXPECTED_RUNTIME_DATABASE_NAME !==
      configuration.runtimeDatabaseName ||
    identityValues.HIRE_MEDIA_R2_EXPECTED_CONTROL_ACCOUNT_ID !==
      configuration.control.accountId ||
    identityValues.HIRE_MEDIA_R2_EXPECTED_CONTROL_BUCKET_NAME !==
      configuration.control.bucket ||
    identityValues.HIRE_MEDIA_R2_EXPECTED_RUNTIME_ACCOUNT_ID !==
      configuration.runtime.accountId ||
    identityValues.HIRE_MEDIA_R2_EXPECTED_RUNTIME_BUCKET_NAME !==
      configuration.runtime.bucket
  ) {
    throw new Error('Hire media R2 activation environment identity mismatch')
  }
  if (
    Buffer.byteLength(sentinelToken, 'utf8') <
      HIRE_MEDIA_R2_ACTIVATION_SENTINEL_TOKEN_MINIMUM_BYTES
  ) {
    throw new Error('Hire media R2 activation sentinel token is too short')
  }
  return {
    ...configuration,
    activationIdentity: {
      environment: identityValues.HIRE_MEDIA_R2_EXPECTED_ENVIRONMENT,
      sentinelToken,
    },
  }
}

function makeClient(configuration) {
  return new S3Client({
    region: 'auto',
    endpoint: `https://${configuration.accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: configuration.accessKeyId,
      secretAccessKey: configuration.secretAccessKey,
    },
  })
}

export function hireMediaR2ActivationSentinelTokenSha256(token) {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

function updateLengthFramed(hmac, value) {
  const bytes = Buffer.from(value, 'utf8')
  const length = Buffer.allocUnsafe(4)
  length.writeUInt32BE(bytes.length)
  hmac.update(length)
  hmac.update(bytes)
}

export function hireMediaR2ActivationBindingHmacSha256({
  token,
  environment,
  runtimeDatabaseName,
  replicaSetName,
  replicaSetId,
  controlR2AccountId,
  controlR2Bucket,
  runtimeR2AccountId,
  runtimeR2Bucket,
}) {
  const hmac = createHmac('sha256', token)
  const fields = [
    ['domain', HIRE_MEDIA_R2_ACTIVATION_BINDING_DOMAIN],
    ['environment', environment],
    ['runtimeDatabaseName', runtimeDatabaseName],
    ['replicaSetName', replicaSetName],
    ['replicaSetId', replicaSetId],
    ['controlR2Jurisdiction', R2_JURISDICTION],
    [
      'controlR2Endpoint',
      `https://${controlR2AccountId}.r2.cloudflarestorage.com`,
    ],
    ['controlR2AccountId', controlR2AccountId],
    ['controlR2Bucket', controlR2Bucket],
    ['controlR2ProtectedPrefix', PRODUCTION_V2_PREFIX],
    ['runtimeR2Jurisdiction', R2_JURISDICTION],
    [
      'runtimeR2Endpoint',
      `https://${runtimeR2AccountId}.r2.cloudflarestorage.com`,
    ],
    ['runtimeR2AccountId', runtimeR2AccountId],
    ['runtimeR2Bucket', runtimeR2Bucket],
    ['runtimeR2ProtectedPrefix', RUNTIME_LANDMARK_V2_PREFIX],
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

export async function verifyHireMediaR2ActivationIdentity({
  mongo,
  runtimeDatabase,
  configuration,
}) {
  if (!configuration.activationIdentity) {
    throw new Error('Hire media R2 activation identity configuration is required')
  }
  if (
    typeof runtimeDatabase.databaseName === 'string' &&
    runtimeDatabase.databaseName !== configuration.runtimeDatabaseName
  ) {
    throw new Error('Hire media R2 activation runtime database selection mismatch')
  }

  const replicaConfiguration = await mongo
    .db('admin', { readPreference: 'primary' })
    .command(
      { replSetGetConfig: 1, commitmentStatus: true },
      { readPreference: 'primary' },
    )
  const replicaSetName = replicaConfiguration?.config?._id
  const replicaSetId = objectIdString(
    replicaConfiguration?.config?.settings?.replicaSetId,
  )
  if (
    replicaConfiguration?.commitmentStatus !== true ||
    typeof replicaSetName !== 'string' ||
    replicaSetName.length === 0 ||
    !/^[a-f0-9]{24}$/.test(replicaSetId)
  ) {
    throw new Error('Hire media R2 activation live replica identity is unavailable')
  }

  const sentinel = await runtimeDatabase
    .collection(HIRE_MEDIA_R2_ACTIVATION_SENTINEL_COLLECTION)
    .findOne(
      { _id: HIRE_MEDIA_R2_ACTIVATION_SENTINEL_ID },
      {
        projection: {
          _id: 1,
          environment: 1,
          runtimeDatabaseName: 1,
          schemaVersion: 1,
          immutable: 1,
          replicaSetName: 1,
          replicaSetId: 1,
          tokenSha256: 1,
          bindingHmacSha256: 1,
        },
        readConcern: { level: 'majority' },
      },
    )
  const expectedTokenSha256 = hireMediaR2ActivationSentinelTokenSha256(
    configuration.activationIdentity.sentinelToken,
  )
  const expectedBindingHmacSha256 =
    hireMediaR2ActivationBindingHmacSha256({
      token: configuration.activationIdentity.sentinelToken,
      environment: configuration.activationIdentity.environment,
      runtimeDatabaseName: configuration.runtimeDatabaseName,
      replicaSetName,
      replicaSetId,
      controlR2AccountId: configuration.control.accountId,
      controlR2Bucket: configuration.control.bucket,
      runtimeR2AccountId: configuration.runtime.accountId,
      runtimeR2Bucket: configuration.runtime.bucket,
    })
  if (
    !sentinel ||
    sentinel._id !== HIRE_MEDIA_R2_ACTIVATION_SENTINEL_ID ||
    sentinel.environment !== HIRE_MEDIA_R2_ACTIVATION_SENTINEL_ENVIRONMENT ||
    sentinel.runtimeDatabaseName !== configuration.runtimeDatabaseName ||
    sentinel.schemaVersion !== HIRE_MEDIA_R2_ACTIVATION_SENTINEL_SCHEMA_VERSION ||
    sentinel.immutable !== true ||
    sentinel.replicaSetName !== replicaSetName ||
    sentinel.replicaSetId !== replicaSetId ||
    !digestMatches(sentinel.tokenSha256, expectedTokenSha256) ||
    !digestMatches(sentinel.bindingHmacSha256, expectedBindingHmacSha256)
  ) {
    throw new Error('Hire media R2 activation identity sentinel is invalid')
  }
}

function isMissingLifecycleConfiguration(error) {
  return error?.$metadata?.httpStatusCode === 404 ||
    error?.name === 'NoSuchLifecycleConfiguration'
}

function expirationPrefix(rule) {
  if (typeof rule.Prefix === 'string') return rule.Prefix
  if (!rule.Filter) return ''
  if (typeof rule.Filter.Prefix === 'string') return rule.Filter.Prefix
  if (typeof rule.Filter.And?.Prefix === 'string') return rule.Filter.And.Prefix

  // Tag-only, size-only, and otherwise unrecognized filters are treated as
  // bucket-wide. This is intentionally conservative: a permanent seal must
  // not depend on an operator remembering never to tag it later.
  return ''
}

function prefixesOverlap(left, right) {
  return left === '' || right === '' || left.startsWith(right) || right.startsWith(left)
}

export function expirationBlockers(
  rules,
  protectedPrefixes = PRODUCTION_V2_PREFIXES,
) {
  return rules
    .filter((rule) => rule.Status === 'Enabled')
    .filter((rule) => Boolean(rule.Expiration || rule.NoncurrentVersionExpiration))
    .map((rule, index) => ({
      id: rule.ID || `unnamed-rule-${index + 1}`,
      prefix: expirationPrefix(rule),
    }))
    .filter(({ prefix }) =>
      protectedPrefixes.some((protectedPrefix) =>
        prefixesOverlap(prefix, protectedPrefix),
      ),
    )
}

export async function countObjectsBelowPrefix(client, bucket, prefix) {
  let count = 0
  let continuationToken
  do {
    const response = await client.send(new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: prefix,
      ...(continuationToken ? { ContinuationToken: continuationToken } : {}),
    }))
    count += response.KeyCount ?? response.Contents?.length ?? 0
    if (response.IsTruncated && !response.NextContinuationToken) {
      throw new Error(`R2 inventory for ${prefix} was truncated without a continuation token`)
    }
    continuationToken = response.IsTruncated
      ? response.NextContinuationToken
      : undefined
  } while (continuationToken)
  return count
}

export function assertFirstActivationInventory(input) {
  if (
    input.controlV2Objects !== 0 ||
    input.runtimeLandmarkV2Objects !== 0 ||
    input.runtimeLandmarkV2References !== 0 ||
    input.runtimeLegacyLandmarkObjects !== 0 ||
    input.runtimeLegacyLandmarkReferences !== 0
  ) {
    throw new Error(
      'First activation requires zero production v2 state and zero legacy runtime landmarks',
    )
  }
}

const LEGACY_RUNTIME_LANDMARK_KEY =
  /^landmarks\/([a-f0-9]{24})\/([a-f0-9]{24})(?:-([a-f0-9]{32}))?\.json$/i
const RUNTIME_LANDMARK_V2_KEY =
  /^landmarks\/v2\/([a-f0-9]{64})$/

function runtimeLandmarkV2ScopeDigest(reference) {
  return createHash('sha256')
    .update('interview-room-ai:hire-runtime-landmark:v2\0')
    .update(reference.principalId.toLowerCase())
    .update('\0')
    .update(reference.runtimeSessionId.toLowerCase())
    .update('\0')
    .update(reference.objectKeyNonce.toLowerCase())
    .digest('hex')
}

export function parseLegacyRuntimeLandmarkKey(key) {
  const match = LEGACY_RUNTIME_LANDMARK_KEY.exec(key)
  return match
    ? {
        principalId: match[1].toLowerCase(),
        runtimeSessionId: match[2].toLowerCase(),
      }
    : null
}

async function listObjectKeysBelowPrefix(client, bucket, prefix) {
  const keys = []
  let continuationToken
  do {
    const response = await client.send(new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: prefix,
      ...(continuationToken ? { ContinuationToken: continuationToken } : {}),
    }))
    for (const object of response.Contents ?? []) {
      if (typeof object.Key === 'string') keys.push(object.Key)
    }
    if (response.IsTruncated && !response.NextContinuationToken) {
      throw new Error('Runtime landmark inventory was truncated without a continuation token')
    }
    continuationToken = response.IsTruncated
      ? response.NextContinuationToken
      : undefined
  } while (continuationToken)
  return keys
}

function objectIdString(value) {
  return value && typeof value.toString === 'function'
    ? value.toString().toLowerCase()
    : ''
}

export function summarizeLegacyRuntimeLandmarkInventory(input) {
  const legacyObjects = new Set()
  let productionV2Excluded = 0
  let malformedOrUnrecognized = 0
  for (const key of input.objectKeys) {
    if (RUNTIME_LANDMARK_V2_KEY.test(key)) {
      productionV2Excluded += 1
    } else if (parseLegacyRuntimeLandmarkKey(key)) {
      legacyObjects.add(key)
    } else {
      malformedOrUnrecognized += 1
    }
  }

  const validReferences = new Set()
  const validV2References = new Set()
  let malformedReferences = 0
  let coordinateMismatchReferences = 0
  for (const reference of input.references) {
    const v2 = RUNTIME_LANDMARK_V2_KEY.exec(reference.key)
    if (v2) {
      if (
        !/^[a-f0-9]{24}$/i.test(reference.principalId) ||
        !/^[a-f0-9]{24}$/i.test(reference.runtimeSessionId) ||
        !/^[a-f0-9]{64}$/.test(reference.objectKeyNonce ?? '') ||
        v2[1] !== runtimeLandmarkV2ScopeDigest(reference)
      ) {
        coordinateMismatchReferences += 1
      } else {
        validV2References.add(reference.key)
      }
      continue
    }
    const parsed = parseLegacyRuntimeLandmarkKey(reference.key)
    if (!parsed) {
      malformedReferences += 1
      continue
    }
    if (
      parsed.principalId !== reference.principalId.toLowerCase() ||
      parsed.runtimeSessionId !== reference.runtimeSessionId.toLowerCase()
    ) {
      coordinateMismatchReferences += 1
      continue
    }
    validReferences.add(reference.key)
  }

  let matchedLegacy = 0
  let unmatchedLegacyObject = 0
  for (const key of legacyObjects) {
    if (validReferences.has(key)) matchedLegacy += 1
    else unmatchedLegacyObject += 1
  }
  let legacyReferenceWithoutObject = 0
  for (const key of validReferences) {
    if (!legacyObjects.has(key)) legacyReferenceWithoutObject += 1
  }
  return {
    productionV2Excluded,
    productionV2References: validV2References.size,
    legacyObjects: legacyObjects.size,
    legacyReferences: validReferences.size,
    matchedLegacy,
    unmatchedLegacyObject,
    legacyReferenceWithoutObject,
    malformedOrUnrecognized,
    malformedReferences,
    coordinateMismatchReferences,
  }
}

async function runtimeLandmarkReferences(database) {
  const landmarkPrefix = /^landmarks\//
  const references = []
  const outboxes = await database
    .collection('hireruntimemultimodalanalysisoutboxes')
    .find(
      { 'landmarkArtifact.sourceKey': landmarkPrefix },
      {
        projection: { principalId: 1, runtimeSessionId: 1, landmarkArtifact: 1 },
        readConcern: { level: 'majority' },
      },
    )
    .toArray()
  for (const outbox of outboxes) {
    const key = outbox.landmarkArtifact?.sourceKey
    if (typeof key !== 'string') continue
    references.push({
      key,
      principalId: objectIdString(outbox.principalId),
      runtimeSessionId: objectIdString(outbox.runtimeSessionId),
      objectKeyNonce: outbox.landmarkArtifact?.objectKeyNonce,
    })
  }
  const sessions = await database
    .collection('interviewsessions')
    .find(
      { facialLandmarksR2Key: landmarkPrefix },
      {
        projection: { _id: 1, userId: 1, facialLandmarksR2Key: 1 },
        readConcern: { level: 'majority' },
      },
    )
    .toArray()
  for (const session of sessions) {
    if (typeof session.facialLandmarksR2Key !== 'string') continue
    references.push({
      key: session.facialLandmarksR2Key,
      principalId: objectIdString(session.userId),
      runtimeSessionId: objectIdString(session._id),
      objectKeyNonce: undefined,
    })
  }
  const bindings = await database
    .collection('hireruntimebindings')
    .find(
      { issuedObjectCapabilities: { $elemMatch: { key: landmarkPrefix } } },
      {
        projection: { principalId: 1, issuedObjectCapabilities: 1 },
        readConcern: { level: 'majority' },
      },
    )
    .toArray()
  for (const binding of bindings) {
    for (const capability of binding.issuedObjectCapabilities ?? []) {
      if (
        typeof capability.key !== 'string' ||
        !landmarkPrefix.test(capability.key)
      ) continue
      references.push({
        key: capability.key,
        principalId: objectIdString(binding.principalId),
        runtimeSessionId: objectIdString(capability.runtimeSessionId),
        objectKeyNonce: capability.objectKeyNonce,
      })
    }
  }
  return references
}

async function auditLegacyRuntimeLandmarks(client, bucket, database) {
  const objectKeys = await listObjectKeysBelowPrefix(
    client,
    bucket,
    'landmarks/',
  )
  const references = await runtimeLandmarkReferences(database)
  const summary = summarizeLegacyRuntimeLandmarkInventory({
    objectKeys,
    references,
  })
  console.log(
    '[inventory] runtime landmark legacy join: ' +
    Object.entries(summary).map(([name, count]) => `${name}=${count}`).join(', '),
  )
  if (
    summary.unmatchedLegacyObject > 0 ||
    summary.legacyReferenceWithoutObject > 0 ||
    summary.malformedOrUnrecognized > 0 ||
    summary.malformedReferences > 0 ||
    summary.coordinateMismatchReferences > 0
  ) {
    throw new Error('Runtime landmark legacy inventory has unresolved blockers')
  }
  return summary
}

async function auditLifecycle(client, bucket, protectedPrefixes, label) {
  let rules = []
  try {
    const response = await client.send(
      new GetBucketLifecycleConfigurationCommand({ Bucket: bucket }),
    )
    rules = response.Rules ?? []
  } catch (error) {
    if (!isMissingLifecycleConfiguration(error)) throw error
  }

  const blockers = expirationBlockers(rules, protectedPrefixes)
  if (blockers.length > 0) {
    const detail = blockers
      .map(({ id, prefix }) => `${id} (prefix ${JSON.stringify(prefix)})`)
      .join(', ')
    throw new Error(
      `Enabled R2 expiration rules overlap protected production v2 prefixes ` +
      `in the ${label} bucket (${protectedPrefixes.join(', ')}): ${detail}`,
    )
  }

  console.log(
    `[pass] No enabled expiration rule overlaps ${protectedPrefixes.join(' or ')} ` +
    `in the ${label} bucket (${rules.length} rule(s) inspected).`,
  )
  const inventory = {}
  for (const prefix of protectedPrefixes) {
    const count = await countObjectsBelowPrefix(client, bucket, prefix)
    inventory[prefix] = count
    console.log(`[inventory] ${label} bucket ${prefix}: ${count} object(s).`)
  }
  return inventory
}

export function assertOwnedCanaryKey(key, runPrefix) {
  const suffix = key.slice(runPrefix.length)
  if (
    !CONFORMANCE_RUN_PREFIX.test(runPrefix) ||
    !key.startsWith(runPrefix) ||
    !CANARY_NAMES.has(suffix) ||
    PRODUCTION_V2_PREFIXES.some((prefix) => key.startsWith(prefix))
  ) {
    throw new Error('Refusing an operation outside the exact random conformance run prefix')
  }
}

function isPreconditionFailure(error) {
  return error?.$metadata?.httpStatusCode === 412 || error?.name === 'PreconditionFailed'
}

function isRateLimited(error) {
  return error?.$metadata?.httpStatusCode === 429 ||
    error?.name === 'TooManyRequests' ||
    error?.name === 'SlowDown'
}

function isMissingObject(error) {
  return error?.$metadata?.httpStatusCode === 404 ||
    error?.name === 'NotFound' ||
    error?.name === 'NoSuchKey'
}

async function delay(milliseconds) {
  await new Promise((resolve) => setTimeout(resolve, milliseconds))
}

async function withDeadline(promise, milliseconds, label) {
  let timeout
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`${label} exceeded ${milliseconds}ms`)),
          milliseconds,
        )
      }),
    ])
  } finally {
    clearTimeout(timeout)
  }
}

function pausedStreamingBody() {
  const payload = Buffer.alloc(128 * 1024, 0x61)
  const splitAt = payload.length / 2
  let firstChunkSent = false
  let finished = false
  let released = false
  let resolveStarted
  const started = new Promise((resolve) => {
    resolveStarted = resolve
  })

  const body = new Readable({
    read() {
      if (!firstChunkSent) {
        firstChunkSent = true
        this.push(payload.subarray(0, splitAt))
        resolveStarted()
      }
      if (released && !finished) {
        finished = true
        this.push(payload.subarray(splitAt))
        this.push(null)
      }
    },
  })

  return {
    body,
    contentLength: payload.length,
    started,
    release() {
      if (finished) return
      released = true
      if (firstChunkSent) {
        finished = true
        body.push(payload.subarray(splitAt))
        body.push(null)
      }
    },
    destroy(error) {
      if (!finished) {
        finished = true
        body.destroy(error)
      }
    },
  }
}

async function sendWithRateLimitRetry(client, commandFactory, label, sendOptions) {
  let lastError
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      return await client.send(commandFactory(), sendOptions)
    } catch (error) {
      lastError = error
      if (!isRateLimited(error) || attempt === 5) throw error
      console.log(`[retry] ${label} was rate-limited; waiting before retry ${attempt}/5.`)
      await delay(SAME_KEY_SETTLE_MS * attempt)
    }
  }
  throw lastError
}

async function expectConditionalRejection(client, input, label) {
  try {
    await sendWithRateLimitRetry(
      client,
      () => new PutObjectCommand({ ...input, IfNoneMatch: '*' }),
      label,
    )
  } catch (error) {
    if (isPreconditionFailure(error)) return
    throw error
  }
  throw new Error(`${label} unexpectedly overwrote an existing object`)
}

async function putSeal(client, bucket, key, label) {
  await sendWithRateLimitRetry(
    client,
    () => new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: new Uint8Array(0),
      ContentLength: 0,
      ContentType: 'application/octet-stream',
      CacheControl: 'private, no-store',
      Metadata: { 'hire-media-tombstone': 'v2' },
    }),
    label,
  )
}

async function assertSeal(observer, bucket, key, label) {
  const head = await observer.send(new HeadObjectCommand({ Bucket: bucket, Key: key }))
  if (
    head.ContentLength !== 0 ||
    head.ContentType !== 'application/octet-stream' ||
    head.CacheControl !== 'private, no-store' ||
    head.Metadata?.['hire-media-tombstone'] !== 'v2'
  ) {
    throw new Error(`${label} did not produce the required zero-byte v2 seal`)
  }
}

async function assertObjectBody(observer, bucket, key, expected, label) {
  const response = await observer.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
  if (!response.Body || typeof response.Body.transformToString !== 'function') {
    throw new Error(`${label} returned an unreadable object body`)
  }
  const actual = await response.Body.transformToString()
  if (actual !== expected) throw new Error(`${label} changed the original object body`)
}

async function assertInFlightUploadLosesToSeal({
  mediaClient,
  sealClient,
  observer,
  bucket,
  key,
}) {
  const paused = pausedStreamingBody()
  const mediaAbort = new AbortController()
  const sealAbort = new AbortController()
  const mediaDeadline = setTimeout(
    () => mediaAbort.abort(new Error('paused conditional PUT timed out')),
    REQUEST_DEADLINE_MS,
  )
  const sealDeadline = setTimeout(
    () => sealAbort.abort(new Error('seal against paused conditional PUT timed out')),
    30_000,
  )
  let mediaSettled = false
  const mediaOutcome = mediaClient.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: paused.body,
      ContentLength: paused.contentLength,
      ContentType: 'application/octet-stream',
      CacheControl: 'private, no-store',
      IfNoneMatch: '*',
    }),
    { abortSignal: mediaAbort.signal },
  ).then(
    (value) => {
      mediaSettled = true
      return { status: 'fulfilled', value }
    },
    (error) => {
      mediaSettled = true
      return { status: 'rejected', error }
    },
  )

  try {
    await withDeadline(
      paused.started,
      10_000,
      'paused conditional PUT body start',
    )
    await delay(IN_FLIGHT_START_SETTLE_MS)
    if (mediaSettled) {
      throw new Error('Conditional PUT settled before the delayed body was released')
    }

    await sendWithRateLimitRetry(
      sealClient,
      () => new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: new Uint8Array(0),
        ContentLength: 0,
        ContentType: 'application/octet-stream',
        CacheControl: 'private, no-store',
        Metadata: { 'hire-media-tombstone': 'v2' },
      }),
      'seal against paused conditional PUT',
      { abortSignal: sealAbort.signal },
    )
    await assertSeal(observer, bucket, key, 'seal while conditional PUT is paused')

    paused.release()
    const outcome = await withDeadline(
      mediaOutcome,
      REQUEST_DEADLINE_MS,
      'paused conditional PUT completion',
    )
    if (outcome.status !== 'rejected' || !isPreconditionFailure(outcome.error)) {
      const outcomeName = outcome.status === 'fulfilled'
        ? 'success'
        : outcome.error?.name || outcome.error?.$metadata?.httpStatusCode || 'unknown error'
      throw new Error(
        `Paused conditional PUT must finish with 412 PreconditionFailed; received ${outcomeName}`,
      )
    }
    await assertSeal(observer, bucket, key, 'in-flight conditional PUT rejection')
  } finally {
    clearTimeout(mediaDeadline)
    clearTimeout(sealDeadline)
    sealAbort.abort(new Error('in-flight conformance seal request closed'))
    if (!mediaSettled) {
      paused.release()
      mediaAbort.abort(new Error('in-flight conformance cleanup'))
      await mediaOutcome
    }
    paused.destroy(new Error('in-flight conformance body closed'))
  }
}

export async function cleanupCanaries(client, observer, bucket, runPrefix, keys) {
  const failures = []
  for (const key of keys) {
    assertOwnedCanaryKey(key, runPrefix)
    try {
      await sendWithRateLimitRetry(
        client,
        () => new DeleteObjectCommand({ Bucket: bucket, Key: key }),
        'canary cleanup',
      )
    } catch (error) {
      failures.push(error)
      continue
    }

    try {
      await observer.send(new HeadObjectCommand({ Bucket: bucket, Key: key }))
      failures.push(new Error('A conformance canary remained after cleanup'))
    } catch (error) {
      if (!isMissingObject(error)) failures.push(error)
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, 'Failed to clean every random R2 conformance canary')
  }
  console.log(`[pass] Deleted and independently verified ${keys.length} owned conformance canaries.`)
}

async function runWriteConformance(client, sealClient, observer, bucket) {
  const runPrefix = `${CONFORMANCE_ROOT}${randomUUID()}/`
  const conditionalThenSeal = `${runPrefix}conditional-then-seal`
  const sealThenConditional = `${runPrefix}seal-then-conditional`
  const inFlightThenSeal = `${runPrefix}in-flight-then-seal`
  const keys = [conditionalThenSeal, sealThenConditional, inFlightThenSeal]
  keys.forEach((key) => assertOwnedCanaryKey(key, runPrefix))

  let primaryError
  try {
    const originalBody = 'hire-media-r2-conformance-original'
    await client.send(new PutObjectCommand({
      Bucket: bucket,
      Key: conditionalThenSeal,
      Body: originalBody,
      ContentType: 'application/octet-stream',
      CacheControl: 'private, no-store',
      IfNoneMatch: '*',
    }))
    await assertObjectBody(
      observer,
      bucket,
      conditionalThenSeal,
      originalBody,
      'initial conditional PUT',
    )

    await delay(SAME_KEY_SETTLE_MS)
    await expectConditionalRejection(
      client,
      {
        Bucket: bucket,
        Key: conditionalThenSeal,
        Body: 'forbidden-overwrite',
        ContentType: 'application/octet-stream',
      },
      'duplicate conditional PUT',
    )
    await assertObjectBody(
      observer,
      bucket,
      conditionalThenSeal,
      originalBody,
      'rejected duplicate conditional PUT',
    )

    await delay(SAME_KEY_SETTLE_MS)
    await putSeal(client, bucket, conditionalThenSeal, 'media-then-seal PUT')
    await assertSeal(observer, bucket, conditionalThenSeal, 'media-then-seal ordering')

    await delay(SAME_KEY_SETTLE_MS)
    await expectConditionalRejection(
      client,
      {
        Bucket: bucket,
        Key: conditionalThenSeal,
        Body: 'forbidden-resurrection',
        ContentType: 'application/octet-stream',
      },
      'conditional PUT after seal',
    )
    await assertSeal(observer, bucket, conditionalThenSeal, 'post-seal rejection')

    await putSeal(client, bucket, sealThenConditional, 'seal-first PUT')
    await assertSeal(observer, bucket, sealThenConditional, 'seal-first ordering')

    await delay(SAME_KEY_SETTLE_MS)
    await expectConditionalRejection(
      client,
      {
        Bucket: bucket,
        Key: sealThenConditional,
        Body: 'forbidden-late-media',
        ContentType: 'application/octet-stream',
      },
      'conditional PUT after seal-first ordering',
    )
    await assertSeal(observer, bucket, sealThenConditional, 'seal-first rejection')

    await assertInFlightUploadLosesToSeal({
      mediaClient: client,
      sealClient,
      observer,
      bucket,
      key: inFlightThenSeal,
    })
    console.log(
      '[pass] R2 preserved media-then-seal, seal-then-conditional, and paused in-flight orderings.',
    )
  } catch (error) {
    primaryError = error
  }

  try {
    await cleanupCanaries(client, observer, bucket, runPrefix, keys)
  } catch (cleanupError) {
    if (primaryError) {
      throw new AggregateError(
        [primaryError, cleanupError],
        'R2 protocol conformance and canary cleanup both failed',
      )
    }
    throw cleanupError
  }
  if (primaryError) throw primaryError
}

async function main() {
  const options = parseArguments(process.argv.slice(2))
  if (options.help) {
    usage()
    return
  }
  if (
    options.write &&
    process.env.HIRE_MEDIA_R2_CONFORMANCE_ACK !== WRITE_ACK
  ) {
    throw new Error(
      `--write requires HIRE_MEDIA_R2_CONFORMANCE_ACK=${WRITE_ACK}`,
    )
  }

  const requireActivationIdentity = options.firstActivation || options.write
  const configuration = requiredEnvironment(process.env, {
    requireActivationIdentity,
  })
  const runtimeMongo = new MongoClient(configuration.runtimeMongoUri, {
    readPreference: 'primary',
  })
  const targets = [
    {
      label: 'control',
      configuration: configuration.control,
      protectedPrefixes: [PRODUCTION_V2_PREFIX],
    },
    {
      label: 'runtime',
      configuration: configuration.runtime,
      protectedPrefixes: [RUNTIME_LANDMARK_V2_PREFIX],
    },
  ].map((target) => ({
    ...target,
    client: makeClient(target.configuration),
    sealClient: makeClient(target.configuration),
    observer: makeClient(target.configuration),
  }))
  try {
    await runtimeMongo.connect()
    const runtimeDatabase = runtimeMongo.db(configuration.runtimeDatabaseName, {
      readPreference: 'primary',
    })
    if (requireActivationIdentity) {
      await verifyHireMediaR2ActivationIdentity({
        mongo: runtimeMongo,
        runtimeDatabase,
        configuration,
      })
      console.log(
        '[pass] Immutable production runtime/database and dual-bucket identity verified.',
      )
    }
    const inventories = {}
    for (const target of targets) {
      inventories[target.label] = await auditLifecycle(
        target.client,
        target.configuration.bucket,
        target.protectedPrefixes,
        target.label,
      )
    }
    const runtimeLandmarkInventory = await auditLegacyRuntimeLandmarks(
      targets[1].client,
      targets[1].configuration.bucket,
      runtimeDatabase,
    )
    if (options.firstActivation) {
      assertFirstActivationInventory({
        controlV2Objects: inventories.control[PRODUCTION_V2_PREFIX],
        runtimeLandmarkV2Objects:
          inventories.runtime[RUNTIME_LANDMARK_V2_PREFIX],
        runtimeLandmarkV2References:
          runtimeLandmarkInventory.productionV2References,
        runtimeLegacyLandmarkObjects:
          runtimeLandmarkInventory.legacyObjects,
        runtimeLegacyLandmarkReferences:
          runtimeLandmarkInventory.legacyReferences,
      })
      console.log('[pass] First-activation production v2 inventories are empty.')
    }
    if (!options.write) {
      console.log('[pass] Read-only audit complete; no object writes or deletes were attempted.')
      return
    }
    for (const target of targets) {
      await runWriteConformance(
        target.client,
        target.sealClient,
        target.observer,
        target.configuration.bucket,
      )
    }
  } finally {
    await runtimeMongo.close()
    for (const target of targets) {
      target.client.destroy()
      target.sealClient.destroy()
      target.observer.destroy()
    }
  }
}

const isDirectExecution = Boolean(
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href,
)

if (isDirectExecution) {
  main().catch((error) => {
    const name = error?.name || 'Error'
    const message = error?.message || String(error)
    console.error(`[fail] ${name}: ${message}`)
    process.exitCode = 1
  })
}
