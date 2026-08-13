import mongoose from 'mongoose'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AppError } from '@shared/errors'

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  send: vi.fn(),
  parseDocument: vi.fn(),
  supportedDocument: vi.fn(),
  resolveApplyToken: vi.fn(),
  resolveAuthority: vi.fn(),
  intakeCandidate: vi.fn(),
  intakeFromApplyPage: vi.fn(),
  analyzeResume: vi.fn(),
  extractEmails: vi.fn(),
  writeFence: vi.fn(),
  candidateFence: vi.fn(),
  jobFindOne: vi.fn(),
  jobUpdateOne: vi.fn(),
  candidateFindOne: vi.fn(),
  privacyExists: vi.fn(),
  taskCreate: vi.fn(),
  taskFind: vi.fn(),
  taskFindOne: vi.fn(),
  taskFindOneAndUpdate: vi.fn(),
  taskExists: vi.fn(),
  taskUpdateOne: vi.fn(),
  taskUpdateMany: vi.fn(),
  jobExists: vi.fn(),
  workspaceFindOne: vi.fn(),
  workspaceExists: vi.fn(),
  memberFindOne: vi.fn(),
  memberExists: vi.fn(),
  loggerWarn: vi.fn(),
}))

vi.mock('../services/hireControlBoundary', () => ({
  connectHireControlDB: (...args: unknown[]) => mocks.connect(...args),
}))
vi.mock('@shared/services/inngest', () => ({
  inngest: { send: (...args: unknown[]) => mocks.send(...args) },
}))
vi.mock('@shared/services/documentParser', () => ({
  parseDocument: (...args: unknown[]) => mocks.parseDocument(...args),
  isSupportedDocumentType: (...args: unknown[]) => mocks.supportedDocument(...args),
  UnsupportedFileTypeError: class UnsupportedFileTypeError extends Error {},
}))
vi.mock('@shared/logger', () => ({ logger: { warn: (...args: unknown[]) => mocks.loggerWarn(...args) } }))
vi.mock('../services/applyPageService', () => ({
  resolveApplyToken: (...args: unknown[]) => mocks.resolveApplyToken(...args),
  resolveWorkspaceWriteAuthority: (...args: unknown[]) => mocks.resolveAuthority(...args),
}))
vi.mock('../services/intakeService', () => ({
  intakeCandidate: (...args: unknown[]) => mocks.intakeCandidate(...args),
  intakeFromApplyPage: (...args: unknown[]) => mocks.intakeFromApplyPage(...args),
}))
vi.mock('../services/jdMatchService', () => ({
  analyzeResumeForJob: (...args: unknown[]) => mocks.analyzeResume(...args),
  extractAllEmails: (...args: unknown[]) => mocks.extractEmails(...args),
}))
vi.mock('../services/workspaceService', () => ({
  activeHireWorkspaceLifecycleFilter: () => ({ lifecycleState: 'active' }),
}))
vi.mock('../services/hireWorkspaceWriteFence', () => ({
  withActiveHireWorkspaceWriteTransaction: (...args: unknown[]) => mocks.writeFence(...args),
}))
vi.mock('../services/hireCandidatePrivacyWriteFence', () => ({
  claimHireCandidatePiiWriteFence: (...args: unknown[]) => mocks.candidateFence(...args),
}))
vi.mock('../services/aiRoundService', () => ({ sha256: (value: string) => `hash:${value}` }))
vi.mock('../models', () => ({
  HIRE_INTAKE_TASK_MAX_PAYLOAD_BYTES: 10 * 1024 * 1024,
  HireJob: {
    findOne: (...args: unknown[]) => mocks.jobFindOne(...args),
    updateOne: (...args: unknown[]) => mocks.jobUpdateOne(...args),
    exists: (...args: unknown[]) => mocks.jobExists(...args),
  },
  HireCandidate: { findOne: (...args: unknown[]) => mocks.candidateFindOne(...args) },
  HirePrivacyRequest: { exists: (...args: unknown[]) => mocks.privacyExists(...args) },
  HireIntakeTask: {
    create: (...args: unknown[]) => mocks.taskCreate(...args),
    find: (...args: unknown[]) => mocks.taskFind(...args),
    findOne: (...args: unknown[]) => mocks.taskFindOne(...args),
    findOneAndUpdate: (...args: unknown[]) => mocks.taskFindOneAndUpdate(...args),
    exists: (...args: unknown[]) => mocks.taskExists(...args),
    updateOne: (...args: unknown[]) => mocks.taskUpdateOne(...args),
    updateMany: (...args: unknown[]) => mocks.taskUpdateMany(...args),
  },
  HireWorkspace: {
    findOne: (...args: unknown[]) => mocks.workspaceFindOne(...args),
    exists: (...args: unknown[]) => mocks.workspaceExists(...args),
  },
  HireWorkspaceMember: {
    findOne: (...args: unknown[]) => mocks.memberFindOne(...args),
    exists: (...args: unknown[]) => mocks.memberExists(...args),
  },
}))

import {
  cleanupExpiredHireIntakeRawPayloadTasks,
  enqueueMemberResumeIntake,
  enqueuePublicApplyIntake,
  getHireIntakeTask,
  processHireIntakeTask,
  cleanupStaleHireIntakeNeedsIdentityTasks,
  supplyHireIntakeIdentity,
} from '../services/intakeQueueService'

const IDS = {
  workspace: 'a'.repeat(24),
  job: 'b'.repeat(24),
  member: 'c'.repeat(24),
  task: 'd'.repeat(24),
  candidate: 'e'.repeat(24),
  application: 'f'.repeat(24),
}
const SESSION = { id: 'tx' }
const CTX = {
  workspace: { _id: new mongoose.Types.ObjectId(IDS.workspace), name: 'Acme' },
  membership: {
    _id: new mongoose.Types.ObjectId(IDS.member),
    name: 'Recruiter',
    email: 'hr@acme.example',
  },
} as never

function query<T>(value: T) {
  const result = {
    select: vi.fn(),
    session: vi.fn(),
    lean: vi.fn(),
    sort: vi.fn(),
    limit: vi.fn(),
    then: (
      onfulfilled?: ((result: T) => unknown) | null,
      onrejected?: ((reason: unknown) => unknown) | null,
    ) => Promise.resolve(value).then(onfulfilled, onrejected),
  }
  result.select.mockReturnValue(result)
  result.session.mockReturnValue(result)
  result.lean.mockReturnValue(result)
  result.sort.mockReturnValue(result)
  result.limit.mockReturnValue(result)
  return result
}

function queuedTask(overrides: Record<string, unknown> = {}) {
  return {
    _id: new mongoose.Types.ObjectId(IDS.task),
    workspaceId: new mongoose.Types.ObjectId(IDS.workspace),
    jobId: new mongoose.Types.ObjectId(IDS.job),
    source: 'bulk_upload' as const,
    originalFileName: 'ada.pdf',
    originalContentType: 'application/pdf',
    originalFileSizeBytes: 12,
    payload: Buffer.from('resume body'),
    actorMemberId: new mongoose.Types.ObjectId(IDS.member),
    actorName: 'Recruiter',
    status: 'queued' as const,
    attempts: 0,
    queuedAt: new Date('2026-08-12T10:00:00.000Z'),
    statusChangedAt: new Date('2026-08-12T10:00:00.000Z'),
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.connect.mockResolvedValue(undefined)
  mocks.send.mockResolvedValue(undefined)
  mocks.supportedDocument.mockReturnValue(true)
  mocks.writeFence.mockImplementation(
    async (_workspaceId: unknown, _memberId: unknown, work: (session: unknown) => unknown) => work(SESSION),
  )
  mocks.candidateFence.mockResolvedValue(undefined)
  mocks.jobUpdateOne.mockResolvedValue({ matchedCount: 1 })
  mocks.candidateFindOne.mockReturnValue(query(null))
  mocks.privacyExists.mockReturnValue(query(null))
  mocks.taskUpdateOne.mockResolvedValue({ matchedCount: 1 })
  mocks.taskExists.mockReturnValue(query({ _id: IDS.task }))
  mocks.jobExists.mockReturnValue(query({ _id: IDS.job }))
  mocks.workspaceExists.mockReturnValue(query({ _id: IDS.workspace }))
  mocks.memberExists.mockReturnValue(query({ _id: IDS.member }))
  mocks.extractEmails.mockReturnValue([])
  mocks.analyzeResume.mockResolvedValue(null)
})

describe('durable member enqueue', () => {
  it('stores one Hire task behind the active-workspace fence and emits ID-only work', async () => {
    mocks.jobFindOne.mockReturnValue(query({ status: 'open' }))
    mocks.taskCreate.mockResolvedValue([queuedTask()])

    await expect(enqueueMemberResumeIntake(CTX, {
      jobId: IDS.job,
      fileName: 'ada.pdf',
      contentType: 'application/pdf',
      payload: Buffer.from('resume body'),
      suppliedEmail: 'ADA@EXAMPLE.COM',
    })).resolves.toEqual({ taskId: IDS.task, status: 'queued' })

    expect(mocks.writeFence).toHaveBeenCalledWith(
      CTX.workspace._id,
      CTX.membership._id,
      expect.any(Function),
    )
    const persisted = mocks.taskCreate.mock.calls[0][0][0]
    expect(persisted).toMatchObject({
      workspaceId: CTX.workspace._id,
      source: 'bulk_upload',
      suppliedEmail: 'ada@example.com',
      actorMemberId: CTX.membership._id,
    })
    expect(persisted.jobId.toString()).toBe(IDS.job)
    expect(mocks.send).toHaveBeenCalledWith({
      name: 'hire/intake.requested',
      data: { workspaceId: IDS.workspace, taskId: IDS.task },
    })
    expect(JSON.stringify(mocks.send.mock.calls[0])).not.toContain('resume body')
    expect(JSON.stringify(mocks.send.mock.calls[0])).not.toContain('ada@example.com')
  })

  it('associates an already-known Hire candidate and claims its privacy fence without B2C lookup', async () => {
    mocks.jobFindOne.mockReturnValue(query({ status: 'open' }))
    mocks.candidateFindOne.mockReturnValue(query({
      _id: new mongoose.Types.ObjectId(IDS.candidate),
      piiAnonymizedAt: undefined,
    }))
    mocks.taskCreate.mockResolvedValue([queuedTask({ candidateId: new mongoose.Types.ObjectId(IDS.candidate) })])

    await enqueueMemberResumeIntake(CTX, {
      jobId: IDS.job,
      fileName: 'ada.pdf',
      contentType: 'application/pdf',
      payload: Buffer.from('resume body'),
      suppliedEmail: 'ada@example.com',
    })

    expect(mocks.candidateFindOne).toHaveBeenCalledWith({
      workspaceId: CTX.workspace._id,
      email: 'ada@example.com',
    })
    expect(mocks.candidateFence).toHaveBeenCalledWith({
      workspaceId: CTX.workspace._id,
      candidateId: expect.any(mongoose.Types.ObjectId),
      session: SESSION,
    })
    expect(mocks.taskCreate.mock.calls[0][0][0].candidateId.toString()).toBe(IDS.candidate)
  })
})

describe('public enqueue boundary', () => {
  it('returns null uniformly for an invalid/revoked public capability without creating a task', async () => {
    mocks.resolveApplyToken.mockResolvedValue(null)
    await expect(enqueuePublicApplyIntake({
      capability: `${IDS.workspace}.${'1'.repeat(64)}`,
      name: 'Ada Lovelace',
      email: 'ada@example.com',
      fileName: 'ada.pdf',
      contentType: 'application/pdf',
      payload: Buffer.from('resume body'),
    })).resolves.toBeNull()
    expect(mocks.taskCreate).not.toHaveBeenCalled()
    expect(mocks.send).not.toHaveBeenCalled()
  })
})

describe('worker ownership and recoverability', () => {
  it('moves a claimed no-email resume to needs_identity without dropping its recovery payload', async () => {
    const task = queuedTask({ attempts: 1 })
    mocks.taskFindOneAndUpdate.mockReturnValue(query(task))
    mocks.jobFindOne.mockResolvedValue({
      _id: task.jobId,
      workspaceId: task.workspaceId,
      jdText: 'backend role',
      status: 'open',
    })
    mocks.workspaceFindOne.mockResolvedValue({ _id: task.workspaceId })
    mocks.memberFindOne.mockResolvedValue({ _id: task.actorMemberId })
    mocks.parseDocument.mockResolvedValue({
      text: 'No email in this résumé',
      wordCount: 5,
      docType: 'txt',
    })

    await expect(processHireIntakeTask({ workspaceId: IDS.workspace, taskId: IDS.task }))
      .resolves.toEqual({ outcome: 'needs_identity' })

    const update = mocks.taskUpdateOne.mock.calls.at(-1)?.[1]
    expect(mocks.taskUpdateOne.mock.calls.at(-1)?.[0]).toMatchObject({
      _id: task._id,
      workspaceId: task.workspaceId,
      status: 'processing',
      claimToken: expect.any(String),
    })
    expect(update.$set).toMatchObject({ status: 'needs_identity' })
    expect(update.$unset).not.toHaveProperty('payload')
    expect(mocks.intakeCandidate).not.toHaveBeenCalled()
  })

  it('cancels before model work when an exact Hire candidate is already anonymized', async () => {
    const task = queuedTask({ suppliedEmail: 'ada@example.com', attempts: 1 })
    mocks.taskFindOneAndUpdate.mockReturnValue(query(task))
    mocks.jobFindOne.mockResolvedValue({
      _id: task.jobId,
      workspaceId: task.workspaceId,
      jdText: 'backend role',
      status: 'open',
    })
    mocks.workspaceFindOne.mockResolvedValue({ _id: task.workspaceId })
    mocks.memberFindOne.mockResolvedValue({ _id: task.actorMemberId })
    mocks.parseDocument.mockResolvedValue({ text: 'ada@example.com', wordCount: 1, docType: 'txt' })
    mocks.candidateFindOne.mockReturnValue(query({
      _id: new mongoose.Types.ObjectId(IDS.candidate),
      piiAnonymizedAt: new Date(),
    }))

    await expect(processHireIntakeTask({ workspaceId: IDS.workspace, taskId: IDS.task }))
      .resolves.toEqual({ outcome: 'cancelled' })

    expect(mocks.analyzeResume).not.toHaveBeenCalled()
    const update = mocks.taskUpdateOne.mock.calls.at(-1)?.[1]
    expect(update.$set).toMatchObject({ status: 'cancelled' })
    expect(update.$unset).toHaveProperty('payload')
  })

  it('cancels before model work when parsing crosses the raw-payload deadline', async () => {
    vi.useFakeTimers()
    try {
      const queuedAt = new Date('2026-08-13T00:00:00.000Z')
      const task = queuedTask({ attempts: 1, queuedAt, suppliedEmail: 'ada@example.com' })
      mocks.taskFindOneAndUpdate.mockReturnValue(query(task))
      mocks.jobFindOne.mockResolvedValue({
        _id: task.jobId,
        workspaceId: task.workspaceId,
        jdText: 'backend role',
        status: 'open',
      })
      mocks.workspaceFindOne.mockResolvedValue({ _id: task.workspaceId })
      mocks.memberFindOne.mockResolvedValue({ _id: task.actorMemberId })
      mocks.parseDocument.mockImplementation(async () => {
        vi.setSystemTime(new Date('2026-08-20T00:00:01.000Z'))
        return { text: 'ada@example.com', wordCount: 1, docType: 'txt' }
      })

      await expect(processHireIntakeTask({
        workspaceId: IDS.workspace,
        taskId: IDS.task,
        now: new Date('2026-08-19T23:59:00.000Z'),
      })).resolves.toEqual({ outcome: 'cancelled' })

      expect(mocks.analyzeResume).not.toHaveBeenCalled()
      const update = mocks.taskUpdateOne.mock.calls.at(-1)?.[1]
      expect(update.$set).toMatchObject({ status: 'cancelled' })
      expect(update.$unset).toHaveProperty('payload')
    } finally {
      vi.useRealTimers()
    }
  })

  it('fails the provider precondition when the raw-payload deadline closes after the lease renews', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-08-19T23:59:00.000Z'))
      const queuedAt = new Date('2026-08-13T00:00:00.000Z')
      const task = queuedTask({ attempts: 1, queuedAt, suppliedEmail: 'ada@example.com' })
      mocks.taskFindOneAndUpdate.mockReturnValue(query(task))
      mocks.jobFindOne.mockResolvedValue({
        _id: task.jobId,
        workspaceId: task.workspaceId,
        jdText: 'backend role',
        status: 'open',
      })
      mocks.workspaceFindOne.mockResolvedValue({ _id: task.workspaceId })
      mocks.memberFindOne.mockResolvedValue({ _id: task.actorMemberId })
      mocks.parseDocument.mockResolvedValue({ text: 'ada@example.com', wordCount: 1, docType: 'txt' })
      mocks.taskExists.mockImplementation((filter: Record<string, unknown>) => {
        expect(filter).toMatchObject({
          workspaceId: new mongoose.Types.ObjectId(IDS.workspace),
          queuedAt: { $gt: new Date('2026-08-13T00:00:01.000Z') },
        })
        return query(null)
      })
      mocks.analyzeResume.mockImplementation(async ({ beforeProviderCall }: {
        beforeProviderCall: () => Promise<boolean>
      }) => {
        vi.setSystemTime(new Date('2026-08-20T00:00:01.000Z'))
        await expect(beforeProviderCall()).resolves.toBe(false)
        return null
      })

      await expect(processHireIntakeTask({
        workspaceId: IDS.workspace,
        taskId: IDS.task,
        now: new Date('2026-08-19T23:59:00.000Z'),
      })).resolves.toEqual({ outcome: 'cancelled' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not retain a no-email resume in needs_identity after the raw-payload deadline', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-08-19T23:59:00.000Z'))
      const queuedAt = new Date('2026-08-13T00:00:00.000Z')
      const task = queuedTask({ attempts: 1, queuedAt })
      mocks.taskFindOneAndUpdate.mockReturnValue(query(task))
      mocks.jobFindOne.mockResolvedValue({
        _id: task.jobId,
        workspaceId: task.workspaceId,
        jdText: 'backend role',
        status: 'open',
      })
      mocks.workspaceFindOne.mockResolvedValue({ _id: task.workspaceId })
      mocks.memberFindOne.mockResolvedValue({ _id: task.actorMemberId })
      mocks.parseDocument.mockResolvedValue({ text: 'no contact details', wordCount: 3, docType: 'txt' })
      mocks.analyzeResume.mockImplementation(async () => {
        vi.setSystemTime(new Date('2026-08-20T00:00:01.000Z'))
        return null
      })

      await expect(processHireIntakeTask({
        workspaceId: IDS.workspace,
        taskId: IDS.task,
        now: new Date('2026-08-19T23:59:00.000Z'),
      })).resolves.toEqual({ outcome: 'cancelled' })

      const update = mocks.taskUpdateOne.mock.calls.at(-1)?.[1]
      expect(update.$set).toMatchObject({ status: 'cancelled' })
      expect(update.$unset).toHaveProperty('payload')
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not persist when final raw-payload authorization loses after the pre-persistence check', async () => {
    vi.useFakeTimers()
    try {
      const now = new Date('2026-08-19T23:59:59.000Z')
      vi.setSystemTime(now)
      const task = queuedTask({
        attempts: 1,
        queuedAt: new Date('2026-08-13T00:00:00.000Z'),
        suppliedEmail: 'ada@example.com',
      })
      mocks.taskFindOneAndUpdate.mockReturnValue(query(task))
      mocks.jobFindOne.mockResolvedValue({
        _id: task.jobId,
        workspaceId: task.workspaceId,
        jdText: 'backend role',
        status: 'open',
      })
      mocks.workspaceFindOne.mockResolvedValue({ _id: task.workspaceId })
      mocks.memberFindOne.mockResolvedValue({ _id: task.actorMemberId })
      mocks.parseDocument.mockResolvedValue({ text: 'ada@example.com', wordCount: 1, docType: 'txt' })

      // The first renewal authorizes model work. The second is the final
      // authorization before persistence; a deadline that wins this atomic
      // conditional write must leave no candidate/application result behind.
      mocks.taskUpdateOne
        .mockResolvedValueOnce({ matchedCount: 1 })
        .mockResolvedValueOnce({ matchedCount: 0 })

      await expect(processHireIntakeTask({
        workspaceId: IDS.workspace,
        taskId: IDS.task,
        now,
      })).resolves.toEqual({ outcome: 'skipped' })

      const finalRenewalFilter = mocks.taskUpdateOne.mock.calls[1]?.[0]
      expect(finalRenewalFilter).toMatchObject({
        _id: task._id,
        workspaceId: task.workspaceId,
        queuedAt: { $gt: new Date('2026-08-12T23:59:59.000Z') },
        status: 'processing',
        claimToken: expect.any(String),
      })
      expect(mocks.intakeCandidate).not.toHaveBeenCalled()
      expect(mocks.intakeFromApplyPage).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it.each([
    ['identity conflict', () => new AppError('Confirm the candidate email', 409, 'IDENTITY_CONFLICT')],
    ['generic worker error', () => new Error('temporary intake provider failure')],
  ])('scrubs rather than recoverably requeues a late %s', async (_label, buildError) => {
    vi.useFakeTimers()
    try {
      const now = new Date('2026-08-19T23:59:59.000Z')
      vi.setSystemTime(now)
      const task = queuedTask({
        attempts: 1,
        queuedAt: new Date('2026-08-13T00:00:00.000Z'),
        suppliedEmail: 'ada@example.com',
      })
      mocks.taskFindOneAndUpdate.mockReturnValue(query(task))
      mocks.jobFindOne.mockResolvedValue({
        _id: task.jobId,
        workspaceId: task.workspaceId,
        jdText: 'backend role',
        status: 'open',
      })
      mocks.workspaceFindOne.mockResolvedValue({ _id: task.workspaceId })
      mocks.memberFindOne.mockResolvedValue({ _id: task.actorMemberId })
      mocks.parseDocument.mockResolvedValue({ text: 'ada@example.com', wordCount: 1, docType: 'txt' })
      mocks.analyzeResume.mockImplementation(async () => {
        vi.setSystemTime(new Date('2026-08-20T00:00:00.000Z'))
        throw buildError()
      })

      await expect(processHireIntakeTask({
        workspaceId: IDS.workspace,
        taskId: IDS.task,
        now,
      })).resolves.toEqual({ outcome: 'cancelled' })

      const update = mocks.taskUpdateOne.mock.calls.at(-1)?.[1]
      expect(update.$set).toMatchObject({
        status: 'cancelled',
        lastError: 'Resume intake retention window expired',
      })
      expect(update.$unset).toHaveProperty('payload')
      expect(mocks.intakeCandidate).not.toHaveBeenCalled()
      expect(mocks.intakeFromApplyPage).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('member task views and recovery', () => {
  it('returns a safe task view without payload, supplied identity, or capability hash', async () => {
    const task = queuedTask({
      suppliedEmail: 'ada@example.com',
      payload: Buffer.from('do not expose'),
      applyTokenHash: 'a'.repeat(64),
    })
    mocks.taskFindOne.mockReturnValue(query(task))

    const result = await getHireIntakeTask(CTX, { jobId: IDS.job, taskId: IDS.task })

    expect(result).toMatchObject({ taskId: IDS.task, status: 'queued', fileName: 'ada.pdf' })
    expect(JSON.stringify(result)).not.toContain('ada@example.com')
    expect(JSON.stringify(result)).not.toContain('do not expose')
    expect(JSON.stringify(result)).not.toContain('a'.repeat(64))
  })

  it('requeues only a member-owned needs_identity task through the active workspace fence', async () => {
    const recovered = queuedTask({
      status: 'queued',
      suppliedEmail: 'ada@example.com',
    })
    mocks.taskFindOneAndUpdate.mockResolvedValue(recovered)

    await expect(supplyHireIntakeIdentity(CTX, {
      jobId: IDS.job,
      taskId: IDS.task,
      name: 'Ada Lovelace',
      email: 'ada@example.com',
    })).resolves.toMatchObject({ taskId: IDS.task, status: 'queued' })

    expect(mocks.writeFence).toHaveBeenCalledWith(
      CTX.workspace._id,
      CTX.membership._id,
      expect.any(Function),
    )
    expect(mocks.taskFindOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: CTX.workspace._id,
        jobId: expect.any(mongoose.Types.ObjectId),
        source: 'bulk_upload',
        queuedAt: { $gt: expect.any(Date) },
        status: 'needs_identity',
      }),
      expect.objectContaining({ $set: expect.objectContaining({ status: 'queued' }) }),
      expect.objectContaining({ session: SESSION }),
    )
    expect(mocks.send).toHaveBeenCalledWith({
      name: 'hire/intake.requested',
      data: { workspaceId: IDS.workspace, taskId: IDS.task },
    })
  })
})

describe('stale identity recovery cleanup', () => {
  it('cancels an unassociated stale task only in its exact workspace and scrubs retained input PII', async () => {
    const taskId = new mongoose.Types.ObjectId(IDS.task)
    mocks.taskFind.mockReturnValue(query([{ _id: taskId }]))
    mocks.taskUpdateMany.mockResolvedValue({ modifiedCount: 1 })
    const now = new Date('2026-08-20T12:00:00.000Z')

    await expect(cleanupStaleHireIntakeNeedsIdentityTasks({
      workspaceId: IDS.workspace,
      now,
      batchSize: 1,
    })).resolves.toEqual({ cancelled: 1 })

    const [findFilter] = mocks.taskFind.mock.calls[0]
    expect(findFilter).toMatchObject({
      workspaceId: new mongoose.Types.ObjectId(IDS.workspace),
      status: 'needs_identity',
      needsIdentityAt: { $lte: new Date('2026-08-13T12:00:00.000Z') },
    })
    expect(findFilter).not.toHaveProperty('candidateId')
    expect(mocks.taskFind.mock.results[0]?.value.select).toHaveBeenCalledWith('_id')

    const [updateFilter, update] = mocks.taskUpdateMany.mock.calls[0]
    expect(updateFilter).toMatchObject({
      workspaceId: new mongoose.Types.ObjectId(IDS.workspace),
      _id: { $in: [taskId] },
      status: 'needs_identity',
      needsIdentityAt: { $lte: new Date('2026-08-13T12:00:00.000Z') },
    })
    expect(update.$set).toMatchObject({
      status: 'cancelled',
      cancelledAt: now,
      statusChangedAt: now,
    })
    expect(update.$unset).toMatchObject({
      payload: 1,
      suppliedName: 1,
      suppliedEmail: 1,
      suppliedPhone: 1,
    })
    expect(JSON.stringify(update)).not.toContain('resume body')
    expect(JSON.stringify(update)).not.toContain('ada@example.com')
  })

  it('does not issue a cross-tenant mutation when its workspace has no stale tasks', async () => {
    const otherWorkspaceId = '9'.repeat(24)
    mocks.taskFind.mockReturnValue(query([]))

    await expect(cleanupStaleHireIntakeNeedsIdentityTasks({
      workspaceId: otherWorkspaceId,
      now: new Date('2026-08-20T12:00:00.000Z'),
    })).resolves.toEqual({ cancelled: 0 })

    expect(mocks.taskFind).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: new mongoose.Types.ObjectId(otherWorkspaceId),
    }))
    expect(mocks.taskUpdateMany).not.toHaveBeenCalled()
  })
})

describe('raw payload retention cleanup', () => {
  it('cancels an unassociated expired queued task only in its exact workspace and scrubs retained PII', async () => {
    const taskId = new mongoose.Types.ObjectId(IDS.task)
    mocks.taskFind.mockReturnValue(query([{ _id: taskId }]))
    mocks.taskUpdateMany.mockResolvedValue({ modifiedCount: 1 })
    const now = new Date('2026-08-20T12:00:00.000Z')

    await expect(cleanupExpiredHireIntakeRawPayloadTasks({
      workspaceId: IDS.workspace,
      now,
      batchSize: 1,
    })).resolves.toEqual({ cancelled: 1 })

    const [findFilter] = mocks.taskFind.mock.calls[0]
    expect(findFilter).toMatchObject({
      workspaceId: new mongoose.Types.ObjectId(IDS.workspace),
      queuedAt: { $lte: new Date('2026-08-13T12:00:00.000Z') },
    })
    expect(findFilter).not.toHaveProperty('candidateId')
    expect(JSON.stringify(findFilter)).toContain('queued')
    expect(JSON.stringify(findFilter)).toContain('needs_identity')
    expect(JSON.stringify(findFilter)).toContain('processing')
    expect(mocks.taskFind.mock.results[0]?.value.select).toHaveBeenCalledWith('_id')

    const [updateFilter, update] = mocks.taskUpdateMany.mock.calls[0]
    expect(updateFilter).toMatchObject({
      workspaceId: new mongoose.Types.ObjectId(IDS.workspace),
      _id: { $in: [taskId] },
      queuedAt: { $lte: new Date('2026-08-13T12:00:00.000Z') },
    })
    expect(update.$set).toMatchObject({
      status: 'cancelled',
      cancelledAt: now,
      statusChangedAt: now,
      lastError: 'Resume intake retention window expired',
    })
    expect(update.$unset).toMatchObject({
      payload: 1,
      suppliedName: 1,
      suppliedEmail: 1,
      suppliedPhone: 1,
    })
  })

  it('does not issue a cross-tenant raw-payload cleanup mutation when its workspace has no expired tasks', async () => {
    const otherWorkspaceId = '9'.repeat(24)
    mocks.taskFind.mockReturnValue(query([]))

    await expect(cleanupExpiredHireIntakeRawPayloadTasks({
      workspaceId: otherWorkspaceId,
      now: new Date('2026-08-20T12:00:00.000Z'),
    })).resolves.toEqual({ cancelled: 0 })

    expect(mocks.taskFind).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: new mongoose.Types.ObjectId(otherWorkspaceId),
    }))
    expect(mocks.taskUpdateMany).not.toHaveBeenCalled()
  })

  it('does not claim a queued task once its raw-payload deadline has expired', async () => {
    mocks.taskFindOneAndUpdate.mockReturnValue(query(null))

    await expect(processHireIntakeTask({
      workspaceId: IDS.workspace,
      taskId: IDS.task,
      now: new Date('2026-08-20T12:00:00.000Z'),
    })).resolves.toEqual({ outcome: 'skipped' })

    const [claimFilter] = mocks.taskFindOneAndUpdate.mock.calls[0]
    expect(claimFilter).toMatchObject({
      workspaceId: new mongoose.Types.ObjectId(IDS.workspace),
      queuedAt: { $gt: new Date('2026-08-13T12:00:00.000Z') },
    })
    expect(mocks.parseDocument).not.toHaveBeenCalled()
  })
})
