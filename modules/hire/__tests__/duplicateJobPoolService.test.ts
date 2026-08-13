import mongoose from 'mongoose'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  job: { findOne: vi.fn(), find: vi.fn() },
  candidate: { find: vi.fn() },
  application: { find: vi.fn() },
  privacy: { find: vi.fn() },
  requirementVersion: { findOne: vi.fn() },
}))

vi.mock('../services/hireControlBoundary', () => ({
  connectHireControlDB: mocks.connect,
}))
vi.mock('../models', () => ({
  TERMINAL_STAGES: ['hired', 'rejected', 'withdrawn'],
  HireJob: mocks.job,
  HireCandidate: mocks.candidate,
  HireApplication: mocks.application,
  HirePrivacyRequest: mocks.privacy,
}))
vi.mock('../models/HireJobRequirementVersion', () => ({
  HireJobRequirementVersion: mocks.requirementVersion,
}))

import { listJobPoolSuggestions } from '../services/duplicateJobPoolService'

const WORKSPACE_ID = new mongoose.Types.ObjectId('111111111111111111111111')
const JOB_ID = new mongoose.Types.ObjectId('333333333333333333333333')
const PREVIOUS_JOB_ID = new mongoose.Types.ObjectId('444444444444444444444444')
const CANDIDATE_ID = new mongoose.Types.ObjectId('555555555555555555555555')
const APPLICATION_ID = new mongoose.Types.ObjectId('666666666666666666666666')
const NOW = new Date('2026-08-13T10:00:00.000Z')

const ctx = {
  workspace: { _id: WORKSPACE_ID, name: 'Acme' },
  membership: { _id: new mongoose.Types.ObjectId('222222222222222222222222'), email: 'hr@acme.example', name: 'HR One' },
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

function setupCandidateAndJob() {
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
  mocks.job.find.mockReturnValue(leanQuery([{ _id: PREVIOUS_JOB_ID, title: 'Platform Engineer' }]))
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.connect.mockResolvedValue(undefined)
})

describe('duplicate job pool suggestions', () => {
  it('returns deterministic workspace-local suggestions without writing an application or contacting a candidate', async () => {
    setupCandidateAndJob()
    mocks.application.find.mockReturnValue(applicationListQuery([
      {
        _id: APPLICATION_ID,
        candidateId: CANDIDATE_ID,
        jobId: PREVIOUS_JOB_ID,
        stage: 'rejected',
        updatedAt: NOW,
      },
    ]))
    mocks.privacy.find.mockReturnValue(leanQuery([]))

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
    })
    expect(mocks.privacy.find).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      candidateId: { $in: [CANDIDATE_ID] },
      live: true,
      status: { $in: ['pending_verification', 'processing'] },
    })
  })

  it('excludes a candidate with any existing application on the current job', async () => {
    setupCandidateAndJob()
    mocks.application.find.mockReturnValue(applicationListQuery([
      {
        _id: APPLICATION_ID,
        candidateId: CANDIDATE_ID,
        jobId: PREVIOUS_JOB_ID,
        stage: 'rejected',
        updatedAt: NOW,
      },
      {
        _id: new mongoose.Types.ObjectId('888888888888888888888888'),
        candidateId: CANDIDATE_ID,
        jobId: JOB_ID,
        stage: 'screened',
        updatedAt: NOW,
      },
    ]))
    mocks.privacy.find.mockReturnValue(leanQuery([]))

    await expect(listJobPoolSuggestions(ctx, JOB_ID.toString())).resolves.toEqual([])
  })

  it('excludes only candidates with a live privacy request in this workspace', async () => {
    setupCandidateAndJob()
    mocks.application.find.mockReturnValue(applicationListQuery([
      {
        _id: APPLICATION_ID,
        candidateId: CANDIDATE_ID,
        jobId: PREVIOUS_JOB_ID,
        stage: 'rejected',
        updatedAt: NOW,
      },
    ]))
    mocks.privacy.find.mockReturnValue(leanQuery([{ candidateId: CANDIDATE_ID }]))

    await expect(listJobPoolSuggestions(ctx, JOB_ID.toString())).resolves.toEqual([])
  })
})
