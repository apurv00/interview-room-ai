import { createHash } from 'crypto'
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
  mockHumanRound,
  mockInterviewKit,
  mockHumanScorecard,
  mockHumanKitDelivery,
  mockGuestSession,
  mockEngineHandoff,
  mockInterviewAttempt,
  mockRequirementVersion,
  mockEmailOutbox,
  mockInvitationBatch,
  mockInvitationBatchItem,
  mockSharePacket,
  mockScheduleMediaPurge,
  mockCancelMediaPurge,
  mockDeliverRuntimeRevocation,
  mockCandidatePiiFence,
  mockCancelAssessmentExports,
  mockDeleteAssessmentExports,
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
    mockCandidate: { create: vi.fn(), find: vi.fn(), findOne: vi.fn(), updateOne: vi.fn() },
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
    mockHumanRound: { find: vi.fn(), updateMany: vi.fn() },
    mockInterviewKit: { updateMany: vi.fn() },
    mockHumanScorecard: { find: vi.fn(), updateMany: vi.fn() },
    mockHumanKitDelivery: { find: vi.fn(), updateMany: vi.fn() },
    mockGuestSession: { updateMany: vi.fn() },
    mockEngineHandoff: { updateMany: vi.fn() },
    mockInterviewAttempt: { updateMany: vi.fn() },
    mockRequirementVersion: { create: vi.fn(), findOne: vi.fn() },
    mockEmailOutbox: { create: vi.fn(), find: vi.fn() },
    mockInvitationBatch: { updateMany: vi.fn() },
    mockInvitationBatchItem: { updateMany: vi.fn() },
    mockSharePacket: { updateMany: vi.fn() },
    mockScheduleMediaPurge: vi.fn(),
    mockCancelMediaPurge: vi.fn(),
    mockDeliverRuntimeRevocation: vi.fn(),
    mockCandidatePiiFence: vi.fn(),
    mockCancelAssessmentExports: vi.fn(),
    mockDeleteAssessmentExports: vi.fn(),
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
      updateOne: (...args: unknown[]) => mockCandidate.updateOne(...args),
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
    HireHumanRound: {
      find: (...args: unknown[]) => mockHumanRound.find(...args),
      updateMany: (...args: unknown[]) => mockHumanRound.updateMany(...args),
    },
    HireInterviewKit: {
      updateMany: (...args: unknown[]) => mockInterviewKit.updateMany(...args),
    },
    HireHumanScorecard: {
      find: (...args: unknown[]) => mockHumanScorecard.find(...args),
      updateMany: (...args: unknown[]) => mockHumanScorecard.updateMany(...args),
    },
    HireHumanKitDelivery: {
      find: (...args: unknown[]) => mockHumanKitDelivery.find(...args),
      updateMany: (...args: unknown[]) => mockHumanKitDelivery.updateMany(...args),
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
    HireInvitationBatch: {
      updateMany: (...args: unknown[]) => mockInvitationBatch.updateMany(...args),
    },
    HireInvitationBatchItem: {
      updateMany: (...args: unknown[]) => mockInvitationBatchItem.updateMany(...args),
    },
  }
})

vi.mock('../models/HireJobRequirementVersion', () => ({
  HireJobRequirementVersion: {
    create: (...args: unknown[]) => mockRequirementVersion.create(...args),
    findOne: (...args: unknown[]) => mockRequirementVersion.findOne(...args),
  },
}))

vi.mock('../models/HireEmailOutbox', () => ({
  HireEmailOutbox: {
    create: (...args: unknown[]) => mockEmailOutbox.create(...args),
    find: (...args: unknown[]) => mockEmailOutbox.find(...args),
  },
}))

vi.mock('@hire-decisions/models', () => ({
  HireSharePacket: {
    updateMany: (...args: unknown[]) => mockSharePacket.updateMany(...args),
  },
}))

vi.mock('../services/mediaLifecycleService', () => ({
  scheduleHireJobMediaPurge: (...args: unknown[]) => mockScheduleMediaPurge(...args),
  cancelFutureHireJobMediaPurge: (...args: unknown[]) => mockCancelMediaPurge(...args),
}))

vi.mock('../services/engineRevocationService', () => ({
  deliverRuntimeRevocation: (...args: unknown[]) => mockDeliverRuntimeRevocation(...args),
}))

vi.mock('../services/hireCandidatePrivacyWriteFence', () => ({
  claimHireCandidatePiiWriteFence: (...args: unknown[]) => mockCandidatePiiFence(...args),
  HireCandidatePiiTombstoneError: class HireCandidatePiiTombstoneError extends Error {},
}))

vi.mock('../services/assessmentExportLifecycleService', () => ({
  cancelHireAssessmentExports: (...args: unknown[]) => mockCancelAssessmentExports(...args),
  deleteHireAssessmentExportObjects: (...args: unknown[]) => mockDeleteAssessmentExports(...args),
}))

import {
  addCandidate,
  addOrMergeJobCandidate,
  createApplication,
  createJob,
  duplicateJob,
  getApplicationDetail,
  getJobPipeline,
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
  mockHumanRound.updateMany.mockResolvedValue({ modifiedCount: 0 })
  mockInterviewKit.updateMany.mockResolvedValue({ modifiedCount: 0 })
  mockHumanScorecard.updateMany.mockResolvedValue({ modifiedCount: 0 })
  mockHumanKitDelivery.updateMany.mockResolvedValue({ modifiedCount: 0 })
  mockHumanScorecard.find.mockReturnValue({ select: vi.fn().mockResolvedValue([]) })
  mockHumanKitDelivery.find.mockReturnValue({ select: vi.fn().mockResolvedValue([]) })
  mockGuestSession.updateMany.mockResolvedValue({ modifiedCount: 0 })
  mockEngineHandoff.updateMany.mockResolvedValue({ modifiedCount: 0 })
  mockInterviewAttempt.updateMany.mockResolvedValue({ modifiedCount: 0 })
  mockInvitationBatch.updateMany.mockResolvedValue({ modifiedCount: 0 })
  mockInvitationBatchItem.updateMany.mockResolvedValue({ modifiedCount: 0 })
  mockSharePacket.updateMany.mockResolvedValue({ modifiedCount: 0 })
  mockScheduleMediaPurge.mockResolvedValue({ purgeEligibleAt: new Date(), scheduled: 0 })
  mockCancelMediaPurge.mockResolvedValue(0)
  mockDeliverRuntimeRevocation.mockResolvedValue(true)
  mockCandidatePiiFence.mockResolvedValue(undefined)
  mockCancelAssessmentExports.mockResolvedValue([])
  mockDeleteAssessmentExports.mockResolvedValue(undefined)
  mockCandidate.updateOne.mockResolvedValue({ matchedCount: 1 })
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

  it('persists an independent optional screening-default snapshot with the job', async () => {
    mockJob.create.mockImplementation(async (docs: unknown[]) => docs)
    mockRequirementVersion.create.mockResolvedValue([])
    const screeningSettings = { location: 'Bengaluru, India', experienceFloorYears: 3 }

    await createJob(CTX, { ...JOB_INPUT, screeningSettings })

    const jobDocument = mockJob.create.mock.calls[0][0][0]
    expect(jobDocument.screeningSettings).toEqual(screeningSettings)
    expect(jobDocument.screeningSettings).not.toBe(screeningSettings)
  })
})

describe('duplicateJob', () => {
  const WORKSPACE_ID = '111111111111111111111111'
  const SOURCE_JOB_ID = '222222222222222222222222'
  const SOURCE_REQUIREMENT_ID = '333333333333333333333333'
  const DUPLICATE_CTX = {
    workspace: { _id: WORKSPACE_ID, name: 'Acme' },
    membership: {
      _id: '444444444444444444444444',
      userId: '555555555555555555555555',
      email: 'hr@acme.com',
      name: 'HR One',
      role: 'admin',
    },
  } as unknown as MembershipContext

  function sourceJob() {
    return {
      _id: SOURCE_JOB_ID,
      workspaceId: WORKSPACE_ID,
      title: 'Backend Engineer',
      jdText: '# Backend Engineer\n\nA reviewed job description.',
      status: 'closed',
      activeRequirementVersionId: SOURCE_REQUIREMENT_ID,
      activeRequirementVersion: 3,
      applyTokenHash: 'f'.repeat(64),
      applyPageEnabled: false,
      screeningSettings: {
        location: 'Bengaluru, India',
        experienceFloorYears: 5,
      },
      closeNote: 'Previous search closed.',
      events: [{ type: 'status_change', from: 'open', to: 'closed' }],
    }
  }

  function sourceRequirement() {
    return {
      _id: SOURCE_REQUIREMENT_ID,
      workspaceId: WORKSPACE_ID,
      jobId: SOURCE_JOB_ID,
      version: 3,
      state: 'active',
      input: {
        role: 'Backend Engineer',
        level: 'Senior',
        mustHaves: ['Production TypeScript'],
        niceToHaves: ['Kafka'],
        location: 'Bengaluru, India',
        workMode: 'hybrid',
        compensation: '₹30–40L',
        companyBlurb: 'A focused product team.',
      },
      proseJd: '# Backend Engineer\n\nA reviewed job description.',
      requirements: [
        { id: 'must-1', text: 'Production TypeScript', importance: 'must_have' },
        { id: 'nice-1', text: 'Kafka', importance: 'nice_to_have' },
      ],
      contentHash: 'a'.repeat(64),
    }
  }

  it('copies only the source job configuration into a fresh open job and apply link', async () => {
    const source = sourceJob()
    const requirement = sourceRequirement()
    mockJob.findOne.mockResolvedValue(source)
    mockRequirementVersion.findOne.mockResolvedValue(requirement)
    mockJob.create.mockImplementation(async (docs: unknown[]) => docs)
    mockRequirementVersion.create.mockResolvedValue([])

    const duplicated = await duplicateJob(DUPLICATE_CTX, SOURCE_JOB_ID)

    const [sourceFilter, sourceProjection, sourceOptions] = mockJob.findOne.mock.calls[0]
    expect(sourceFilter).toEqual({ _id: SOURCE_JOB_ID, workspaceId: WORKSPACE_ID })
    expect(sourceProjection).toBeNull()
    expect(sourceOptions).toEqual({ session })
    expect(mockRequirementVersion.findOne).toHaveBeenCalledWith(
      {
        _id: SOURCE_REQUIREMENT_ID,
        workspaceId: WORKSPACE_ID,
        jobId: SOURCE_JOB_ID,
        version: 3,
        state: 'active',
      },
      null,
      { session },
    )

    const [jobDocs, jobOptions] = mockJob.create.mock.calls[0]
    const [versionDocs, versionOptions] = mockRequirementVersion.create.mock.calls[0]
    const job = jobDocs[0]
    const version = versionDocs[0]
    const rawSecret = duplicated.capability.split('.')[1]

    expect(duplicated.capability).toMatch(new RegExp(`^${WORKSPACE_ID}\\.[a-f0-9]{64}$`))
    expect(jobOptions).toEqual({ session })
    expect(versionOptions).toEqual({ session })
    expect(job).toMatchObject({
      workspaceId: WORKSPACE_ID,
      title: source.title,
      jdText: source.jdText,
      activeRequirementVersion: 1,
      status: 'open',
      intakeWriteVersion: 0,
      applyPageEnabled: true,
      screeningSettings: source.screeningSettings,
      events: [],
      createdBy: '555555555555555555555555',
      createdByMemberId: '444444444444444444444444',
      createdByName: 'HR One',
    })
    expect(String(job._id)).not.toBe(SOURCE_JOB_ID)
    expect(job.screeningSettings).not.toBe(source.screeningSettings)
    expect(String(job.activeRequirementVersionId)).toBe(String(version._id))
    expect(job).not.toHaveProperty('closeNote')
    expect(job).not.toHaveProperty('closedAt')
    expect(job.applyTokenHash).toBe(
      createHash('sha256').update(rawSecret).digest('hex'),
    )
    expect(version).toMatchObject({
      workspaceId: WORKSPACE_ID,
      version: 1,
      state: 'active',
      input: requirement.input,
      proseJd: requirement.proseJd,
      requirements: requirement.requirements,
      contentHash: requirement.contentHash,
      createdByMemberId: '444444444444444444444444',
      createdByName: 'HR One',
    })
    expect(String(version.jobId)).toBe(String(job._id))
    expect(version.input).not.toBe(requirement.input)
    expect(version.requirements).not.toBe(requirement.requirements)
    expect(JSON.stringify([jobDocs, versionDocs])).not.toContain(rawSecret)
    expect(mockCandidate.create).not.toHaveBeenCalled()
    expect(mockCandidate.find).not.toHaveBeenCalled()
    expect(mockApplication.create).not.toHaveBeenCalled()
    expect(mockApplication.find).not.toHaveBeenCalled()
  })

  it('does not create a duplicate when the active source requirement is missing', async () => {
    mockJob.findOne.mockResolvedValue(sourceJob())
    mockRequirementVersion.findOne.mockResolvedValue(null)

    await expect(duplicateJob(DUPLICATE_CTX, SOURCE_JOB_ID)).rejects.toMatchObject({
      code: 'JOB_REQUIREMENT_VERSION_INVALID',
    })

    expect(mockJob.create).not.toHaveBeenCalled()
    expect(mockRequirementVersion.create).not.toHaveBeenCalled()
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

  it('freezes a rendered custom close email for each recipient inside the outbox transaction', async () => {
    mockJob.findOne.mockResolvedValue(null)
    mockJob.findOneAndUpdate.mockResolvedValue({
      _id: 'j1',
      title: 'Backend Engineer',
      status: 'closed',
      events: [],
    })
    mockApplication.find.mockResolvedValue([
      { _id: 'a1', candidateId: 'c1', stage: 'screened' },
    ])
    mockCandidate.find.mockResolvedValue([
      { _id: 'c1', name: 'Ada Lovelace', email: 'ada@example.com' },
    ])
    mockApplication.bulkWrite.mockResolvedValue({ modifiedCount: 1 })
    mockEmailOutbox.create.mockResolvedValue([])

    await updateJobStatus(CTX, 'j1', {
      status: 'closed',
      expectedStatus: 'open',
      operationId: OP_A,
      closeNote: 'Internal: selected another candidate after panel review.',
      closeEmailTemplate: {
        subject: '{workspace_name}: update for {candidate_first_name}',
        body: 'Hi {candidate_first_name},\n\n{job_title} at {workspace_name} has closed. <b>Thank you.</b>',
      },
    })

    const [outboxDocs, outboxOptions] = mockEmailOutbox.create.mock.calls[0]
    expect(outboxOptions).toEqual({ session })
    expect(outboxDocs).toHaveLength(1)
    expect(outboxDocs[0].payload).toMatchObject({
      emailSnapshot: {
        subject: 'Acme: update for Ada',
        body: 'Hi Ada,\n\nBackend Engineer at Acme has closed. <b>Thank you.</b>',
      },
      decisionNote: 'Internal: selected another candidate after panel review.',
    })
    expect(outboxDocs[0].payload.emailSnapshot.body).not.toContain('selected another candidate')
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
    const assessmentExportTarget = {
      key: 'hire-assessment-exports/v1/ws/job/app/candidate/export.pdf',
      coordinate: {
        workspaceId: 'ws-A',
        jobId: 'j1',
        applicationId: 'a1',
        candidateId: 'c1',
        exportId: 'e1',
      },
    }
    mockCancelAssessmentExports.mockResolvedValueOnce([assessmentExportTarget])
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
    expect(mockHumanKitDelivery.updateMany).toHaveBeenCalledWith(
      {
        workspaceId: 'ws-A',
        jobId: 'j1',
        status: { $in: ['pending', 'sending', 'failed'] },
      },
      expect.objectContaining({
        $set: expect.objectContaining({ status: 'cancelled' }),
        $unset: { claimToken: 1, leaseExpiresAt: 1 },
      }),
      { session },
    )
    expect(mockInterviewKit.updateMany).toHaveBeenCalledWith(
      { workspaceId: 'ws-A', jobId: 'j1', active: true },
      expect.objectContaining({
        $set: expect.objectContaining({
          status: 'revoked',
          active: false,
          revokedByMemberId: 'm1',
          revokedByName: 'HR One',
          revocationReason: 'Job closed by recruiter',
        }),
      }),
      { session },
    )
    expect(mockHumanScorecard.updateMany).toHaveBeenCalledWith(
      { workspaceId: 'ws-A', jobId: 'j1', status: 'draft' },
      expect.objectContaining({ $set: expect.objectContaining({ status: 'cancelled' }) }),
      { session },
    )
    expect(mockHumanRound.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'ws-A',
        jobId: 'j1',
        status: { $nin: ['completed', 'revoked'] },
      }),
      expect.objectContaining({
        $set: expect.objectContaining({
          status: 'revoked',
          revokedByMemberId: 'm1',
          revokedByName: 'HR One',
          revocationReason: 'Job closed by recruiter',
        }),
      }),
      { session },
    )
    expect(mockSharePacket.updateMany).toHaveBeenCalledWith(
      {
        workspaceId: 'ws-A',
        jobId: 'j1',
        active: true,
        status: 'active',
        revokedAt: { $exists: false },
      },
      {
        $set: {
          active: false,
          status: 'revoked',
          revokedAt: expect.any(Date),
          revokedByMemberId: 'm1',
          revokedByName: 'HR One',
          revocationReason: 'Job closed by recruiter',
        },
      },
      { session },
    )
    expect(mockCancelAssessmentExports).toHaveBeenCalledWith({
      scope: { workspaceId: 'ws-A', jobId: 'j1' },
      cancelledAt: expect.any(Date),
      session,
    })
    expect(mockDeleteAssessmentExports).toHaveBeenCalledWith([assessmentExportTarget])
    expect(mockCancelAssessmentExports.mock.invocationCallOrder[0]).toBeLessThan(
      mockDeleteAssessmentExports.mock.invocationCallOrder[0],
    )
    expect(mockInvitationBatchItem.updateMany).toHaveBeenCalledWith(
      {
        workspaceId: 'ws-A',
        jobId: 'j1',
        status: { $in: ['pending', 'sending', 'failed'] },
      },
      expect.objectContaining({
        $set: expect.objectContaining({ status: 'cancelled' }),
        $unset: { claimToken: 1, leaseExpiresAt: 1 },
      }),
      { session },
    )
    expect(mockInvitationBatch.updateMany).toHaveBeenCalledWith(
      {
        workspaceId: 'ws-A',
        jobId: 'j1',
        status: { $in: ['planned', 'scheduled', 'dispatching', 'failed'] },
      },
      expect.objectContaining({
        $set: expect.objectContaining({
          status: 'cancelled',
          cancelledByMemberId: 'm1',
          cancelledByName: 'HR One',
        }),
      }),
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

describe('getJobPipeline', () => {
  it('ranks only fresh scores and batch-enriches same-workspace prior jobs', async () => {
    const resumeHash = (value: string) => createHash('sha256').update(value).digest('hex')
    const currentJd = 'Current reviewed job description'
    const scoredAt = new Date('2026-08-12T00:00:00.000Z')
    const applications = [
      {
        _id: 'a-low',
        workspaceId: 'ws-A',
        jobId: 'j1',
        candidateId: 'c-low',
        stage: 'new',
        createdAt: new Date('2026-08-12T00:03:00.000Z'),
        resumeMatch: {
          score: 80,
          strengths: [],
          gaps: [],
          scoredAt,
          jdHash: resumeHash(currentJd),
          resumeHash: resumeHash('low current'),
        },
      },
      {
        _id: 'a-high',
        workspaceId: 'ws-A',
        jobId: 'j1',
        candidateId: 'c-high',
        stage: 'screened',
        createdAt: new Date('2026-08-12T00:04:00.000Z'),
        resumeMatch: {
          score: 95,
          strengths: [],
          gaps: [],
          scoredAt,
          jdHash: resumeHash(currentJd),
          resumeHash: resumeHash('high current'),
        },
      },
      {
        _id: 'a-stale',
        workspaceId: 'ws-A',
        jobId: 'j1',
        candidateId: 'c-stale',
        stage: 'new',
        createdAt: new Date('2026-08-12T00:01:00.000Z'),
        resumeMatch: {
          score: 100,
          strengths: [],
          gaps: [],
          scoredAt,
          jdHash: resumeHash(currentJd),
          resumeHash: resumeHash('old resume'),
        },
      },
      {
        _id: 'a-unscored',
        workspaceId: 'ws-A',
        jobId: 'j1',
        candidateId: 'c-unscored',
        stage: 'new',
        createdAt: new Date('2026-08-12T00:02:00.000Z'),
      },
    ]
    mockJob.findOne.mockResolvedValue({ _id: 'j1', workspaceId: 'ws-A', jdText: currentJd })
    mockApplication.find
      .mockImplementationOnce(() => ({
        sort: vi.fn().mockResolvedValue(applications),
      }))
      .mockImplementationOnce(() => ({
        select: vi.fn().mockResolvedValue([
          {
            _id: 'past-low',
            workspaceId: 'ws-A',
            jobId: 'j-old',
            candidateId: 'c-low',
            stage: 'offer',
          },
          // This is intentionally an in-workspace row for another candidate;
          // it must not leak onto c-low's card.
          {
            _id: 'past-high',
            workspaceId: 'ws-A',
            jobId: 'j-other',
            candidateId: 'c-high',
            stage: 'rejected',
          },
        ]),
      }))
    mockCandidate.find.mockResolvedValue([
      { _id: 'c-low', workspaceId: 'ws-A', resumeText: 'low current' },
      { _id: 'c-high', workspaceId: 'ws-A', resumeText: 'high current' },
      { _id: 'c-stale', workspaceId: 'ws-A', resumeText: 'new resume' },
      { _id: 'c-unscored', workspaceId: 'ws-A', resumeText: 'unscored current' },
    ])
    mockRound.find.mockReturnValue({
      sort: vi.fn().mockReturnValue({ select: vi.fn().mockResolvedValue([]) }),
    })
    mockHumanRound.find.mockReturnValue({
      sort: vi.fn().mockReturnValue({ select: vi.fn().mockResolvedValue([
        {
          _id: 'human-1',
          applicationId: 'a-low',
          mode: 'guest_kit',
          status: 'completed',
          createdAt: new Date('2026-08-12T00:05:00.000Z'),
        },
        {
          _id: 'human-2',
          applicationId: 'a-low',
          mode: 'member_room',
          status: 'pending_scorecard',
          createdAt: new Date('2026-08-12T00:06:00.000Z'),
        },
      ]) }),
    })
    mockJob.find.mockReturnValue({
      select: vi.fn().mockResolvedValue([
        { _id: 'j-old', workspaceId: 'ws-A', title: 'Earlier role' },
        { _id: 'j-other', workspaceId: 'ws-A', title: 'Other role' },
      ]),
    })

    const result = await getJobPipeline(CTX, 'j1')

    expect(mockApplication.find.mock.calls[0][0]).toEqual({
      workspaceId: 'ws-A',
      jobId: 'j1',
    })
    expect(mockApplication.find.mock.calls[1][0]).toEqual({
      workspaceId: 'ws-A',
      candidateId: { $in: ['c-low', 'c-high', 'c-stale', 'c-unscored'] },
      jobId: { $ne: 'j1' },
    })
    expect(mockJob.find).toHaveBeenCalledWith({
      workspaceId: 'ws-A',
      _id: { $in: ['j-old', 'j-other'] },
    })
    expect(result.entries.map((entry) => entry.application._id)).toEqual([
      'a-high',
      'a-low',
      'a-stale',
      'a-unscored',
    ])
    expect(result.entries.map((entry) => [entry.scoreState, entry.rank])).toEqual([
      ['scored', 1],
      ['scored', 2],
      ['stale', null],
      ['unscored', null],
    ])
    expect(result.entries[1].previouslySeenIn).toEqual([
      { jobId: 'j-old', jobTitle: 'Earlier role', stage: 'offer' },
    ])
    expect(result.entries[0].previouslySeenIn).toEqual([
      { jobId: 'j-other', jobTitle: 'Other role', stage: 'rejected' },
    ])
    expect(result.entries[2].previouslySeenIn).toEqual([])
    expect(result.entries.find((entry) => entry.application._id === 'a-low')?.humanRoundSummary)
      .toMatchObject({ total: 2, completed: 1, pendingScorecard: 1, revoked: 0 })
    expect(result.entries.find((entry) => entry.application._id === 'a-low')?.humanRoundSummary.rounds)
      .toHaveLength(2)
    expect(result.entries.find((entry) => entry.application._id === 'a-high')?.humanRoundSummary)
      .toMatchObject({ total: 0, completed: 0, pendingScorecard: 0, revoked: 0 })
  })
})

describe('getApplicationDetail', () => {
  it('returns human evidence separately from AI rounds with exact workspace coordinates and no delivery PII', async () => {
    mockApplication.findOne.mockResolvedValue({
      _id: 'app-1',
      workspaceId: 'ws-A',
      candidateId: 'candidate-1',
      jobId: 'job-1',
    })
    mockCandidate.findOne.mockResolvedValue({ _id: 'candidate-1', workspaceId: 'ws-A' })
    mockJob.findOne.mockResolvedValue({ _id: 'job-1', workspaceId: 'ws-A' })
    mockRound.find.mockReturnValue({
      sort: vi.fn().mockResolvedValue([{ _id: 'ai-1', applicationId: 'app-1' }]),
    })
    mockHumanRound.find.mockReturnValue({
      sort: vi.fn().mockResolvedValue([
        { _id: 'human-1', applicationId: 'app-1', mode: 'member_room' },
      ]),
    })
    mockHumanScorecard.find.mockReturnValue({
      select: vi.fn().mockResolvedValue([
        {
          humanRoundId: 'human-1',
          reviewerKind: 'member',
          reviewerName: 'HR One',
          dimensions: [{ key: 'role_capability', rating: 4, evidence: 'Clear example' }],
          recommendation: 'yes',
          overallComment: 'Proceed.',
          submittedAt: new Date('2026-08-13T01:00:00.000Z'),
        },
      ]),
    })
    mockHumanKitDelivery.find.mockReturnValue({
      select: vi.fn().mockResolvedValue([
        {
          humanRoundId: 'human-1',
          purpose: 'initial',
          status: 'failed',
          attempts: 5,
          sentAt: undefined,
          recipientEmail: 'must-not-project@example.com',
          ciphertext: 'must-not-project',
        },
      ]),
    })

    const detail = await getApplicationDetail(CTX, 'app-1')

    expect(detail.rounds).toEqual([{ _id: 'ai-1', applicationId: 'app-1' }])
    expect(detail.humanRounds).toEqual([
      {
        round: { _id: 'human-1', applicationId: 'app-1', mode: 'member_room' },
        scorecard: expect.objectContaining({
          reviewerKind: 'member',
          recommendation: 'yes',
          overallComment: 'Proceed.',
        }),
        delivery: {
          initial: {
            status: 'failed',
            attempts: 5,
            sentAt: undefined,
          },
          reminder: null,
        },
      },
    ])
    expect(mockRound.find).toHaveBeenCalledWith({
      workspaceId: 'ws-A',
      applicationId: 'app-1',
    })
    expect(mockHumanRound.find).toHaveBeenCalledWith({
      workspaceId: 'ws-A',
      applicationId: 'app-1',
    })
    expect(mockHumanScorecard.find).toHaveBeenCalledWith({
      workspaceId: 'ws-A',
      applicationId: 'app-1',
      jobId: 'job-1',
      candidateId: 'candidate-1',
      status: 'submitted',
    })
    expect(mockHumanKitDelivery.find).toHaveBeenCalledWith({
      workspaceId: 'ws-A',
      applicationId: 'app-1',
      jobId: 'job-1',
      candidateId: 'candidate-1',
      purpose: { $in: ['initial', 'reminder'] },
    })
    expect(JSON.stringify(detail.humanRounds)).not.toContain('must-not-project@example.com')
    expect(JSON.stringify(detail.humanRounds)).not.toContain('must-not-project')
  })
})

describe('addOrMergeJobCandidate', () => {
  const OPEN_JOB = { _id: 'j1', workspaceId: 'ws-A', status: 'open' }
  const EXISTING_CANDIDATE = {
    _id: 'c1',
    workspaceId: 'ws-A',
    name: 'Jane Candidate',
    email: 'jane@example.com',
    source: 'apply_page',
    sourceHistory: ['apply_page'],
  }

  function application(
    overrides: Record<string, unknown> = {},
  ) {
    return {
      _id: 'a1',
      workspaceId: 'ws-A',
      jobId: 'j1',
      candidateId: 'c1',
      stage: 'screened',
      events: [],
      ...overrides,
    }
  }

  function armManualExisting(
    existingApplication: Record<string, unknown> | null,
  ) {
    mockJob.findOne.mockResolvedValue(OPEN_JOB)
    mockCandidate.findOne.mockResolvedValue(EXISTING_CANDIDATE)
    mockApplication.findOne.mockResolvedValue(existingApplication)
    mockJob.updateOne.mockResolvedValue({ matchedCount: 1 })
  }

  it('does not disclose or accept a guessed cross-tenant pool candidate id', async () => {
    mockJob.findOne.mockResolvedValue(OPEN_JOB)
    mockCandidate.findOne.mockResolvedValue(null)

    await expect(
      addOrMergeJobCandidate(CTX, 'j1', {
        candidateId: 'foreign-candidate',
        operationId: OP_A,
      }),
    ).rejects.toMatchObject({ statusCode: 404, code: 'NOT_FOUND' })

    expect(mockCandidate.findOne).toHaveBeenCalledWith(
      { _id: 'foreign-candidate', workspaceId: 'ws-A' },
      null,
      { session },
    )
    expect(mockApplication.create).not.toHaveBeenCalled()
  })

  it('treats an email known only in another workspace as a new local candidate', async () => {
    mockJob.findOne.mockResolvedValue(OPEN_JOB)
    // This is what a cross-tenant email looks like here: the only lookup is
    // workspace-scoped, so the foreign record is indistinguishable from none.
    mockCandidate.findOne.mockResolvedValue(null)
    mockCandidate.create.mockImplementation(async (docs: Array<Record<string, unknown>>) => [
      { ...docs[0], _id: 'c-local' },
    ])
    mockApplication.findOne.mockResolvedValue(null)
    mockJob.updateOne.mockResolvedValue({ matchedCount: 1 })
    mockApplication.create.mockImplementation(async (docs: unknown[]) => docs)

    const result = await addOrMergeJobCandidate(CTX, 'j1', {
      name: 'Jane Candidate',
      email: 'jane@example.com',
      operationId: OP_A,
    })

    expect(result).toMatchObject({
      status: 'created',
      createdCandidate: true,
      createdApplication: true,
    })
    expect(mockCandidate.findOne).toHaveBeenCalledWith(
      { workspaceId: 'ws-A', email: 'jane@example.com' },
      null,
      { session },
    )
    expect(mockCandidate.create.mock.calls[0][0][0]).toMatchObject({
      workspaceId: 'ws-A',
      email: 'jane@example.com',
      source: 'manual',
      sourceHistory: ['manual'],
    })
  })

  it('merges a same-workspace manual email into the same active card with provenance and actor snapshots', async () => {
    const existing = application()
    const updated = application({
      events: [
        {
          type: 'source_merged',
          actorMemberId: 'm1',
          actorName: 'HR One',
          operationId: OP_A,
        },
        {
          type: 'reapplied',
          actorMemberId: 'm1',
          actorName: 'HR One',
          operationId: OP_A,
        },
      ],
    })
    armManualExisting(existing)
    mockApplication.findOneAndUpdate.mockResolvedValue(updated)

    const result = await addOrMergeJobCandidate(CTX, 'j1', {
      name: 'Jane Candidate',
      email: 'JANE@example.com',
      operationId: OP_A,
    })

    expect(result).toMatchObject({
      status: 'reapplied',
      createdCandidate: false,
      createdApplication: false,
      sourceMerged: true,
    })
    expect(mockCandidate.findOne).toHaveBeenCalledWith(
      { workspaceId: 'ws-A', email: 'jane@example.com' },
      null,
      { session },
    )
    expect(mockCandidate.updateOne).toHaveBeenCalledWith(
      {
        _id: 'c1',
        workspaceId: 'ws-A',
        piiAnonymizedAt: { $exists: false },
      },
      { $addToSet: { sourceHistory: { $each: ['manual'] } } },
      { session, runValidators: true },
    )
    expect(mockCandidatePiiFence).toHaveBeenCalledWith({
      workspaceId: 'ws-A',
      candidateId: 'c1',
      session,
    })
    expect(mockApplication.create).not.toHaveBeenCalled()
    const [filter, update, options] = mockApplication.findOneAndUpdate.mock.calls[0]
    expect(filter).toEqual({
      _id: 'a1',
      workspaceId: 'ws-A',
      jobId: 'j1',
      candidateId: 'c1',
      'events.operationId': { $ne: OP_A },
    })
    expect(options).toMatchObject({ new: true, session, runValidators: true })
    expect(update.$push.events.$each).toEqual([
      expect.objectContaining({
        type: 'source_merged',
        actorMemberId: 'm1',
        actorUserId: 'u1',
        actorName: 'HR One',
        note: 'Candidate source recorded: manual entry',
        operationId: OP_A,
      }),
      expect.objectContaining({
        type: 'reapplied',
        actorMemberId: 'm1',
        actorUserId: 'u1',
        actorName: 'HR One',
        note: 'Candidate re-applied via manual entry',
        operationId: OP_A,
      }),
    ])
  })

  it('treats a same-operation retry as the existing application instead of appending another card/event', async () => {
    const existing = application({
      events: [{ type: 'reapplied', operationId: OP_A }],
    })
    armManualExisting(existing)

    const result = await addOrMergeJobCandidate(CTX, 'j1', {
      name: 'Jane Candidate',
      email: 'jane@example.com',
      operationId: OP_A,
    })

    expect(result).toMatchObject({
      status: 'reapplied',
      createdCandidate: false,
      createdApplication: false,
      sourceMerged: false,
    })
    expect(mockJob.updateOne).not.toHaveBeenCalled()
    expect(mockCandidate.updateOne).not.toHaveBeenCalled()
    expect(mockApplication.findOneAndUpdate).not.toHaveBeenCalled()
    expect(mockApplication.create).not.toHaveBeenCalled()
  })

  it('recovers a concurrent per-job uniqueness race as the one existing application', async () => {
    const winner = application()
    mockJob.findOne.mockResolvedValue(OPEN_JOB)
    mockCandidate.findOne.mockResolvedValue(EXISTING_CANDIDATE)
    mockApplication.findOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(winner)
    mockJob.updateOne.mockResolvedValue({ matchedCount: 1 })
    mockApplication.create.mockRejectedValueOnce(Object.assign(new Error('dup'), { code: 11000 }))
    mockApplication.findOneAndUpdate.mockResolvedValue(application({ events: [] }))

    const result = await addOrMergeJobCandidate(CTX, 'j1', {
      candidateId: 'c1',
      operationId: OP_B,
    })

    expect(result).toMatchObject({
      status: 'reapplied',
      createdCandidate: false,
      createdApplication: false,
    })
    expect(mockApplication.create).toHaveBeenCalledTimes(1)
    expect(mockApplication.findOneAndUpdate).toHaveBeenCalledTimes(1)
  })

  it('reuses the workspace candidate on a different job and creates exactly one new application', async () => {
    const secondJob = { ...OPEN_JOB, _id: 'j2' }
    mockJob.findOne.mockResolvedValue(secondJob)
    mockCandidate.findOne.mockResolvedValue(EXISTING_CANDIDATE)
    mockApplication.findOne.mockResolvedValue(null)
    mockJob.updateOne.mockResolvedValue({ matchedCount: 1 })
    mockApplication.create.mockImplementation(async (docs: unknown[]) => docs)

    const result = await addOrMergeJobCandidate(CTX, 'j2', {
      name: 'Jane Candidate',
      email: 'jane@example.com',
      operationId: OP_A,
    })

    expect(result).toMatchObject({
      status: 'created',
      candidate: EXISTING_CANDIDATE,
      createdCandidate: false,
      createdApplication: true,
      sourceMerged: true,
    })
    expect(mockCandidate.create).not.toHaveBeenCalled()
    expect(mockApplication.create.mock.calls[0][0][0]).toMatchObject({
      workspaceId: 'ws-A',
      jobId: 'j2',
      candidateId: 'c1',
      createdByMemberId: 'm1',
      createdByName: 'HR One',
      events: [
        expect.objectContaining({
          type: 'created',
          note: 'Added via manual entry',
          operationId: OP_A,
          actorMemberId: 'm1',
        }),
      ],
    })
  })

  it('fails closed for a rejected candidate and never automatically revives the card', async () => {
    const rejected = application({ stage: 'rejected' })
    armManualExisting(rejected)

    const result = await addOrMergeJobCandidate(CTX, 'j1', {
      name: 'Jane Candidate',
      email: 'jane@example.com',
      operationId: OP_A,
    })

    expect(result).toMatchObject({
      status: 'already_considered',
      createdApplication: false,
    })
    expect(mockJob.updateOne).not.toHaveBeenCalled()
    expect(mockCandidate.updateOne).not.toHaveBeenCalled()
    expect(mockApplication.create).not.toHaveBeenCalled()
    expect(mockApplication.findOneAndUpdate).not.toHaveBeenCalled()
  })
})

describe('moveStage', () => {
  function armApp(stage: string, events: unknown[] = []) {
    mockApplication.findOne.mockResolvedValue({ _id: 'a1', jobId: 'j1', candidateId: 'c1', stage, events })
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

  it('atomically shuts down active human-kit lifecycle rows on a terminal stage', async () => {
    armApp('interviewing')
    mockApplication.findOneAndUpdate.mockResolvedValue({ _id: 'a1', stage: 'rejected' })
    const assessmentExportTarget = {
      key: 'hire-assessment-exports/v1/ws/job/app/candidate/export.pdf',
      coordinate: {
        workspaceId: 'ws-A',
        jobId: 'j1',
        applicationId: 'a1',
        candidateId: 'c1',
        exportId: 'e1',
      },
    }
    mockCancelAssessmentExports.mockResolvedValueOnce([assessmentExportTarget])

    await moveStage(CTX, 'a1', {
      action: 'reject',
      expectedFrom: 'interviewing',
      operationId: OP_A,
      note: 'Candidate withdrew from consideration.',
    })

    const scope = {
      workspaceId: 'ws-A',
      applicationId: 'a1',
      jobId: 'j1',
      candidateId: 'c1',
    }
    expect(mockHumanKitDelivery.updateMany).toHaveBeenCalledWith(
      { ...scope, status: { $in: ['pending', 'sending', 'failed'] } },
      expect.objectContaining({
        $set: expect.objectContaining({
          status: 'cancelled',
          lastError: 'Application reached a terminal stage',
        }),
        $unset: { claimToken: 1, leaseExpiresAt: 1 },
      }),
      { session },
    )
    expect(mockInterviewKit.updateMany).toHaveBeenCalledWith(
      { ...scope, active: true },
      expect.objectContaining({
        $set: expect.objectContaining({
          active: false,
          status: 'revoked',
          revokedByMemberId: 'm1',
          revokedByName: 'HR One',
          revocationReason: 'Application moved to terminal stage: rejected',
        }),
      }),
      { session },
    )
    expect(mockHumanScorecard.updateMany).toHaveBeenCalledWith(
      { ...scope, status: 'draft' },
      expect.objectContaining({ $set: expect.objectContaining({ status: 'cancelled' }) }),
      { session },
    )
    expect(mockHumanRound.updateMany).toHaveBeenCalledWith(
      { ...scope, status: { $nin: ['completed', 'revoked'] } },
      expect.objectContaining({
        $set: expect.objectContaining({
          status: 'revoked',
          revokedByMemberId: 'm1',
          revokedByName: 'HR One',
          revocationReason: 'Application moved to terminal stage: rejected',
        }),
      }),
      { session },
    )
    expect(mockSharePacket.updateMany).toHaveBeenCalledWith(
      {
        ...scope,
        active: true,
        status: 'active',
        revokedAt: { $exists: false },
      },
      expect.objectContaining({
        $set: expect.objectContaining({
          active: false,
          status: 'revoked',
          revokedByMemberId: 'm1',
          revokedByName: 'HR One',
          revocationReason: 'Application moved to terminal stage: rejected',
        }),
      }),
      { session },
    )
    expect(mockCancelAssessmentExports).toHaveBeenCalledWith({
      scope,
      cancelledAt: expect.any(Date),
      session,
    })
    expect(mockDeleteAssessmentExports).toHaveBeenCalledWith([assessmentExportTarget])
    expect(mockRound.updateMany).not.toHaveBeenCalled()
    expect(mockDeliverRuntimeRevocation).not.toHaveBeenCalled()
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
    expect(mockHumanKitDelivery.updateMany).not.toHaveBeenCalled()
    expect(mockInterviewKit.updateMany).not.toHaveBeenCalled()
    expect(mockHumanScorecard.updateMany).not.toHaveBeenCalled()
    expect(mockHumanRound.updateMany).not.toHaveBeenCalled()
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
