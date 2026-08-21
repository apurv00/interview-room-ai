import { ObjectId } from 'mongodb'
import { describe, expect, it, vi } from 'vitest'
import {
  HIRE_MEDIA_V1_DESTRUCTIVE_ACK,
  HIRE_MEDIA_V1_SENTINEL_COLLECTION,
  HIRE_MEDIA_V1_SENTINEL_ID,
  executeHireMediaV1ReconciliationCli,
  hireMediaV1ProductionBindingHmacSha256,
  hireMediaV1SentinelTokenSha256,
  runHireMediaV1Reconciliation,
} from '../reconcile-hire-media-v1.mjs'

const IDS = {
  workspace: '111111111111111111111111',
  application: '222222222222222222222222',
  round: '333333333333333333333333',
  attempt: '444444444444444444444444',
  live: '555555555555555555555555',
  purged: '666666666666666666666666',
  orphan: '777777777777777777777777',
  changed: '888888888888888888888888',
} as const

const REPLICA_SET_NAME = 'prod-hire-rs'
const REPLICA_SET_ID = 'aaaaaaaaaaaaaaaaaaaaaaaa'

const FILE_FOR_KIND = {
  identity_photo: 'identity-photo.jpg',
  camera_recording: 'camera-recording.webm',
  screen_recording: 'screen-recording.webm',
  audio_recording: 'audio-recording.webm',
  facial_landmarks: 'facial-landmarks.json',
} as const

type MediaKind = keyof typeof FILE_FOR_KIND

function key(assetId: string, kind: MediaKind = 'camera_recording') {
  return [
    'hire-media',
    IDS.workspace,
    IDS.application,
    IDS.round,
    IDS.attempt,
    `${assetId}-${FILE_FOR_KIND[kind]}`,
  ].join('/')
}

function row(
  assetId: string,
  state = 'ready',
  kind: MediaKind = 'camera_recording',
  overrides: Record<string, unknown> = {},
) {
  return {
    _id: new ObjectId(assetId),
    workspaceId: new ObjectId(IDS.workspace),
    applicationId: new ObjectId(IDS.application),
    roundId: new ObjectId(IDS.round),
    attemptId: new ObjectId(IDS.attempt),
    kind,
    objectKey: key(assetId, kind),
    state,
    ...overrides,
  }
}

function valueEquals(left: unknown, right: unknown) {
  if (left instanceof ObjectId && right instanceof ObjectId) {
    return left.equals(right)
  }
  return left === right
}

function matchesFilter(document: Record<string, unknown>, filter: Record<string, unknown>) {
  return Object.entries(filter).every(([field, expected]) =>
    valueEquals(document[field], expected),
  )
}

function fakeMongo(
  initialRows: Array<Record<string, unknown>>,
  options: {
    databaseName?: string
    sentinel?: Record<string, unknown> | null
    sentinelSequence?: Array<Record<string, unknown> | null>
    replicaConfiguration?: Record<string, unknown>
    adminCommandError?: Error
    mongoOptions?: Record<string, unknown>
    findOne?: (
      filter: Record<string, unknown>,
      rows: Array<Record<string, unknown>>,
    ) => Record<string, unknown> | null
  } = {},
) {
  const rows = [...initialRows]
  function cursor(documents: Array<Record<string, unknown>>) {
    const value = {
      toArray: vi.fn(async () => documents),
      sort: vi.fn(),
      batchSize: vi.fn(),
      async *[Symbol.asyncIterator]() {
        for (const document of documents) yield document
      },
    }
    value.sort.mockReturnValue(value)
    value.batchSize.mockReturnValue(value)
    return value
  }
  const collection = {
    find: vi.fn((query: { objectKey?: { $in: string[] } }) => {
      if (query.objectKey?.$in) {
        return cursor(rows.filter((document) =>
          typeof document.objectKey === 'string' &&
          query.objectKey?.$in.includes(document.objectKey),
        ))
      }
      return cursor(rows)
    }),
    findOne: vi.fn(async (filter: Record<string, unknown>) => {
      if (options.findOne) return options.findOne(filter, rows)
      return rows.find((document) => matchesFilter(document, filter)) ?? null
    }),
  }
  const hasSentinelOverride = Object.prototype.hasOwnProperty.call(
    options,
    'sentinel',
  )
  const sentinel = hasSentinelOverride
    ? options.sentinel ?? null
    : productionSentinel()
  let sentinelRead = 0
  const sentinelCollection = {
    findOne: vi.fn(async () => {
      if (options.sentinelSequence) {
        const selected = options.sentinelSequence[
          Math.min(sentinelRead, options.sentinelSequence.length - 1)
        ]
        sentinelRead += 1
        return selected ?? null
      }
      return sentinel
    }),
    insertOne: vi.fn(),
    updateOne: vi.fn(),
    replaceOne: vi.fn(),
  }
  const replicaConfiguration = options.replicaConfiguration ?? {
    commitmentStatus: true,
    config: {
      _id: REPLICA_SET_NAME,
      settings: { replicaSetId: new ObjectId(REPLICA_SET_ID) },
    },
  }
  const adminCommand = vi.fn(async () => {
    if (options.adminCommandError) throw options.adminCommandError
    return replicaConfiguration
  })
  const database = {
    databaseName: options.databaseName ?? 'prod-hire-control',
    admin: vi.fn(() => ({
      command: adminCommand,
    })),
    collection: vi.fn((name: string) =>
      name === HIRE_MEDIA_V1_SENTINEL_COLLECTION
        ? sentinelCollection
        : collection,
    ),
  }
  const client = {
    options: options.mongoOptions ?? {
      hosts: ['db.invalid:27017'],
      replicaSet: REPLICA_SET_NAME,
      tls: true,
      directConnection: false,
      loadBalanced: false,
    },
    db: vi.fn(() => database),
    connect: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  }
  return {
    client,
    collection,
    sentinelCollection,
    adminCommand,
    rows,
  }
}

function notFound() {
  return Object.assign(new Error('sensitive-provider-error'), {
    name: 'NotFound',
    $metadata: { httpStatusCode: 404 },
  })
}

function baseEnvironment() {
  return {
    NODE_ENV: 'production',
    IPG_SURFACE: 'hire-control',
    HIRE_MEDIA_V1_EXPECTED_ENVIRONMENT: 'production',
    HIRE_MEDIA_V1_EXPECTED_SURFACE: 'hire-control',
    HIRE_CONTROL_DATABASE_NAME: 'prod-hire-control',
    HIRE_RUNTIME_DATABASE_NAME: 'prod-hire-runtime',
    B2C_DATABASE_NAME: 'prod-b2c',
    HIRE_MEDIA_V1_EXPECTED_DATABASE_NAME: 'prod-hire-control',
    MONGODB_URI:
      'mongodb://secret-user:secret-password@db.invalid:27017/prod-hire-control?replicaSet=prod-hire-rs&tls=true',
    R2_ACCOUNT_ID: 'secret-account-id',
    HIRE_MEDIA_V1_EXPECTED_R2_ACCOUNT_ID: 'secret-account-id',
    R2_ACCESS_KEY_ID: 'secret-access-key-id',
    R2_SECRET_ACCESS_KEY: 'secret-access-key',
    R2_BUCKET_NAME: 'secret-production-bucket',
    HIRE_MEDIA_V1_EXPECTED_BUCKET_NAME: 'secret-production-bucket',
  }
}

function destructiveEnvironment() {
  return {
    ...baseEnvironment(),
    HIRE_MEDIA_V1_DESTRUCTIVE_ACK,
    HIRE_MEDIA_V1_ENVIRONMENT_BINDING_ACK:
      'exact-production-control-bucket-and-database-pair-reviewed',
    HIRE_MEDIA_V1_FREEZE_ACK: 'hire-control-write-freeze-active',
    HIRE_MEDIA_V1_OLD_WORKERS_ACK:
      'zero-old-hire-media-writers-and-deleters',
    HIRE_MEDIA_V1_EXTERNAL_PRINCIPALS_ACK:
      'all-credentialed-r2-writer-and-cleanup-principals-inventoried-and-frozen',
    HIRE_MEDIA_V1_STAGING_ACK: 'zero-staging-asserted',
    HIRE_MEDIA_V1_PURGE_CLAIMED_ACK: 'zero-purge-claimed-asserted',
    HIRE_MEDIA_V1_LATE_WRITE_EVIDENCE_ACK:
      'provider-barrier-or-old-write-namespace-retirement-evidence-recorded',
    HIRE_MEDIA_V1_LATE_WRITE_SAFETY_MODE:
      'provider-enforced-write-barrier-completed',
    HIRE_MEDIA_V1_SENTINEL_TOKEN: 's'.repeat(40),
  }
}

function productionSentinel(
  environment: ReturnType<typeof destructiveEnvironment> = destructiveEnvironment(),
  mongoAuthority: {
    scheme: string
    authority: string
    srvServiceName: string
    replicaSetOption: string
    tls: string
    directConnection: string
    loadBalanced: string
  } = {
    scheme: 'mongodb',
    authority: 'db.invalid:27017',
    srvServiceName: 'mongodb',
    replicaSetOption: REPLICA_SET_NAME,
    tls: 'true',
    directConnection: 'false',
    loadBalanced: 'false',
  },
) {
  const r2Endpoint =
    `https://${environment.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`
  return {
    _id: HIRE_MEDIA_V1_SENTINEL_ID,
    environment: 'production',
    databaseName: environment.HIRE_MEDIA_V1_EXPECTED_DATABASE_NAME,
    schemaVersion: 1,
    immutable: true,
    replicaSetName: REPLICA_SET_NAME,
    replicaSetId: REPLICA_SET_ID,
    tokenSha256: hireMediaV1SentinelTokenSha256(
      environment.HIRE_MEDIA_V1_SENTINEL_TOKEN,
    ),
    bindingHmacSha256: hireMediaV1ProductionBindingHmacSha256({
      token: environment.HIRE_MEDIA_V1_SENTINEL_TOKEN,
      environment: 'production',
      surface: 'hire-control',
      databaseName: environment.HIRE_MEDIA_V1_EXPECTED_DATABASE_NAME,
      replicaSetName: REPLICA_SET_NAME,
      replicaSetId: REPLICA_SET_ID,
      mongoScheme: mongoAuthority.scheme,
      mongoAuthority: mongoAuthority.authority,
      mongoSrvServiceName: mongoAuthority.srvServiceName,
      mongoReplicaSetOption: mongoAuthority.replicaSetOption,
      mongoTls: mongoAuthority.tls,
      mongoDirectConnection: mongoAuthority.directConnection,
      mongoLoadBalanced: mongoAuthority.loadBalanced,
      r2Jurisdiction: 'default',
      r2Endpoint,
      r2AccountId: environment.R2_ACCOUNT_ID,
      r2Bucket: environment.R2_BUCKET_NAME,
      r2Prefix: 'hire-media/',
    }),
  }
}

function r2Factory(primary: { send: ReturnType<typeof vi.fn> }, observer?: {
  send: ReturnType<typeof vi.fn>
}) {
  return vi.fn((_configuration: unknown, role: string) => ({
    ...(role === 'absence-observer' ? observer ?? primary : primary),
    destroy: vi.fn(),
  }))
}

describe('legacy Hire media inventory', () => {
  it('fully paginates, excludes v2/conformance, and classifies only exact lowercase v1 keys', async () => {
    const liveKey = key(IDS.live)
    const purgedKey = key(IDS.purged, 'identity_photo')
    const orphanKey = key(IDS.orphan, 'facial_landmarks')
    const primary = {
      send: vi.fn(async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
        expect(command.constructor.name).toBe('ListObjectsV2Command')
        expect(command.input.Prefix).toBe('hire-media/')
        expect(command.input.MaxKeys).toBe(1000)
        if (!command.input.ContinuationToken) {
          return {
            IsTruncated: true,
            NextContinuationToken: 'opaque-page-2',
            Contents: [
              { Key: liveKey },
              { Key: purgedKey },
              { Key: `hire-media/v2/${'a'.repeat(64)}` },
              { Key: `hire-media/${IDS.workspace}/${IDS.application}/${IDS.round}/${IDS.attempt}/${IDS.orphan}-Camera-Recording.webm` },
              { Key: 'hire-media-conformance/v2/test/ignored' },
            ],
          }
        }
        expect(command.input.ContinuationToken).toBe('opaque-page-2')
        return {
          IsTruncated: false,
          Contents: [
            { Key: orphanKey },
            { Key: `hire-media/${IDS.workspace}/${IDS.application}/${IDS.round}/${IDS.attempt}/${IDS.orphan}-camera-recording.jpg` },
          ],
        }
      }),
    }
    const mongo = fakeMongo([
      row(IDS.live),
      row(IDS.purged, 'purged', 'identity_photo'),
    ])

    const result = await runHireMediaV1Reconciliation({
      environment: baseEnvironment(),
      createMongoClient: vi.fn(() => mongo.client) as never,
      createR2Client: r2Factory(primary) as never,
    })

    expect(result).toMatchObject({
      status: 'blocked-malformed',
      mode: 'read-only',
      initial: {
        pages: 2,
        objectsSeen: 7,
        matchedLive: 1,
        matchedPurged: 1,
        unmatchedCanonicalOrphan: 1,
        malformedOrUnrecognized: 2,
        productionV2Excluded: 1,
        conformanceExcluded: 1,
      },
      deletion: { attempted: 0, verifiedAbsent: 0 },
    })
    expect(primary.send).toHaveBeenCalledTimes(2)
  })

  it('globally blocks a same-key row that fails the complete exact join', async () => {
    const canonicalKey = key(IDS.orphan)
    const wrongCoordinateRow = row(IDS.orphan, 'ready', 'camera_recording', {
      applicationId: new ObjectId('999999999999999999999999'),
    })
    const primary = {
      send: vi.fn(async () => ({
        IsTruncated: false,
        Contents: [{ Key: canonicalKey }],
      })),
    }
    const mongo = fakeMongo([wrongCoordinateRow])

    await expect(runHireMediaV1Reconciliation({
      environment: baseEnvironment(),
      createMongoClient: vi.fn(() => mongo.client) as never,
      createR2Client: r2Factory(primary) as never,
    })).rejects.toMatchObject({ code: 'database_exact_join_mismatch' })

    const objectKeyLookup = mongo.collection.find.mock.calls.find(
      ([query]) => query.objectKey?.$in,
    )
    expect(objectKeyLookup?.[0]).toEqual({
      objectKey: { $in: [canonicalKey] },
    })
    expect(primary.send).toHaveBeenCalledOnce()
  })

  it('blocks a malformed or unrecognized Mongo media protocol row with no R2 object', async () => {
    const primary = {
      send: vi.fn(async () => ({ IsTruncated: false, Contents: [] })),
    }
    const mongo = fakeMongo([
      row(IDS.live, 'ready', 'camera_recording', {
        objectKey: 'unexpected-media-protocol',
      }),
    ])

    const result = await runHireMediaV1Reconciliation({
      environment: baseEnvironment(),
      createMongoClient: vi.fn(() => mongo.client) as never,
      createR2Client: r2Factory(primary) as never,
    })

    expect(result.status).toBe('blocked-malformed')
    expect(result.database.malformedOrUnrecognizedRows).toBe(1)
    expect(result.deletion.attempted).toBe(0)
  })

  it('fully validates coordinate, kind, and nonce invariants for v1 Mongo rows even when R2 is empty', async () => {
    const primary = {
      send: vi.fn(async () => ({ IsTruncated: false, Contents: [] })),
    }
    const mongo = fakeMongo([
      row(IDS.live, 'ready', 'camera_recording', {
        applicationId: new ObjectId('999999999999999999999999'),
      }),
      row(IDS.purged, 'ready', 'identity_photo', {
        objectKeyNonce: 'a'.repeat(64),
      }),
      row(IDS.changed, 'ready', 'camera_recording', {
        kind: 'screen_recording',
      }),
    ])

    const result = await runHireMediaV1Reconciliation({
      environment: baseEnvironment(),
      createMongoClient: vi.fn(() => mongo.client) as never,
      createR2Client: r2Factory(primary) as never,
    })

    expect(result.status).toBe('blocked-malformed')
    expect(result.database).toMatchObject({
      mongoV1Rows: 3,
      mongoV1InconsistentRows: 3,
      malformedOrUnrecognizedRows: 0,
    })
    const fullScan = mongo.collection.find.mock.calls.find(
      ([query]) => Object.keys(query).length === 0,
    )
    expect(fullScan?.[1]).toMatchObject({
      readConcern: { level: 'majority' },
      readPreference: 'primary',
    })
    expect(primary.send).toHaveBeenCalledOnce()
  })

  it('is read-only by default even when exact cleanup candidates exist', async () => {
    const primary = {
      send: vi.fn(async (command: { constructor: { name: string } }) => {
        expect(command.constructor.name).toBe('ListObjectsV2Command')
        return { IsTruncated: false, Contents: [{ Key: key(IDS.orphan) }] }
      }),
    }
    const mongo = fakeMongo([])

    const result = await runHireMediaV1Reconciliation({
      environment: baseEnvironment(),
      createMongoClient: vi.fn(() => mongo.client) as never,
      createR2Client: r2Factory(primary) as never,
    })

    expect(result.status).toBe('reconciliation-required')
    expect(result.deletion.attempted).toBe(0)
    expect(primary.send).toHaveBeenCalledOnce()
  })
})

describe('legacy Hire media destructive reconciliation', () => {
  it.each([
    ['absent', null],
    ['wrong environment', { ...productionSentinel(), environment: 'staging' }],
    ['wrong database', { ...productionSentinel(), databaseName: 'prod-b2c' }],
    ['wrong schema', { ...productionSentinel(), schemaVersion: 2 }],
    ['not immutable', { ...productionSentinel(), immutable: false }],
    ['wrong replica-set name', { ...productionSentinel(), replicaSetName: 'other-rs' }],
    ['wrong replica-set id', { ...productionSentinel(), replicaSetId: 'b'.repeat(24) }],
    ['wrong token digest', { ...productionSentinel(), tokenSha256: 'a'.repeat(64) }],
    ['wrong production binding', { ...productionSentinel(), bindingHmacSha256: 'b'.repeat(64) }],
  ])('refuses an %s production sentinel before any R2 operation', async (_label, sentinel) => {
    const primary = { send: vi.fn() }
    const mongo = fakeMongo([], { sentinel })

    await expect(runHireMediaV1Reconciliation({
      environment: destructiveEnvironment(),
      destructive: true,
      createMongoClient: vi.fn(() => mongo.client) as never,
      createR2Client: r2Factory(primary) as never,
    })).rejects.toMatchObject({ code: 'production_identity_sentinel_invalid' })

    expect(mongo.sentinelCollection.findOne).toHaveBeenCalledWith(
      { _id: HIRE_MEDIA_V1_SENTINEL_ID },
      expect.objectContaining({
        readConcern: { level: 'majority' },
        readPreference: 'primary',
      }),
    )
    expect(mongo.adminCommand).toHaveBeenCalledWith(
      { replSetGetConfig: 1, commitmentStatus: true },
      { readPreference: 'primary' },
    )
    expect(primary.send).not.toHaveBeenCalled()
    expect(mongo.collection.find).not.toHaveBeenCalled()
    expect(mongo.sentinelCollection.insertOne).not.toHaveBeenCalled()
    expect(mongo.sentinelCollection.updateOne).not.toHaveBeenCalled()
    expect(mongo.sentinelCollection.replaceOne).not.toHaveBeenCalled()
  })

  it.each([
    [
      'uncommitted replica-set configuration',
      {
        commitmentStatus: false,
        config: {
          _id: REPLICA_SET_NAME,
          settings: { replicaSetId: new ObjectId(REPLICA_SET_ID) },
        },
      },
    ],
    [
      'missing immutable replica-set id',
      {
        commitmentStatus: true,
        config: { _id: REPLICA_SET_NAME, settings: {} },
      },
    ],
    [
      'standalone topology',
      { ok: 1 },
    ],
  ])('refuses %s before reading the sentinel or R2', async (_label, replicaConfiguration) => {
    const primary = { send: vi.fn() }
    const mongo = fakeMongo([], { replicaConfiguration })

    await expect(runHireMediaV1Reconciliation({
      environment: destructiveEnvironment(),
      destructive: true,
      createMongoClient: vi.fn(() => mongo.client) as never,
      createR2Client: r2Factory(primary) as never,
    })).rejects.toMatchObject({
      code: 'production_replica_set_identity_invalid',
    })
    expect(mongo.sentinelCollection.findOne).not.toHaveBeenCalled()
    expect(primary.send).not.toHaveBeenCalled()
  })

  it('fails closed when the reconciliation role cannot read replica-set identity', async () => {
    const primary = { send: vi.fn() }
    const mongo = fakeMongo([], {
      adminCommandError: new Error('sensitive privilege failure'),
    })

    await expect(runHireMediaV1Reconciliation({
      environment: destructiveEnvironment(),
      destructive: true,
      createMongoClient: vi.fn(() => mongo.client) as never,
      createR2Client: r2Factory(primary) as never,
    })).rejects.toThrow('sensitive privilege failure')
    expect(mongo.sentinelCollection.findOne).not.toHaveBeenCalled()
    expect(primary.send).not.toHaveBeenCalled()
  })

  it('rejects a copied sentinel when the live replica-set id differs', async () => {
    const primary = { send: vi.fn() }
    const mongo = fakeMongo([], {
      sentinel: productionSentinel(),
      replicaConfiguration: {
        commitmentStatus: true,
        config: {
          _id: REPLICA_SET_NAME,
          settings: { replicaSetId: new ObjectId('c'.repeat(24)) },
        },
      },
    })

    await expect(runHireMediaV1Reconciliation({
      environment: destructiveEnvironment(),
      destructive: true,
      createMongoClient: vi.fn(() => mongo.client) as never,
      createR2Client: r2Factory(primary) as never,
    })).rejects.toMatchObject({ code: 'production_identity_sentinel_invalid' })
    expect(primary.send).not.toHaveBeenCalled()
  })

  it('rejects the same database, replica-set id, and sentinel on a different Mongo authority', async () => {
    const primary = { send: vi.fn() }
    const mongo = fakeMongo([], {
      sentinel: productionSentinel(),
      mongoOptions: {
        hosts: ['restored-db.invalid:27017'],
        replicaSet: REPLICA_SET_NAME,
        tls: true,
        directConnection: false,
        loadBalanced: false,
      },
    })

    await expect(runHireMediaV1Reconciliation({
      environment: destructiveEnvironment(),
      destructive: true,
      createMongoClient: vi.fn(() => mongo.client) as never,
      createR2Client: r2Factory(primary) as never,
    })).rejects.toMatchObject({ code: 'production_identity_sentinel_invalid' })
    expect(primary.send).not.toHaveBeenCalled()
  })

  it('rejects the same SRV seed when its DNS service name differs', async () => {
    const primary = { send: vi.fn() }
    const authorizedSrvAuthority = {
      scheme: 'mongodb+srv',
      authority: 'cluster.example',
      srvServiceName: 'mongodb',
      replicaSetOption: '',
      tls: 'true',
      directConnection: 'false',
      loadBalanced: 'false',
    }
    const mongo = fakeMongo([], {
      sentinel: productionSentinel(
        destructiveEnvironment(),
        authorizedSrvAuthority,
      ),
      mongoOptions: {
        hosts: [],
        srvHost: 'CLUSTER.EXAMPLE',
        srvServiceName: 'custom-mongodb',
        tls: true,
        directConnection: false,
        loadBalanced: false,
      },
    })

    await expect(runHireMediaV1Reconciliation({
      environment: destructiveEnvironment(),
      destructive: true,
      createMongoClient: vi.fn(() => mongo.client) as never,
      createR2Client: r2Factory(primary) as never,
    })).rejects.toMatchObject({ code: 'production_identity_sentinel_invalid' })
    expect(primary.send).not.toHaveBeenCalled()
  })

  it('requires a sentinel secret containing at least 32 bytes', async () => {
    const primary = { send: vi.fn() }
    const mongo = fakeMongo([])
    const environment = {
      ...destructiveEnvironment(),
      HIRE_MEDIA_V1_SENTINEL_TOKEN: 'too-short',
    }

    await expect(runHireMediaV1Reconciliation({
      environment,
      destructive: true,
      createMongoClient: vi.fn(() => mongo.client) as never,
      createR2Client: r2Factory(primary) as never,
    })).rejects.toMatchObject({
      code: 'production_identity_sentinel_token_too_short',
    })
    expect(mongo.client.connect).not.toHaveBeenCalled()
    expect(primary.send).not.toHaveBeenCalled()
  })

  it.each(['staging', 'purge_claimed'])(
    'blocks before deletion while any %s row exists',
    async (state) => {
      const primary = {
        send: vi.fn(async (command: { constructor: { name: string } }) => {
          expect(command.constructor.name).toBe('ListObjectsV2Command')
          return { IsTruncated: false, Contents: [{ Key: key(IDS.orphan) }] }
        }),
      }
      const mongo = fakeMongo([row(IDS.live, state)])

      const result = await runHireMediaV1Reconciliation({
        environment: destructiveEnvironment(),
        destructive: true,
        createMongoClient: vi.fn(() => mongo.client) as never,
        createR2Client: r2Factory(primary) as never,
      })

      expect(result.status).toBe('blocked-active-database-work')
      expect(result.deletion.attempted).toBe(0)
      expect(primary.send).toHaveBeenCalledOnce()
    },
  )

  it('blocks every deletion when any scanned key is malformed', async () => {
    const primary = {
      send: vi.fn(async (command: { constructor: { name: string } }) => {
        expect(command.constructor.name).toBe('ListObjectsV2Command')
        return {
          IsTruncated: false,
          Contents: [
            { Key: key(IDS.orphan) },
            { Key: `${key(IDS.changed)}.unexpected` },
          ],
        }
      }),
    }
    const mongo = fakeMongo([])

    const result = await runHireMediaV1Reconciliation({
      environment: destructiveEnvironment(),
      destructive: true,
      createMongoClient: vi.fn(() => mongo.client) as never,
      createR2Client: r2Factory(primary) as never,
    })

    expect(result.status).toBe('blocked-malformed')
    expect(result.deletion.attempted).toBe(0)
    expect(primary.send).toHaveBeenCalledOnce()
  })

  it('refuses deletion when exact database ownership changes after inventory', async () => {
    const changedKey = key(IDS.changed)
    const changedRow = row(IDS.changed)
    const primary = {
      send: vi.fn(async (command: { constructor: { name: string } }) => {
        if (command.constructor.name === 'ListObjectsV2Command') {
          return { IsTruncated: false, Contents: [{ Key: changedKey }] }
        }
        throw new Error('DeleteObject must not be issued')
      }),
    }
    let exactRevalidation = false
    const mongo = fakeMongo([], {
      findOne: () => {
        exactRevalidation = true
        return changedRow
      },
    })

    await expect(runHireMediaV1Reconciliation({
      environment: destructiveEnvironment(),
      destructive: true,
      createMongoClient: vi.fn(() => mongo.client) as never,
      createR2Client: r2Factory(primary) as never,
    })).rejects.toMatchObject({ code: 'delete_ownership_changed' })

    expect(exactRevalidation).toBe(true)
    expect(primary.send).toHaveBeenCalledOnce()
  })

  it('reverifies the production binding after inventory and aborts before the first delete', async () => {
    const orphanKey = key(IDS.orphan)
    const primary = {
      send: vi.fn(async (command: { constructor: { name: string } }) => {
        expect(command.constructor.name).toBe('ListObjectsV2Command')
        return { IsTruncated: false, Contents: [{ Key: orphanKey }] }
      }),
    }
    const mongo = fakeMongo([], {
      sentinelSequence: [
        productionSentinel(),
        { ...productionSentinel(), bindingHmacSha256: 'd'.repeat(64) },
      ],
    })

    await expect(runHireMediaV1Reconciliation({
      environment: destructiveEnvironment(),
      destructive: true,
      createMongoClient: vi.fn(() => mongo.client) as never,
      createR2Client: r2Factory(primary) as never,
    })).rejects.toMatchObject({ code: 'production_identity_sentinel_invalid' })

    expect(mongo.adminCommand).toHaveBeenCalledTimes(2)
    expect(mongo.sentinelCollection.findOne).toHaveBeenCalledTimes(2)
    expect(primary.send).toHaveBeenCalledOnce()
  })

  it('refuses destructive mode without an exact bucket/database binding and hard late-write assertion', async () => {
    const mongo = fakeMongo([])
    const primary = { send: vi.fn() }
    const mismatched = {
      ...destructiveEnvironment(),
      HIRE_MEDIA_V1_EXPECTED_BUCKET_NAME: 'different-bucket',
      HIRE_MEDIA_V1_LATE_WRITE_SAFETY_MODE: '',
    }

    await expect(runHireMediaV1Reconciliation({
      environment: mismatched,
      destructive: true,
      createMongoClient: vi.fn(() => mongo.client) as never,
      createR2Client: r2Factory(primary) as never,
    })).rejects.toMatchObject({ code: 'environment_identity_mismatch' })
    expect(primary.send).not.toHaveBeenCalled()
    expect(mongo.client.connect).not.toHaveBeenCalled()
  })

  it('refuses a repeated surface database or a mismatched R2 account before scanning', async () => {
    const mongo = fakeMongo([])
    const primary = { send: vi.fn() }
    const repeatedDatabase = {
      ...destructiveEnvironment(),
      HIRE_RUNTIME_DATABASE_NAME: 'prod-hire-control',
    }
    await expect(runHireMediaV1Reconciliation({
      environment: repeatedDatabase,
      destructive: true,
      createMongoClient: vi.fn(() => mongo.client) as never,
      createR2Client: r2Factory(primary) as never,
    })).rejects.toMatchObject({ code: 'environment_identity_mismatch' })

    const mismatchedAccount = {
      ...destructiveEnvironment(),
      HIRE_MEDIA_V1_EXPECTED_R2_ACCOUNT_ID: 'different-account',
    }
    await expect(runHireMediaV1Reconciliation({
      environment: mismatchedAccount,
      destructive: true,
      createMongoClient: vi.fn(() => mongo.client) as never,
      createR2Client: r2Factory(primary) as never,
    })).rejects.toMatchObject({ code: 'environment_identity_mismatch' })
    expect(primary.send).not.toHaveBeenCalled()
    expect(mongo.client.connect).not.toHaveBeenCalled()
  })

  it('deletes exact orphan/purged v1 keys one-by-one, verifies absence, and fully rescans', async () => {
    const purgedKey = key(IDS.purged, 'identity_photo')
    const orphanKey = key(IDS.orphan, 'facial_landmarks')
    const liveKey = key(IDS.live)
    const deleted: string[] = []
    const primary = {
      send: vi.fn(async (command: { constructor: { name: string }; input: { Key?: string } }) => {
        if (command.constructor.name === 'ListObjectsV2Command') {
          return {
            IsTruncated: false,
            Contents: [{ Key: purgedKey }, { Key: orphanKey }],
          }
        }
        expect(command.constructor.name).toBe('DeleteObjectCommand')
        deleted.push(command.input.Key as string)
        return {}
      }),
    }
    const observer = {
      send: vi.fn(async (command: { constructor: { name: string } }) => {
        if (command.constructor.name === 'HeadObjectCommand') throw notFound()
        expect(command.constructor.name).toBe('ListObjectsV2Command')
        return { IsTruncated: false, Contents: [{ Key: liveKey }] }
      }),
    }
    const mongo = fakeMongo([
      row(IDS.purged, 'purged', 'identity_photo'),
      row(IDS.live),
    ])

    const result = await runHireMediaV1Reconciliation({
      environment: destructiveEnvironment(),
      destructive: true,
      createMongoClient: vi.fn(() => mongo.client) as never,
      createR2Client: r2Factory(primary, observer) as never,
    })

    expect(deleted).toEqual([purgedKey, orphanKey])
    expect(result).toMatchObject({
      status: 'destructive-reconciled-observation',
      mode: 'destructive',
      initial: {
        matchedPurged: 1,
        unmatchedCanonicalOrphan: 1,
      },
      postDelete: {
        pages: 1,
        matchedLive: 1,
        matchedPurged: 0,
        unmatchedCanonicalOrphan: 0,
        malformedOrUnrecognized: 0,
        productionV2Excluded: 0,
      },
      deletion: { attempted: 2, verifiedAbsent: 2 },
      lateWriteSafetyOperatorAssertion: true,
    })
    expect(observer.send).toHaveBeenCalledTimes(3)
    expect(mongo.sentinelCollection.findOne).toHaveBeenCalledTimes(2)
    expect(mongo.adminCommand).toHaveBeenCalledTimes(2)
    expect(mongo.sentinelCollection.insertOne).not.toHaveBeenCalled()
    expect(mongo.sentinelCollection.updateOne).not.toHaveBeenCalled()
    expect(mongo.sentinelCollection.replaceOne).not.toHaveBeenCalled()
    const serializedResult = JSON.stringify(result)
    for (const sensitive of [
      IDS.workspace,
      IDS.application,
      IDS.round,
      IDS.attempt,
      IDS.live,
      IDS.purged,
      IDS.orphan,
    ]) {
      expect(serializedResult).not.toContain(sensitive)
    }
  })
})

describe('legacy Hire media output redaction', () => {
  it('prints only aggregate status when an unexpected provider error contains secrets', async () => {
    const secretKey = key(IDS.orphan)
    const environment = baseEnvironment()
    const leakedError = new Error([
      secretKey,
      environment.MONGODB_URI,
      environment.R2_ACCOUNT_ID,
      environment.R2_ACCESS_KEY_ID,
      environment.R2_SECRET_ACCESS_KEY,
      environment.R2_BUCKET_NAME,
    ].join(' '))
    const primary = { send: vi.fn(async () => { throw leakedError }) }
    const mongo = fakeMongo([])
    const stdout: string[] = []
    const stderr: string[] = []

    const exitCode = await executeHireMediaV1ReconciliationCli({
      argv: [],
      environment,
      stdout: (message: string) => stdout.push(message),
      stderr: (message: string) => stderr.push(message),
      dependencies: {
        createMongoClient: vi.fn(() => mongo.client) as never,
        createR2Client: r2Factory(primary) as never,
      },
    })

    expect(exitCode).toBe(1)
    expect(stdout).toEqual([])
    expect(stderr).toEqual([
      '[fail] Hire media v1 reconciliation failed (unexpected_error).',
    ])
    const output = stderr.join('\n')
    for (const sensitive of [
      secretKey,
      environment.MONGODB_URI,
      environment.R2_ACCOUNT_ID,
      environment.R2_ACCESS_KEY_ID,
      environment.R2_SECRET_ACCESS_KEY,
      environment.R2_BUCKET_NAME,
      IDS.orphan,
    ]) {
      expect(output).not.toContain(sensitive)
    }
  })
})
