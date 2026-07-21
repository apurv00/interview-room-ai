#!/usr/bin/env tsx
/**
 * Read-only identity gate for the protected jobs-staging promotion workflow.
 *
 * The target database must match both an operator-configured database name and
 * a staging-only sentinel whose token is held by the GitHub Environment. This
 * command never creates or updates the sentinel; provisioning is an out-of-band
 * operation described in SOURCE_CONTROL_RUNBOOK.md.
 */

import { createHash, timingSafeEqual } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { MongoClient, type Document } from 'mongodb'

export const JOBS_STAGING_SENTINEL_COLLECTION = '__deployment_environment_identity'
export const JOBS_STAGING_SENTINEL_ID = 'jobs-source-control-promotion-v1'
export const JOBS_STAGING_ENVIRONMENT = 'jobs-staging'

const MINIMUM_SENTINEL_TOKEN_BYTES = 32

interface JobsStagingSentinelDocument extends Document {
  _id: string
  environment: string
  databaseName: string
  schemaVersion: number
  immutable: boolean
  tokenSha256: string
}

export interface JobsStagingIdentityEnvironment extends NodeJS.ProcessEnv {
  MONGODB_URI?: string
  A02_STAGING_EXPECTED_DATABASE?: string
  A02_STAGING_SENTINEL_TOKEN?: string
}

export type JobsStagingMongoClientFactory = (uri: string) => MongoClient

function requiredEnvironmentValue(
  environment: JobsStagingIdentityEnvironment,
  name: keyof JobsStagingIdentityEnvironment,
): string {
  const value = environment[name]
  if (!value) {
    throw new Error(`${name} environment variable is not defined`)
  }
  if (value !== value.trim()) {
    throw new Error(`${name} must not contain leading or trailing whitespace`)
  }
  return value
}

export function jobsStagingSentinelTokenSha256(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

function assertSentinelToken(token: string): void {
  if (Buffer.byteLength(token, 'utf8') < MINIMUM_SENTINEL_TOKEN_BYTES) {
    throw new Error(
      `A02_STAGING_SENTINEL_TOKEN must contain at least ${MINIMUM_SENTINEL_TOKEN_BYTES} bytes`,
    )
  }
}

function sentinelMatches(
  sentinel: JobsStagingSentinelDocument | null,
  expectedDatabaseName: string,
  expectedTokenSha256: string,
): boolean {
  if (
    !sentinel ||
    sentinel._id !== JOBS_STAGING_SENTINEL_ID ||
    sentinel.environment !== JOBS_STAGING_ENVIRONMENT ||
    sentinel.databaseName !== expectedDatabaseName ||
    sentinel.schemaVersion !== 1 ||
    sentinel.immutable !== true ||
    !/^[a-f0-9]{64}$/.test(sentinel.tokenSha256)
  ) {
    return false
  }

  const actualDigest = Buffer.from(sentinel.tokenSha256, 'hex')
  const expectedDigest = Buffer.from(expectedTokenSha256, 'hex')
  return (
    actualDigest.length === expectedDigest.length && timingSafeEqual(actualDigest, expectedDigest)
  )
}

export async function verifyJobsStagingDatabaseIdentity(
  environment: JobsStagingIdentityEnvironment = process.env,
  createClient: JobsStagingMongoClientFactory = (uri) =>
    new MongoClient(uri, {
      readPreference: 'primary',
      serverSelectionTimeoutMS: 15_000,
      connectTimeoutMS: 15_000,
    }),
): Promise<void> {
  const uri = requiredEnvironmentValue(environment, 'MONGODB_URI')
  const expectedDatabaseName = requiredEnvironmentValue(
    environment,
    'A02_STAGING_EXPECTED_DATABASE',
  )
  const sentinelToken = requiredEnvironmentValue(environment, 'A02_STAGING_SENTINEL_TOKEN')
  assertSentinelToken(sentinelToken)

  const client = createClient(uri)
  try {
    const database = client.db()
    if (database.databaseName !== expectedDatabaseName) {
      throw new Error(
        `staging database name mismatch: URI selects ${JSON.stringify(database.databaseName)}, expected ${JSON.stringify(expectedDatabaseName)}`,
      )
    }

    await client.connect()
    const sentinel = await database
      .collection<JobsStagingSentinelDocument>(JOBS_STAGING_SENTINEL_COLLECTION)
      .findOne(
        { _id: JOBS_STAGING_SENTINEL_ID },
        {
          projection: {
            _id: 1,
            environment: 1,
            databaseName: 1,
            schemaVersion: 1,
            immutable: 1,
            tokenSha256: 1,
          },
          readConcern: { level: 'majority' },
          readPreference: 'primary',
        },
      )

    const expectedTokenSha256 = jobsStagingSentinelTokenSha256(sentinelToken)
    if (!sentinelMatches(sentinel, expectedDatabaseName, expectedTokenSha256)) {
      throw new Error(
        `staging identity sentinel ${JOBS_STAGING_SENTINEL_COLLECTION}/${JOBS_STAGING_SENTINEL_ID} is absent or invalid`,
      )
    }

    console.log(
      `STAGING DATABASE IDENTITY PASSED — ${expectedDatabaseName} has the protected ${JOBS_STAGING_ENVIRONMENT} sentinel.`,
    )
  } finally {
    await client.close()
  }
}

async function main(): Promise<void> {
  await verifyJobsStagingDatabaseIdentity()
}

const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error('Jobs staging database identity check failed:', error)
      process.exit(1)
    })
}
