#!/usr/bin/env node

import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import { pathToFileURL } from 'node:url'
import {
  DeleteObjectCommand,
  GetBucketLifecycleConfigurationCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'

export const PRODUCTION_V2_PREFIX = 'hire-media/v2/'
export const CONFORMANCE_ROOT = 'hire-media-conformance/v2/'
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
  npm run check:hire-media-r2-protocol
  HIRE_MEDIA_R2_CONFORMANCE_ACK=${WRITE_ACK} \\
    npm run check:hire-media-r2-protocol -- --write

The default mode is read-only and audits bucket lifecycle rules. --write also
creates three random objects below ${CONFORMANCE_ROOT}, verifies conditional PUT
and zero-byte seal behavior, and deletes only those exact canary keys. It never
writes to or deletes from ${PRODUCTION_V2_PREFIX}.
`)
}

function parseArguments(argv) {
  const options = { write: false }
  for (const argument of argv) {
    if (argument === '--write') options.write = true
    else if (argument === '--help' || argument === '-h') options.help = true
    else throw new Error(`Unknown argument: ${argument}`)
  }
  return options
}

function requiredEnvironment() {
  const names = [
    'R2_ACCOUNT_ID',
    'R2_ACCESS_KEY_ID',
    'R2_SECRET_ACCESS_KEY',
    'R2_BUCKET_NAME',
  ]
  const missing = names.filter((name) => !process.env[name]?.trim())
  if (missing.length > 0) {
    throw new Error(`Missing required environment: ${missing.join(', ')}`)
  }
  return {
    accountId: process.env.R2_ACCOUNT_ID.trim(),
    accessKeyId: process.env.R2_ACCESS_KEY_ID.trim(),
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY.trim(),
    bucket: process.env.R2_BUCKET_NAME.trim(),
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

export function expirationBlockers(rules) {
  return rules
    .filter((rule) => rule.Status === 'Enabled')
    .filter((rule) => Boolean(rule.Expiration || rule.NoncurrentVersionExpiration))
    .map((rule, index) => ({
      id: rule.ID || `unnamed-rule-${index + 1}`,
      prefix: expirationPrefix(rule),
    }))
    .filter(({ prefix }) => prefixesOverlap(prefix, PRODUCTION_V2_PREFIX))
}

async function auditLifecycle(client, bucket) {
  let rules = []
  try {
    const response = await client.send(
      new GetBucketLifecycleConfigurationCommand({ Bucket: bucket }),
    )
    rules = response.Rules ?? []
  } catch (error) {
    if (!isMissingLifecycleConfiguration(error)) throw error
  }

  const blockers = expirationBlockers(rules)
  if (blockers.length > 0) {
    const detail = blockers
      .map(({ id, prefix }) => `${id} (prefix ${JSON.stringify(prefix)})`)
      .join(', ')
    throw new Error(
      `Enabled R2 expiration rules overlap ${PRODUCTION_V2_PREFIX}: ${detail}`,
    )
  }

  console.log(
    `[pass] No enabled expiration rule overlaps ${PRODUCTION_V2_PREFIX} (${rules.length} rule(s) inspected).`,
  )
}

export function assertOwnedCanaryKey(key, runPrefix) {
  const suffix = key.slice(runPrefix.length)
  if (
    !CONFORMANCE_RUN_PREFIX.test(runPrefix) ||
    !key.startsWith(runPrefix) ||
    !CANARY_NAMES.has(suffix) ||
    key.startsWith(PRODUCTION_V2_PREFIX)
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

  const configuration = requiredEnvironment()
  const client = makeClient(configuration)
  const sealClient = makeClient(configuration)
  const observer = makeClient(configuration)
  try {
    await auditLifecycle(client, configuration.bucket)
    if (!options.write) {
      console.log('[pass] Read-only audit complete; no object writes or deletes were attempted.')
      return
    }
    await runWriteConformance(client, sealClient, observer, configuration.bucket)
  } finally {
    client.destroy()
    sealClient.destroy()
    observer.destroy()
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
