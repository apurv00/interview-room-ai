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
    readSelection: vi.fn(),
    claimCandidateFence: vi.fn().mockResolvedValue(undefined),
    onboardingFence: vi.fn().mockResolvedValue(undefined),
    job: { findOne: vi.fn(), updateOne: vi.fn(), exists: vi.fn() },
    requirement: { findOne: vi.fn() },
    application: { find: vi.fn(), updateOne: vi.fn() },
    candidate: { find: vi.fn(), updateMany: vi.fn() },
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

vi.mock('@hire-operations', () => ({
  readCandidateSelectionSnapshot: (...args: unknown[]) =>
    mocks.readSelection(...args),
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
const SELECTION_ID = '999999999999999999999999'

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
    stage: 'applied',
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
  mocks.candidate.updateMany.mockResolvedValue({ matchedCount: 1 })
  mocks.gate.find.mockImplementation(() => mocks.chain([]))
  mocks.batch.find.mockImplementation(() => mocks.chain([]))
})

describe('screeningGateService', () => {
  const request = { rule: { mode: 'top_n' as const, topN: 1 } }
  const selectionRequest = {
    ...request,
    selectionSnapshotId: SELECTION_ID,
    selectionNote: 'Recruiter selected this cohort for documented screening review',
  }

  function selectedStaleCandidateSnapshot(expectedStage = 'applied') {
    return {
      selectionId: SELECTION_ID,
      jobId: JOB_ID.toString(),
      applicationIds: [STALE_APPLICATION_ID.toString()],
      entries: [
        {
          applicationId: STALE_APPLICATION_ID.toString(),
          expectedStage,
        },
      ],
      count: 1,
      description: 'This page · 1 candidate',
      expiresAt: new Date('2099-08-12T12:00:00.000Z'),
    }
  }

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
    expect(mocks.application.find.mock.results[0].value.select).toHaveBeenCalledWith(
      '_id workspaceId jobId candidateId stage createdAt resumeMatch.score resumeMatch.jdHash resumeMatch.resumeHash applicantSubmissions.match.resumeHash',
    )
    expect(mocks.candidate.find.mock.results[0].value.select).toHaveBeenCalledWith(
      '_id workspaceId screeningProfile piiAnonymizedAt',
    )
    expect(mocks.job.updateOne).not.toHaveBeenCalled()
    expect(mocks.gate.create).not.toHaveBeenCalled()
    expect(mocks.item.create).not.toHaveBeenCalled()
  })

  it('keeps an apply-page score fresh when its retained submission hash still matches', async () => {
    const retainedResumeHash = hash('Public apply resume')
    const publicApplication = application({
      id: FRESH_APPLICATION_ID,
      candidateId: FRESH_CANDIDATE_ID,
      createdAt: new Date('2026-08-12T09:00:00.000Z'),
      score: 91,
      resumeHash: retainedResumeHash,
    })
    publicApplication.applicantSubmissions = [{
      match: { resumeHash: retainedResumeHash },
    }] as never
    Object.assign(publicApplication.resumeMatch, { stale: true })
    mocks.application.find.mockImplementation(() => mocks.chain([publicApplication]))
    mocks.candidate.find.mockImplementation(() => mocks.chain([
      candidate({
        id: FRESH_CANDIDATE_ID,
        resumeText: 'A different pool resume',
        location: 'Bengaluru, India',
        experienceYears: 6,
      }),
    ]))

    const result = await previewJobScreeningGate(CTX, JOB_ID.toString(), request)

    expect(result.preview.rankedApplications).toEqual([
      expect.objectContaining({
        applicationId: FRESH_APPLICATION_ID.toString(),
        score: 91,
        scoreState: 'scored',
      }),
    ])
  })

  it('returns a controlled stale-preview conflict when an exception target is unavailable', async () => {
    await expect(
      previewJobScreeningGate(CTX, JOB_ID.toString(), {
        ...request,
        exceptions: [{
          applicationId: 'abababababababababababab',
          action: 'include',
          note: 'Recruiter reviewed this exception',
        }],
      }),
    ).rejects.toMatchObject({ code: 'SCREENING_PREVIEW_STALE', statusCode: 409 })
  })

  it('uses a scoped snapshot as the exact manually included population', async () => {
    mocks.readSelection.mockResolvedValue(selectedStaleCandidateSnapshot())

    const result = await previewJobScreeningGate(
      CTX,
      JOB_ID.toString(),
      selectionRequest,
    )

    expect(mocks.readSelection).toHaveBeenCalledWith(
      CTX,
      expect.objectContaining({
        jobId: JOB_ID.toString(),
        selectionId: SELECTION_ID,
        now: expect.any(Date),
      }),
    )
    expect(result.preview.rankedApplications).toHaveLength(1)
    expect(result.preview.rankedApplications[0]).toMatchObject({
      applicationId: STALE_APPLICATION_ID.toString(),
      knockoutReasons: ['location'],
      selected: true,
      selectionReason: 'manual_include',
    })
    expect(result.preview.rankedApplications).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ applicationId: FRESH_APPLICATION_ID.toString() }),
      ]),
    )
    expect(result.preview.exceptions).toEqual([])
    expect(result.preview.selectedCount).toBe(1)
  })

  it('re-resolves the handoff in the write transaction and persists its rationale', async () => {
    mocks.readSelection.mockResolvedValue(selectedStaleCandidateSnapshot())
    const preview = await previewJobScreeningGate(
      CTX,
      JOB_ID.toString(),
      selectionRequest,
    )

    const confirmed = await confirmJobScreeningGate(
      CTX,
      JOB_ID.toString(),
      {
        ...selectionRequest,
        previewFingerprint: preview.previewFingerprint,
      },
    )

    expect(confirmed.previewFingerprint).toBe(preview.previewFingerprint)
    expect(mocks.readSelection).toHaveBeenLastCalledWith(
      CTX,
      expect.objectContaining({
        jobId: JOB_ID.toString(),
        selectionId: SELECTION_ID,
        session: { id: 'screening-session' },
      }),
    )
    const gateDocument = mocks.gate.create.mock.calls[0][0][0]
    expect(gateDocument.exceptions).toEqual([])
    expect(gateDocument.selectionHandoff).toEqual(
      expect.objectContaining({
        selectionSnapshotId: new mongoose.Types.ObjectId(SELECTION_ID),
        actorMemberId: MEMBER_ID,
        actorName: 'Ava Recruiter',
        note: selectionRequest.selectionNote,
      }),
    )
    expect(JSON.stringify(gateDocument).match(
      new RegExp(selectionRequest.selectionNote, 'g'),
    )).toHaveLength(1)
    expect(mocks.item.create.mock.calls[0][0]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          applicationId: STALE_APPLICATION_ID,
          selectionReason: 'manual_include',
        }),
      ]),
    )
  })

  it('rejects a selection snapshot whose expected stage is no longer current', async () => {
    mocks.readSelection.mockResolvedValue(
      selectedStaleCandidateSnapshot('human_interview'),
    )

    await expect(
      previewJobScreeningGate(CTX, JOB_ID.toString(), selectionRequest),
    ).rejects.toMatchObject({
      code: 'SCREENING_SELECTION_STALE',
      statusCode: 409,
    })
    expect(mocks.gate.create).not.toHaveBeenCalled()
    expect(mocks.batch.create).not.toHaveBeenCalled()
  })

  it('rejects confirmation when a snapshot candidate becomes privacy protected', async () => {
    mocks.readSelection.mockResolvedValue(selectedStaleCandidateSnapshot())
    const preview = await previewJobScreeningGate(
      CTX,
      JOB_ID.toString(),
      selectionRequest,
    )
    mocks.privacy.find.mockImplementation(() =>
      mocks.chain([{ candidateId: STALE_CANDIDATE_ID }]),
    )

    await expect(
      confirmJobScreeningGate(CTX, JOB_ID.toString(), {
        ...selectionRequest,
        previewFingerprint: preview.previewFingerprint,
      }),
    ).rejects.toMatchObject({
      code: 'SCREENING_SELECTION_STALE',
      statusCode: 409,
    })
    expect(mocks.readSelection).toHaveBeenLastCalledWith(
      CTX,
      expect.objectContaining({
        jobId: JOB_ID.toString(),
        selectionId: SELECTION_ID,
        session: { id: 'screening-session' },
      }),
    )
    expect(mocks.gate.create).not.toHaveBeenCalled()
    expect(mocks.batch.create).not.toHaveBeenCalled()
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
    expect(mocks.candidate.updateMany).toHaveBeenCalledWith(
      {
        _id: { $in: [FRESH_CANDIDATE_ID] },
        workspaceId: WORKSPACE_ID,
        piiAnonymizedAt: { $exists: false },
      },
      { $inc: { privacyWriteFenceVersion: 1 } },
      { session: { id: 'screening-session' }, timestamps: false },
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

  it('confirms 5,000 selected candidates with one privacy fence and 250-row inserts', async () => {
    const applications = Array.from({ length: 5_000 }, (_, index) => {
      const applicationId = new mongoose.Types.ObjectId(
        (index + 1).toString(16).padStart(24, '0'),
      )
      const candidateId = new mongoose.Types.ObjectId(
        (index + 6_001).toString(16).padStart(24, '0'),
      )
      return application({
        id: applicationId,
        candidateId,
        createdAt: new Date(1_700_000_000_000 + index),
        score: index % 101,
        resumeHash: hash(`resume-${index}`),
      })
    })
    const candidates = applications.map((entry, index) =>
      candidate({
        id: entry.candidateId,
        resumeText: `resume-${index}`,
        location: 'Bengaluru, India',
        experienceYears: 6,
      }),
    )
    mocks.application.find.mockImplementation(() => mocks.chain(applications))
    mocks.candidate.find.mockImplementation(() => mocks.chain(candidates))
    mocks.candidate.updateMany.mockResolvedValue({ matchedCount: 5_000 })
    const largeRequest = { rule: { mode: 'top_n' as const, topN: 5_000 } }
    const preview = await previewJobScreeningGate(CTX, JOB_ID.toString(), largeRequest)

    const result = await confirmJobScreeningGate(CTX, JOB_ID.toString(), {
      ...largeRequest,
      previewFingerprint: preview.previewFingerprint,
    })

    expect(result.itemCount).toBe(5_000)
    expect(mocks.candidate.updateMany).toHaveBeenCalledTimes(1)
    expect(mocks.candidate.updateMany.mock.calls[0][0]._id.$in).toHaveLength(5_000)
    expect(mocks.candidate.updateMany.mock.calls[0][2]).toMatchObject({
      timestamps: false,
    })
    expect(mocks.item.create).toHaveBeenCalledTimes(20)
    expect(mocks.item.create.mock.calls.every(([docs]) => docs.length <= 250)).toBe(true)
  })

  it('lists only workspace-and-job-scoped gate batches', async () => {
    const gateId = new mongoose.Types.ObjectId('999999999999999999999999')
    const gate = {
      _id: gateId,
      workspaceId: WORKSPACE_ID,
      jobId: JOB_ID,
      confirmedAt: new Date('2026-08-13T09:00:00.000Z'),
    }
    const batch = { _id: new mongoose.Types.ObjectId(), workspaceId: WORKSPACE_ID, jobId: JOB_ID, screeningGateId: gateId }
    mocks.gate.find.mockImplementation(() => mocks.chain([gate]))
    mocks.batch.find.mockImplementation(() => mocks.chain([batch]))

    const result = await listJobScreeningGates(CTX, JOB_ID.toString(), { limit: 10 })

    expect(result).toEqual({
      items: [{ gate, batches: [batch], hasMoreBatches: false }],
      nextCursor: null,
    })
    expect(mocks.gate.find).toHaveBeenCalledWith({ workspaceId: WORKSPACE_ID, jobId: JOB_ID })
    expect(mocks.batch.find).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      jobId: JOB_ID,
      screeningGateId: gateId,
    })
  })
})
