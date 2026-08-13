import mongoose from 'mongoose'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  transaction: vi.fn(),
  piiFence: vi.fn(),
  job: { findOne: vi.fn(), find: vi.fn(), updateOne: vi.fn() },
  candidate: { find: vi.fn(), findOne: vi.fn(), updateOne: vi.fn() },
  application: { find: vi.fn(), findOne: vi.fn(), exists: vi.fn(), create: vi.fn() },
  emailOutbox: { create: vi.fn() },
  privacy: { find: vi.fn(), exists: vi.fn() },
  optOut: { find: vi.fn(), exists: vi.fn() },
  requirementVersion: { findOne: vi.fn() },
}))

vi.mock('../services/hireControlBoundary', () => ({
  connectHireControlDB: mocks.connect,
}))
vi.mock('../services/hireWorkspaceWriteFence', () => ({
  withActiveHireWorkspaceWriteTransaction: mocks.transaction,
}))
vi.mock('../services/hireCandidatePrivacyWriteFence', () => ({
  claimHireCandidatePiiWriteFence: mocks.piiFence,
  HireCandidatePiiTombstoneError: class HireCandidatePiiTombstoneError extends Error {},
}))
vi.mock('../models', () => ({
  TERMINAL_STAGES: ['hired', 'rejected', 'withdrawn'],
  HireJob: mocks.job,
  HireCandidate: mocks.candidate,
  HireApplication: mocks.application,
  HireEmailOutbox: mocks.emailOutbox,
  HirePrivacyRequest: mocks.privacy,
}))
vi.mock('../models/HireJobRequirementVersion', () => ({
  HireJobRequirementVersion: mocks.requirementVersion,
}))
vi.mock('../models/HireReengagementOptOut', () => ({
  HireReengagementOptOut: mocks.optOut,
}))

import {
  listJobPoolSuggestions,
  reengagePoolCandidate,
} from '../services/duplicateJobPoolService'

const WORKSPACE_ID = new mongoose.Types.ObjectId('111111111111111111111111')
const MEMBER_ID = new mongoose.Types.ObjectId('222222222222222222222222')
const JOB_ID = new mongoose.Types.ObjectId('333333333333333333333333')
const PREVIOUS_JOB_ID = new mongoose.Types.ObjectId('444444444444444444444444')
const CANDIDATE_ID = new mongoose.Types.ObjectId('555555555555555555555555')
const APPLICATION_ID = new mongoose.Types.ObjectId('666666666666666666666666')
const OPERATION_ID = '11111111-1111-4111-8111-111111111111'
const NOW = new Date('2026-08-13T10:00:00.000Z')
const session = { id: 'session-1' }

const ctx = {
  workspace: { _id: WORKSPACE_ID, name: 'Acme' },
  membership: { _id: MEMBER_ID, email: 'hr@acme.example', name: 'HR One' },
} as never

function leanQuery<T>(value: T) {
  return {
    select: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue(value) }),
  }
}

function candidateListQuery<T>(value: T) {
  return {
    select: vi.fn().mockReturnValue({
      sort: vi.fn().mockReturnValue({
        limit: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue(value) }),
      }),
    }),
  }
}

function applicationListQuery<T>(value: T) {
  return {
    select: vi.fn().mockReturnValue({
      sort: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue(value) }),
    }),
  }
}

function sessionValue<T>(value: T) {
  return { session: vi.fn().mockResolvedValue(value) }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.connect.mockResolvedValue(undefined)
  mocks.transaction.mockImplementation(
    async (_workspaceId: unknown, _memberId: unknown, work: (value: unknown) => unknown) => work(session),
  )
  mocks.piiFence.mockResolvedValue(undefined)
  mocks.job.updateOne.mockResolvedValue({ matchedCount: 1 })
  mocks.candidate.updateOne.mockResolvedValue({ matchedCount: 1 })
  mocks.application.create.mockResolvedValue([{ _id: APPLICATION_ID }])
  mocks.emailOutbox.create.mockResolvedValue([])
})

describe('duplicate job pool suggestions', () => {
  it('returns deterministic workspace-local suggestions without writing an application or resume artifact', async () => {
    mocks.job.findOne.mockReturnValue(leanQuery({
      _id: JOB_ID,
      activeRequirementVersionId: new mongoose.Types.ObjectId('777777777777777777777777'),
      status: 'open',
    }))
    mocks.requirementVersion.findOne.mockReturnValue(leanQuery({
      requirements: [
        { id: 'one', text: 'TypeScript platform services', importance: 'must_have' },
        { id: 'two', text: 'Kafka', importance: 'nice_to_have' },
      ],
    }))
    mocks.candidate.find.mockReturnValue(candidateListQuery([
      {
        _id: CANDIDATE_ID,
        name: 'Ada Lovelace',
        email: 'ada@example.com',
        resumeText: 'Built TypeScript platform services and distributed systems.',
      },
    ]))
    mocks.application.find.mockReturnValue(applicationListQuery([
      {
        _id: APPLICATION_ID,
        candidateId: CANDIDATE_ID,
        jobId: PREVIOUS_JOB_ID,
        stage: 'rejected',
        updatedAt: NOW,
      },
    ]))
    mocks.optOut.find.mockReturnValue(leanQuery([]))
    mocks.privacy.find.mockReturnValue(leanQuery([]))
    mocks.job.find.mockReturnValue(leanQuery([{ _id: PREVIOUS_JOB_ID, title: 'Platform Engineer' }]))

    await expect(listJobPoolSuggestions(ctx, JOB_ID.toString())).resolves.toEqual([
      {
        candidate: { id: CANDIDATE_ID.toString(), name: 'Ada Lovelace', email: 'ada@example.com' },
        matchScore: 67,
        matchedRequirements: ['TypeScript platform services'],
        previouslySeenIn: [
          { jobId: PREVIOUS_JOB_ID.toString(), jobTitle: 'Platform Engineer', stage: 'rejected' },
        ],
      },
    ])
    expect(mocks.candidate.find).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      piiAnonymizedAt: { $exists: false },
      resumeText: { $type: 'string', $ne: '' },
    })
    expect(mocks.application.find).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      candidateId: { $in: [CANDIDATE_ID] },
      stage: { $in: ['hired', 'rejected', 'withdrawn'] },
    })
    expect(mocks.application.create).not.toHaveBeenCalled()
    expect(mocks.emailOutbox.create).not.toHaveBeenCalled()
    expect(mocks.job.updateOne).not.toHaveBeenCalled()
  })

  it('creates an application and a re-engagement outbox row only for an explicit member confirmation', async () => {
    mocks.job.findOne.mockReturnValue(sessionValue({
      _id: JOB_ID,
      workspaceId: WORKSPACE_ID,
      title: 'Backend Engineer',
      status: 'open',
    }))
    mocks.candidate.findOne.mockReturnValue(sessionValue({
      _id: CANDIDATE_ID,
      workspaceId: WORKSPACE_ID,
      name: 'Ada Lovelace',
      email: 'ada@example.com',
      source: 'apply_page',
      sourceHistory: ['apply_page'],
    }))
    mocks.application.findOne.mockReturnValue(sessionValue(null))
    mocks.optOut.exists.mockReturnValue(sessionValue(null))
    mocks.privacy.exists.mockReturnValue(sessionValue(null))
    mocks.application.exists.mockReturnValue(sessionValue({ _id: APPLICATION_ID }))

    await expect(reengagePoolCandidate(ctx, JOB_ID.toString(), {
      candidateId: CANDIDATE_ID.toString(),
      operationId: OPERATION_ID,
      now: NOW,
    })).resolves.toEqual({
      status: 'queued',
      candidateId: CANDIDATE_ID.toString(),
      applicationId: APPLICATION_ID.toString(),
    })

    expect(mocks.transaction).toHaveBeenCalledWith(WORKSPACE_ID, MEMBER_ID, expect.any(Function))
    expect(mocks.job.updateOne).toHaveBeenCalledWith(
      { _id: JOB_ID, workspaceId: WORKSPACE_ID, status: 'open' },
      { $inc: { intakeWriteVersion: 1 } },
      { session },
    )
    expect(mocks.emailOutbox.create).toHaveBeenCalledWith(
      [expect.objectContaining({
        workspaceId: WORKSPACE_ID,
        jobId: JOB_ID,
        applicationId: APPLICATION_ID,
        candidateId: CANDIDATE_ID,
        kind: 'job_reengagement',
        operationId: OPERATION_ID,
        recipientEmail: 'ada@example.com',
        recipientName: 'Ada Lovelace',
        status: 'pending',
        sendAfter: NOW,
      })],
      { session },
    )
    expect(mocks.application.exists).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      candidateId: CANDIDATE_ID,
      jobId: { $ne: JOB_ID },
      stage: { $in: ['hired', 'rejected', 'withdrawn'] },
    })
  })

  it('does not add or email an opted-out candidate, scoped to the member workspace', async () => {
    mocks.job.findOne.mockReturnValue(sessionValue({
      _id: JOB_ID,
      workspaceId: WORKSPACE_ID,
      title: 'Backend Engineer',
      status: 'open',
    }))
    mocks.candidate.findOne.mockReturnValue(sessionValue({
      _id: CANDIDATE_ID,
      workspaceId: WORKSPACE_ID,
      name: 'Ada Lovelace',
      email: 'ada@example.com',
      source: 'apply_page',
    }))
    mocks.application.findOne.mockReturnValue(sessionValue(null))
    mocks.optOut.exists.mockReturnValue(sessionValue({ _id: 'optout-1' }))

    await expect(reengagePoolCandidate(ctx, JOB_ID.toString(), {
      candidateId: CANDIDATE_ID.toString(),
      operationId: OPERATION_ID,
      now: NOW,
    })).resolves.toEqual({ status: 'opted_out', candidateId: CANDIDATE_ID.toString() })

    expect(mocks.optOut.exists).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      candidateId: CANDIDATE_ID,
    })
    expect(mocks.application.create).not.toHaveBeenCalled()
    expect(mocks.emailOutbox.create).not.toHaveBeenCalled()
  })
})
