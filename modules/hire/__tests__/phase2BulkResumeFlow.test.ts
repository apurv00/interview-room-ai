/**
 * Phase 2 volume proof: a deterministic composition test for the whole
 * recruiter-upload path. It intentionally replaces only infrastructure and
 * the advisory model with an in-memory Hire control-plane adapter; the queue
 * worker, intake/dedupe service, and pipeline ranking reader are real.
 *
 * This is not a provider/load test. It proves that a 50-file batch can move
 * through durable task creation -> parse -> score -> Hire email dedupe ->
 * ranked queue with no manual identity step or network/LLM dependency.
 */
import crypto from 'node:crypto'
import mongoose from 'mongoose'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  connectControl: vi.fn(),
  connectDb: vi.fn(),
  inngestSend: vi.fn(),
  parseDocument: vi.fn(),
  isSupportedDocumentType: vi.fn(),
  analyzeResume: vi.fn(),
  extractEmails: vi.fn(),
  workspaceTransaction: vi.fn(),
  candidateFence: vi.fn(),
  onboardingTestDriveFence: vi.fn(),
  jobFindOne: vi.fn(),
  jobFind: vi.fn(),
  jobUpdateOne: vi.fn(),
  jobExists: vi.fn(),
  candidateFindOne: vi.fn(),
  candidateFind: vi.fn(),
  candidateCreate: vi.fn(),
  candidateUpdateOne: vi.fn(),
  applicationFindOne: vi.fn(),
  applicationFind: vi.fn(),
  applicationCreate: vi.fn(),
  applicationUpdateOne: vi.fn(),
  applicationUpdateMany: vi.fn(),
  taskCreate: vi.fn(),
  taskFind: vi.fn(),
  taskFindOne: vi.fn(),
  taskFindOneAndUpdate: vi.fn(),
  taskUpdateOne: vi.fn(),
  taskUpdateMany: vi.fn(),
  taskExists: vi.fn(),
  workspaceFindOne: vi.fn(),
  workspaceExists: vi.fn(),
  memberFindOne: vi.fn(),
  memberExists: vi.fn(),
  privacyExists: vi.fn(),
  roundFind: vi.fn(),
  humanRoundFind: vi.fn(),
  loggerWarn: vi.fn(),
}))

vi.mock('@shared/db/connection', () => ({
  connectDB: (...args: unknown[]) => mocks.connectDb(...args),
}))
vi.mock('../services/hireControlBoundary', () => ({
  connectHireControlDB: (...args: unknown[]) => mocks.connectControl(...args),
}))
vi.mock('@shared/services/inngest', () => ({
  inngest: { send: (...args: unknown[]) => mocks.inngestSend(...args) },
}))
vi.mock('@shared/services/documentParser', () => ({
  parseDocument: (...args: unknown[]) => mocks.parseDocument(...args),
  isSupportedDocumentType: (...args: unknown[]) => mocks.isSupportedDocumentType(...args),
  UnsupportedFileTypeError: class UnsupportedFileTypeError extends Error {},
}))
vi.mock('@shared/logger', () => ({
  logger: { warn: (...args: unknown[]) => mocks.loggerWarn(...args) },
}))
vi.mock('../services/jdMatchService', () => ({
  analyzeResumeForJob: (...args: unknown[]) => mocks.analyzeResume(...args),
  extractAllEmails: (...args: unknown[]) => mocks.extractEmails(...args),
}))
vi.mock('../services/hireWorkspaceWriteFence', () => ({
  withActiveHireWorkspaceWriteTransaction: (...args: unknown[]) =>
    mocks.workspaceTransaction(...args),
}))
vi.mock('../services/hireCandidatePrivacyWriteFence', () => ({
  claimHireCandidatePiiWriteFence: (...args: unknown[]) => mocks.candidateFence(...args),
  HireCandidatePiiTombstoneError: class HireCandidatePiiTombstoneError extends Error {},
}))
vi.mock('@hire-onboarding-boundary', () => ({
  assertHireOnboardingTestDriveWriteIsolation: (...args: unknown[]) =>
    mocks.onboardingTestDriveFence(...args),
}))
vi.mock('../services/workspaceService', () => ({
  activeHireWorkspaceLifecycleFilter: () => ({ lifecycleState: 'active' }),
}))
vi.mock('../services/aiRoundService', () => ({
  sha256: (value: string) => crypto.createHash('sha256').update(value).digest('hex'),
}))
vi.mock('../services/applyPageService', () => ({
  resolveApplyToken: vi.fn(),
  resolveWorkspaceWriteAuthority: vi.fn(),
}))
vi.mock('../services/mediaLifecycleService', () => ({
  scheduleHireJobMediaPurge: vi.fn(),
  cancelFutureHireJobMediaPurge: vi.fn(),
}))
vi.mock('../services/engineRevocationService', () => ({
  deliverRuntimeRevocation: vi.fn(),
}))
vi.mock('../models/HireJobRequirementVersion', () => ({
  HireJobRequirementVersion: { create: vi.fn(), findOne: vi.fn() },
}))
vi.mock('../models/HireEmailOutbox', () => ({
  HireEmailOutbox: { create: vi.fn(), find: vi.fn() },
}))
vi.mock('../models', () => ({
  HIRE_INTAKE_TASK_MAX_PAYLOAD_BYTES: 10 * 1024 * 1024,
  HIRE_STAGES: ['new', 'screened', 'interviewing', 'shortlist', 'offer', 'hired', 'rejected', 'withdrawn'],
  TERMINAL_STAGES: ['hired', 'rejected', 'withdrawn'],
  APPLICANT_SUBMISSION_CAP: 3,
  HireJob: {
    findOne: (...args: unknown[]) => mocks.jobFindOne(...args),
    find: (...args: unknown[]) => mocks.jobFind(...args),
    updateOne: (...args: unknown[]) => mocks.jobUpdateOne(...args),
    exists: (...args: unknown[]) => mocks.jobExists(...args),
  },
  HireCandidate: {
    findOne: (...args: unknown[]) => mocks.candidateFindOne(...args),
    find: (...args: unknown[]) => mocks.candidateFind(...args),
    create: (...args: unknown[]) => mocks.candidateCreate(...args),
    updateOne: (...args: unknown[]) => mocks.candidateUpdateOne(...args),
  },
  HireApplication: {
    findOne: (...args: unknown[]) => mocks.applicationFindOne(...args),
    find: (...args: unknown[]) => mocks.applicationFind(...args),
    create: (...args: unknown[]) => mocks.applicationCreate(...args),
    updateOne: (...args: unknown[]) => mocks.applicationUpdateOne(...args),
    updateMany: (...args: unknown[]) => mocks.applicationUpdateMany(...args),
  },
  HireIntakeTask: {
    create: (...args: unknown[]) => mocks.taskCreate(...args),
    find: (...args: unknown[]) => mocks.taskFind(...args),
    findOne: (...args: unknown[]) => mocks.taskFindOne(...args),
    findOneAndUpdate: (...args: unknown[]) => mocks.taskFindOneAndUpdate(...args),
    updateOne: (...args: unknown[]) => mocks.taskUpdateOne(...args),
    updateMany: (...args: unknown[]) => mocks.taskUpdateMany(...args),
    exists: (...args: unknown[]) => mocks.taskExists(...args),
  },
  HireWorkspace: {
    findOne: (...args: unknown[]) => mocks.workspaceFindOne(...args),
    exists: (...args: unknown[]) => mocks.workspaceExists(...args),
  },
  HireWorkspaceMember: {
    findOne: (...args: unknown[]) => mocks.memberFindOne(...args),
    exists: (...args: unknown[]) => mocks.memberExists(...args),
  },
  HirePrivacyRequest: { exists: (...args: unknown[]) => mocks.privacyExists(...args) },
  HireRound: { find: (...args: unknown[]) => mocks.roundFind(...args) },
  HireHumanRound: { find: (...args: unknown[]) => mocks.humanRoundFind(...args) },
  HireEngineHandoff: { updateMany: vi.fn() },
  HireGuestSession: { updateMany: vi.fn() },
  HireInterviewAttempt: { updateMany: vi.fn() },
  HireInvitationBatch: { updateMany: vi.fn() },
  HireInvitationBatchItem: { updateMany: vi.fn() },
}))

import {
  enqueueMemberResumeIntake,
  processHireIntakeTask,
} from '../services/intakeQueueService'
import { getJobPipeline } from '../services/pipelineService'

type StoredDocument = Record<string, unknown>

interface Query<T> extends PromiseLike<T> {
  select: (...args: unknown[]) => Query<T>
  session: (...args: unknown[]) => Query<T>
  sort: (...args: unknown[]) => Query<T>
  limit: (...args: unknown[]) => Query<T>
  lean: (...args: unknown[]) => Query<T>
}

function query<T>(value: T): Query<T> {
  const resolved = Promise.resolve(value)
  const result = {} as Query<T>
  result.select = () => result
  result.session = () => result
  result.sort = () => result
  result.limit = () => result
  result.lean = () => result
  result.then = resolved.then.bind(resolved)
  return result
}

function idEquals(left: unknown, right: unknown): boolean {
  return String(left) === String(right)
}

function matches(document: StoredDocument, filter: Record<string, unknown>): boolean {
  return Object.entries(filter).every(([key, expected]) => {
    if (key === '$or') {
      return (expected as Array<Record<string, unknown>>).some((part) => matches(document, part))
    }
    const actual = document[key]
    if (expected instanceof mongoose.Types.ObjectId || expected instanceof Date) {
      return idEquals(actual, expected)
    }
    if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
      const operator = expected as Record<string, unknown>
      if ('$ne' in operator) return !idEquals(actual, operator.$ne)
      if ('$in' in operator) return (operator.$in as unknown[]).some((item) => idEquals(actual, item))
      if ('$exists' in operator) return (actual !== undefined) === Boolean(operator.$exists)
      if ('$gt' in operator) return actual instanceof Date && actual > (operator.$gt as Date)
      if ('$lte' in operator) return actual instanceof Date && actual <= (operator.$lte as Date)
      return false
    }
    return idEquals(actual, expected)
  })
}

function applyUpdate(document: StoredDocument, update: Record<string, unknown>): void {
  for (const [key, value] of Object.entries((update.$set ?? {}) as Record<string, unknown>)) {
    document[key] = value
  }
  for (const key of Object.keys((update.$unset ?? {}) as Record<string, unknown>)) {
    delete document[key]
  }
  for (const [key, value] of Object.entries((update.$inc ?? {}) as Record<string, number>)) {
    document[key] = Number(document[key] ?? 0) + value
  }
}

const session = { id: 'phase-2-volume-session' }
let workspace: StoredDocument
let member: StoredDocument
let currentJob: StoredDocument
let earlierJob: StoredDocument
let tasks: StoredDocument[]
let candidates: StoredDocument[]
let applications: StoredDocument[]
let createdAtCursor: number

function findCandidate(filter: Record<string, unknown>): StoredDocument | null {
  return candidates.find((candidate) => matches(candidate, filter)) ?? null
}

function findApplication(filter: Record<string, unknown>): StoredDocument | null {
  return applications.find((application) => matches(application, filter)) ?? null
}

function resumeEmail(text: string): string {
  const match = text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/)
  if (!match) throw new Error('fixture resume has no email')
  return match[0].toLowerCase()
}

beforeEach(() => {
  vi.clearAllMocks()
  workspace = {
    _id: new mongoose.Types.ObjectId('a'.repeat(24)),
    name: 'Volume Test Workspace',
    lifecycleState: 'active',
  }
  member = {
    _id: new mongoose.Types.ObjectId('b'.repeat(24)),
    workspaceId: workspace._id,
    name: 'Volume Recruiter',
    email: 'recruiter@volume.example',
    authState: 'active',
  }
  currentJob = {
    _id: new mongoose.Types.ObjectId('c'.repeat(24)),
    workspaceId: workspace._id,
    title: 'Senior Backend Engineer',
    jdText: 'TypeScript, Node.js, distributed systems',
    status: 'open',
  }
  earlierJob = {
    _id: new mongoose.Types.ObjectId('d'.repeat(24)),
    workspaceId: workspace._id,
    title: 'Earlier Platform Role',
    jdText: 'Earlier job',
    status: 'open',
  }
  tasks = []
  candidates = []
  applications = []
  createdAtCursor = 0

  mocks.connectControl.mockResolvedValue(undefined)
  mocks.connectDb.mockResolvedValue(undefined)
  mocks.inngestSend.mockResolvedValue(undefined)
  mocks.isSupportedDocumentType.mockReturnValue(true)
  mocks.workspaceTransaction.mockImplementation(
    async (_workspaceId: unknown, _memberId: unknown, work: (tx: unknown) => Promise<unknown>) =>
      work(session),
  )
  mocks.candidateFence.mockResolvedValue(undefined)
  mocks.onboardingTestDriveFence.mockResolvedValue(undefined)
  mocks.jobFindOne.mockImplementation((filter: Record<string, unknown>) =>
    query([currentJob, earlierJob].find((job) => matches(job, filter)) ?? null),
  )
  mocks.jobFind.mockImplementation((filter: Record<string, unknown>) =>
    query([currentJob, earlierJob].filter((job) => matches(job, filter))),
  )
  mocks.jobUpdateOne.mockResolvedValue({ matchedCount: 1 })
  mocks.jobExists.mockImplementation((filter: Record<string, unknown>) =>
    Promise.resolve([currentJob, earlierJob].find((job) => matches(job, filter)) ?? null),
  )
  mocks.humanRoundFind.mockReturnValue(query([]))

  mocks.candidateFindOne.mockImplementation((filter: Record<string, unknown>) =>
    query(findCandidate(filter)),
  )
  mocks.candidateFind.mockImplementation((filter: Record<string, unknown>) =>
    query(candidates.filter((candidate) => matches(candidate, filter))),
  )
  mocks.candidateCreate.mockImplementation(async ([input]: StoredDocument[]) => {
    const candidate = {
      ...input,
      _id: new mongoose.Types.ObjectId(),
      __v: 0,
      createdAt: new Date(Date.UTC(2026, 7, 13, 0, 0, createdAtCursor++)),
      updatedAt: new Date(Date.UTC(2026, 7, 13, 0, 0, createdAtCursor)),
    }
    candidates.push(candidate)
    return [candidate]
  })
  mocks.candidateUpdateOne.mockImplementation(
    async (filter: Record<string, unknown>, update: Record<string, unknown>) => {
      const candidate = findCandidate(filter)
      if (!candidate) return { matchedCount: 0 }
      applyUpdate(candidate, update)
      return { matchedCount: 1 }
    },
  )

  mocks.applicationFindOne.mockImplementation((filter: Record<string, unknown>) =>
    query(findApplication(filter)),
  )
  mocks.applicationFind.mockImplementation((filter: Record<string, unknown>) =>
    query(applications.filter((application) => matches(application, filter))),
  )
  mocks.applicationCreate.mockImplementation(async ([input]: StoredDocument[]) => {
    const application = {
      ...input,
      _id: new mongoose.Types.ObjectId(),
      __v: 0,
      createdAt: new Date(Date.UTC(2026, 7, 13, 0, 1, createdAtCursor++)),
      updatedAt: new Date(Date.UTC(2026, 7, 13, 0, 1, createdAtCursor)),
    }
    applications.push(application)

    // Seed a prior role only once the first duplicate-key candidate exists.
    // That makes the pipeline's "previously seen" signal prove the same
    // workspace-local candidate identity was reused rather than duplicated.
    if (
      (application.candidateId as mongoose.Types.ObjectId).toString() ===
      (candidates[0]?._id as mongoose.Types.ObjectId | undefined)?.toString()
    ) {
      applications.push({
        _id: new mongoose.Types.ObjectId(),
        workspaceId: workspace._id,
        jobId: earlierJob._id,
        candidateId: application.candidateId,
        stage: 'screened',
        events: [],
        createdAt: new Date(Date.UTC(2026, 7, 12, 0, 0, 0)),
        updatedAt: new Date(Date.UTC(2026, 7, 12, 0, 0, 0)),
      })
    }
    return [application]
  })
  mocks.applicationUpdateOne.mockImplementation(
    async (filter: Record<string, unknown>, update: Record<string, unknown>) => {
      const application = findApplication(filter)
      if (!application) return { matchedCount: 0 }
      applyUpdate(application, update)
      return { matchedCount: 1 }
    },
  )
  mocks.applicationUpdateMany.mockImplementation(
    async (filter: Record<string, unknown>, update: Record<string, unknown>) => {
      const affected = applications.filter((application) => matches(application, filter))
      affected.forEach((application) => applyUpdate(application, update))
      return { modifiedCount: affected.length }
    },
  )

  mocks.taskCreate.mockImplementation(async ([input]: StoredDocument[][]) => {
    const task = { ...input, _id: new mongoose.Types.ObjectId(), __v: 0 }
    tasks.push(task)
    return [task]
  })
  mocks.taskFindOneAndUpdate.mockImplementation(
    (filter: Record<string, unknown>, update: Record<string, unknown>) => {
      const task = tasks.find((candidate) => matches(candidate, {
        _id: filter._id,
        workspaceId: filter.workspaceId,
        status: candidate.status === 'queued' ? 'queued' : 'processing',
      }))
      if (!task) return query(null)
      applyUpdate(task, update)
      return query(task)
    },
  )
  mocks.taskUpdateOne.mockImplementation(
    async (filter: Record<string, unknown>, update: Record<string, unknown>) => {
      const task = tasks.find((candidate) => matches(candidate, filter))
      if (!task) return { matchedCount: 0 }
      applyUpdate(task, update)
      return { matchedCount: 1 }
    },
  )
  mocks.taskFind.mockImplementation((filter: Record<string, unknown>) =>
    query(tasks.filter((task) => matches(task, filter))),
  )
  mocks.taskFindOne.mockImplementation((filter: Record<string, unknown>) =>
    query(tasks.find((task) => matches(task, filter)) ?? null),
  )
  mocks.taskUpdateMany.mockResolvedValue({ modifiedCount: 0 })
  mocks.taskExists.mockImplementation((filter: Record<string, unknown>) =>
    Promise.resolve(tasks.find((task) => matches(task, filter)) ?? null),
  )

  mocks.workspaceFindOne.mockResolvedValue(workspace)
  mocks.workspaceExists.mockResolvedValue(workspace)
  mocks.memberFindOne.mockResolvedValue(member)
  mocks.memberExists.mockResolvedValue(member)
  mocks.privacyExists.mockReturnValue(query(null))
  mocks.roundFind.mockReturnValue(query([]))
  mocks.parseDocument.mockImplementation(async (payload: Buffer) => ({
    text: payload.toString('utf8'),
    wordCount: 30,
    docType: 'txt',
  }))
  mocks.extractEmails.mockImplementation((text: string) => [resumeEmail(text)])
  mocks.analyzeResume.mockImplementation(async (input: {
    resumeText: string
    beforeProviderCall?: () => Promise<boolean>
  }) => {
    expect(await input.beforeProviderCall?.()).toBe(true)
    const score = Number(input.resumeText.match(/score:(\d+)/)?.[1])
    return {
      name: input.resumeText.match(/name:([^\n]+)/)?.[1]?.trim() ?? null,
      email: resumeEmail(input.resumeText),
      phone: null,
      location: 'Bengaluru',
      experienceYears: 6,
      matchScore: score,
      strengths: ['TypeScript', 'Node.js'],
      gaps: [],
    }
  })
})

describe('Phase 2 50-resume automated intake flow', () => {
  it('queues, parses, scores, dedupes, and ranks 50 resumes without manual identity input', async () => {
    const ctx = { workspace, membership: member } as never
    const fixtureFor = (index: number) => {
      const dedupeIndex = index === 49 ? 0 : index
      const email = `candidate-${String(dedupeIndex).padStart(2, '0')}@volume.example`
      return Buffer.from(
        `name:Candidate ${String(dedupeIndex).padStart(2, '0')}\n${email}\n` +
          `Senior backend engineer with TypeScript and Node.js\nscore:${50 + index}`,
      )
    }

    const queued = []
    for (let index = 0; index < 50; index += 1) {
      queued.push(await enqueueMemberResumeIntake(ctx, {
        jobId: (currentJob._id as mongoose.Types.ObjectId).toString(),
        fileName: `candidate-${String(index).padStart(2, '0')}.txt`,
        contentType: 'text/plain',
        payload: fixtureFor(index),
      }))
    }

    expect(queued).toHaveLength(50)
    expect(tasks).toHaveLength(50)
    expect(mocks.inngestSend).toHaveBeenCalledTimes(50)
    expect(JSON.stringify(mocks.inngestSend.mock.calls)).not.toContain('@volume.example')

    const outcomes = []
    for (const queuedTask of queued) {
      outcomes.push(await processHireIntakeTask({
        workspaceId: (workspace._id as mongoose.Types.ObjectId).toString(),
        taskId: queuedTask.taskId,
        now: new Date('2026-08-13T12:00:00.000Z'),
      }))
    }

    expect(outcomes).toHaveLength(50)
    expect(outcomes.every((outcome) => outcome.outcome === 'completed')).toBe(true)
    expect(mocks.parseDocument).toHaveBeenCalledTimes(50)
    expect(mocks.analyzeResume).toHaveBeenCalledTimes(50)
    expect(tasks.every((task) => task.status === 'completed')).toBe(true)
    expect(tasks.every((task) => !('payload' in task))).toBe(true)

    // One duplicate email completed as a re-upload, not a second candidate
    // or a second application in the same job. The old-job application is
    // deliberately excluded from this current-job count.
    expect(candidates).toHaveLength(49)
    expect(applications.filter((application) => idEquals(application.jobId, currentJob._id))).toHaveLength(49)

    const pipeline = await getJobPipeline(ctx, (currentJob._id as mongoose.Types.ObjectId).toString())
    expect(pipeline.entries).toHaveLength(49)
    expect(pipeline.entries.map((entry) => entry.scoreState)).toEqual(
      Array.from({ length: 49 }, () => 'scored'),
    )
    expect(pipeline.entries.map((entry) => entry.rank)).toEqual(
      Array.from({ length: 49 }, (_, index) => index + 1),
    )

    const deduped = pipeline.entries.find(
      (entry) => entry.candidate?.email === 'candidate-00@volume.example',
    )
    expect(deduped?.rank).toBe(1)
    expect(deduped?.application.resumeMatch?.score).toBe(99)
    expect(deduped?.previouslySeenIn).toEqual([
      {
        jobId: (earlierJob._id as mongoose.Types.ObjectId).toString(),
        jobTitle: 'Earlier Platform Role',
        stage: 'screened',
      },
    ])
  })
})
