import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  connect: vi.fn().mockResolvedValue(undefined),
  resolveAuthority: vi.fn(),
  onboardingFence: vi.fn(),
  transact: vi.fn(),
  candidateFence: vi.fn().mockResolvedValue(undefined),
  applicationFence: vi.fn().mockResolvedValue(undefined),
  workspaceExists: vi.fn(),
  workspaceFindOne: vi.fn(),
  jobExists: vi.fn(),
  jobFindOne: vi.fn(),
  jobUpdateOne: vi.fn(),
  applicationExists: vi.fn(),
  applicationFindOne: vi.fn(),
  applicationUpdateOne: vi.fn().mockResolvedValue({ matchedCount: 1 }),
  candidateFindOne: vi.fn(),
  privacyExists: vi.fn(),
  kitFindOne: vi.fn(),
  kitCreate: vi.fn(),
  kitUpdateOne: vi.fn(),
  kitUpdateMany: vi.fn(),
  roundFindOne: vi.fn(),
  roundUpdateOne: vi.fn(),
  roundFindOneAndUpdate: vi.fn(),
  roundCreate: vi.fn(),
  scorecardCreate: vi.fn(),
  scorecardUpdateOne: vi.fn(),
  deliveryFindOne: vi.fn(),
  deliveryUpdateMany: vi.fn(),
  deliveryCreate: vi.fn(),
  kickDelivery: vi.fn(),
  append: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../services/hireControlBoundary', () => ({ connectHireControlDB: mocks.connect }))
vi.mock('../services/applyPageService', () => ({ resolveWorkspaceWriteAuthority: mocks.resolveAuthority }))
vi.mock('../services/hireWorkspaceWriteFence', () => ({
  withActiveHireWorkspaceWriteTransaction: async (_workspaceId: unknown, _memberId: unknown, work: (session: unknown) => Promise<unknown>) => work({ id: 'tx' }),
}))
vi.mock('../services/hireCandidatePrivacyWriteFence', async () => {
  const actual = await vi.importActual<typeof import('../services/hireCandidatePrivacyWriteFence')>('../services/hireCandidatePrivacyWriteFence')
  return { ...actual, claimHireCandidatePiiWriteFence: mocks.candidateFence }
})
vi.mock('../services/hireApplicationDispatchFence', () => ({
  claimNonTerminalHireApplicationDispatchFence: mocks.applicationFence,
}))
vi.mock('@hire-onboarding-boundary', () => ({
  assertHireOnboardingTestDriveWriteIsolation: (...args: unknown[]) =>
    mocks.onboardingFence(...args),
}))
vi.mock('../services/pipelineService', () => ({ appendApplicationEvent: mocks.append }))
vi.mock('../services/humanKitDeliveryService', () => ({
  createHumanInterviewKitDelivery: mocks.deliveryCreate,
  kickHumanInterviewKitDelivery: mocks.kickDelivery,
}))
vi.mock('../models', () => ({
  HireApplication: {
    exists: mocks.applicationExists,
    findOne: mocks.applicationFindOne,
    updateOne: mocks.applicationUpdateOne,
  },
  HireCandidate: { findOne: mocks.candidateFindOne },
  HireHumanKitDelivery: {
    findOne: mocks.deliveryFindOne,
    updateMany: mocks.deliveryUpdateMany,
  },
  HireHumanRound: {
    findOne: mocks.roundFindOne,
    updateOne: mocks.roundUpdateOne,
    findOneAndUpdate: mocks.roundFindOneAndUpdate,
    create: mocks.roundCreate,
  },
  HireHumanScorecard: { create: mocks.scorecardCreate, updateOne: mocks.scorecardUpdateOne },
  HireInterviewKit: {
    findOne: mocks.kitFindOne,
    create: mocks.kitCreate,
    updateOne: mocks.kitUpdateOne,
    updateMany: mocks.kitUpdateMany,
  },
  HireJob: { exists: mocks.jobExists, findOne: mocks.jobFindOne, updateOne: mocks.jobUpdateOne },
  HirePrivacyRequest: { exists: mocks.privacyExists },
  HireWorkspace: { exists: mocks.workspaceExists, findOne: mocks.workspaceFindOne },
  HIRE_HUMAN_SCORECARD_DIMENSIONS: ['role_capability', 'problem_solving', 'communication', 'collaboration'],
}))

import {
  bootstrapHumanInterviewKit,
  createGuestHumanRound,
  createMemberHumanRound,
  revokeHumanInterviewKit,
  submitHumanInterviewKitScorecard,
  submitMemberHumanRoundScorecard,
} from '../services/humanRoundService'

const IDS = {
  workspace: '111111111111111111111111',
  member: '222222222222222222222222',
  application: '333333333333333333333333',
  job: '444444444444444444444444',
  candidate: '555555555555555555555555',
  round: '666666666666666666666666',
  kit: '777777777777777777777777',
}
const SECRET = 'ab'.repeat(32)
const CAPABILITY = `${IDS.workspace}.${IDS.kit}.${SECRET}`
const NOW = new Date('2026-08-13T10:00:00.000Z')
const EXPIRES = new Date('2026-08-20T10:00:00.000Z')

function sessionValue<T>(value: T) {
  return { session: vi.fn().mockResolvedValue(value) }
}

function kit(overrides: Record<string, unknown> = {}) {
  return {
    _id: IDS.kit,
    workspaceId: IDS.workspace,
    applicationId: IDS.application,
    jobId: IDS.job,
    candidateId: IDS.candidate,
    humanRoundId: IDS.round,
    secretHash: 'f'.repeat(64),
    active: true,
    status: 'active',
    expiresAt: EXPIRES,
    select: vi.fn().mockReturnThis(),
    ...overrides,
  }
}

function round(overrides: Record<string, unknown> = {}) {
  return {
    _id: IDS.round,
    workspaceId: IDS.workspace,
    applicationId: IDS.application,
    jobId: IDS.job,
    candidateId: IDS.candidate,
    mode: 'guest_kit',
    status: 'pending_scorecard',
    briefSnapshot: { candidateName: 'Ada', jobTitle: 'Engineer', experienceYears: 5 },
    ...overrides,
  }
}

const DIMENSIONS = [
  { key: 'role_capability', rating: 4, evidence: 'Strong role evidence.' },
  { key: 'problem_solving', rating: 4, evidence: 'Clear approach.' },
  { key: 'communication', rating: 5, evidence: 'Very clear.' },
  { key: 'collaboration', rating: 4, evidence: 'Included others.' },
] as const

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  mocks.resolveAuthority.mockResolvedValue(IDS.member)
  mocks.onboardingFence.mockResolvedValue(undefined)
  mocks.workspaceExists.mockReturnValue(sessionValue({ _id: IDS.workspace }))
  mocks.workspaceFindOne.mockReturnValue({ select: vi.fn().mockReturnThis(), lean: vi.fn().mockResolvedValue({ name: 'Acme' }) })
  mocks.jobExists.mockReturnValue(sessionValue({ _id: IDS.job }))
  mocks.jobFindOne.mockReturnValue({ select: vi.fn().mockReturnThis(), lean: vi.fn().mockResolvedValue({ title: 'Engineer' }) })
  mocks.jobUpdateOne.mockResolvedValue({ matchedCount: 1 })
  mocks.applicationExists.mockReturnValue(sessionValue({ _id: IDS.application }))
  mocks.candidateFindOne.mockResolvedValue({ _id: IDS.candidate, name: 'Ada' })
  mocks.privacyExists.mockReturnValue(sessionValue(null))
  mocks.kitFindOne.mockReturnValue({ select: vi.fn().mockResolvedValue(kit()) })
  mocks.roundFindOne.mockResolvedValue(round())
  mocks.deliveryFindOne.mockReturnValue({ select: vi.fn().mockReturnThis(), lean: vi.fn().mockResolvedValue({ recipientName: 'Jordan' }) })
  mocks.kitUpdateOne.mockResolvedValue({ matchedCount: 1 })
  mocks.roundUpdateOne.mockResolvedValue({ matchedCount: 1 })
  mocks.kitUpdateMany.mockResolvedValue({ modifiedCount: 1 })
  mocks.deliveryUpdateMany.mockResolvedValue({ modifiedCount: 0 })
  mocks.scorecardCreate.mockResolvedValue([{}])
  mocks.scorecardUpdateOne.mockResolvedValue({ matchedCount: 1 })
  mocks.kickDelivery.mockResolvedValue(undefined)
})

describe('public human interview kit service', () => {
  it('returns a least-disclosure brief only after lifecycle, candidate, and terminal-stage fences', async () => {
    const view = await bootstrapHumanInterviewKit({ kitId: IDS.kit, capability: CAPABILITY })

    expect(view).toEqual({
      workspaceName: 'Acme',
      jobTitle: 'Engineer',
      interviewerName: 'Jordan',
      brief: { candidateName: 'Ada', experienceYears: 5 },
    })
    expect(mocks.candidateFence).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: IDS.workspace,
      candidateId: IDS.candidate,
      session: { id: 'tx' },
    }))
    expect(mocks.applicationFence).toHaveBeenCalledWith(expect.objectContaining({
      applicationId: IDS.application,
      session: { id: 'tx' },
    }))
    expect(mocks.kitUpdateOne).toHaveBeenCalledWith(
      expect.objectContaining({ active: true, status: 'active' }),
      expect.objectContaining({ $set: { openedAt: NOW } }),
      { session: { id: 'tx' } },
    )
  })

  it('returns null when an expired/revoked capability cannot load an active kit', async () => {
    mocks.kitFindOne.mockReturnValue({ select: vi.fn().mockResolvedValue(null) })

    await expect(bootstrapHumanInterviewKit({ kitId: IDS.kit, capability: CAPABILITY })).resolves.toBeNull()
    expect(mocks.candidateFence).not.toHaveBeenCalled()
  })

  it('consumes the active kit before creating evidence and appends the audit atomically', async () => {
    const result = await submitHumanInterviewKitScorecard({
      kitId: IDS.kit,
      capability: CAPABILITY,
      dimensions: [...DIMENSIONS],
      recommendation: 'yes',
      overallComment: 'Strong practical interview evidence.',
    })

    expect(result).toEqual({ state: 'submitted' })
    const consumeOrder = mocks.kitUpdateOne.mock.invocationCallOrder[0]
    const scorecardOrder = mocks.scorecardCreate.mock.invocationCallOrder[0]
    expect(consumeOrder).toBeLessThan(scorecardOrder)
    expect(mocks.jobUpdateOne).toHaveBeenCalledWith(expect.objectContaining({ _id: IDS.job, status: 'open' }), { $inc: { intakeWriteVersion: 1, candidateReadVersion: 1 } }, { session: { id: 'tx' } })
    expect(mocks.kitUpdateOne).toHaveBeenCalledWith(
      expect.objectContaining({ active: true, status: 'active', secretHash: expect.any(String) }),
      { $set: { status: 'submitted', submittedAt: NOW, active: false } },
      { session: { id: 'tx' } },
    )
    expect(mocks.applicationUpdateOne).toHaveBeenCalledWith(
      expect.objectContaining({ _id: IDS.application, workspaceId: IDS.workspace }),
      expect.objectContaining({ $push: expect.objectContaining({ events: expect.objectContaining({ type: 'human_scorecard_submitted' }) }) }),
      { session: { id: 'tx' } },
    )
  })

  it('aborts before scorecard creation when a concurrent revoke/submit wins kit consumption', async () => {
    mocks.kitUpdateOne.mockResolvedValueOnce({ matchedCount: 0 })

    await expect(submitHumanInterviewKitScorecard({
      kitId: IDS.kit,
      capability: CAPABILITY,
      dimensions: [...DIMENSIONS],
      recommendation: 'yes',
      overallComment: 'Strong practical interview evidence.',
    })).resolves.toBeNull()

    expect(mocks.scorecardCreate).not.toHaveBeenCalled()
    expect(mocks.roundUpdateOne).not.toHaveBeenCalled()
    expect(mocks.applicationUpdateOne).not.toHaveBeenCalled()
  })
})

describe('guest human-kit creation isolation', () => {
  it('rejects a practice application before it creates a round, kit, or delivery email', async () => {
    mocks.applicationFindOne.mockResolvedValue({
      _id: IDS.application,
      workspaceId: IDS.workspace,
      jobId: IDS.job,
      candidateId: IDS.candidate,
    })
    mocks.jobFindOne.mockResolvedValue({
      _id: IDS.job,
      workspaceId: IDS.workspace,
      title: 'Engineer',
      status: 'open',
    })
    mocks.candidateFindOne.mockResolvedValue({
      _id: IDS.candidate,
      workspaceId: IDS.workspace,
      name: 'Ada',
      email: 'ada@example.com',
    })
    mocks.onboardingFence.mockRejectedValue(
      Object.assign(new Error('Practice interviews are isolated'), {
        code: 'ONBOARDING_TEST_DRIVE_ISOLATED',
        statusCode: 409,
      }),
    )

    await expect(createGuestHumanRound({
      workspace: { _id: IDS.workspace, name: 'Acme' },
      membership: { _id: IDS.member, name: 'Recruiter', email: 'hr@acme.example' },
    } as never, {
      applicationId: IDS.application,
      interviewerName: 'Jordan Interviewer',
      interviewerEmail: 'jordan@example.com',
      operationId: '123e4567-e89b-42d3-a456-426614174000',
    })).rejects.toMatchObject({ code: 'ONBOARDING_TEST_DRIVE_ISOLATED' })

    expect(mocks.jobUpdateOne).not.toHaveBeenCalled()
    expect(mocks.roundCreate).not.toHaveBeenCalled()
    expect(mocks.deliveryCreate).not.toHaveBeenCalled()
    expect(mocks.kickDelivery).not.toHaveBeenCalled()
  })

  it('revises candidate pages once for a new round but not for its replay', async () => {
    const application = {
      _id: IDS.application,
      workspaceId: IDS.workspace,
      jobId: IDS.job,
      candidateId: IDS.candidate,
    }
    const job = {
      _id: IDS.job,
      workspaceId: IDS.workspace,
      title: 'Engineer',
      status: 'open',
    }
    const candidate = {
      _id: IDS.candidate,
      workspaceId: IDS.workspace,
      name: 'Ada',
      email: 'ada@example.com',
    }
    const ctx = {
      workspace: { _id: IDS.workspace, name: 'Acme' },
      membership: { _id: IDS.member, name: 'Recruiter', email: 'hr@acme.example' },
    } as never
    const input = {
      applicationId: IDS.application,
      interviewerName: 'Jordan Interviewer',
      interviewerEmail: 'jordan@example.com',
      operationId: '123e4567-e89b-42d3-a456-426614174000',
    }
    mocks.applicationFindOne.mockResolvedValue(application)
    mocks.jobFindOne.mockResolvedValue(job)
    mocks.candidateFindOne.mockResolvedValue(candidate)
    mocks.roundFindOne.mockResolvedValueOnce(null)
    mocks.roundCreate.mockImplementationOnce(async (docs: unknown[]) => docs)
    mocks.kitCreate.mockImplementationOnce(async (docs: unknown[]) => docs)
    mocks.deliveryCreate.mockResolvedValueOnce({ _id: '888888888888888888888888' })

    await createGuestHumanRound(ctx, input)

    expect(mocks.jobUpdateOne).toHaveBeenLastCalledWith(
      expect.objectContaining({ _id: IDS.job, status: 'open' }),
      { $inc: { intakeWriteVersion: 1, candidateReadVersion: 1 } },
      { session: { id: 'tx' } },
    )

    vi.clearAllMocks()
    mocks.applicationFindOne.mockResolvedValue(application)
    mocks.jobFindOne.mockResolvedValue(job)
    mocks.candidateFindOne.mockResolvedValue(candidate)
    mocks.onboardingFence.mockResolvedValue(undefined)
    mocks.jobUpdateOne.mockResolvedValue({ matchedCount: 1 })
    mocks.privacyExists.mockReturnValue(sessionValue(null))
    mocks.roundFindOne.mockResolvedValue(round())
    mocks.kitFindOne.mockReturnValue({ select: vi.fn().mockResolvedValue(kit()) })
    mocks.deliveryFindOne.mockResolvedValue({ _id: '888888888888888888888888' })
    mocks.kickDelivery.mockResolvedValue(undefined)

    await createGuestHumanRound(ctx, input)

    expect(mocks.jobUpdateOne).toHaveBeenLastCalledWith(
      expect.objectContaining({ _id: IDS.job, status: 'open' }),
      { $inc: { intakeWriteVersion: 1 } },
      { session: { id: 'tx' } },
    )
  })
})

describe('member human-round candidate-page revisions', () => {
  const ctx = {
    workspace: { _id: IDS.workspace, name: 'Acme' },
    membership: { _id: IDS.member, name: 'Recruiter', email: 'hr@acme.example' },
  } as never

  beforeEach(() => {
    mocks.applicationFindOne.mockResolvedValue({
      _id: IDS.application,
      workspaceId: IDS.workspace,
      jobId: IDS.job,
      candidateId: IDS.candidate,
    })
    mocks.jobFindOne.mockResolvedValue({
      _id: IDS.job,
      workspaceId: IDS.workspace,
      title: 'Engineer',
      status: 'open',
    })
    mocks.candidateFindOne.mockResolvedValue({
      _id: IDS.candidate,
      workspaceId: IDS.workspace,
      name: 'Ada',
    })
  })

  it('revises the page when a member opens a human round', async () => {
    mocks.roundFindOne.mockResolvedValueOnce(null)
    mocks.roundCreate.mockImplementationOnce(async (docs: unknown[]) => docs)

    await createMemberHumanRound(ctx, {
      applicationId: IDS.application,
      operationId: '123e4567-e89b-42d3-a456-426614174001',
    })

    expect(mocks.jobUpdateOne).toHaveBeenCalledWith(
      expect.objectContaining({ _id: IDS.job, status: 'open' }),
      { $inc: { intakeWriteVersion: 1, candidateReadVersion: 1 } },
      { session: { id: 'tx' } },
    )
  })

  it('revises the page when a member submits human evidence', async () => {
    mocks.roundFindOne.mockResolvedValueOnce(round({ mode: 'member_room' }))
    mocks.roundFindOneAndUpdate.mockResolvedValueOnce(
      round({ mode: 'member_room', status: 'completed' }),
    )

    await submitMemberHumanRoundScorecard(ctx, {
      humanRoundId: IDS.round,
      dimensions: [...DIMENSIONS],
      recommendation: 'yes',
      overallComment: 'Strong practical interview evidence.',
    })

    expect(mocks.jobUpdateOne).toHaveBeenCalledWith(
      expect.objectContaining({ _id: IDS.job, status: 'open' }),
      { $inc: { intakeWriteVersion: 1, candidateReadVersion: 1 } },
      { session: { id: 'tx' } },
    )
  })
})

it('revisions candidate pages when a human interview kit is revoked', async () => {
  const current = round()
  mocks.roundFindOne.mockResolvedValueOnce(current)
  mocks.roundFindOneAndUpdate.mockResolvedValueOnce({ ...current, status: 'revoked' })
  await revokeHumanInterviewKit({ workspace: { _id: IDS.workspace }, membership: { _id: IDS.member, name: 'HR' } } as never, IDS.round)
  expect(mocks.jobUpdateOne).toHaveBeenCalledWith(
    { _id: IDS.job, workspaceId: IDS.workspace }, { $inc: { intakeWriteVersion: 1, candidateReadVersion: 1 } }, { session: { id: 'tx' } },
  )
})
