import mongoose from 'mongoose'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AppError } from '@shared/errors'

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  withWriteTransaction: vi.fn(),
  send: vi.fn(),
  jobFindOne: vi.fn(),
  applicationFind: vi.fn(),
  applicationFindOne: vi.fn(),
  candidateUpdateMany: vi.fn(),
  candidateExists: vi.fn(),
  privacyCount: vi.fn(),
  privacyExists: vi.fn(),
  workspaceFindOne: vi.fn(),
  memberFindOne: vi.fn(),
  moveStage: vi.fn(),
  operationFindOne: vi.fn(),
  operationFind: vi.fn(),
  operationCreate: vi.fn(),
  operationUpdateOne: vi.fn(),
  itemInsertMany: vi.fn(),
  itemFindOneAndUpdate: vi.fn(),
  itemFindOne: vi.fn(),
  itemUpdateOne: vi.fn(),
  itemUpdateMany: vi.fn(),
  itemAggregate: vi.fn(),
  itemExists: vi.fn(),
  itemDistinct: vi.fn(),
  itemFind: vi.fn(),
}))

vi.mock('@shared/services/inngest', () => ({
  inngest: { send: mocks.send },
}))
vi.mock('../../hire/models/HireApplication', () => ({
  HireApplication: {
    find: mocks.applicationFind,
    findOne: mocks.applicationFindOne,
  },
  TERMINAL_STAGES: ['hired', 'rejected', 'withdrawn'],
}))
vi.mock('../../hire/models/HireCandidate', () => ({
  HireCandidate: {
    updateMany: mocks.candidateUpdateMany,
    exists: mocks.candidateExists,
  },
}))
vi.mock('../../hire/models/HirePrivacyRequest', () => ({
  HirePrivacyRequest: {
    countDocuments: mocks.privacyCount,
    exists: mocks.privacyExists,
  },
  activeHirePrivacyRequestFilter: () => ({ live: true }),
}))
vi.mock('../../hire/models/HireJob', () => ({
  HireJob: { findOne: mocks.jobFindOne },
}))
vi.mock('../../hire/models/HireWorkspace', () => ({
  HireWorkspace: { findOne: mocks.workspaceFindOne },
}))
vi.mock('../../hire/models/HireWorkspaceMember', () => ({
  HireWorkspaceMember: { findOne: mocks.memberFindOne },
}))
vi.mock('../../hire/services/hireControlBoundary', () => ({
  connectHireControlDB: mocks.connect,
}))
vi.mock('../../hire/services/hireWorkspaceLifecycleFilter', () => ({
  activeHireWorkspaceLifecycleFilter: () => ({ lifecycleState: 'active' }),
}))
vi.mock('../../hire/services/hireWorkspaceWriteFence', () => ({
  withActiveHireWorkspaceWriteTransaction: mocks.withWriteTransaction,
}))
vi.mock('../../hire/services/pipelineService', () => ({
  moveStage: mocks.moveStage,
}))
vi.mock('../models', () => ({
  HIRE_CANDIDATE_BULK_ITEM_RETENTION_MS: 90 * 24 * 60 * 60 * 1000,
  HIRE_CANDIDATE_BULK_OPERATION_RETENTION_MS: 365 * 24 * 60 * 60 * 1000,
  HireCandidateBulkOperation: {
    findOne: mocks.operationFindOne,
    find: mocks.operationFind,
    create: mocks.operationCreate,
    updateOne: mocks.operationUpdateOne,
  },
  HireCandidateBulkOperationItem: {
    insertMany: mocks.itemInsertMany,
    findOneAndUpdate: mocks.itemFindOneAndUpdate,
    findOne: mocks.itemFindOne,
    updateOne: mocks.itemUpdateOne,
    updateMany: mocks.itemUpdateMany,
    aggregate: mocks.itemAggregate,
    exists: mocks.itemExists,
    distinct: mocks.itemDistinct,
    find: mocks.itemFind,
  },
}))

import {
  createHireCandidateBulkOperation,
  listDueHireCandidateBulkOperationIds,
  processHireCandidateBulkOperation,
} from '../services/bulkOperationService'

const WORKSPACE_ID = new mongoose.Types.ObjectId('111111111111111111111111')
const JOB_ID = new mongoose.Types.ObjectId('222222222222222222222222')
const MEMBER_ID = new mongoose.Types.ObjectId('333333333333333333333333')
const SELECTION_ID = new mongoose.Types.ObjectId('444444444444444444444444')
const OPERATION_ID = new mongoose.Types.ObjectId('555555555555555555555555')
const APP_A = new mongoose.Types.ObjectId('666666666666666666666666')
const APP_B = new mongoose.Types.ObjectId('777777777777777777777777')
const CANDIDATE_A = new mongoose.Types.ObjectId('888888888888888888888888')
const CANDIDATE_B = new mongoose.Types.ObjectId('999999999999999999999999')
const CLIENT_OPERATION_ID = '11111111-1111-4111-8111-111111111111'
const NOW = new Date('2026-08-25T10:00:00.000Z')

const ctx = {
  workspace: { _id: WORKSPACE_ID, lifecycleState: 'active' },
  membership: {
    _id: MEMBER_ID,
    name: 'Ada Recruiter',
    email: 'ada@example.com',
    authState: 'active',
  },
} as never

function queryResult<T>(value: T) {
  return {
    select: vi.fn(() => ({
      sort: vi.fn(() => ({ session: vi.fn().mockResolvedValue(value) })),
      session: vi.fn().mockResolvedValue(value),
    })),
  }
}

function countResult(value: number) {
  return { session: vi.fn().mockResolvedValue(value) }
}

function operation(overrides: Record<string, unknown> = {}) {
  return {
    _id: OPERATION_ID,
    workspaceId: WORKSPACE_ID,
    jobId: JOB_ID,
    selectionSnapshotId: SELECTION_ID,
    requestedByMemberId: MEMBER_ID,
    requestedByName: 'Ada Recruiter',
    clientOperationId: CLIENT_OPERATION_ID,
    action: 'advance',
    expectedStage: 'new',
    communication: 'none',
    selectionDescription: '2 candidates on this page',
    status: 'queued',
    totalCount: 2,
    queuedCount: 2,
    processingCount: 0,
    succeededCount: 0,
    conflictCount: 0,
    failedCount: 0,
    dispatchStatus: 'pending',
    dispatchAttempts: 0,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
}

describe('candidate bulk operation service', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.connect.mockResolvedValue(undefined)
    mocks.withWriteTransaction.mockImplementation(
      async (_workspaceId: unknown, _memberId: unknown, work: (session: unknown) => unknown) =>
        work({ id: 'session' }),
    )
    mocks.send.mockResolvedValue({ ids: ['event-1'] })
    mocks.operationUpdateOne.mockResolvedValue({ matchedCount: 1 })
    mocks.itemInsertMany.mockResolvedValue([])
    mocks.candidateUpdateMany.mockResolvedValue({ matchedCount: 2 })
    mocks.privacyCount.mockReturnValue(countResult(0))
    mocks.jobFindOne.mockReturnValue(queryResult({ _id: JOB_ID }))
    mocks.applicationFind.mockReturnValue(
      queryResult([
        { _id: APP_A, candidateId: CANDIDATE_A, stage: 'new' },
        { _id: APP_B, candidateId: CANDIDATE_B, stage: 'new' },
      ]),
    )
    mocks.operationCreate.mockImplementation(async ([document]: [Record<string, unknown>]) => [
      operation(document),
    ])
    mocks.itemFindOne.mockReturnValue({
      select: vi.fn(() => ({
        sort: vi.fn(() => ({ lean: vi.fn().mockResolvedValue(null) })),
      })),
    })
  })

  it('creates per-row expected-state items only from the immutable snapshot', async () => {
    mocks.operationFindOne.mockResolvedValue(null)
    const readSelection = vi.fn().mockResolvedValue({
      selectionId: SELECTION_ID.toString(),
      jobId: JOB_ID.toString(),
      entries: [
        { applicationId: APP_A.toString(), expectedStage: 'new' },
        { applicationId: APP_B.toString(), expectedStage: 'new' },
      ],
      count: 2,
      description: '2 candidates on this page',
      expiresAt: new Date('2099-01-01T00:00:00.000Z'),
    })

    const result = await createHireCandidateBulkOperation(
      ctx,
      {
        jobId: JOB_ID.toString(),
        selectionId: SELECTION_ID.toString(),
        clientOperationId: CLIENT_OPERATION_ID,
        action: 'advance',
        expectedStage: 'new',
        communication: 'none',
        confirmed: true,
        confirmedCount: 2,
      },
      readSelection,
    )

    expect(readSelection).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({
        jobId: JOB_ID.toString(),
        selectionId: SELECTION_ID.toString(),
        session: { id: 'session' },
      }),
    )
    expect(mocks.candidateUpdateMany).toHaveBeenCalledWith(
      {
        _id: { $in: [CANDIDATE_A, CANDIDATE_B] },
        workspaceId: WORKSPACE_ID,
        piiAnonymizedAt: { $exists: false },
      },
      { $inc: { privacyWriteFenceVersion: 1 } },
      { session: { id: 'session' }, timestamps: false },
    )
    const inserted = mocks.itemInsertMany.mock.calls[0][0]
    const persistedOperationId = inserted[0].bulkOperationId.toString()
    expect(inserted).toHaveLength(2)
    expect(inserted).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          applicationId: APP_A,
          expectedStage: 'new',
          rowOperationId: `bulk:${persistedOperationId}:${APP_A.toString()}`,
        }),
      ]),
    )
    expect(mocks.send).toHaveBeenCalledWith({
      name: 'hire/candidate-bulk-operation.requested',
      data: {
        workspaceId: WORKSPACE_ID.toString(),
        operationId: persistedOperationId,
      },
    })
    expect(mocks.operationCreate.mock.calls[0][0][0]).toMatchObject({
      nextRecoveryAt: expect.any(Date),
    })
    expect(result).toMatchObject({ status: 'queued', totalCount: 2 })
  })

  it('fails before persistence when privacy wins the candidate-row fence', async () => {
    mocks.operationFindOne.mockResolvedValue(null)
    mocks.candidateUpdateMany.mockResolvedValue({ matchedCount: 1 })
    const readSelection = vi.fn().mockResolvedValue({
      selectionId: SELECTION_ID.toString(),
      jobId: JOB_ID.toString(),
      entries: [
        { applicationId: APP_A.toString(), expectedStage: 'new' },
        { applicationId: APP_B.toString(), expectedStage: 'new' },
      ],
      count: 2,
      description: '2 candidates',
      expiresAt: new Date('2099-01-01T00:00:00.000Z'),
    })

    await expect(
      createHireCandidateBulkOperation(
        ctx,
        {
          jobId: JOB_ID.toString(),
          selectionId: SELECTION_ID.toString(),
          clientOperationId: CLIENT_OPERATION_ID,
          action: 'advance',
          expectedStage: 'new',
          communication: 'none',
          confirmed: true,
          confirmedCount: 2,
        },
        readSelection,
      ),
    ).rejects.toMatchObject({ code: 'SELECTION_PRIVACY_PROTECTED' })
    expect(mocks.operationCreate).not.toHaveBeenCalled()
    expect(mocks.itemInsertMany).not.toHaveBeenCalled()
  })

  it('recovers only a bounded page of operations whose durable due time elapsed', async () => {
    const limit = vi.fn(() => ({
      lean: vi.fn().mockResolvedValue([{ _id: OPERATION_ID }]),
    }))
    const sort = vi.fn(() => ({ limit }))
    const select = vi.fn(() => ({ sort }))
    mocks.operationFind.mockReturnValue({ select })

    await expect(
      listDueHireCandidateBulkOperationIds({
        workspaceId: WORKSPACE_ID.toString(),
        limit: 100,
        now: NOW,
      }),
    ).resolves.toEqual([OPERATION_ID.toString()])

    expect(mocks.operationFind).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      status: { $in: ['queued', 'processing'] },
      nextRecoveryAt: { $lte: NOW },
    })
    expect(sort).toHaveBeenCalledWith({
      nextRecoveryAt: 1,
      updatedAt: 1,
      _id: 1,
    })
    expect(limit).toHaveBeenCalledWith(25)
  })

  it('fails closed when a snapshot stage changed before confirmation', async () => {
    mocks.operationFindOne.mockResolvedValue(null)
    mocks.applicationFind.mockReturnValue(
      queryResult([
        { _id: APP_A, candidateId: CANDIDATE_A, stage: 'screened' },
        { _id: APP_B, candidateId: CANDIDATE_B, stage: 'new' },
      ]),
    )
    const readSelection = vi.fn().mockResolvedValue({
      selectionId: SELECTION_ID.toString(),
      jobId: JOB_ID.toString(),
      entries: [
        { applicationId: APP_A.toString(), expectedStage: 'new' },
        { applicationId: APP_B.toString(), expectedStage: 'new' },
      ],
      count: 2,
      description: '2 candidates',
      expiresAt: new Date('2099-01-01T00:00:00.000Z'),
    })
    await expect(
      createHireCandidateBulkOperation(
        ctx,
        {
          jobId: JOB_ID.toString(),
          selectionId: SELECTION_ID.toString(),
          clientOperationId: CLIENT_OPERATION_ID,
          action: 'advance',
          expectedStage: 'new',
          communication: 'none',
          confirmed: true,
          confirmedCount: 2,
        },
        readSelection,
      ),
    ).rejects.toMatchObject({ code: 'SELECTION_STAGE_CHANGED' })
    expect(mocks.operationCreate).not.toHaveBeenCalled()
    expect(mocks.send).not.toHaveBeenCalled()
  })

  it('rejects an idempotency replay whose stage intent changed', async () => {
    mocks.operationFindOne.mockResolvedValue(operation())

    await expect(
      createHireCandidateBulkOperation(
        ctx,
        {
          jobId: JOB_ID.toString(),
          selectionId: SELECTION_ID.toString(),
          clientOperationId: CLIENT_OPERATION_ID,
          action: 'advance',
          expectedStage: 'screened',
          communication: 'none',
          confirmed: true,
          confirmedCount: 2,
        },
        vi.fn(),
      ),
    ).rejects.toMatchObject({ code: 'BULK_OPERATION_ID_REUSED' })

    expect(mocks.operationCreate).not.toHaveBeenCalled()
    expect(mocks.send).not.toHaveBeenCalled()
  })

  it('requires a reviewed reason for bulk reject and withdrawal', async () => {
    mocks.operationFindOne.mockResolvedValue(null)
    await expect(
      createHireCandidateBulkOperation(
        ctx,
        {
          jobId: JOB_ID.toString(),
          selectionId: SELECTION_ID.toString(),
          clientOperationId: CLIENT_OPERATION_ID,
          action: 'reject',
          communication: 'none',
          confirmed: true,
          confirmedCount: 2,
        },
        vi.fn(),
      ),
    ).rejects.toMatchObject({ code: 'BULK_REASON_REQUIRED' })
    await expect(
      createHireCandidateBulkOperation(
        ctx,
        {
          jobId: JOB_ID.toString(),
          selectionId: SELECTION_ID.toString(),
          clientOperationId: CLIENT_OPERATION_ID,
          action: 'withdraw',
          reasonCode: 'role_filled',
          communication: 'none',
          confirmed: true,
          confirmedCount: 2,
        },
        vi.fn(),
      ),
    ).rejects.toMatchObject({ code: 'BULK_REASON_MISMATCH' })
  })

  it('persists a controlled reason code instead of recruiter free text', async () => {
    mocks.operationFindOne.mockResolvedValue(null)
    const readSelection = vi.fn().mockResolvedValue({
      selectionId: SELECTION_ID.toString(),
      jobId: JOB_ID.toString(),
      entries: [
        { applicationId: APP_A.toString(), expectedStage: 'new' },
        { applicationId: APP_B.toString(), expectedStage: 'new' },
      ],
      count: 2,
      description: 'Selected candidates · 2 candidates',
      expiresAt: new Date('2099-01-01T00:00:00.000Z'),
    })

    await createHireCandidateBulkOperation(
      ctx,
      {
        jobId: JOB_ID.toString(),
        selectionId: SELECTION_ID.toString(),
        clientOperationId: CLIENT_OPERATION_ID,
        action: 'reject',
        reasonCode: 'requirements_mismatch',
        communication: 'none',
        confirmed: true,
        confirmedCount: 2,
      },
      readSelection,
    )

    expect(mocks.operationCreate.mock.calls[0][0][0]).toMatchObject({
      reasonCode: 'requirements_mismatch',
    })
    expect(mocks.operationCreate.mock.calls[0][0][0]).not.toHaveProperty('note')
  })

  it('reuses the stable row id and privacy fence when a worker claim is replayed', async () => {
    const op = operation({ startedAt: NOW })
    const item = {
      _id: new mongoose.Types.ObjectId('aaaaaaaaaaaaaaaaaaaaaaaa'),
      applicationId: APP_A,
      expectedStage: 'new',
      rowOperationId: `bulk:${OPERATION_ID.toString()}:${APP_A.toString()}`,
      attempts: 2,
    }
    mocks.operationFindOne.mockResolvedValue(op)
    mocks.workspaceFindOne.mockResolvedValue(ctx.workspace)
    mocks.memberFindOne.mockResolvedValue(ctx.membership)
    mocks.itemFindOneAndUpdate
      .mockResolvedValueOnce(item)
      .mockResolvedValueOnce(null)
    mocks.applicationFindOne.mockReturnValue({
      select: vi.fn().mockResolvedValue({ candidateId: CANDIDATE_A }),
    })
    mocks.candidateExists.mockResolvedValue({ _id: CANDIDATE_A })
    mocks.privacyExists.mockResolvedValue(null)
    mocks.moveStage.mockResolvedValue({ _id: APP_A })
    mocks.itemUpdateOne.mockResolvedValue({ matchedCount: 1 })
    mocks.itemAggregate.mockResolvedValue([{ _id: 'succeeded', count: 1 }])

    await expect(
      processHireCandidateBulkOperation({
        workspaceId: WORKSPACE_ID.toString(),
        operationId: OPERATION_ID.toString(),
        now: NOW,
      }),
    ).resolves.toMatchObject({ outcome: 'completed', processed: 1 })
    expect(mocks.moveStage).toHaveBeenCalledWith(ctx, APP_A.toString(), {
      action: 'advance',
      expectedFrom: 'new',
      operationId: item.rowOperationId,
      note: undefined,
      requirePrivacyAvailable: true,
    })
    expect(mocks.itemUpdateOne).toHaveBeenCalledWith(
      expect.objectContaining({ claimToken: expect.any(String) }),
      expect.objectContaining({
        $set: expect.objectContaining({ status: 'succeeded', outcomeCode: 'APPLIED' }),
      }),
    )
  })

  it('writes only the server-controlled reason label into row stage history', async () => {
    const op = operation({
      action: 'reject',
      expectedStage: undefined,
      reasonCode: 'requirements_mismatch',
      startedAt: NOW,
    })
    const item = {
      _id: new mongoose.Types.ObjectId('aaaaaaaaaaaaaaaaaaaaaaaa'),
      applicationId: APP_A,
      expectedStage: 'new',
      rowOperationId: 'row-controlled-reason',
      attempts: 1,
    }
    mocks.operationFindOne.mockResolvedValue(op)
    mocks.workspaceFindOne.mockResolvedValue(ctx.workspace)
    mocks.memberFindOne.mockResolvedValue(ctx.membership)
    mocks.itemFindOneAndUpdate.mockResolvedValueOnce(item).mockResolvedValueOnce(null)
    mocks.applicationFindOne.mockReturnValue({
      select: vi.fn().mockResolvedValue({ candidateId: CANDIDATE_A }),
    })
    mocks.candidateExists.mockResolvedValue({ _id: CANDIDATE_A })
    mocks.privacyExists.mockResolvedValue(null)
    mocks.moveStage.mockResolvedValue({ _id: APP_A })
    mocks.itemUpdateOne.mockResolvedValue({ matchedCount: 1 })
    mocks.itemAggregate.mockResolvedValue([{ _id: 'succeeded', count: 1 }])

    await processHireCandidateBulkOperation({
      workspaceId: WORKSPACE_ID.toString(),
      operationId: OPERATION_ID.toString(),
      now: NOW,
    })

    expect(mocks.moveStage).toHaveBeenCalledWith(
      ctx,
      APP_A.toString(),
      expect.objectContaining({
        note: 'Bulk reason: Requirements mismatch',
        requirePrivacyAvailable: true,
      }),
    )
  })

  it('records privacy and stage races as controlled per-row conflicts', async () => {
    const op = operation({ startedAt: NOW })
    const itemA = {
      _id: new mongoose.Types.ObjectId('aaaaaaaaaaaaaaaaaaaaaaaa'),
      applicationId: APP_A,
      expectedStage: 'new',
      rowOperationId: 'row-a',
      attempts: 1,
    }
    const itemB = {
      _id: new mongoose.Types.ObjectId('bbbbbbbbbbbbbbbbbbbbbbbb'),
      applicationId: APP_B,
      expectedStage: 'new',
      rowOperationId: 'row-b',
      attempts: 1,
    }
    mocks.operationFindOne.mockResolvedValue(op)
    mocks.workspaceFindOne.mockResolvedValue(ctx.workspace)
    mocks.memberFindOne.mockResolvedValue(ctx.membership)
    mocks.itemFindOneAndUpdate
      .mockResolvedValueOnce(itemA)
      .mockResolvedValueOnce(itemB)
      .mockResolvedValueOnce(null)
    mocks.applicationFindOne.mockReturnValue({
      select: vi
        .fn()
        .mockResolvedValueOnce({ candidateId: CANDIDATE_A })
        .mockResolvedValueOnce({ candidateId: CANDIDATE_B }),
    })
    mocks.candidateExists
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ _id: CANDIDATE_B })
    mocks.privacyExists.mockResolvedValue(null)
    mocks.moveStage.mockRejectedValueOnce(
      new AppError('stage changed', 409, 'STAGE_RACE'),
    )
    mocks.itemUpdateOne.mockResolvedValue({ matchedCount: 1 })
    mocks.itemAggregate.mockResolvedValue([{ _id: 'conflict', count: 2 }])

    await processHireCandidateBulkOperation({
      workspaceId: WORKSPACE_ID.toString(),
      operationId: OPERATION_ID.toString(),
      now: NOW,
    })
    const outcomes = mocks.itemUpdateOne.mock.calls.map((call) => call[1].$set.outcomeCode)
    expect(outcomes).toEqual([
      'CANDIDATE_PRIVACY_UNAVAILABLE',
      'STAGE_RACE',
    ])
  })
})
