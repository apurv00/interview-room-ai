import { ObjectId } from 'mongodb'
import { describe, expect, it, vi } from 'vitest'
import {
  assertExactHireCandidateBulkOperationInventoryIndexes,
  HIRE_CANDIDATE_BULK_INVENTORY_SENTINEL_COLLECTION,
  HIRE_CANDIDATE_BULK_INVENTORY_SENTINEL_ID,
  hireCandidateBulkInventoryBindingHmacSha256,
  hireCandidateBulkInventoryConfiguration,
  hireCandidateBulkInventorySentinelTokenSha256,
  inventoryHireCandidateBulkOperations,
  summarizeHireCandidateBulkOperationInventory,
  type HireCandidateBulkInventoryDependencies,
} from '../inventory-hire-candidate-bulk-operations'
import {
  HIRE_CANDIDATE_BULK_OPERATION_IDEMPOTENCY_INDEX,
  HIRE_CANDIDATE_BULK_OPERATION_JOB_HISTORY_INDEX,
  HIRE_CANDIDATE_BULK_OPERATION_RECOVERY_INDEX,
  HIRE_CANDIDATE_BULK_OPERATION_TTL_INDEX,
} from '../../modules/hire-candidate-actions/models/HireCandidateBulkOperation'

const exactIndexes = [
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
]

const sentinelToken = 'candidate-bulk-inventory-sentinel-token-32-bytes'
const bulkOperationCollectionUuid = 'c'.repeat(32)
const productionEnvironment = {
  NODE_ENV: 'production',
  IPG_SURFACE: 'hire-control',
  HIRE_CONTROL_DATABASE_NAME: 'hire-control',
  HIRE_RUNTIME_DATABASE_NAME: 'hire-runtime',
  B2C_DATABASE_NAME: 'b2c',
  HIRE_CANDIDATE_BULK_INVENTORY_EXPECTED_ENVIRONMENT: 'production',
  HIRE_CANDIDATE_BULK_INVENTORY_EXPECTED_DATABASE_NAME: 'hire-control',
  HIRE_CANDIDATE_BULK_INVENTORY_SENTINEL_TOKEN: sentinelToken,
}

const mongoAuthority = {
  scheme: 'mongodb' as const,
  authority: 'db-a:27017,db-b:27017',
  srvServiceName: 'mongodb',
  replicaSetOption: 'rs0',
  tls: 'false' as const,
  directConnection: 'false' as const,
  loadBalanced: 'false' as const,
}

describe('Hire candidate bulk-operation inventory', () => {
  it('requires every exact durable-ledger index', () => {
    expect(() =>
      assertExactHireCandidateBulkOperationInventoryIndexes(exactIndexes),
    ).not.toThrow()
    expect(() =>
      assertExactHireCandidateBulkOperationInventoryIndexes(
        exactIndexes.map((index) =>
          index.name === HIRE_CANDIDATE_BULK_OPERATION_IDEMPOTENCY_INDEX
            ? { ...index, name: 'wrong-idempotency-name' }
            : index,
        ),
      ),
    ).toThrow(HIRE_CANDIDATE_BULK_OPERATION_IDEMPOTENCY_INDEX)
    expect(() =>
      assertExactHireCandidateBulkOperationInventoryIndexes(
        exactIndexes.map((index) =>
          index.name === HIRE_CANDIDATE_BULK_OPERATION_TTL_INDEX
            ? { ...index, expireAfterSeconds: 1 }
            : index,
        ),
      ),
    ).toThrow(HIRE_CANDIDATE_BULK_OPERATION_TTL_INDEX)
    expect(() =>
      assertExactHireCandidateBulkOperationInventoryIndexes([
        ...exactIndexes,
        {
          name: 'duplicate-idempotency-key',
          key: { workspaceId: 1, requestedByMemberId: 1, clientOperationId: 1 },
        },
      ]),
    ).toThrow(HIRE_CANDIDATE_BULK_OPERATION_IDEMPOTENCY_INDEX)
    expect(() =>
      assertExactHireCandidateBulkOperationInventoryIndexes(
        exactIndexes.map((index) =>
          index.name === HIRE_CANDIDATE_BULK_OPERATION_RECOVERY_INDEX
            ? { ...index, collation: { locale: 'en' } }
            : index,
        ),
      ),
    ).toThrow(HIRE_CANDIDATE_BULK_OPERATION_RECOVERY_INDEX)
  })

  it('requires an exact production surface and independently stored sentinel token', () => {
    expect(hireCandidateBulkInventoryConfiguration(productionEnvironment)).toEqual({
      environment: 'production',
      surface: 'hire-control',
      expectedDatabaseName: 'hire-control',
      sentinelToken,
    })
    expect(() =>
      hireCandidateBulkInventoryConfiguration({
        ...productionEnvironment,
        NODE_ENV: 'staging',
      }),
    ).toThrow('production identity is not configured')
    expect(() =>
      hireCandidateBulkInventoryConfiguration({
        ...productionEnvironment,
        HIRE_CANDIDATE_BULK_INVENTORY_SENTINEL_TOKEN: 'too-short',
      }),
    ).toThrow('production identity is not configured')
  })

  it('binds the sentinel HMAC to live replica and normalized connection identity', () => {
    const base = hireCandidateBulkInventoryBindingHmacSha256({
      sentinelToken,
      environment: 'production',
      surface: 'hire-control',
      databaseName: 'hire-control',
      replicaSetName: 'rs0',
      replicaSetId: 'aaaaaaaaaaaaaaaaaaaaaaaa',
      bulkOperationCollectionUuid,
      mongoAuthority,
    })
    expect(base).toMatch(/^[a-f0-9]{64}$/)
    expect(hireCandidateBulkInventorySentinelTokenSha256(sentinelToken)).toMatch(
      /^[a-f0-9]{64}$/,
    )
    expect(
      hireCandidateBulkInventoryBindingHmacSha256({
        sentinelToken,
        environment: 'production',
        surface: 'hire-control',
        databaseName: 'hire-control',
        replicaSetName: 'rs0',
        replicaSetId: 'bbbbbbbbbbbbbbbbbbbbbbbb',
        bulkOperationCollectionUuid,
        mongoAuthority,
      }),
    ).not.toBe(base)
    expect(
      hireCandidateBulkInventoryBindingHmacSha256({
        sentinelToken,
        environment: 'production',
        surface: 'hire-control',
        databaseName: 'hire-control',
        replicaSetName: 'rs0',
        replicaSetId: 'aaaaaaaaaaaaaaaaaaaaaaaa',
        bulkOperationCollectionUuid,
        mongoAuthority: { ...mongoAuthority, authority: 'replacement:27017' },
      }),
    ).not.toBe(base)
    expect(
      hireCandidateBulkInventoryBindingHmacSha256({
        sentinelToken,
        environment: 'production',
        surface: 'hire-control',
        databaseName: 'hire-control',
        replicaSetName: 'rs0',
        replicaSetId: 'aaaaaaaaaaaaaaaaaaaaaaaa',
        bulkOperationCollectionUuid: 'd'.repeat(32),
        mongoAuthority,
      }),
    ).not.toBe(base)
  })

  it('enumerates retained rows while emitting only unresolved opaque coordinates', () => {
    const completedId = new ObjectId('100000000000000000000001')
    const queuedId = new ObjectId('100000000000000000000002')
    const summary = summarizeHireCandidateBulkOperationInventory(
      [
        {
          _id: completedId,
          status: 'completed',
          dispatchStatus: 'dispatched',
          totalCount: 2,
          queuedCount: 0,
          processingCount: 0,
          succeededCount: 2,
          conflictCount: 0,
          failedCount: 0,
          workspaceId: 'must-not-serialize',
          requestedByName: 'must-not-serialize',
          selectionDescription: 'must-not-serialize',
        },
        {
          _id: queuedId,
          status: 'queued',
          dispatchStatus: 'pending',
          totalCount: 3,
          queuedCount: 3,
          processingCount: 0,
          succeededCount: 0,
          conflictCount: 0,
          failedCount: 0,
          candidateIds: ['must-not-serialize'],
        },
      ],
      2,
    )

    expect(summary).toMatchObject({
      retainedOperationCount: 2,
      unresolvedOperationCount: 1,
      completenessInvariant: {
        expectedRetainedOperationCount: 2,
        enumeratedRetainedOperationCount: 2,
        exact: true,
      },
      rollbackDisposition: 'FIX_FORWARD_REQUIRED',
      unresolvedOperations: [
        {
          operationId: queuedId.toHexString(),
          status: 'queued',
          totalCount: 3,
          queuedCount: 3,
        },
      ],
    })
    const serialized = JSON.stringify(summary)
    expect(serialized).not.toContain('must-not-serialize')
    expect(serialized).not.toContain(completedId.toHexString())
  })

  it('fails closed on malformed counters or incomplete enumeration', () => {
    const row = {
      _id: new ObjectId('200000000000000000000001'),
      status: 'processing',
      dispatchStatus: 'dispatched',
      totalCount: 2,
      queuedCount: 1,
      processingCount: 0,
      succeededCount: 0,
      conflictCount: 0,
      failedCount: 0,
    }
    expect(() =>
      summarizeHireCandidateBulkOperationInventory([row], 1),
    ).toThrow('malformed counters')
    expect(() =>
      summarizeHireCandidateBulkOperationInventory(
        [{ ...row, succeededCount: 1 }],
        2,
      ),
    ).toThrow('completeness invariant')
  })

  it.each([
    {
      status: 'completed',
      succeededCount: 0,
      conflictCount: 0,
      failedCount: 2,
    },
    {
      status: 'failed',
      succeededCount: 1,
      conflictCount: 1,
      failedCount: 0,
    },
    {
      status: 'partial',
      succeededCount: 2,
      conflictCount: 0,
      failedCount: 0,
    },
  ])('rejects malformed $status terminal semantics', (terminal) => {
    expect(() =>
      summarizeHireCandidateBulkOperationInventory(
        [
          {
            _id: new ObjectId('300000000000000000000001'),
            dispatchStatus: 'dispatched',
            totalCount: 2,
            queuedCount: 0,
            processingCount: 0,
            ...terminal,
          },
        ],
        1,
      ),
    ).toThrow('malformed status counters')
  })

  it('keeps a zero retained result conditional on external baseline evidence', () => {
    expect(summarizeHireCandidateBulkOperationInventory([], 0)).toEqual({
      retainedOperationCount: 0,
      unresolvedOperationCount: 0,
      completenessInvariant: {
        expectedRetainedOperationCount: 0,
        enumeratedRetainedOperationCount: 0,
        exact: true,
      },
      rollbackDisposition:
        'ROLLBACK_ELIGIBILITY_REQUIRES_RETAINED_ZERO_BASELINE',
      unresolvedOperations: [],
    })
  })

  it('verifies identity before and after a projected primary snapshot without writes', async () => {
    const replicaSetId = new ObjectId('aaaaaaaaaaaaaaaaaaaaaaaa')
    const operationId = new ObjectId('400000000000000000000001')
    const bindingHmacSha256 = hireCandidateBulkInventoryBindingHmacSha256({
      sentinelToken,
      environment: 'production',
      surface: 'hire-control',
      databaseName: 'hire-control',
      replicaSetName: 'rs0',
      replicaSetId: replicaSetId.toHexString(),
      bulkOperationCollectionUuid,
      mongoAuthority,
    })
    const sentinel = {
      _id: HIRE_CANDIDATE_BULK_INVENTORY_SENTINEL_ID,
      environment: 'production',
      surface: 'hire-control',
      databaseName: 'hire-control',
      schemaVersion: 1,
      immutable: true,
      replicaSetName: 'rs0',
      replicaSetId: replicaSetId.toHexString(),
      bulkOperationCollectionUuid,
      tokenSha256: hireCandidateBulkInventorySentinelTokenSha256(sentinelToken),
      bindingHmacSha256,
    }
    const adminCommand = vi.fn().mockResolvedValue({
      commitmentStatus: true,
      config: { _id: 'rs0', settings: { replicaSetId } },
    })
    const sentinelFindOne = vi.fn().mockResolvedValue(sentinel)
    async function* projectedRows() {
      yield {
        _id: operationId,
        status: 'completed',
        dispatchStatus: 'dispatched',
        totalCount: 1,
        queuedCount: 0,
        processingCount: 0,
        succeededCount: 1,
        conflictCount: 0,
        failedCount: 0,
      }
    }
    const countDocuments = vi.fn().mockResolvedValue(1)
    const find = vi.fn(() => projectedRows())
    const indexes = vi.fn().mockResolvedValue(exactIndexes)
    const operationCollection = { countDocuments, find, indexes }
    const sentinelCollection = { findOne: sentinelFindOne }
    let inTransaction = false
    const startTransaction = vi.fn(() => {
      inTransaction = true
    })
    const abortTransaction = vi.fn(async () => {
      inTransaction = false
    })
    const commitTransaction = vi.fn(async () => {
      inTransaction = false
    })
    const endSession = vi.fn()
    const session = {
      startTransaction,
      abortTransaction,
      commitTransaction,
      inTransaction: () => inTransaction,
      endSession,
    }
    const startSession = vi.fn(() => session)
    const mongoClient = {
      options: {
        hosts: ['db-b:27017', 'db-a:27017'],
        replicaSet: 'rs0',
        srvServiceName: 'mongodb',
        tls: false,
        directConnection: false,
        loadBalanced: false,
      },
      startSession,
    }
    const listCollections = vi.fn(() => ({
      toArray: vi.fn().mockResolvedValue([
        {
          name: 'hirecandidatebulkoperations',
          type: 'collection',
          info: { uuid: bulkOperationCollectionUuid },
        },
      ]),
    }))
    const collection = vi.fn((name: string) =>
      name === HIRE_CANDIDATE_BULK_INVENTORY_SENTINEL_COLLECTION
        ? sentinelCollection
        : operationCollection,
    )
    const database = {
      admin: () => ({ command: adminCommand }),
      listCollections,
      collection,
    }
    const connect = vi.fn().mockResolvedValue({
      connection: {
        name: 'hire-control',
        db: database,
        getClient: () => mongoClient,
      },
    })

    const report = await inventoryHireCandidateBulkOperations({
      environment: productionEnvironment,
      connect:
        connect as unknown as NonNullable<
          HireCandidateBulkInventoryDependencies['connect']
        >,
      now: () => new Date('2026-08-27T10:00:00.000Z'),
    })

    expect(connect).toHaveBeenCalledWith({ schemaInitialization: 'disabled' })
    expect(adminCommand).toHaveBeenCalledTimes(2)
    expect(sentinelFindOne).toHaveBeenCalledTimes(2)
    expect(sentinelFindOne).toHaveBeenCalledWith(
      { _id: HIRE_CANDIDATE_BULK_INVENTORY_SENTINEL_ID },
      expect.objectContaining({
        readConcern: { level: 'majority' },
        readPreference: 'primary',
      }),
    )
    expect(startTransaction).toHaveBeenCalledWith({
      readConcern: { level: 'snapshot' },
      readPreference: 'primary',
      writeConcern: { w: 'majority' },
    })
    expect(countDocuments).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ session }),
    )
    expect(find).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        projection: {
          _id: 1,
          status: 1,
          dispatchStatus: 1,
          totalCount: 1,
          queuedCount: 1,
          processingCount: 1,
          succeededCount: 1,
          conflictCount: 1,
          failedCount: 1,
        },
        sort: { _id: 1 },
        session,
      }),
    )
    expect(commitTransaction).toHaveBeenCalledTimes(1)
    expect(abortTransaction).not.toHaveBeenCalled()
    expect(endSession).toHaveBeenCalledTimes(1)
    expect(listCollections).toHaveBeenCalledTimes(2)
    expect(indexes).toHaveBeenCalledTimes(2)
    expect(adminCommand.mock.invocationCallOrder[0]).toBeLessThan(
      countDocuments.mock.invocationCallOrder[0],
    )
    expect(commitTransaction.mock.invocationCallOrder[0]).toBeLessThan(
      adminCommand.mock.invocationCallOrder[1],
    )
    expect(report).toMatchObject({
      targetIdentityVerified: true,
      snapshotCommitWriteConcern: 'majority',
      retainedOperationCount: 1,
      unresolvedOperationCount: 0,
      rollbackDisposition: 'FIX_FORWARD_REQUIRED',
      generatedAt: '2026-08-27T10:00:00.000Z',
    })
    const serialized = JSON.stringify(report)
    expect(serialized).not.toContain(sentinelToken)
    expect(serialized).not.toContain('hire-control')
  })
})
