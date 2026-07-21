import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { MongoClient } from 'mongodb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  JOBS_STAGING_SENTINEL_COLLECTION,
  JOBS_STAGING_SENTINEL_ID,
  jobsStagingSentinelTokenSha256,
  verifyJobsStagingDatabaseIdentity,
  type JobsStagingIdentityEnvironment,
} from '../verify-jobs-staging-database'

const TOKEN = 'staging-only-token-with-at-least-32-bytes'

function validEnvironment(
  overrides: Partial<JobsStagingIdentityEnvironment> = {},
): JobsStagingIdentityEnvironment {
  return {
    MONGODB_URI: 'mongodb://staging.invalid/jobs_staging',
    A02_STAGING_EXPECTED_DATABASE: 'jobs_staging',
    A02_STAGING_SENTINEL_TOKEN: TOKEN,
    ...overrides,
  }
}

function fakeClient(options: {
  databaseName?: string
  sentinel?: Record<string, unknown> | null
} = {}) {
  const findOne = vi.fn().mockResolvedValue(
    options.sentinel === undefined
      ? {
          _id: JOBS_STAGING_SENTINEL_ID,
          environment: 'jobs-staging',
          databaseName: 'jobs_staging',
          schemaVersion: 1,
          immutable: true,
          tokenSha256: jobsStagingSentinelTokenSha256(TOKEN),
        }
      : options.sentinel,
  )
  const collection = vi.fn().mockReturnValue({ findOne })
  const connect = vi.fn().mockResolvedValue(undefined)
  const close = vi.fn().mockResolvedValue(undefined)
  const db = vi.fn().mockReturnValue({
    databaseName: options.databaseName ?? 'jobs_staging',
    collection,
  })

  return {
    client: { connect, close, db } as unknown as MongoClient,
    close,
    collection,
    connect,
    findOne,
  }
}

describe('Jobs staging database identity gate', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it.each([
    ['MONGODB_URI', { MONGODB_URI: undefined }],
    ['A02_STAGING_EXPECTED_DATABASE', { A02_STAGING_EXPECTED_DATABASE: undefined }],
    ['A02_STAGING_SENTINEL_TOKEN', { A02_STAGING_SENTINEL_TOKEN: undefined }],
  ] as const)('fails before constructing a client when %s is absent', async (name, override) => {
    const createClient = vi.fn()

    await expect(
      verifyJobsStagingDatabaseIdentity(validEnvironment(override), createClient),
    ).rejects.toThrow(`${name} environment variable is not defined`)
    expect(createClient).not.toHaveBeenCalled()
  })

  it('rejects a short or whitespace-mutated sentinel token before connecting', async () => {
    const createClient = vi.fn()

    await expect(
      verifyJobsStagingDatabaseIdentity(
        validEnvironment({ A02_STAGING_SENTINEL_TOKEN: 'too-short' }),
        createClient,
      ),
    ).rejects.toThrow('must contain at least 32 bytes')
    await expect(
      verifyJobsStagingDatabaseIdentity(
        validEnvironment({ A02_STAGING_SENTINEL_TOKEN: `${TOKEN} ` }),
        createClient,
      ),
    ).rejects.toThrow('must not contain leading or trailing whitespace')
    expect(createClient).not.toHaveBeenCalled()
  })

  it('rejects a URI selecting a different database before making a network connection', async () => {
    const fake = fakeClient({ databaseName: 'production' })

    await expect(
      verifyJobsStagingDatabaseIdentity(validEnvironment(), () => fake.client),
    ).rejects.toThrow('staging database name mismatch')
    expect(fake.connect).not.toHaveBeenCalled()
    expect(fake.findOne).not.toHaveBeenCalled()
    expect(fake.close).toHaveBeenCalledOnce()
  })

  it.each([
    ['missing', null],
    ['wrong environment', {
      _id: JOBS_STAGING_SENTINEL_ID,
      environment: 'production',
      databaseName: 'jobs_staging',
      schemaVersion: 1,
      immutable: true,
      tokenSha256: jobsStagingSentinelTokenSha256(TOKEN),
    }],
    ['wrong database', {
      _id: JOBS_STAGING_SENTINEL_ID,
      environment: 'jobs-staging',
      databaseName: 'production',
      schemaVersion: 1,
      immutable: true,
      tokenSha256: jobsStagingSentinelTokenSha256(TOKEN),
    }],
    ['mutable', {
      _id: JOBS_STAGING_SENTINEL_ID,
      environment: 'jobs-staging',
      databaseName: 'jobs_staging',
      schemaVersion: 1,
      immutable: false,
      tokenSha256: jobsStagingSentinelTokenSha256(TOKEN),
    }],
    ['wrong token', {
      _id: JOBS_STAGING_SENTINEL_ID,
      environment: 'jobs-staging',
      databaseName: 'jobs_staging',
      schemaVersion: 1,
      immutable: true,
      tokenSha256: jobsStagingSentinelTokenSha256(`${TOKEN}-different`),
    }],
  ])('fails closed when the sentinel is %s', async (_case, sentinel) => {
    const fake = fakeClient({ sentinel })

    await expect(
      verifyJobsStagingDatabaseIdentity(validEnvironment(), () => fake.client),
    ).rejects.toThrow('is absent or invalid')
    expect(fake.connect).toHaveBeenCalledOnce()
    expect(fake.close).toHaveBeenCalledOnce()
  })

  it('passes only the exact immutable staging sentinel and performs a primary majority read', async () => {
    const fake = fakeClient()

    await verifyJobsStagingDatabaseIdentity(validEnvironment(), () => fake.client)

    expect(fake.collection).toHaveBeenCalledExactlyOnceWith(JOBS_STAGING_SENTINEL_COLLECTION)
    expect(fake.findOne).toHaveBeenCalledExactlyOnceWith(
      { _id: JOBS_STAGING_SENTINEL_ID },
      expect.objectContaining({
        readConcern: { level: 'majority' },
        readPreference: 'primary',
      }),
    )
    expect(fake.close).toHaveBeenCalledOnce()
  })

  it('keeps the identity gate before the only source-control index mutation in the workflow', () => {
    const workflow = readFileSync(
      resolve(process.cwd(), '.github/workflows/jobs-source-control-promotion.yml'),
      'utf8',
    )
    const gateCommand = 'npx tsx scripts/verify-jobs-staging-database.ts'
    const mutationCommand = 'npm run prepare:jobs-source-control-indexes -- --apply'
    const gateOffset = workflow.indexOf(gateCommand)
    const mutationOffset = workflow.indexOf(mutationCommand)

    expect(gateOffset).toBeGreaterThan(-1)
    expect(mutationOffset).toBeGreaterThan(gateOffset)
    expect(workflow.match(new RegExp(mutationCommand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')))
      .toHaveLength(1)
    expect(workflow.slice(gateOffset, mutationOffset)).toContain(
      'A02_STAGING_EXPECTED_DATABASE: ${{ vars.A02_STAGING_EXPECTED_DATABASE }}',
    )
    expect(workflow.slice(gateOffset, mutationOffset)).toContain(
      'A02_STAGING_SENTINEL_TOKEN: ${{ secrets.A02_STAGING_SENTINEL_TOKEN }}',
    )
  })
})
