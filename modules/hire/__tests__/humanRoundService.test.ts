import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  connect: vi.fn().mockResolvedValue(undefined),
  resolveAuthority: vi.fn(),
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
  privacyExists: vi.fn(),
  kitFindOne: vi.fn(),
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
  deliver: vi.fn(),
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
vi.mock('../services/pipelineService', () => ({ appendApplicationEvent: mocks.append }))
vi.mock('../services/humanKitDeliveryService', () => ({
  createHumanInterviewKitDelivery: mocks.deliveryCreate,
  deliverHumanInterviewKit: mocks.deliver,
}))
vi.mock('../models', () => ({
  HireApplication: {
    exists: mocks.applicationExists,
    findOne: mocks.applicationFindOne,
    updateOne: mocks.applicationUpdateOne,
  },
  HireCandidate: { findOne: vi.fn() },
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
  submitHumanInterviewKitScorecard,
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
  mocks.workspaceExists.mockReturnValue(sessionValue({ _id: IDS.workspace }))
  mocks.workspaceFindOne.mockReturnValue({ select: vi.fn().mockReturnThis(), lean: vi.fn().mockResolvedValue({ name: 'Acme' }) })
  mocks.jobExists.mockReturnValue(sessionValue({ _id: IDS.job }))
  mocks.jobFindOne.mockReturnValue({ select: vi.fn().mockReturnThis(), lean: vi.fn().mockResolvedValue({ title: 'Engineer' }) })
  mocks.applicationExists.mockReturnValue(sessionValue({ _id: IDS.application }))
  mocks.privacyExists.mockReturnValue(sessionValue(null))
  mocks.kitFindOne.mockReturnValue({ select: vi.fn().mockResolvedValue(kit()) })
  mocks.roundFindOne.mockResolvedValue(round())
  mocks.deliveryFindOne.mockReturnValue({ select: vi.fn().mockReturnThis(), lean: vi.fn().mockResolvedValue({ recipientName: 'Jordan' }) })
  mocks.kitUpdateOne.mockResolvedValue({ matchedCount: 1 })
  mocks.roundUpdateOne.mockResolvedValue({ matchedCount: 1 })
  mocks.deliveryUpdateMany.mockResolvedValue({ modifiedCount: 0 })
  mocks.scorecardCreate.mockResolvedValue([{}])
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
