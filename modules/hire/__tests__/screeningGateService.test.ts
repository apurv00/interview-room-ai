import { createHash } from 'node:crypto'
import mongoose from 'mongoose'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AppError } from '@shared/errors'

const mocks = vi.hoisted(() => {
  const chain = <T>(value: T) => {
    const query = {
      select: vi.fn(() => query),
      sort: vi.fn(() => query),
      limit: vi.fn(() => query),
      session: vi.fn(() => query),
      then: (resolve: (value: T) => unknown, reject?: (reason: unknown) => unknown) =>
        Promise.resolve(value).then(resolve, reject),
    }
    return query
  }
  return {
    chain,
    connectHireControlDB: vi.fn().mockResolvedValue(undefined),
    withWriteTransaction: vi.fn(
      async (_workspaceId: unknown, _memberId: unknown, work: (session: unknown) => Promise<unknown>) =>
        work({ id: 'screening-session' }),
    ),
    claimCandidateFence: vi.fn().mockResolvedValue(undefined),
    onboardingFence: vi.fn().mockResolvedValue(undefined),
    job: { findOne: vi.fn(), updateOne: vi.fn(), exists: vi.fn() },
    requirement: { findOne: vi.fn() },
    application: { find: vi.fn(), updateOne: vi.fn() },
    candidate: { find: vi.fn() },
    privacy: { find: vi.fn() },
    round: { find: vi.fn() },
    gate: { find: vi.fn(), create: vi.fn() },
    batch: { find: vi.fn(), create: vi.fn() },
    item: { create: vi.fn() },
  }
})

vi.mock('../services/hireControlBoundary', () => ({
  connectHireControlDB: mocks.connectHireControlDB,
}))

vi.mock('../services/hireWorkspaceWriteFence', () => ({
  withActiveHireWorkspaceWriteTransaction: mocks.withWriteTransaction,
}))

vi.mock('../services/hireCandidatePrivacyWriteFence', () => ({
  claimHireCandidatePiiWriteFence: mocks.claimCandidateFence,
}))

vi.mock('@hire-onboarding-boundary', () => ({
  assertHireOnboardingTestDriveWriteIsolation: (...args: unknown[]) =>
    mocks.onboardingFence(...args),
}))

vi.mock('../models', () => ({
  HIRE_SCREENING_GATE_SNAPSHOT_CAP: 5000,
  HireJob: mocks.job,
  HireJobRequirementVersion: mocks.requirement,
  HireApplication: mocks.application,
  HireCandidate: mocks.candidate,
  HirePrivacyRequest: mocks.privacy,
  HireRound: mocks.round,
  HireScreeningGate: mocks.gate,
  HireInvitationBatch: mocks.batch,
  HireInvitationBatchItem: mocks.item,
  TERMINAL_STAGES: ['hired', 'rejected', 'withdrawn'],
  activeHirePrivacyRequestFilter: (now: Date) => ({
    live: true,
    $or: [
      { status: 'processing' },
      { status: 'pending_verification', verificationExpiresAt: { $gt: now } },
    ],
  }),
}))

import {
  confirmJobScreeningGate,
  listJobScreeningGates,
  previewJobScreeningGate,
} from '../services/screeningGateService'
import type { MembershipContext } from '../services/workspaceService'

const WORKSPACE_ID = new mongoose.Types.ObjectId('111111111111111111111111')
const JOB_ID = new mongoose.Types.ObjectId('222222222222222222222222')
const REQUIREMENT_ID = new mongoose.Types.ObjectId('333333333333333333333333')
const MEMBER_ID = new mongoose.Types.ObjectId('444444444444444444444444')
const FRESH_APPLICATION_ID = new mongoose.Types.ObjectId('555555555555555555555555')
const STALE_APPLICATION_ID = new mongoose.Types.ObjectId('666666666666666666666666')
const FRESH_CANDIDATE_ID = new mongoose.Types.ObjectId('777777777777777777777777')
const STALE_CANDIDATE_ID = new mongoose.Types.ObjectId('888888888888888888888888')

const CTX = {
  workspace: { _id: WORKSPACE_ID, name: 'Acme' },
  membership: {
    _id: MEMBER_ID,
    email: 'hr@acme.example',
    name: 'Ava Recruiter',
    role: 'admin',
  },
} as unknown as MembershipContext

function hash(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

const job = {
  _id: JOB_ID,
  workspaceId: WORKSPACE_ID,
  status: 'open',
  jdText: 'Current reviewed job description',
  screeningSettings: { location: 'Bengaluru, India', experienceFloorYears: 4 },
  activeRequirementVersionId: REQUIREMENT_ID,
  activeRequirementVersion: 2,
}

function application(input: {
  id: mongoose.Types.ObjectId
  candidateId: mongoose.Types.ObjectId
  createdAt: Date
  score: number
  resumeHash: string
}) {
  return {
    _id: input.id,
    workspaceId: WORKSPACE_ID,
    jobId: JOB_ID,
    candidateId: input.candidateId,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
    resumeMatch: {
      score: input.score,
      strengths: [],
      gaps: [],
      scoredAt: input.createdAt,
      jdHash: hash(job.jdText),
      resumeHash: input.resumeHash,
    },
    applicantSubmissions: [],
  }
}

function candidate(input: {
  id: mongoose.Types.ObjectId
  resumeText: string
  location?: string
  experienceYears?: number
}) {
  return {
    _id: input.id,
    workspaceId: WORKSPACE_ID,
    resumeText: input.resumeText,
    screeningProfile: {
      ...(input.location ? { location: input.location } : {}),
      ...(input.experienceYears !== undefined ? { experienceYears: input.experienceYears } : {}),
      resumeHash: hash(input.resumeText),
      extractedAt: new Date('2026-08-12T08:00:00.000Z'),
    },
  }
}

function currentCandidates() {
  return [
    candidate({
      id: FRESH_CANDIDATE_ID,
      resumeText: 'Fresh current resume',
      location: 'Bengaluru, India',
      experienceYears: 6,
    }),
    candidate({
      id: STALE_CANDIDATE_ID,
      resumeText: 'Changed current resume',
      location: 'Mumbai, India',
      experienceYears: 8,
    }),
  ]
}

function setCurrentRows() {
  const freshResume = 'Fresh current resume'
  const applications = [
    application({
      id: FRESH_APPLICATION_ID,
      candidateId: FRESH_CANDIDATE_ID,
      createdAt: new Date('2026-08-12T09:00:00.000Z'),
      score: 84,
      resumeHash: hash(freshResume),
    }),
    application({
      id: STALE_APPLICATION_ID,
      candidateId: STALE_CANDIDATE_ID,
      createdAt: new Date('2026-08-12T08:00:00.000Z'),
      score: 99,
      resumeHash: hash('Old replaced resume'),
    }),
  ]
  mocks.job.findOne.mockImplementation(() => mocks.chain(job))
  mocks.requirement.findOne.mockImplementation(() =>
    mocks.chain({ _id: REQUIREMENT_ID, version: 2, contentHash: 'c'.repeat(64) }),
  )
  mocks.application.find.mockImplementation(() => mocks.chain(applications))
  mocks.candidate.find.mockImplementation(() => mocks.chain(currentCandidates()))
  mocks.privacy.find.mockImplementation(() => mocks.chain([]))
  mocks.round.find.mockImplementation(() => mocks.chain([]))
}

beforeEach(() => {
  vi.clearAllMocks()
  setCurrentRows()
  mocks.job.updateOne.mockResolvedValue({ matchedCount: 1 })
  mocks.onboardingFence.mockResolvedValue(undefined)
  mocks.job.exists.mockImplementation(() => mocks.chain(true))
  mocks.gate.create.mockImplementation(async (docs: unknown[]) => docs)
  mocks.batch.create.mockImplementation(async (docs: unknown[]) => docs)
  mocks.item.create.mockImplementation(async (docs: unknown[]) => docs)
  mocks.gate.find.mockImplementation(() => mocks.chain([]))
  mocks.batch.find.mockImplementation(() => mocks.chain([]))
})

describe('screeningGateService', () => {
  const request = { rule: { mode: 'top_n' as const, topN: 1 } }

  it('builds a tenant-scoped, read-only preview using current profiles and fresh scores', async () => {
    const result = await previewJobScreeningGate(CTX, JOB_ID.toString(), request)

    expect(result.preview.rankedApplications.map((entry) => entry.applicationId)).toEqual([
      FRESH_APPLICATION_ID.toString(),
      STALE_APPLICATION_ID.toString(),
    ])
    expect(result.preview.rankedApplications[0]).toMatchObject({
      scoreState: 'scored',
      selected: true,
      selectionReason: 'top_n',
    })
    expect(result.preview.rankedApplications[1]).toMatchObject({
      score: 99,
      scoreState: 'stale',
      knockoutReasons: ['location'],
      selected: false,
    })
    expect(result.previewFingerprint).toMatch(/^[a-f0-9]{64}$/)
    expect(result.requirementVersion).toEqual({
      id: REQUIREMENT_ID.toString(),
      version: 2,
      contentHash: 'c'.repeat(64),
    })
    expect(mocks.application.find).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      jobId: JOB_ID,
      stage: { $nin: ['hired', 'rejected', 'withdrawn'] },
    })
    expect(mocks.candidate.find).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: WORKSPACE_ID }),
    )
    expect(mocks.job.updateOne).not.toHaveBeenCalled()
    expect(mocks.gate.create).not.toHaveBeenCalled()
    expect(mocks.item.create).not.toHaveBeenCalled()
  })

  it('rebuilds the exact preview inside the active-workspace transaction and freezes gate, contract, and unsent items', async () => {
    const preview = await previewJobScreeningGate(CTX, JOB_ID.toString(), request)

    const result = await confirmJobScreeningGate(CTX, JOB_ID.toString(), {
      ...request,
      previewFingerprint: preview.previewFingerprint,
      sendAfter: '2026-08-13T09:00:00.000Z',
    })

    expect(mocks.withWriteTransaction).toHaveBeenCalledWith(
      WORKSPACE_ID,
      MEMBER_ID,
      expect.any(Function),
    )
    expect(mocks.job.updateOne).toHaveBeenCalledWith(
      { _id: JOB_ID, workspaceId: WORKSPACE_ID, status: 'open' },
      { $inc: { intakeWriteVersion: 1 } },
      { session: { id: 'screening-session' } },
    )
    const gateDocument = mocks.gate.create.mock.calls[0][0][0]
    expect(gateDocument).toMatchObject({
      workspaceId: WORKSPACE_ID,
      jobId: JOB_ID,
      requirementVersionId: REQUIREMENT_ID,
      requirementVersion: 2,
      requirementContentHash: 'c'.repeat(64),
      selectionMode: 'top_n',
      selectedCount: 1,
      confirmedByMemberId: MEMBER_ID,
      confirmedByName: 'Ava Recruiter',
    })
    const batchDocument = mocks.batch.create.mock.calls[0][0][0]
    expect(batchDocument).toMatchObject({
      workspaceId: WORKSPACE_ID,
      jobId: JOB_ID,
      wave: 1,
      status: 'planned',
      plannedCount: 1,
      createdByMemberId: MEMBER_ID,
    })
    const itemDocument = mocks.item.create.mock.calls[0][0][0]
    expect(itemDocument).toMatchObject({
      applicationId: FRESH_APPLICATION_ID,
      candidateId: FRESH_CANDIDATE_ID,
      status: 'pending',
      selectionReason: 'top_n',
    })
    expect(mocks.claimCandidateFence).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: WORKSPACE_ID,
        candidateId: FRESH_CANDIDATE_ID,
        session: { id: 'screening-session' },
      }),
    )
    expect(mocks.application.updateOne).not.toHaveBeenCalled()
    expect(result.itemCount).toBe(1)
    expect(result.requirementVersion).toEqual({
      id: REQUIREMENT_ID.toString(),
      version: 2,
      contentHash: 'c'.repeat(64),
    })
  })

  it('excludes active and completed-deletion candidates from the recipient set', async () => {
    mocks.privacy.find.mockImplementation(() =>
      mocks.chain([{ candidateId: STALE_CANDIDATE_ID }]),
    )
    mocks.candidate.find.mockImplementation(() => mocks.chain([
      {
        ...currentCandidates()[0],
        piiAnonymizedAt: new Date('2026-08-12T08:30:00.000Z'),
      },
    ]))

    const result = await previewJobScreeningGate(CTX, JOB_ID.toString(), request)

    expect(result.preview.rankedApplications).toEqual([])
    expect(result.preview.selectedCount).toBe(0)
    expect(mocks.privacy.find).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      candidateId: { $in: [FRESH_CANDIDATE_ID, STALE_CANDIDATE_ID] },
      live: true,
      $or: [
        { status: 'processing' },
        {
          status: 'pending_verification',
          verificationExpiresAt: { $gt: expect.any(Date) },
        },
      ],
    })
  })

  it('rejects confirmation when a reviewed recipient is anonymized', async () => {
    const requestWithException = {
      ...request,
      exceptions: [{ applicationId: FRESH_APPLICATION_ID.toString(), action: 'include' as const, note: 'Reviewed exception' }],
    }
    const preview = await previewJobScreeningGate(CTX, JOB_ID.toString(), requestWithException)
    mocks.candidate.find.mockImplementation(() => mocks.chain(
      currentCandidates().map((row) =>
        row._id.equals(FRESH_CANDIDATE_ID)
          ? { ...row, piiAnonymizedAt: new Date('2026-08-12T09:30:00.000Z') }
          : row,
      ),
    ))

    await expect(
      confirmJobScreeningGate(CTX, JOB_ID.toString(), {
        ...requestWithException,
        previewFingerprint: preview.previewFingerprint,
      }),
    ).rejects.toMatchObject({ code: 'SCREENING_PREVIEW_STALE', statusCode: 409 })

    expect(mocks.gate.create).not.toHaveBeenCalled()
    expect(mocks.batch.create).not.toHaveBeenCalled()
    expect(mocks.item.create).not.toHaveBeenCalled()
  })

  it('rejects a synthetic practice job before creating a gate or invitation batch', async () => {
    mocks.onboardingFence.mockRejectedValue(
      new AppError('Practice interviews are isolated', 409, 'ONBOARDING_TEST_DRIVE_ISOLATED'),
    )

    await expect(
      confirmJobScreeningGate(CTX, JOB_ID.toString(), {
        ...request,
        previewFingerprint: 'a'.repeat(64),
      }),
    ).rejects.toMatchObject({ code: 'ONBOARDING_TEST_DRIVE_ISOLATED' })

    expect(mocks.job.updateOne).not.toHaveBeenCalled()
    expect(mocks.gate.create).not.toHaveBeenCalled()
    expect(mocks.batch.create).not.toHaveBeenCalled()
    expect(mocks.item.create).not.toHaveBeenCalled()
  })

  it('rejects a changed queue before creating a gate or batch', async () => {
    await expect(
      confirmJobScreeningGate(CTX, JOB_ID.toString(), {
        ...request,
        previewFingerprint: 'f'.repeat(64),
      }),
    ).rejects.toMatchObject({ code: 'SCREENING_PREVIEW_STALE', statusCode: 409 })

    expect(mocks.gate.create).not.toHaveBeenCalled()
    expect(mocks.batch.create).not.toHaveBeenCalled()
    expect(mocks.item.create).not.toHaveBeenCalled()
  })

  it('rejects confirmation when the active requirement contract is absent', async () => {
    const preview = await previewJobScreeningGate(CTX, JOB_ID.toString(), request)
    mocks.requirement.findOne.mockImplementation(() => mocks.chain(null))

    await expect(
      confirmJobScreeningGate(CTX, JOB_ID.toString(), {
        ...request,
        previewFingerprint: preview.previewFingerprint,
      }),
    ).rejects.toMatchObject({ code: 'JOB_REQUIREMENT_VERSION_INVALID', statusCode: 409 })
    expect(mocks.gate.create).not.toHaveBeenCalled()
  })

  it('rejects confirmation if the active requirement contract changed after review', async () => {
    const preview = await previewJobScreeningGate(CTX, JOB_ID.toString(), request)
    mocks.job.findOne.mockImplementation(() =>
      mocks.chain({ ...job, activeRequirementVersion: 3 }),
    )
    mocks.requirement.findOne.mockImplementation(() =>
      mocks.chain({ _id: REQUIREMENT_ID, version: 3, contentHash: 'e'.repeat(64) }),
    )

    await expect(
      confirmJobScreeningGate(CTX, JOB_ID.toString(), {
        ...request,
        previewFingerprint: preview.previewFingerprint,
      }),
    ).rejects.toMatchObject({ code: 'SCREENING_PREVIEW_STALE', statusCode: 409 })
    expect(mocks.gate.create).not.toHaveBeenCalled()
  })

  it('keeps terminal applications and existing live AI rounds out of a confirmed invite plan', async () => {
    const preview = await previewJobScreeningGate(CTX, JOB_ID.toString(), request)
    expect(mocks.application.find).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      jobId: JOB_ID,
      stage: { $nin: ['hired', 'rejected', 'withdrawn'] },
    })

    // The candidate can start a round while HR reviews. The transactional
    // rebuild must remove that live round from selection and reject the stale
    // proof instead of creating a worker item that would only be skipped.
    mocks.round.find.mockImplementation(() =>
      mocks.chain([{ applicationId: FRESH_APPLICATION_ID }]),
    )

    await expect(
      confirmJobScreeningGate(CTX, JOB_ID.toString(), {
        ...request,
        previewFingerprint: preview.previewFingerprint,
      }),
    ).rejects.toMatchObject({ code: 'SCREENING_PREVIEW_STALE', statusCode: 409 })

    expect(mocks.round.find).toHaveBeenLastCalledWith({
      workspaceId: WORKSPACE_ID,
      jobId: JOB_ID,
      applicationId: { $in: [FRESH_APPLICATION_ID, STALE_APPLICATION_ID] },
      kind: 'ai',
      live: true,
      status: { $nin: ['completed', 'revoked'] },
      revokedAt: { $exists: false },
      inviteTokenExpiry: { $gt: expect.any(Date) },
    })
    expect(mocks.gate.create).not.toHaveBeenCalled()
    expect(mocks.batch.create).not.toHaveBeenCalled()
    expect(mocks.item.create).not.toHaveBeenCalled()
  })

  it('lists only workspace-and-job-scoped gate batches', async () => {
    const gateId = new mongoose.Types.ObjectId('999999999999999999999999')
    const gate = { _id: gateId, workspaceId: WORKSPACE_ID, jobId: JOB_ID }
    const batch = { _id: new mongoose.Types.ObjectId(), workspaceId: WORKSPACE_ID, jobId: JOB_ID, screeningGateId: gateId }
    mocks.gate.find.mockImplementation(() => mocks.chain([gate]))
    mocks.batch.find.mockImplementation(() => mocks.chain([batch]))

    const result = await listJobScreeningGates(CTX, JOB_ID.toString())

    expect(result).toEqual([{ gate, batches: [batch] }])
    expect(mocks.gate.find).toHaveBeenCalledWith({ workspaceId: WORKSPACE_ID, jobId: JOB_ID })
    expect(mocks.batch.find).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      jobId: JOB_ID,
      screeningGateId: { $in: [gateId] },
    })
  })
})
