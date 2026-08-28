import { randomUUID } from 'node:crypto'
import mongoose from 'mongoose'
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'

const mocks = vi.hoisted(() => ({
  send: vi.fn(),
}))

// Inngest is the only external side effect in this gate. Mongo models,
// transactions, leases, privacy fences, and stage moves all stay real.
vi.mock('@shared/services/inngest', () => ({
  inngest: { send: mocks.send },
}))

import { HireApplication } from '../../hire/models/HireApplication'
import { HireCandidate } from '../../hire/models/HireCandidate'
import { HireJob } from '../../hire/models/HireJob'
import { HirePrivacyRequest } from '../../hire/models/HirePrivacyRequest'
import { HireWorkspace } from '../../hire/models/HireWorkspace'
import { HireWorkspaceMember } from '../../hire/models/HireWorkspaceMember'
import { connectHireControlDB } from '../../hire/services/hireControlBoundary'
import { moveStage } from '../../hire/services/pipelineService'
import type { MembershipContext } from '../../hire/services/workspaceService'
import {
  HireCandidateBulkOperation,
  HireCandidateBulkOperationItem,
} from '../models'
import {
  HIRE_CANDIDATE_BULK_MAX_ATTEMPTS,
  createHireCandidateBulkOperation,
  processHireCandidateBulkOperation,
  type ReadCandidateSelectionSnapshot,
} from '../services/bulkOperationService'

const enabled = process.env.HIRE_CANDIDATE_BULK_REPLICA_SET_TEST === '1'
const uri = process.env.HIRE_CANDIDATE_BULK_REPLICA_SET_TEST_URI
const database = process.env.HIRE_CANDIDATE_BULK_REPLICA_SET_TEST_DATABASE

function databaseName(mongoUri: string | undefined): string | null {
  const match = mongoUri?.match(
    /^mongodb(?:\+srv)?:\/\/[^/]+\/([^/?#]+)(?:[?#]|$)/i,
  )
  if (!match) return null
  try {
    return decodeURIComponent(match[1])
  } catch {
    return null
  }
}

if (
  enabled &&
  (!uri ||
    !database ||
    !database.endsWith('_test') ||
    databaseName(uri) !== database)
) {
  throw new Error(
    'HIRE_CANDIDATE_BULK_REPLICA_SET_TEST_URI must name HIRE_CANDIDATE_BULK_REPLICA_SET_TEST_DATABASE, and that isolated database must end in _test',
  )
}

const replicaSuite = describe.skipIf(!enabled)
const CREATED_AT = new Date('2026-08-25T08:00:00.000Z')
const VALID_APPLICATION_COUNT = 11

const ids = {
  workspaceId: new mongoose.Types.ObjectId(),
  memberId: new mongoose.Types.ObjectId(),
  creatorId: new mongoose.Types.ObjectId(),
  departmentId: new mongoose.Types.ObjectId(),
  jobId: new mongoose.Types.ObjectId(),
  selectionId: new mongoose.Types.ObjectId(),
  rollbackSelectionId: new mongoose.Types.ObjectId(),
  rollbackCandidateId: new mongoose.Types.ObjectId(),
  rollbackApplicationId: new mongoose.Types.ObjectId(),
}

const validRows = Array.from({ length: VALID_APPLICATION_COUNT }, (_, index) => ({
  candidateId: new mongoose.Types.ObjectId(),
  applicationId: new mongoose.Types.ObjectId(),
  email: `candidate-bulk-replica-${index}@example.test`,
}))

async function seedWorkspace(): Promise<void> {
  await Promise.all([
    HireCandidateBulkOperationItem.deleteMany({}),
    HireCandidateBulkOperation.deleteMany({}),
    HirePrivacyRequest.deleteMany({}),
    HireApplication.deleteMany({}),
    HireCandidate.deleteMany({}),
    HireJob.deleteMany({}),
    HireWorkspaceMember.deleteMany({}),
    HireWorkspace.deleteMany({}),
  ])

  await HireWorkspace.create({
    _id: ids.workspaceId,
    name: 'Candidate bulk replica acceptance',
    guestAuthMode: 'magic_link',
    lifecycleState: 'active',
    authorityVersion: 1,
    writeFenceVersion: 0,
    privacyAggregateFenceVersion: 0,
    lifecycleEvents: [],
    adminTransferEvents: [],
    createdBy: ids.creatorId,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  })
  await HireWorkspaceMember.create({
    _id: ids.memberId,
    workspaceId: ids.workspaceId,
    email: 'ada.bulk-replica@example.test',
    normalizedEmail: 'ada.bulk-replica@example.test',
    name: 'Ada Bulk Recruiter',
    role: 'admin',
    authState: 'active',
    sessionVersion: 1,
    workspaceWriteFenceVersion: 0,
    digestEgressFenceVersion: 0,
    addedByName: 'System',
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  })
  await HireJob.create({
    _id: ids.jobId,
    workspaceId: ids.workspaceId,
    departmentId: ids.departmentId,
    title: 'Replica-set platform engineer',
    jdText: 'Build reliable multi-tenant hiring systems.',
    status: 'open',
    intakeWriteVersion: 0,
    candidateReadVersion: 0,
    applyPageEnabled: false,
    events: [],
    createdByMemberId: ids.memberId,
    createdByName: 'Ada Bulk Recruiter',
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  })
  await HireCandidate.insertMany([
    ...validRows.map((row, index) => ({
      _id: row.candidateId,
      workspaceId: ids.workspaceId,
      name: `Replica candidate ${index}`,
      email: row.email,
      source: 'manual' as const,
      sourceHistory: ['manual'] as const,
      privacyWriteFenceVersion: 0,
      createdByMemberId: ids.memberId,
      createdByName: 'Ada Bulk Recruiter',
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    })),
    {
      _id: ids.rollbackCandidateId,
      workspaceId: ids.workspaceId,
      name: 'Corrupted-stage rollback candidate',
      email: 'candidate-bulk-rollback@example.test',
      source: 'manual' as const,
      sourceHistory: ['manual'] as const,
      privacyWriteFenceVersion: 0,
      createdByMemberId: ids.memberId,
      createdByName: 'Ada Bulk Recruiter',
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    },
  ])
  await HireApplication.insertMany(
    validRows.map((row) => ({
      _id: row.applicationId,
      workspaceId: ids.workspaceId,
      jobId: ids.jobId,
      candidateId: row.candidateId,
      stage: 'new' as const,
      events: [],
      createdByMemberId: ids.memberId,
      createdByName: 'Ada Bulk Recruiter',
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    })),
  )

  // Deliberately bypass model validation for one corrupted legacy row. A
  // reject operation accepts mixed source stages, so the operation row is
  // written first and the generated item then fails its enum validation. The
  // surrounding real transaction must roll back that operation and all fences.
  await HireApplication.collection.insertOne({
    _id: ids.rollbackApplicationId,
    workspaceId: ids.workspaceId,
    jobId: ids.jobId,
    candidateId: ids.rollbackCandidateId,
    stage: 'corrupted_stage',
    events: [],
    createdByMemberId: ids.memberId,
    createdByName: 'Ada Bulk Recruiter',
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  })
}

async function membershipContext(): Promise<MembershipContext> {
  const [workspace, membership] = await Promise.all([
    HireWorkspace.findById(ids.workspaceId),
    HireWorkspaceMember.findById(ids.memberId),
  ])
  if (!workspace || !membership) throw new Error('replica test authority is missing')
  return { workspace, membership }
}

function validSelection(): ReadCandidateSelectionSnapshot {
  return async (_ctx, input) => {
    expect(input.session.inTransaction()).toBe(true)
    return {
      selectionId: ids.selectionId.toString(),
      jobId: ids.jobId.toString(),
      entries: validRows.map((row) => ({
        applicationId: row.applicationId.toString(),
        expectedStage: 'new',
      })),
      count: VALID_APPLICATION_COUNT,
      description: `${VALID_APPLICATION_COUNT} new candidates`,
      expiresAt: new Date('2099-01-01T00:00:00.000Z'),
    }
  }
}

const successInput = {
  jobId: ids.jobId.toString(),
  selectionId: ids.selectionId.toString(),
  clientOperationId: '11111111-1111-4111-8111-111111111111',
  action: 'advance' as const,
  expectedStage: 'new' as const,
  communication: 'none' as const,
  confirmed: true as const,
  confirmedCount: VALID_APPLICATION_COUNT,
}

replicaSuite('Hire candidate bulk operations on a real replica set', () => {
  beforeAll(async () => {
    vi.stubEnv('NODE_ENV', 'test')
    vi.stubEnv('NEXTAUTH_SECRET', 'candidate-bulk-replica-test-secret-123456')
    vi.stubEnv('IPG_SURFACE', 'hire-control')
    vi.stubEnv('MONGODB_URI', uri as string)
    vi.stubEnv('HIRE_CONTROL_DATABASE_NAME', database as string)
    vi.stubEnv('B2C_DATABASE_NAME', 'ipg_candidate_bulk_replica_b2c_test')
    vi.stubEnv(
      'HIRE_RUNTIME_DATABASE_NAME',
      'ipg_candidate_bulk_replica_runtime_test',
    )

    await connectHireControlDB()
    if (mongoose.connection.name !== database || !database?.endsWith('_test')) {
      throw new Error('refusing to prepare a non-isolated candidate-bulk database')
    }
    const hello = await mongoose.connection.db?.admin().command({ hello: 1 })
    if (
      !hello ||
      hello.isWritablePrimary !== true ||
      typeof hello.setName !== 'string' ||
      !hello.setName
    ) {
      throw new Error('candidate-bulk integration gate requires a writable replica-set primary')
    }

    await mongoose.connection.dropDatabase()
    await Promise.all([
      HireCandidateBulkOperation.createIndexes(),
      HireCandidateBulkOperationItem.createIndexes(),
      HireCandidate.collection.createIndex(
        { workspaceId: 1, email: 1 },
        { name: 'workspaceId_1_email_1', unique: true },
      ),
      HireApplication.collection.createIndex(
        { workspaceId: 1, jobId: 1, candidateId: 1 },
        { name: 'workspaceId_1_jobId_1_candidateId_1', unique: true },
      ),
    ])
  }, 30_000)

  beforeEach(async () => {
    mocks.send.mockReset()
    mocks.send.mockResolvedValue({ ids: ['candidate-bulk-replica-event'] })
    await seedWorkspace()
  })

  afterAll(async () => {
    if (mongoose.connection.readyState === 1) {
      if (mongoose.connection.name === database && database?.endsWith('_test')) {
        await mongoose.connection.dropDatabase()
      }
      await mongoose.disconnect()
    }
    vi.unstubAllEnvs()
  })

  it(
    'atomically creates the operation, items, and privacy fences; replays the client id; and rolls every write back after a late item failure',
    async () => {
      const ctx = await membershipContext()
      const first = await createHireCandidateBulkOperation(
        ctx,
        successInput,
        validSelection(),
      )
      const replay = await createHireCandidateBulkOperation(
        ctx,
        successInput,
        validSelection(),
      )

      expect(replay.operationId).toBe(first.operationId)
      expect(mocks.send).toHaveBeenCalledTimes(1)
      expect(
        await HireCandidateBulkOperation.countDocuments({
          workspaceId: ids.workspaceId,
          clientOperationId: successInput.clientOperationId,
        }),
      ).toBe(1)
      const items = await HireCandidateBulkOperationItem.find({
        workspaceId: ids.workspaceId,
        bulkOperationId: first.operationId,
      })
        .sort({ _id: 1 })
        .lean()
      expect(items).toHaveLength(VALID_APPLICATION_COUNT)
      expect(
        new Set(items.map((item) => item.rowOperationId)).size,
      ).toBe(VALID_APPLICATION_COUNT)
      for (const item of items) {
        expect(item.rowOperationId).toBe(
          `bulk:${first.operationId}:${item.applicationId?.toString()}`,
        )
      }

      const fencedCandidates = await HireCandidate.find({
        _id: { $in: validRows.map((row) => row.candidateId) },
      })
        .select('privacyWriteFenceVersion')
        .lean()
      expect(fencedCandidates).toHaveLength(VALID_APPLICATION_COUNT)
      expect(
        fencedCandidates.every(
          (candidate) => candidate.privacyWriteFenceVersion === 1,
        ),
      ).toBe(true)
      expect((await HireWorkspace.findById(ids.workspaceId))?.writeFenceVersion).toBe(1)
      expect(
        (await HireWorkspaceMember.findById(ids.memberId))
          ?.workspaceWriteFenceVersion,
      ).toBe(1)

      const operationsBeforeRollback = await HireCandidateBulkOperation.countDocuments({})
      const itemsBeforeRollback = await HireCandidateBulkOperationItem.countDocuments({})
      const workspaceFenceBeforeRollback = (
        await HireWorkspace.findById(ids.workspaceId)
      )?.writeFenceVersion
      const memberFenceBeforeRollback = (
        await HireWorkspaceMember.findById(ids.memberId)
      )?.workspaceWriteFenceVersion
      const dispatchesBeforeRollback = mocks.send.mock.calls.length
      const rollbackClientOperationId =
        '22222222-2222-4222-8222-222222222222'

      await expect(
        createHireCandidateBulkOperation(
          ctx,
          {
            jobId: ids.jobId.toString(),
            selectionId: ids.rollbackSelectionId.toString(),
            clientOperationId: rollbackClientOperationId,
            action: 'reject',
            communication: 'none',
            reasonCode: 'requirements_mismatch',
            confirmed: true,
            confirmedCount: 1,
          },
          async (_readCtx, input) => {
            expect(input.session.inTransaction()).toBe(true)
            return {
              selectionId: ids.rollbackSelectionId.toString(),
              jobId: ids.jobId.toString(),
              entries: [
                {
                  applicationId: ids.rollbackApplicationId.toString(),
                  expectedStage: 'corrupted_stage' as never,
                },
              ],
              count: 1,
              description: 'One corrupted legacy candidate',
              expiresAt: new Date('2099-01-01T00:00:00.000Z'),
            }
          },
        ),
      ).rejects.toThrow(/HireCandidateBulkOperationItem validation failed/)

      expect(await HireCandidateBulkOperation.countDocuments({})).toBe(
        operationsBeforeRollback,
      )
      expect(
        await HireCandidateBulkOperation.countDocuments({
          clientOperationId: rollbackClientOperationId,
        }),
      ).toBe(0)
      expect(await HireCandidateBulkOperationItem.countDocuments({})).toBe(
        itemsBeforeRollback,
      )
      expect(
        (await HireCandidate.findById(ids.rollbackCandidateId))
          ?.privacyWriteFenceVersion,
      ).toBe(0)
      expect((await HireWorkspace.findById(ids.workspaceId))?.writeFenceVersion).toBe(
        workspaceFenceBeforeRollback,
      )
      expect(
        (await HireWorkspaceMember.findById(ids.memberId))
          ?.workspaceWriteFenceVersion,
      ).toBe(memberFenceBeforeRollback)
      expect(mocks.send).toHaveBeenCalledTimes(dispatchesBeforeRollback)
    },
    30_000,
  )

  it(
    'reclaims an expired post-commit lease, reuses the row operation id, and retries bounded pages to completion without duplicate stage events',
    async () => {
      const ctx = await membershipContext()
      const created = await createHireCandidateBulkOperation(
        ctx,
        { ...successInput, clientOperationId: randomUUID() },
        validSelection(),
      )
      const firstItem = await HireCandidateBulkOperationItem.findOne({
        workspaceId: ids.workspaceId,
        bulkOperationId: created.operationId,
      })
        .sort({ _id: 1 })
        .lean()
      if (!firstItem?.applicationId || !firstItem.rowOperationId) {
        throw new Error('candidate-bulk replica item coordinate is missing')
      }

      // Simulate a worker that committed the stage move and then died before
      // settling its durable item claim. Recovery must replay this exact row
      // id and observe the already-committed event instead of moving twice.
      await moveStage(ctx, firstItem.applicationId.toString(), {
        action: 'advance',
        expectedFrom: 'new',
        operationId: firstItem.rowOperationId,
        requirePrivacyAvailable: true,
      })
      const processAt = new Date(Date.now() + 60_000)
      await HireCandidateBulkOperationItem.updateOne(
        { _id: firstItem._id },
        {
          $set: {
            status: 'processing',
            attempts: 1,
            claimToken: 'expired-worker-claim',
            leaseExpiresAt: new Date(processAt.getTime() - 1),
          },
        },
      )

      const pageSizes: number[] = []
      let terminalOutcome = ''
      for (let page = 0; page < 10; page += 1) {
        const result = await processHireCandidateBulkOperation({
          workspaceId: ids.workspaceId.toString(),
          operationId: created.operationId,
          now: processAt,
          batchSize: 3,
        })
        pageSizes.push(result.processed)
        terminalOutcome = result.outcome
        if (result.outcome === 'completed') break
        expect(result).toMatchObject({
          outcome: 'processing',
          hasRemainingWork: true,
        })
      }

      expect(terminalOutcome).toBe('completed')
      expect(pageSizes).toEqual([3, 3, 3, 2])
      const operation = await HireCandidateBulkOperation.findById(
        created.operationId,
      ).lean()
      expect(operation).toMatchObject({
        status: 'completed',
        queuedCount: 0,
        processingCount: 0,
        succeededCount: VALID_APPLICATION_COUNT,
        conflictCount: 0,
        failedCount: 0,
      })

      const persistedItems = await HireCandidateBulkOperationItem.find({
        workspaceId: ids.workspaceId,
        bulkOperationId: created.operationId,
      }).lean()
      expect(persistedItems).toHaveLength(VALID_APPLICATION_COUNT)
      expect(persistedItems.every((item) => item.status === 'succeeded')).toBe(
        true,
      )
      expect(
        persistedItems.find((item) => item._id.equals(firstItem._id))?.attempts,
      ).toBe(2)
      expect(
        persistedItems
          .filter((item) => !item._id.equals(firstItem._id))
          .every((item) => item.attempts === 1),
      ).toBe(true)

      const applications = await HireApplication.find({
        _id: { $in: validRows.map((row) => row.applicationId) },
      }).lean()
      const itemByApplication = new Map(
        persistedItems.map((item) => [
          item.applicationId?.toString(),
          item.rowOperationId,
        ]),
      )
      for (const application of applications) {
        expect(application.stage).toBe('screened')
        const stageEvents = application.events.filter(
          (event) => event.type === 'stage_move',
        )
        expect(stageEvents).toHaveLength(1)
        expect(stageEvents[0]).toMatchObject({
          from: 'new',
          to: 'screened',
          operationId: itemByApplication.get(application._id.toString()),
        })
      }

      await expect(
        processHireCandidateBulkOperation({
          workspaceId: ids.workspaceId.toString(),
          operationId: created.operationId,
          now: new Date(processAt.getTime() + 1),
          batchSize: 3,
        }),
      ).resolves.toEqual({
        outcome: 'skipped',
        processed: 0,
        hasRemainingWork: false,
      })
      const stageEventCountAfterTerminalReplay = await HireApplication.aggregate<{
        count: number
      }>([
        { $match: { _id: { $in: validRows.map((row) => row.applicationId) } } },
        { $unwind: '$events' },
        { $match: { 'events.type': 'stage_move' } },
        { $count: 'count' },
      ])
      expect(stageEventCountAfterTerminalReplay).toEqual([
        { count: VALID_APPLICATION_COUNT },
      ])
    },
    30_000,
  )

  it(
    'fails an exhausted expired lease without applying another stage mutation',
    async () => {
      const ctx = await membershipContext()
      const created = await createHireCandidateBulkOperation(
        ctx,
        { ...successInput, clientOperationId: randomUUID() },
        validSelection(),
      )
      const exhaustedItem = await HireCandidateBulkOperationItem.findOne({
        workspaceId: ids.workspaceId,
        bulkOperationId: created.operationId,
      })
        .sort({ _id: 1 })
        .lean()
      if (!exhaustedItem?.applicationId || !exhaustedItem.rowOperationId) {
        throw new Error('candidate-bulk exhausted item coordinate is missing')
      }

      // The stage mutation committed, but its worker died before settlement.
      // At the retry ceiling this durable claim must become terminal without
      // invoking the row operation again.
      await moveStage(ctx, exhaustedItem.applicationId.toString(), {
        action: 'advance',
        expectedFrom: 'new',
        operationId: exhaustedItem.rowOperationId,
        requirePrivacyAvailable: true,
      })
      const processAt = new Date(Date.now() + 60_000)
      await HireCandidateBulkOperationItem.updateOne(
        { _id: exhaustedItem._id },
        {
          $set: {
            status: 'processing',
            attempts: HIRE_CANDIDATE_BULK_MAX_ATTEMPTS,
            claimToken: 'exhausted-worker-claim',
            leaseExpiresAt: new Date(processAt.getTime() - 1),
          },
        },
      )

      await expect(
        processHireCandidateBulkOperation({
          workspaceId: ids.workspaceId.toString(),
          operationId: created.operationId,
          now: processAt,
          batchSize: 25,
        }),
      ).resolves.toEqual({
        outcome: 'partial',
        processed: VALID_APPLICATION_COUNT - 1,
        hasRemainingWork: false,
      })

      const persistedItem = await HireCandidateBulkOperationItem.findById(
        exhaustedItem._id,
      ).lean()
      expect(persistedItem).toMatchObject({
        status: 'failed',
        attempts: HIRE_CANDIDATE_BULK_MAX_ATTEMPTS,
        outcomeCode: 'WORKER_CRASH_RETRY_EXHAUSTED',
        processedAt: processAt,
      })
      expect(persistedItem).not.toHaveProperty('claimToken')
      expect(persistedItem).not.toHaveProperty('leaseExpiresAt')

      const operation = await HireCandidateBulkOperation.findById(
        created.operationId,
      ).lean()
      expect(operation).toMatchObject({
        status: 'partial',
        queuedCount: 0,
        processingCount: 0,
        succeededCount: VALID_APPLICATION_COUNT - 1,
        conflictCount: 0,
        failedCount: 1,
      })
      const application = await HireApplication.findById(
        exhaustedItem.applicationId,
      ).lean()
      expect(application?.stage).toBe('screened')
      const stageEvents =
        application?.events.filter((event) => event.type === 'stage_move') ?? []
      expect(stageEvents).toHaveLength(1)
      expect(stageEvents[0]).toMatchObject({
        from: 'new',
        to: 'screened',
        operationId: exhaustedItem.rowOperationId,
      })

      await expect(
        processHireCandidateBulkOperation({
          workspaceId: ids.workspaceId.toString(),
          operationId: created.operationId,
          now: new Date(processAt.getTime() + 1),
          batchSize: 25,
        }),
      ).resolves.toEqual({
        outcome: 'skipped',
        processed: 0,
        hasRemainingWork: false,
      })
      const replayedApplication = await HireApplication.findById(
        exhaustedItem.applicationId,
      ).lean()
      expect(
        replayedApplication?.events.filter(
          (event) => event.type === 'stage_move',
        ),
      ).toHaveLength(1)
    },
    30_000,
  )
})
