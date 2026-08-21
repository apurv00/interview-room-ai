import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import {
  CONFORMANCE_ROOT,
  HIRE_MEDIA_R2_ACTIVATION_SENTINEL_COLLECTION,
  HIRE_MEDIA_R2_ACTIVATION_SENTINEL_ID,
  assertFirstActivationInventory,
  assertOwnedCanaryKey,
  cleanupCanaries,
  countObjectsBelowPrefix,
  expirationBlockers,
  hireMediaR2ActivationBindingHmacSha256,
  hireMediaR2ActivationSentinelTokenSha256,
  parseLegacyRuntimeLandmarkKey,
  requiredEnvironment,
  summarizeLegacyRuntimeLandmarkInventory,
  verifyHireMediaR2ActivationIdentity,
} from '../check-hire-media-r2-protocol.mjs'

const ACTIVATION_TOKEN = 'sentinel-token-material-32-bytes!!'
const REPLICA_SET_ID = 'a'.repeat(24)

function activationEnvironment(overrides: Record<string, string> = {}) {
  return {
    R2_ACCOUNT_ID: 'control-account',
    R2_ACCESS_KEY_ID: 'control-access',
    R2_SECRET_ACCESS_KEY: 'control-secret',
    R2_BUCKET_NAME: 'control-bucket',
    HIRE_RUNTIME_R2_ACCOUNT_ID: 'runtime-account',
    HIRE_RUNTIME_R2_ACCESS_KEY_ID: 'runtime-access',
    HIRE_RUNTIME_R2_SECRET_ACCESS_KEY: 'runtime-secret',
    HIRE_RUNTIME_R2_BUCKET_NAME: 'runtime-bucket',
    MONGODB_URI: 'mongodb://runtime-primary.invalid/',
    HIRE_RUNTIME_DATABASE_NAME: 'hire-runtime-production',
    NODE_ENV: 'production',
    HIRE_MEDIA_R2_EXPECTED_ENVIRONMENT: 'production',
    HIRE_MEDIA_R2_EXPECTED_RUNTIME_DATABASE_NAME: 'hire-runtime-production',
    HIRE_MEDIA_R2_EXPECTED_CONTROL_ACCOUNT_ID: 'control-account',
    HIRE_MEDIA_R2_EXPECTED_CONTROL_BUCKET_NAME: 'control-bucket',
    HIRE_MEDIA_R2_EXPECTED_RUNTIME_ACCOUNT_ID: 'runtime-account',
    HIRE_MEDIA_R2_EXPECTED_RUNTIME_BUCKET_NAME: 'runtime-bucket',
    HIRE_MEDIA_R2_ACTIVATION_SENTINEL_TOKEN: ACTIVATION_TOKEN,
    ...overrides,
  }
}

function activationConfiguration(overrides: Record<string, string> = {}) {
  return requiredEnvironment(activationEnvironment(overrides), {
    requireActivationIdentity: true,
  })
}

function activationSentinel(
  configuration: ReturnType<typeof activationConfiguration>,
  overrides: Record<string, unknown> = {},
) {
  return {
    _id: HIRE_MEDIA_R2_ACTIVATION_SENTINEL_ID,
    environment: 'production',
    runtimeDatabaseName: configuration.runtimeDatabaseName,
    schemaVersion: 1,
    immutable: true,
    replicaSetName: 'production-rs',
    replicaSetId: REPLICA_SET_ID,
    tokenSha256: hireMediaR2ActivationSentinelTokenSha256(ACTIVATION_TOKEN),
    bindingHmacSha256: hireMediaR2ActivationBindingHmacSha256({
      token: ACTIVATION_TOKEN,
      environment: 'production',
      runtimeDatabaseName: configuration.runtimeDatabaseName,
      replicaSetName: 'production-rs',
      replicaSetId: REPLICA_SET_ID,
      controlR2AccountId: configuration.control.accountId,
      controlR2Bucket: configuration.control.bucket,
      runtimeR2AccountId: configuration.runtime.accountId,
      runtimeR2Bucket: configuration.runtime.bucket,
    }),
    ...overrides,
  }
}

function activationIdentityHarness(input: {
  configuration?: ReturnType<typeof activationConfiguration>
  sentinel?: Record<string, unknown> | null
  replicaConfiguration?: Record<string, unknown>
} = {}) {
  const configuration = input.configuration ?? activationConfiguration()
  const command = vi.fn().mockResolvedValue(
    input.replicaConfiguration ?? {
      commitmentStatus: true,
      config: {
        _id: 'production-rs',
        settings: { replicaSetId: { toString: () => REPLICA_SET_ID } },
      },
    },
  )
  const findOne = vi.fn().mockResolvedValue(
    input.sentinel === undefined
      ? activationSentinel(configuration)
      : input.sentinel,
  )
  const runtimeDatabase = {
    databaseName: configuration.runtimeDatabaseName,
    collection: vi.fn(() => ({ findOne })),
  }
  const mongo = {
    db: vi.fn(() => ({ command })),
  }
  return { configuration, mongo, runtimeDatabase, command, findOne }
}

describe('Hire media R2 production activation identity', () => {
  it('requires independent expected values and a minimum-strength token', () => {
    expect(() => activationConfiguration()).not.toThrow()
    expect(() => activationConfiguration({
      HIRE_MEDIA_R2_EXPECTED_RUNTIME_BUCKET_NAME: 'different-bucket',
    })).toThrow(/environment identity mismatch/)
    expect(() => activationConfiguration({
      HIRE_MEDIA_R2_ACTIVATION_SENTINEL_TOKEN: 'too-short',
    })).toThrow(/sentinel token is too short/)
  })

  it('verifies the committed live replica identity and immutable sentinel', async () => {
    const harness = activationIdentityHarness()

    await expect(verifyHireMediaR2ActivationIdentity(harness)).resolves.toBeUndefined()

    expect(harness.mongo.db).toHaveBeenCalledWith('admin', {
      readPreference: 'primary',
    })
    expect(harness.command).toHaveBeenCalledWith(
      { replSetGetConfig: 1, commitmentStatus: true },
      { readPreference: 'primary' },
    )
    expect(harness.runtimeDatabase.collection).toHaveBeenCalledWith(
      HIRE_MEDIA_R2_ACTIVATION_SENTINEL_COLLECTION,
    )
    expect(harness.findOne).toHaveBeenCalledWith(
      { _id: HIRE_MEDIA_R2_ACTIVATION_SENTINEL_ID },
      expect.objectContaining({ readConcern: { level: 'majority' } }),
    )
  })

  it.each([
    ['runtimeDatabaseName', 'different-runtime-database'],
    ['replicaSetName', 'different-replica-set'],
    ['replicaSetId', 'b'.repeat(24)],
    ['controlR2AccountId', 'different-control-account'],
    ['controlR2Bucket', 'different-control-bucket'],
    ['runtimeR2AccountId', 'different-runtime-account'],
    ['runtimeR2Bucket', 'different-runtime-bucket'],
  ] as const)('binds %s into the immutable identity HMAC', (name, value) => {
    const identity = {
      token: ACTIVATION_TOKEN,
      environment: 'production',
      runtimeDatabaseName: 'hire-runtime-production',
      replicaSetName: 'production-rs',
      replicaSetId: REPLICA_SET_ID,
      controlR2AccountId: 'control-account',
      controlR2Bucket: 'control-bucket',
      runtimeR2AccountId: 'runtime-account',
      runtimeR2Bucket: 'runtime-bucket',
    }
    expect(hireMediaR2ActivationBindingHmacSha256({
      ...identity,
      [name]: value,
    })).not.toBe(hireMediaR2ActivationBindingHmacSha256(identity))
  })

  it('rejects a self-consistently wrong bucket tuple against the sentinel', async () => {
    const productionConfiguration = activationConfiguration()
    const wrongConfiguration = activationConfiguration({
      HIRE_RUNTIME_R2_BUCKET_NAME: 'self-consistent-wrong-bucket',
      HIRE_MEDIA_R2_EXPECTED_RUNTIME_BUCKET_NAME:
        'self-consistent-wrong-bucket',
    })
    const harness = activationIdentityHarness({
      configuration: wrongConfiguration,
      sentinel: activationSentinel(productionConfiguration),
    })

    await expect(
      verifyHireMediaR2ActivationIdentity(harness),
    ).rejects.toThrow(/identity sentinel is invalid/)
  })

  it('rejects copied or uncommitted runtime deployment identity', async () => {
    const copied = activationIdentityHarness({
      replicaConfiguration: {
        commitmentStatus: true,
        config: {
          _id: 'production-rs',
          settings: {
            replicaSetId: { toString: () => 'b'.repeat(24) },
          },
        },
      },
    })
    await expect(
      verifyHireMediaR2ActivationIdentity(copied),
    ).rejects.toThrow(/identity sentinel is invalid/)

    const uncommitted = activationIdentityHarness({
      replicaConfiguration: {
        commitmentStatus: false,
        config: {
          _id: 'production-rs',
          settings: { replicaSetId: { toString: () => REPLICA_SET_ID } },
        },
      },
    })
    await expect(
      verifyHireMediaR2ActivationIdentity(uncommitted),
    ).rejects.toThrow(/live replica identity is unavailable/)
  })
})

describe('Hire media R2 lifecycle audit', () => {
  it('blocks every enabled expiration prefix that can select a v2 seal', () => {
    const blockers = expirationBlockers([
      { ID: 'bucket-wide', Status: 'Enabled', Expiration: { Days: 30 } },
      {
        ID: 'parent',
        Status: 'Enabled',
        Filter: { Prefix: 'hire-media/' },
        Expiration: { Days: 30 },
      },
      {
        ID: 'exact',
        Status: 'Enabled',
        Filter: { Prefix: 'hire-media/v2/' },
        Expiration: { Days: 30 },
      },
      {
        ID: 'child',
        Status: 'Enabled',
        Filter: { And: { Prefix: 'hire-media/v2/a' } },
        Expiration: { Days: 30 },
      },
      {
        ID: 'runtime-landmarks',
        Status: 'Enabled',
        Filter: { Prefix: 'landmarks/v2/' },
        Expiration: { Days: 30 },
      },
      {
        ID: 'tag-only-is-conservative',
        Status: 'Enabled',
        Filter: { Tag: { Key: 'temporary', Value: 'true' } },
        Expiration: { Days: 30 },
      },
    ])

    expect(blockers.map(({ id }: { id: string }) => id)).toEqual([
      'bucket-wide',
      'parent',
      'exact',
      'child',
      'runtime-landmarks',
      'tag-only-is-conservative',
    ])
  })

  it('allows disabled, non-expiring, and provably disjoint rules', () => {
    expect(expirationBlockers([
      {
        ID: 'disabled',
        Status: 'Disabled',
        Filter: { Prefix: 'hire-media/v2/' },
        Expiration: { Days: 1 },
      },
      {
        ID: 'transition-only',
        Status: 'Enabled',
        Filter: { Prefix: 'hire-media/v2/' },
        Transitions: [{ Days: 30, StorageClass: 'STANDARD_IA' }],
      },
      {
        ID: 'sibling',
        Status: 'Enabled',
        Filter: { Prefix: 'hire-media/v2-legacy/' },
        Expiration: { Days: 1 },
      },
      {
        ID: 'conformance-only',
        Status: 'Enabled',
        Prefix: 'hire-media-conformance/',
        Expiration: { Days: 1 },
      },
      {
        ID: 'landmark-sibling',
        Status: 'Enabled',
        Prefix: 'landmarks/v2-legacy/',
        Expiration: { Days: 1 },
      },
    ])).toEqual([])
  })

  it('paginates count-only inventory without exposing object keys', async () => {
    const client = {
      send: vi.fn()
        .mockResolvedValueOnce({
          KeyCount: 1000,
          IsTruncated: true,
          NextContinuationToken: 'opaque-next-page',
        })
        .mockResolvedValueOnce({ KeyCount: 7, IsTruncated: false }),
    }

    await expect(countObjectsBelowPrefix(
      client,
      'production-bucket',
      'landmarks/v2/',
    )).resolves.toBe(1007)
    expect(client.send.mock.calls.map(([command]) => command.input)).toEqual([
      { Bucket: 'production-bucket', Prefix: 'landmarks/v2/' },
      {
        Bucket: 'production-bucket',
        Prefix: 'landmarks/v2/',
        ContinuationToken: 'opaque-next-page',
      },
    ])
  })

  it('fails first activation if either exact production v2 prefix is nonempty', () => {
    expect(() => assertFirstActivationInventory({
      controlV2Objects: 0,
      runtimeLandmarkV2Objects: 0,
      runtimeLandmarkV2References: 0,
      runtimeLegacyLandmarkObjects: 0,
      runtimeLegacyLandmarkReferences: 0,
    })).not.toThrow()
    expect(() => assertFirstActivationInventory({
      controlV2Objects: 1,
      runtimeLandmarkV2Objects: 0,
      runtimeLandmarkV2References: 0,
      runtimeLegacyLandmarkObjects: 0,
      runtimeLegacyLandmarkReferences: 0,
    })).toThrow(/First activation requires zero/)
    expect(() => assertFirstActivationInventory({
      controlV2Objects: 0,
      runtimeLandmarkV2Objects: 1,
      runtimeLandmarkV2References: 0,
      runtimeLegacyLandmarkObjects: 0,
      runtimeLegacyLandmarkReferences: 0,
    })).toThrow(/First activation requires zero/)
    expect(() => assertFirstActivationInventory({
      controlV2Objects: 0,
      runtimeLandmarkV2Objects: 0,
      runtimeLandmarkV2References: 1,
      runtimeLegacyLandmarkObjects: 0,
      runtimeLegacyLandmarkReferences: 0,
    })).toThrow(/First activation requires zero/)
    expect(() => assertFirstActivationInventory({
      controlV2Objects: 0,
      runtimeLandmarkV2Objects: 0,
      runtimeLandmarkV2References: 0,
      runtimeLegacyLandmarkObjects: 1,
      runtimeLegacyLandmarkReferences: 1,
    })).toThrow(/zero legacy runtime landmarks/)
  })
})

describe('Hire media R2 canary ownership guard', () => {
  const runPrefix = `${CONFORMANCE_ROOT}123e4567-e89b-42d3-a456-426614174000/`

  it('accepts an object strictly inside the random run prefix', () => {
    expect(() => assertOwnedCanaryKey(
      `${runPrefix}conditional-then-seal`,
      runPrefix,
    )).not.toThrow()
  })

  it.each([
    ['hire-media/v2/' + 'a'.repeat(64), runPrefix],
    ['landmarks/v2/' + 'b'.repeat(64), runPrefix],
    [CONFORMANCE_ROOT, CONFORMANCE_ROOT],
    [`${CONFORMANCE_ROOT}another-run/canary`, runPrefix],
    [runPrefix, runPrefix],
    [`${runPrefix}unexpected-canary`, runPrefix],
  ])('rejects an unowned key', (key, prefix) => {
    expect(() => assertOwnedCanaryKey(key, prefix)).toThrow(/Refusing/)
  })
})

describe('Hire runtime legacy landmark inventory join', () => {
  const principalId = 'a'.repeat(24)
  const runtimeSessionId = 'b'.repeat(24)
  const legacyKey =
    `landmarks/${principalId}/${runtimeSessionId}-${'c'.repeat(32)}.json`

  function v2Key(objectKeyNonce: string): string {
    const digest = createHash('sha256')
      .update('interview-room-ai:hire-runtime-landmark:v2\0')
      .update(principalId)
      .update('\0')
      .update(runtimeSessionId)
      .update('\0')
      .update(objectKeyNonce)
      .digest('hex')
    return `landmarks/v2/${digest}`
  }

  it('parses only an exact coordinate-bearing legacy key', () => {
    expect(parseLegacyRuntimeLandmarkKey(legacyKey)).toEqual({
      principalId,
      runtimeSessionId,
    })
    expect(parseLegacyRuntimeLandmarkKey(
      `landmarks/v2/${'d'.repeat(64)}`,
    )).toBeNull()
  })

  it('joins every legacy object to an exact scoped durable reference and excludes v2', () => {
    expect(summarizeLegacyRuntimeLandmarkInventory({
      objectKeys: [
        legacyKey,
        `landmarks/v2/${'d'.repeat(64)}`,
      ],
      references: [
        { key: legacyKey, principalId, runtimeSessionId },
        // The same key may be inventoried by both outbox and session pointer.
        { key: legacyKey, principalId, runtimeSessionId },
      ],
    })).toEqual({
      productionV2Excluded: 1,
      productionV2References: 0,
      legacyObjects: 1,
      legacyReferences: 1,
      matchedLegacy: 1,
      unmatchedLegacyObject: 0,
      legacyReferenceWithoutObject: 0,
      malformedOrUnrecognized: 0,
      malformedReferences: 0,
      coordinateMismatchReferences: 0,
    })
  })

  it('reports unmatched, absent, malformed, and crossed-coordinate blockers without keys', () => {
    const absentKey =
      `landmarks/${principalId}/${'e'.repeat(24)}-${'f'.repeat(32)}.json`
    expect(summarizeLegacyRuntimeLandmarkInventory({
      objectKeys: [legacyKey, 'landmarks/not-canonical'],
      references: [
        { key: absentKey, principalId, runtimeSessionId: 'e'.repeat(24) },
        { key: legacyKey, principalId: '9'.repeat(24), runtimeSessionId },
        { key: 'landmarks/not-canonical', principalId, runtimeSessionId },
      ],
    })).toMatchObject({
      unmatchedLegacyObject: 1,
      legacyReferenceWithoutObject: 1,
      malformedOrUnrecognized: 1,
      malformedReferences: 1,
      coordinateMismatchReferences: 1,
    })
  })

  it('counts only nonce-authorized digest-only v2 references for first activation', () => {
    const objectKeyNonce = 'f'.repeat(64)
    const sourceKey = v2Key(objectKeyNonce)
    expect(summarizeLegacyRuntimeLandmarkInventory({
      objectKeys: [sourceKey],
      references: [{
        key: sourceKey,
        principalId,
        runtimeSessionId,
        objectKeyNonce,
      }],
    })).toMatchObject({
      productionV2Excluded: 1,
      productionV2References: 1,
      coordinateMismatchReferences: 0,
    })
    expect(summarizeLegacyRuntimeLandmarkInventory({
      objectKeys: [sourceKey],
      references: [{
        key: sourceKey,
        principalId,
        runtimeSessionId,
        objectKeyNonce: 'e'.repeat(64),
      }],
    })).toMatchObject({
      productionV2References: 0,
      coordinateMismatchReferences: 1,
    })
  })
})

describe('Hire media R2 canary cleanup', () => {
  const runPrefix = `${CONFORMANCE_ROOT}123e4567-e89b-42d3-a456-426614174000/`
  const ownedKeys = [
    `${runPrefix}conditional-then-seal`,
    `${runPrefix}seal-then-conditional`,
    `${runPrefix}in-flight-then-seal`,
  ]

  it('deletes and verifies only the three exact owned keys', async () => {
    const deleted = [] as string[]
    const client = {
      send: vi.fn(async (command: { input: { Key: string } }) => {
        deleted.push(command.input.Key)
        return {}
      }),
    }
    const observer = {
      send: vi.fn(async () => {
        throw Object.assign(new Error('not found'), {
          name: 'NotFound',
          $metadata: { httpStatusCode: 404 },
        })
      }),
    }

    await cleanupCanaries(client, observer, 'test-bucket', runPrefix, ownedKeys)

    expect(deleted).toEqual(ownedKeys)
    expect(observer.send).toHaveBeenCalledTimes(3)
  })

  it.each([
    `hire-media/v2/${'a'.repeat(64)}`,
    `landmarks/v2/${'b'.repeat(64)}`,
  ])('refuses production key %s before issuing any delete', async (productionKey) => {
    const client = { send: vi.fn() }
    const observer = { send: vi.fn() }

    await expect(cleanupCanaries(
      client,
      observer,
      'test-bucket',
      runPrefix,
      [productionKey],
    )).rejects.toThrow(/Refusing/)
    expect(client.send).not.toHaveBeenCalled()
    expect(observer.send).not.toHaveBeenCalled()
  })

  it('fails the gate when deletion is not independently observable', async () => {
    const client = { send: vi.fn().mockResolvedValue({}) }
    const observer = { send: vi.fn().mockResolvedValue({ ContentLength: 0 }) }

    await expect(cleanupCanaries(
      client,
      observer,
      'test-bucket',
      runPrefix,
      [ownedKeys[0]],
    )).rejects.toThrow(/Failed to clean every random R2 conformance canary/)
    expect(client.send).toHaveBeenCalledOnce()
    expect(observer.send).toHaveBeenCalledOnce()
  })
})
