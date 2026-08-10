import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@shared/db/connection', () => ({
  connectDB: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../services/hireWorkspaceWriteFence', () => ({
  withActiveHireWorkspaceWriteTransaction: (
    _workspaceId: unknown,
    _memberId: unknown,
    work: (session: unknown) => Promise<unknown>,
  ) => work(session),
}))

const {
  session,
  mockJob,
  mockCandidate,
  mockApplication,
  mockRound,
  mockGuestSession,
  mockEngineHandoff,
  mockInterviewAttempt,
  mockRequirementVersion,
  mockEmailOutbox,
  mockScheduleMediaPurge,
  mockCancelMediaPurge,
  mockDeliverRuntimeRevocation,
} = vi.hoisted(() => {
  const transactionSession = {
    withTransaction: vi.fn(async (work: () => Promise<void>) => work()),
    endSession: vi.fn().mockResolvedValue(undefined),
  }
  return {
    session: transactionSession,
    mockJob: {
      create: vi.fn(),
      find: vi.fn(),
      findOne: vi.fn(),
      findOneAndUpdate: vi.fn(),
      updateOne: vi.fn(),
      exists: vi.fn(),
      db: { startSession: vi.fn().mockResolvedValue(transactionSession) },
    },
    mockCandidate: { create: vi.fn(), find: vi.fn(), findOne: vi.fn() },
    mockApplication: {
      create: vi.fn(),
      find: vi.fn(),
      findOne: vi.fn(),
      findOneAndUpdate: vi.fn(),
      updateOne: vi.fn(),
      aggregate: vi.fn(),
      bulkWrite: vi.fn(),
    },
    mockRound: { find: vi.fn(), updateMany: vi.fn() },
    mockGuestSession: { updateMany: vi.fn() },
    mockEngineHandoff: { updateMany: vi.fn() },
    mockInterviewAttempt: { updateMany: vi.fn() },
    mockRequirementVersion: { create: vi.fn() },
    mockEmailOutbox: { create: vi.fn(), find: vi.fn() },
    mockScheduleMediaPurge: vi.fn(),
    mockCancelMediaPurge: vi.fn(),
    mockDeliverRuntimeRevocation: vi.fn(),
  }
})

vi.mock('../models', () => {
  return {
    HIRE_STAGES: [
      'new',
      'screened',
      'interviewing',
      'shortlist',
      'offer',
      'hired',
      'rejected',
      'withdrawn',
    ],
    TERMINAL_STAGES: ['hired', 'rejected', 'withdrawn'],
    HireJob: {
      ...mockJob,
      create: (...args: unknown[]) => mockJob.create(...args),
      find: (...args: unknown[]) => mockJob.find(...args),
      findOne: (...args: unknown[]) => mockJob.findOne(...args),
      findOneAndUpdate: (...args: unknown[]) => mockJob.findOneAndUpdate(...args),
      updateOne: (...args: unknown[]) => mockJob.updateOne(...args),
      exists: (...args: unknown[]) => mockJob.exists(...args),
      db: mockJob.db,
    },
    HireCandidate: {
      create: (...args: unknown[]) => mockCandidate.create(...args),
      find: (...args: unknown[]) => mockCandidate.find(...args),
      findOne: (...args: unknown[]) => mockCandidate.findOne(...args),
    },
    HireApplication: {
      create: (...args: unknown[]) => mockApplication.create(...args),
      find: (...args: unknown[]) => mockApplication.find(...args),
      findOne: (...args: unknown[]) => mockApplication.findOne(...args),
      findOneAndUpdate: (...args: unknown[]) => mockApplication.findOneAndUpdate(...args),
      updateOne: (...args: unknown[]) => mockApplication.updateOne(...args),
      aggregate: (...args: unknown[]) => mockApplication.aggregate(...args),
      bulkWrite: (...args: unknown[]) => mockApplication.bulkWrite(...args),
    },
    HireRound: {
      find: (...args: unknown[]) => mockRound.find(...args),
      updateMany: (...args: unknown[]) => mockRound.updateMany(...args),
    },
    HireGuestSession: {
      updateMany: (...args: unknown[]) => mockGuestSession.updateMany(...args),
    },
    HireEngineHandoff: {
      updateMany: (...args: unknown[]) => mockEngineHandoff.updateMany(...args),
    },
    HireInterviewAttempt: {
      updateMany: (...args: unknown[]) => mockInterviewAttempt.updateMany(...args),
    },
  }
})

vi.mock('../models/HireJobRequirementVersion', () => ({
  HireJobRequirementVersion: {
    create: (...args: unknown[]) => mockRequirementVersion.create(...args),
  },
}))

vi.mock('../models/HireEmailOutbox', () => ({
  HireEmailOutbox: {
    create: (...args: unknown[]) => mockEmailOutbox.create(...args),
    find: (...args: unknown[]) => mockEmailOutbox.find(...args),
  },
}))

vi.mock('../services/mediaLifecycleService', () => ({
  scheduleHireJobMediaPurge: (...args: unknown[]) => mockScheduleMediaPurge(...args),
  cancelFutureHireJobMediaPurge: (...args: unknown[]) => mockCancelMediaPurge(...args),
}))

vi.mock('../services/engineRevocationService', () => ({
  deliverRuntimeRevocation: (...args: unknown[]) => mockDeliverRuntimeRevocation(...args),
}))

import {
  addCandidate,
  createApplication,
  createJob,
  moveStage,
  updateJobStatus,
} from '../services/pipelineService'
import type { MembershipContext } from '../services/workspaceService'

const CTX = {
  workspace: { _id: 'ws-A', name: 'Acme' },
  membership: {
    _id: 'm1',
    userId: 'u1',
    email: 'hr@acme.com',
    name: 'HR One',
    role: 'admin',
  },
} as unknown as MembershipContext

const OP_A = '11111111-1111-4111-8111-111111111111'
const OP_B = '22222222-2222-4222-8222-222222222222'

const JOB_INPUT = {
  title: 'Backend Engineer',
  level: 'Senior',
  mustHaves: ['Production TypeScript'],
  niceToHaves: ['Kafka'],
  location: 'Bengaluru, India',
  workMode: 'hybrid' as const,
  jdText: '# Backend Engineer\n\nA sufficiently detailed reviewed job description for testing.',
}

beforeEach(() => {
  vi.clearAllMocks()
  session.withTransaction.mockImplementation(async (work: () => Promise<void>) => work())
  session.endSession.mockResolvedValue(undefined)
  mockJob.db.startSession.mockResolvedValue(session)
  mockJob.exists.mockReturnValue({ session: vi.fn().mockResolvedValue(true) })
  mockRound.find.mockResolvedValue([])
  mockRound.updateMany.mockResolvedValue({ modifiedCount: 0 })
  mockGuestSession.updateMany.mockResolvedValue({ modifiedCount: 0 })
  mockEngineHandoff.updateMany.mockResolvedValue({ modifiedCount: 0 })
  mockInterviewAttempt.updateMany.mockResolvedValue({ modifiedCount: 0 })
  mockScheduleMediaPurge.mockResolvedValue({ purgeEligibleAt: new Date(), scheduled: 0 })
  mockCancelMediaPurge.mockResolvedValue(0)
  mockDeliverRuntimeRevocation.mockResolvedValue(true)
  mockEmailOutbox.find.mockResolvedValue([])
})

describe('createJob', () => {
  it('persists the job and immutable scoring contract in one transaction', async () => {
    mockJob.create.mockImplementation(async (docs: unknown[]) => docs)
    mockRequirementVersion.create.mockResolvedValue([])

    const job = await createJob(CTX, JOB_INPUT)

    const [jobDocs, jobOptions] = mockJob.create.mock.calls[0]
    const [versionDocs, versionOptions] = mockRequirementVersion.create.mock.calls[0]
    expect(job).toBe(jobDocs[0])
    expect(jobOptions).toEqual({ session })
    expect(versionOptions).toEqual({ session })
    expect(jobDocs[0]).toMatchObject({
      workspaceId: 'ws-A',
      status: 'open',
      createdBy: 'u1',
      createdByMemberId: 'm1',
      createdByName: 'HR One',
      activeRequirementVersion: 1,
    })
    expect(String(jobDocs[0].activeRequirementVersionId)).toBe(String(versionDocs[0]._id))
    expect(String(versionDocs[0].jobId)).toBe(String(jobDocs[0]._id))
    expect(versionDocs[0]).toMatchObject({
      workspaceId: 'ws-A',
      version: 1,
      state: 'active',
      createdByMemberId: 'm1',
      requirements: [
        expect.objectContaining({ text: 'Production TypeScript', importance: 'must_have' }),
        expect.objectContaining({ text: 'Kafka', importance: 'nice_to_have' }),
      ],
    })
  })

  it('does not require a legacy B2C User actor', async () => {
    const passwordOnly = {
      ...CTX,
      membership: { ...CTX.membership, userId: undefined },
    } as unknown as MembershipContext
    mockJob.create.mockImplementation(async (docs: unknown[]) => docs)
    mockRequirementVersion.create.mockResolvedValue([])

    await createJob(passwordOnly, JOB_INPUT)

    const jobDoc = mockJob.create.mock.calls[0][0][0]
    expect(jobDoc).not.toHaveProperty('createdBy')
    expect(jobDoc).toMatchObject({ createdByMemberId: 'm1', createdByName: 'HR One' })
  })
})

describe('updateJobStatus', () => {
  it('requires a note and explicit compare-and-set inputs to close', async () => {
    await expect(
      updateJobStatus(CTX, 'j1', {
        status: 'closed',
        expectedStatus: 'open',
        operationId: OP_A,
      }),
    ).rejects.toMatchObject({ code: 'CLOSE_NOTE_REQUIRED' })
    expect(mockJob.findOneAndUpdate).not.toHaveBeenCalled()
  })

  it('atomically rejects live applications and creates one staggered outbox row each', async () => {
    const applications = [
      { _id: 'a1', candidateId: 'c1', stage: 'screened' },
      { _id: 'a2', candidateId: 'c2', stage: 'offer' },
    ]
    mockJob.findOne.mockResolvedValue(null)
    mockJob.findOneAndUpdate.mockResolvedValue({
      _id: 'j1',
      title: 'Backend Engineer',
      status: 'closed',
      events: [],
    })
    mockApplication.find.mockResolvedValue(applications)
    mockCandidate.find.mockResolvedValue([
      { _id: 'c1', name: 'One', email: 'one@example.com' },
      { _id: 'c2', name: 'Two', email: 'two@example.com' },
    ])
    mockApplication.bulkWrite.mockResolvedValue({ modifiedCount: 2 })
    mockEmailOutbox.create.mockResolvedValue([])

    await updateJobStatus(CTX, 'j1', {
      status: 'closed',
      expectedStatus: 'open',
      operationId: OP_A,
      closeNote: 'Role filled after human review.',
    })

    const [statusFilter, statusUpdate, statusOptions] = mockJob.findOneAndUpdate.mock.calls[0]
    expect(statusFilter).toEqual({ _id: 'j1', workspaceId: 'ws-A', status: 'open' })
    expect(statusOptions).toEqual({ new: true, session })
    expect(statusUpdate.$set).toMatchObject({
      status: 'closed',
      closeNote: 'Role filled after human review.',
      closedByMemberId: 'm1',
      closedByName: 'HR One',
    })
    expect(statusUpdate.$push.events).toMatchObject({
      from: 'open',
      to: 'closed',
      actorMemberId: 'm1',
      actorName: 'HR One',
      operationId: OP_A,
    })
    expect(mockApplication.find).toHaveBeenCalledWith(
      {
        workspaceId: 'ws-A',
        jobId: 'j1',
        stage: { $nin: ['hired', 'withdrawn'] },
      },
      null,
      { session },
    )

    const [writes, batchOptions] = mockApplication.bulkWrite.mock.calls[0]
    expect(batchOptions).toEqual({ session })
    expect(writes).toHaveLength(2)
    expect(writes[0].updateOne.filter).toMatchObject({
      workspaceId: 'ws-A',
      jobId: 'j1',
      stage: 'screened',
    })
    expect(writes[0].updateOne.update.$set).toEqual({
      stage: 'rejected',
      decisionNote: 'Role filled after human review.',
    })
    expect(writes[0].updateOne.update.$push.events).toMatchObject({
      actorMemberId: 'm1',
      actorName: 'HR One',
      operationId: OP_A,
    })

    const [outboxDocs, outboxOptions] = mockEmailOutbox.create.mock.calls[0]
    expect(outboxOptions).toEqual({ session })
    expect(outboxDocs).toHaveLength(2)
    expect(outboxDocs[0]).toMatchObject({
      workspaceId: 'ws-A',
      applicationId: 'a1',
      candidateId: 'c1',
      operationId: OP_A,
      recipientEmail: 'one@example.com',
      status: 'pending',
      payload: expect.objectContaining({ workspaceName: 'Acme' }),
    })
    expect(outboxDocs[1].sendAfter.getTime() - outboxDocs[0].sendAfter.getTime()).toBe(2_000)
  })

  it('emails manually rejected candidates at close without rewriting their stage event', async () => {
    mockJob.findOne.mockResolvedValue(null)
    mockJob.findOneAndUpdate.mockResolvedValue({
      _id: 'j1',
      title: 'Backend Engineer',
      status: 'closed',
      events: [],
    })
    mockApplication.find.mockResolvedValue([
      { _id: 'a-rejected', candidateId: 'c-rejected', stage: 'rejected' },
      { _id: 'a-live', candidateId: 'c-live', stage: 'shortlist' },
    ])
    mockCandidate.find.mockResolvedValue([
      { _id: 'c-rejected', name: 'Rejected', email: 'rejected@example.com' },
      { _id: 'c-live', name: 'Live', email: 'live@example.com' },
    ])
    mockApplication.bulkWrite.mockResolvedValue({ modifiedCount: 1 })
    mockEmailOutbox.create.mockResolvedValue([])

    await updateJobStatus(CTX, 'j1', {
      status: 'closed',
      expectedStatus: 'open',
      operationId: OP_A,
      closeNote: 'Closing after human review.',
    })

    const [writes] = mockApplication.bulkWrite.mock.calls[0]
    expect(writes).toHaveLength(1)
    expect(writes[0].updateOne.filter).toMatchObject({
      _id: 'a-live',
      stage: 'shortlist',
    })
    expect(writes[0].updateOne.update.$push.events).toMatchObject({
      from: 'shortlist',
      to: 'rejected',
      actorMemberId: 'm1',
      operationId: OP_A,
    })
    const [outboxDocs] = mockEmailOutbox.create.mock.calls[0]
    expect(outboxDocs).toHaveLength(2)
    expect(outboxDocs.map((row: { applicationId: string }) => row.applicationId)).toEqual([
      'a-rejected',
      'a-live',
    ])
  })

  it('does not enqueue a duplicate rejection for an application notified by an earlier close', async () => {
    mockJob.findOne.mockResolvedValue(null)
    mockJob.findOneAndUpdate.mockResolvedValue({
      _id: 'j1',
      title: 'Backend Engineer',
      status: 'closed',
      events: [],
    })
    mockApplication.find.mockResolvedValue([
      { _id: 'a-rejected', candidateId: 'c-rejected', stage: 'rejected' },
    ])
    mockEmailOutbox.find.mockResolvedValue([{ applicationId: 'a-rejected' }])
    mockCandidate.find.mockResolvedValue([])

    await updateJobStatus(CTX, 'j1', {
      status: 'closed',
      expectedStatus: 'open',
      operationId: OP_B,
      closeNote: 'Closing again after review.',
    })

    expect(mockApplication.bulkWrite).not.toHaveBeenCalled()
    expect(mockEmailOutbox.create).not.toHaveBeenCalled()
    expect(mockCandidate.find).not.toHaveBeenCalled()
  })

  it('aborts before outbox creation if a stage loses the close race', async () => {
    mockJob.findOne.mockResolvedValue(null)
    mockJob.findOneAndUpdate.mockResolvedValue({
      _id: 'j1',
      title: 'Backend Engineer',
      events: [],
    })
    mockApplication.find.mockResolvedValue([
      { _id: 'a1', candidateId: 'c1', stage: 'screened' },
    ])
    mockCandidate.find.mockResolvedValue([
      { _id: 'c1', name: 'One', email: 'one@example.com' },
    ])
    mockApplication.bulkWrite.mockResolvedValue({ modifiedCount: 0 })

    await expect(
      updateJobStatus(CTX, 'j1', {
        status: 'closed',
        expectedStatus: 'open',
        operationId: OP_A,
        closeNote: 'Closing after review.',
      }),
    ).rejects.toMatchObject({ code: 'CLOSE_STAGE_RACE' })
    expect(mockEmailOutbox.create).not.toHaveBeenCalled()
  })

  it('revokes pending AI and guest authority in the close transaction and notifies runtime', async () => {
    const closedAt = new Date('2026-08-10T10:00:00.000Z')
    mockJob.findOne.mockResolvedValue(null)
    mockJob.findOneAndUpdate.mockResolvedValue({
      _id: 'j1',
      title: 'Backend Engineer',
      status: 'closed',
      closedAt,
      events: [],
    })
    mockRound.find.mockResolvedValue([
      { _id: 'r-pending', status: 'invited' },
      { _id: 'r-complete', status: 'completed' },
    ])
    mockApplication.find.mockResolvedValue([])

    await updateJobStatus(CTX, 'j1', {
      status: 'closed',
      expectedStatus: 'open',
      operationId: OP_A,
      closeNote: 'Role filled after review.',
    })

    expect(mockRound.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'ws-A',
        jobId: 'j1',
        status: { $nin: ['completed', 'revoked'] },
      }),
      expect.objectContaining({
        $set: expect.objectContaining({
          status: 'revoked',
          revocationState: 'pending',
          revocationReason: 'Job closed by recruiter',
        }),
        $unset: { live: 1 },
      }),
      { session },
    )
    expect(mockGuestSession.updateMany).toHaveBeenCalledWith(
      { workspaceId: 'ws-A', jobId: 'j1', active: true },
      expect.any(Object),
      { session },
    )
    expect(mockEngineHandoff.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ roundId: { $in: ['r-pending', 'r-complete'] } }),
      expect.any(Object),
      { session },
    )
    expect(mockInterviewAttempt.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: 'ws-A', jobId: 'j1', live: true }),
      expect.any(Object),
      { session },
    )
    expect(mockScheduleMediaPurge).toHaveBeenCalledWith({
      workspaceId: 'ws-A',
      jobId: 'j1',
      closedAt,
    })
    expect(mockDeliverRuntimeRevocation).toHaveBeenCalledOnce()
    expect(mockDeliverRuntimeRevocation).toHaveBeenCalledWith('ws-A', 'r-pending')
  })

  it('returns the prior result for a matching idempotent retry and rejects operation reuse', async () => {
    const prior = {
      _id: 'j1',
      events: [{ type: 'status_change', from: 'open', to: 'closed', operationId: OP_A }],
    }
    mockJob.findOne.mockResolvedValue(prior)

    await expect(
      updateJobStatus(CTX, 'j1', {
        status: 'closed',
        expectedStatus: 'open',
        operationId: OP_A,
        closeNote: 'Closing after review.',
      }),
    ).resolves.toBe(prior)
    expect(mockJob.findOneAndUpdate).not.toHaveBeenCalled()

    prior.events[0].to = 'on_hold'
    await expect(
      updateJobStatus(CTX, 'j1', {
        status: 'closed',
        expectedStatus: 'open',
        operationId: OP_A,
        closeNote: 'Closing after review.',
      }),
    ).rejects.toMatchObject({ code: 'OPERATION_ID_REUSED' })
  })
})

describe('addCandidate', () => {
  it('lowercases email and scopes the candidate to the workspace', async () => {
    mockCandidate.create.mockResolvedValue([{ _id: 'c1' }])
    await addCandidate(CTX, { name: 'Jane', email: 'Jane@Ex.com' })
    expect(mockCandidate.create.mock.calls[0][0][0]).toMatchObject({
      email: 'jane@ex.com',
      workspaceId: 'ws-A',
      source: 'manual',
      createdBy: 'u1',
      createdByMemberId: 'm1',
      createdByName: 'HR One',
    })
  })

  it('attributes a password-only write to the Hire member without a B2C User', async () => {
    const passwordOnly = {
      ...CTX,
      membership: { ...CTX.membership, userId: undefined },
    } as unknown as MembershipContext
    mockCandidate.create.mockResolvedValue([{ _id: 'c1' }])

    await addCandidate(passwordOnly, { name: 'Jane', email: 'jane@example.com' })

    const candidate = mockCandidate.create.mock.calls[0][0][0]
    expect(candidate).not.toHaveProperty('createdBy')
    expect(candidate).toMatchObject({
      createdByMemberId: 'm1',
      createdByName: 'HR One',
    })
  })

  it('maps duplicate email to a workspace-level conflict', async () => {
    mockCandidate.create.mockRejectedValue(Object.assign(new Error('dup'), { code: 11000 }))
    await expect(addCandidate(CTX, { name: 'J', email: 'j@x.com' })).rejects.toMatchObject({
      statusCode: 409,
      code: 'CANDIDATE_EXISTS',
    })
  })
})

describe('createApplication', () => {
  it('validates both job and candidate within the workspace', async () => {
    mockJob.findOne.mockResolvedValue({ _id: 'j1', status: 'open' })
    mockCandidate.findOne.mockResolvedValue(null)
    await expect(
      createApplication(CTX, { jobId: 'j1', candidateId: 'foreign' }),
    ).rejects.toMatchObject({ statusCode: 404 })
    expect(mockCandidate.findOne).toHaveBeenCalledWith({
      _id: 'foreign',
      workspaceId: 'ws-A',
    })
  })

  it('claims an open job and snapshots the Hire member actor in one transaction', async () => {
    mockJob.findOne.mockResolvedValue({ _id: 'j1', status: 'open' })
    mockCandidate.findOne.mockResolvedValue({ _id: 'c1' })
    mockJob.updateOne.mockResolvedValue({ matchedCount: 1 })
    mockApplication.create.mockImplementation(async (docs: unknown[]) => docs)

    await createApplication(CTX, { jobId: 'j1', candidateId: 'c1' })

    expect(mockJob.updateOne.mock.calls[0]).toEqual([
      { _id: 'j1', workspaceId: 'ws-A', status: 'open' },
      { $inc: { intakeWriteVersion: 1 } },
      { session },
    ])
    const [docs, options] = mockApplication.create.mock.calls[0]
    expect(options).toEqual({ session })
    expect(docs[0]).toMatchObject({
      workspaceId: 'ws-A',
      jobId: 'j1',
      candidateId: 'c1',
      createdByMemberId: 'm1',
      createdByName: 'HR One',
    })
    expect(docs[0].events[0]).toMatchObject({
      type: 'created',
      actorMemberId: 'm1',
      actorName: 'HR One',
    })
  })

  it('rejects intake on held jobs before writing', async () => {
    mockJob.findOne.mockResolvedValue({ _id: 'j1', status: 'on_hold' })
    mockCandidate.findOne.mockResolvedValue({ _id: 'c1' })
    await expect(
      createApplication(CTX, { jobId: 'j1', candidateId: 'c1' }),
    ).rejects.toMatchObject({ code: 'JOB_ON_HOLD' })
    expect(mockApplication.create).not.toHaveBeenCalled()
  })
})

describe('moveStage', () => {
  function armApp(stage: string, events: unknown[] = []) {
    mockApplication.findOne.mockResolvedValue({ _id: 'a1', jobId: 'j1', stage, events })
    mockJob.updateOne.mockResolvedValue({ matchedCount: 1 })
  }

  it('advances exactly one stage with explicit from-stage CAS and actor snapshot', async () => {
    armApp('new')
    mockApplication.findOneAndUpdate.mockResolvedValue({ _id: 'a1', stage: 'screened' })

    await moveStage(CTX, 'a1', { action: 'advance', expectedFrom: 'new', operationId: OP_A })

    expect(mockJob.updateOne.mock.calls[0][0]).toEqual({
      _id: 'j1',
      workspaceId: 'ws-A',
      status: 'open',
    })
    const [filter, update, options] = mockApplication.findOneAndUpdate.mock.calls[0]
    expect(filter).toEqual({
      _id: 'a1',
      workspaceId: 'ws-A',
      stage: 'new',
      'events.operationId': { $ne: OP_A },
    })
    expect(options).toEqual({ new: true, session })
    expect(update.$set.stage).toBe('screened')
    expect(update.$push.events).toMatchObject({
      type: 'stage_move',
      from: 'new',
      to: 'screened',
      actorMemberId: 'm1',
      actorName: 'HR One',
      operationId: OP_A,
    })
  })

  it('records accepted and declined offer outcomes explicitly', async () => {
    armApp('offer')
    mockApplication.findOneAndUpdate.mockResolvedValue({ _id: 'a1', stage: 'hired' })
    await moveStage(CTX, 'a1', {
      action: 'offer_accepted',
      expectedFrom: 'offer',
      operationId: OP_A,
      note: 'Accepted after references cleared.',
    })
    let update = mockApplication.findOneAndUpdate.mock.calls[0][1]
    expect(update.$set).toMatchObject({
      stage: 'hired',
      decisionNote: 'Accepted after references cleared.',
      offerDecision: {
        outcome: 'accepted',
        actorMemberId: 'm1',
        actorName: 'HR One',
      },
    })

    vi.clearAllMocks()
    session.withTransaction.mockImplementation(async (work: () => Promise<void>) => work())
    mockJob.db.startSession.mockResolvedValue(session)
    armApp('offer')
    mockApplication.findOneAndUpdate.mockResolvedValue({ _id: 'a1', stage: 'rejected' })
    await moveStage(CTX, 'a1', {
      action: 'offer_declined',
      expectedFrom: 'offer',
      operationId: OP_B,
      note: 'Candidate chose another role.',
    })
    update = mockApplication.findOneAndUpdate.mock.calls[0][1]
    expect(update.$set).toMatchObject({
      stage: 'rejected',
      decisionNote: 'Candidate chose another role.',
      offerDecision: { outcome: 'declined' },
    })
  })

  it('requires an acceptance note and never advances Offer ambiguously', async () => {
    armApp('offer')
    await expect(
      moveStage(CTX, 'a1', {
        action: 'offer_accepted',
        expectedFrom: 'offer',
        operationId: OP_A,
      }),
    ).rejects.toMatchObject({ code: 'DECISION_NOTE_REQUIRED' })
    await expect(
      moveStage(CTX, 'a1', { action: 'advance', expectedFrom: 'offer', operationId: OP_A }),
    ).rejects.toMatchObject({ code: 'OFFER_OUTCOME_REQUIRED' })
  })

  it('supports Withdrawn and freezes every terminal stage', async () => {
    armApp('interviewing')
    mockApplication.findOneAndUpdate.mockResolvedValue({ _id: 'a1', stage: 'withdrawn' })
    await moveStage(CTX, 'a1', {
      action: 'withdraw',
      expectedFrom: 'interviewing',
      operationId: OP_A,
    })
    expect(mockApplication.findOneAndUpdate.mock.calls[0][1].$set.stage).toBe('withdrawn')

    armApp('withdrawn')
    await expect(
      moveStage(CTX, 'a1', {
        action: 'reject',
        expectedFrom: 'withdrawn',
        operationId: OP_B,
      }),
    ).rejects.toMatchObject({ code: 'STAGE_TERMINAL' })
  })

  it('rejects stale expectedFrom and lost compare-and-set races', async () => {
    armApp('screened')
    await expect(
      moveStage(CTX, 'a1', { action: 'advance', expectedFrom: 'new', operationId: OP_A }),
    ).rejects.toMatchObject({ code: 'STAGE_RACE' })

    const initial = { _id: 'a1', jobId: 'j1', stage: 'new', events: [] }
    mockApplication.findOne.mockResolvedValueOnce(initial).mockResolvedValueOnce(null)
    mockJob.updateOne.mockResolvedValue({ matchedCount: 1 })
    mockApplication.findOneAndUpdate.mockResolvedValue(null)
    await expect(
      moveStage(CTX, 'a1', { action: 'advance', expectedFrom: 'new', operationId: OP_B }),
    ).rejects.toMatchObject({ code: 'STAGE_RACE' })
  })

  it('is idempotent only when operation id, from-stage, and target all match', async () => {
    const event = {
      type: 'stage_move',
      from: 'new',
      to: 'screened',
      operationId: OP_A,
    }
    armApp('screened', [event])
    await expect(
      moveStage(CTX, 'a1', { action: 'advance', expectedFrom: 'new', operationId: OP_A }),
    ).resolves.toMatchObject({ stage: 'screened' })
    expect(mockJob.updateOne).not.toHaveBeenCalled()

    event.to = 'rejected'
    await expect(
      moveStage(CTX, 'a1', { action: 'advance', expectedFrom: 'new', operationId: OP_A }),
    ).rejects.toMatchObject({ code: 'OPERATION_ID_REUSED' })
  })
})
