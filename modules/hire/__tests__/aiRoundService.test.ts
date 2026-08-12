import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  connectHireControlDB: vi.fn().mockResolvedValue(undefined),
  sendEmail: vi.fn().mockResolvedValue({ ok: true, id: 'email-1' }),
  createInviteDelivery: vi.fn().mockResolvedValue({}),
  deliverInvite: vi.fn(),
  appendEvent: vi.fn().mockResolvedValue(undefined),
  revokeGuestAccess: vi.fn().mockResolvedValue(undefined),
  deliverRuntimeRevocation: vi.fn().mockResolvedValue(undefined),
  roundCreate: vi.fn(),
  roundFind: vi.fn(),
  roundFindOne: vi.fn(),
  roundFindOneAndUpdate: vi.fn(),
  roundUpdateOne: vi.fn(),
  jobFindOne: vi.fn(),
  jobUpdateOne: vi.fn(),
  requirementFindOne: vi.fn(),
  candidateFindOne: vi.fn(),
  applicationFindOne: vi.fn(),
  workspaceExists: vi.fn(),
}))

vi.mock('../services/hireControlBoundary', () => ({
  connectHireControlDB: mocks.connectHireControlDB,
}))
vi.mock('@shared/services/emailService', () => ({
  sendEmail: mocks.sendEmail,
}))
vi.mock('@shared/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}))
vi.mock('../services/pipelineService', () => ({
  appendApplicationEvent: mocks.appendEvent,
}))
vi.mock('../services/engineRevocationService', () => ({
  revokeControlPlaneGuestAccess: mocks.revokeGuestAccess,
  deliverRuntimeRevocation: mocks.deliverRuntimeRevocation,
}))
vi.mock('../services/hireWorkspaceWriteFence', () => ({
  withActiveHireWorkspaceWriteTransaction: (
    _workspaceId: unknown,
    _memberId: unknown,
    work: (session: unknown) => Promise<unknown>,
  ) => work({ id: 'hire-tx' }),
}))
vi.mock('../services/aiInviteDeliveryService', () => ({
  createAiInviteDeliveryRecord: (...args: unknown[]) => mocks.createInviteDelivery(...args),
  deliverAiInvite: (...args: unknown[]) => mocks.deliverInvite(...args),
}))
vi.mock('../models', () => ({
  HireRound: {
    create: mocks.roundCreate,
    find: mocks.roundFind,
    findOne: mocks.roundFindOne,
    findOneAndUpdate: mocks.roundFindOneAndUpdate,
    updateOne: mocks.roundUpdateOne,
  },
  HireJob: { findOne: mocks.jobFindOne, updateOne: mocks.jobUpdateOne },
  HireJobRequirementVersion: { findOne: mocks.requirementFindOne },
  HireCandidate: { findOne: mocks.candidateFindOne },
  HireApplication: { findOne: mocks.applicationFindOne },
  HireWorkspace: { exists: mocks.workspaceExists },
}))

import {
  AI_ROUND_INTERVIEW_TYPE,
  buildJdSnapshot,
  revokeRound,
  sendAiRound,
  sha256,
  verifyRoundToken,
} from '../services/aiRoundService'
import type { MembershipContext } from '../services/workspaceService'

const IDS = {
  workspace: '111111111111111111111111',
  member: '222222222222222222222222',
  user: '333333333333333333333333',
  application: '444444444444444444444444',
  job: '555555555555555555555555',
  candidate: '666666666666666666666666',
  requirement: '777777777777777777777777',
  round: 'aaaaaaaaaaaaaaaaaaaaaaaa',
}
const RAW_TOKEN = 'ab'.repeat(32)
const INVITE_CAPABILITY = `${IDS.workspace}.${RAW_TOKEN}`

const CTX = {
  workspace: { _id: IDS.workspace, name: 'Acme' },
  membership: {
    _id: IDS.member,
    userId: IDS.user,
    email: 'hr@acme.example',
    name: 'HR One',
  },
} as unknown as MembershipContext

function happyPath() {
  mocks.applicationFindOne.mockResolvedValue({
    _id: IDS.application,
    jobId: IDS.job,
    candidateId: IDS.candidate,
  })
  mocks.jobFindOne.mockResolvedValue({
    _id: IDS.job,
    title: 'Backend Engineer',
    status: 'open',
    activeRequirementVersionId: IDS.requirement,
    activeRequirementVersion: 2,
  })
  mocks.candidateFindOne.mockResolvedValue({
    _id: IDS.candidate,
    email: 'same-as-b2c@example.com',
    name: 'Jane Candidate',
  })
  mocks.requirementFindOne.mockResolvedValue({
    _id: IDS.requirement,
    version: 2,
    state: 'active',
    contentHash: 'cd'.repeat(32),
    proseJd: 'Build production APIs for a growing software platform.',
    requirements: [
      { id: 'must-1', text: 'Production TypeScript', importance: 'must_have' },
      { id: 'nice-1', text: 'Distributed systems', importance: 'nice_to_have' },
    ],
  })
  mocks.roundFind.mockResolvedValue([])
  mocks.roundCreate.mockImplementation(async (docs: Array<Record<string, unknown>>) => docs)
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.connectHireControlDB.mockResolvedValue(undefined)
  mocks.sendEmail.mockResolvedValue({ ok: true, id: 'email-1' })
  mocks.createInviteDelivery.mockResolvedValue({})
  mocks.deliverInvite.mockImplementation(async (_ctx: unknown, roundId: string) => {
    const input = mocks.createInviteDelivery.mock.calls.at(-1)?.[0]
    const capability = `${IDS.workspace}.${input.rawToken}`
    return {
      emailSent: true,
      view: {
        inviteUrl: `https://hire.interviewprep.guru/candidate/${roundId}#invite=${capability}`,
      },
    }
  })
  mocks.appendEvent.mockResolvedValue(undefined)
  mocks.revokeGuestAccess.mockResolvedValue(undefined)
  mocks.deliverRuntimeRevocation.mockResolvedValue(undefined)
  mocks.workspaceExists.mockResolvedValue({ _id: IDS.workspace })
  mocks.jobUpdateOne.mockResolvedValue({ matchedCount: 1 })
  happyPath()
})

describe('sendAiRound', () => {
  it('atomically stores only the token hash plus encrypted-delivery input and returns a fragment URL', async () => {
    const result = await sendAiRound(CTX, {
      applicationId: IDS.application,
      experience: '3-6',
      duration: 15,
    })
    const document = mocks.roundCreate.mock.calls[0][0][0]
    const url = new URL(result.inviteUrl)
    const rawCapability = new URLSearchParams(url.hash.slice(1)).get('invite')
    const rawToken = rawCapability?.split('.')[1]

    expect(rawToken).toMatch(/^[a-f0-9]{64}$/)
    expect(document.inviteTokenHash).toBe(sha256(rawToken!))
    expect(document).not.toHaveProperty('inviteToken')
    expect(mocks.createInviteDelivery).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: IDS.workspace,
        applicationId: IDS.application,
        jobId: IDS.job,
        candidateId: IDS.candidate,
        rawToken,
        session: { id: 'hire-tx' },
      }),
    )
    expect(url.search).toBe('')
    expect(rawCapability).toMatch(new RegExp(`^${IDS.workspace}\\.[a-f0-9]{64}$`))
  })

  it('freezes the active structured requirement version into the engine config', async () => {
    await sendAiRound(CTX, {
      applicationId: IDS.application,
      experience: '7+',
      duration: 30,
    })
    const document = mocks.roundCreate.mock.calls[0][0][0]

    expect(mocks.requirementFindOne).toHaveBeenCalledWith({
      _id: IDS.requirement,
      workspaceId: IDS.workspace,
      jobId: IDS.job,
      version: 2,
      state: 'active',
    })
    expect(document).toMatchObject({
      workspaceId: IDS.workspace,
      applicationId: IDS.application,
      jobId: IDS.job,
      candidateId: IDS.candidate,
      candidateEmail: 'same-as-b2c@example.com',
      authMode: 'magic_link',
      live: true,
      requirementVersionId: IDS.requirement,
      requirementVersion: 2,
      requirementHash: 'cd'.repeat(32),
      createdByMemberId: IDS.member,
      createdByName: 'HR One',
      createdBy: IDS.user,
      config: {
        role: 'Backend Engineer',
        interviewType: AI_ROUND_INTERVIEW_TYPE,
        experience: '7+',
        duration: 30,
      },
    })
    expect(document.jdSnapshot).toContain('## Immutable interview scoring contract')
    expect(document.jdSnapshot).toContain('Requirement version: 2')
    expect(document.jdSnapshot).toContain('[MUST_HAVE][must-1] Production TypeScript')
    expect(document.jdHash).toBe(sha256(document.jdSnapshot))
    expect(document).not.toHaveProperty('guestUserId')
    expect(document).not.toHaveProperty('sessionId')
  })

  it('supports a password-only Hire member without writing a legacy B2C actor id', async () => {
    const hireOnly = {
      ...CTX,
      membership: { ...CTX.membership, userId: undefined },
    } as MembershipContext
    await sendAiRound(hireOnly, {
      applicationId: IDS.application,
      experience: '0-2',
      duration: 15,
    })
    const document = mocks.roundCreate.mock.calls[0][0][0]
    expect(document.createdByMemberId).toBe(IDS.member)
    expect(document).not.toHaveProperty('createdBy')
    expect(mocks.appendEvent.mock.calls.at(-1)?.[2]).not.toHaveProperty('actorUserId')
  })

  it('delegates to durable delivery and records honest delivery state', async () => {
    const result = await sendAiRound(CTX, {
      applicationId: IDS.application,
      experience: '3-6',
      duration: 15,
    })
    expect(mocks.deliverInvite).toHaveBeenCalledWith(CTX, expect.any(String))
    expect(result.inviteUrl).toContain('#invite=')
    expect(mocks.appendEvent).toHaveBeenCalledWith(
      IDS.workspace,
      IDS.application,
      expect.objectContaining({
        type: 'ai_round_sent',
        actorMemberId: IDS.member,
        actorName: 'HR One',
        note: expect.stringContaining('invite sent'),
      }),
    )
    expect(mocks.appendEvent.mock.calls.at(-1)?.[2].note).not.toContain(
      'same-as-b2c@example.com',
    )

    mocks.deliverInvite.mockResolvedValueOnce({
      emailSent: false,
      view: { inviteUrl: 'https://hire.interviewprep.guru/candidate/round#invite=capability' },
    })
    const failed = await sendAiRound(CTX, {
      applicationId: IDS.application,
      experience: '3-6',
      duration: 15,
    })
    expect(failed.emailSent).toBe(false)
    expect(mocks.appendEvent.mock.calls.at(-1)?.[2].note).toContain(
      'EMAIL DELIVERY FAILED',
    )
  })

  it('rejects a closed job, an unreviewed requirement set, and an in-flight round', async () => {
    mocks.jobFindOne.mockResolvedValueOnce({
      _id: IDS.job,
      title: 'Backend Engineer',
      status: 'closed',
    })
    await expect(
      sendAiRound(CTX, {
        applicationId: IDS.application,
        experience: '3-6',
        duration: 15,
      }),
    ).rejects.toMatchObject({ code: 'JOB_NOT_OPEN' })

    happyPath()
    mocks.requirementFindOne.mockResolvedValueOnce(null)
    await expect(
      sendAiRound(CTX, {
        applicationId: IDS.application,
        experience: '3-6',
        duration: 15,
      }),
    ).rejects.toMatchObject({ code: 'JOB_REQUIREMENTS_NOT_ACTIVE' })

    happyPath()
    mocks.roundFind.mockResolvedValueOnce([
      {
        _id: IDS.round,
        status: 'invited',
        inviteTokenExpiry: new Date(Date.now() + 60_000),
      },
    ])
    await expect(
      sendAiRound(CTX, {
        applicationId: IDS.application,
        experience: '3-6',
        duration: 15,
      }),
    ).rejects.toMatchObject({ code: 'ROUND_IN_FLIGHT', statusCode: 409 })
  })

  it('revokes all control-plane guest capability before superseding an expired link', async () => {
    mocks.roundFind.mockResolvedValueOnce([
      {
        _id: IDS.round,
        workspaceId: IDS.workspace,
        applicationId: IDS.application,
        status: 'invited',
        inviteTokenExpiry: new Date(Date.now() - 60_000),
      },
    ])
    await sendAiRound(CTX, {
      applicationId: IDS.application,
      experience: '3-6',
      duration: 15,
    })
    expect(mocks.roundUpdateOne).toHaveBeenCalledWith(
      { _id: IDS.round, workspaceId: IDS.workspace },
      expect.objectContaining({
        $set: expect.objectContaining({ status: 'revoked', revocationState: 'confirmed' }),
        $unset: { live: 1 },
      }),
    )
    expect(mocks.revokeGuestAccess).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: IDS.workspace,
        applicationId: IDS.application,
        roundId: IDS.round,
      }),
    )
  })

  it('maps the partial-index race to the same in-flight conflict', async () => {
    mocks.roundCreate.mockRejectedValueOnce(Object.assign(new Error('duplicate'), { code: 11000 }))
    await expect(
      sendAiRound(CTX, {
        applicationId: IDS.application,
        experience: '3-6',
        duration: 15,
      }),
    ).rejects.toMatchObject({ code: 'ROUND_IN_FLIGHT', statusCode: 409 })
  })
})

describe('buildJdSnapshot', () => {
  it('is deterministic, versioned, and bounded to the unchanged engine contract', () => {
    const input = {
      proseJd: 'J'.repeat(49_950),
      version: 7,
      contentHash: 'ef'.repeat(32),
      requirements: [
        { id: 'must-1', text: 'A required skill', importance: 'must_have' },
      ],
    }
    const first = buildJdSnapshot(input)
    expect(first).toBe(buildJdSnapshot(input))
    expect(first.length).toBeLessThanOrEqual(50_000)
    expect(first).toContain('Requirement version: 7')
  })
})

describe('verifyRoundToken', () => {
  it('hashes the credential and maps revoked, completed, expired, and live states', async () => {
    mocks.roundFindOne.mockResolvedValueOnce(null)
    await verifyRoundToken(IDS.round, INVITE_CAPABILITY)
    expect(mocks.roundFindOne).toHaveBeenCalledWith({
      _id: IDS.round,
      workspaceId: IDS.workspace,
      inviteTokenHash: sha256(RAW_TOKEN),
    })

    mocks.roundFindOne.mockResolvedValueOnce({
      workspaceId: IDS.workspace,
      revokedAt: new Date(),
      status: 'invited',
    })
    expect((await verifyRoundToken(IDS.round, INVITE_CAPABILITY))?.state).toBe('revoked')
    mocks.roundFindOne.mockResolvedValueOnce({ workspaceId: IDS.workspace, status: 'completed' })
    expect((await verifyRoundToken(IDS.round, INVITE_CAPABILITY))?.state).toBe('completed')
    mocks.roundFindOne.mockResolvedValueOnce({
      status: 'prepared',
      workspaceId: IDS.workspace,
      inviteTokenExpiry: new Date(Date.now() - 1),
    })
    expect((await verifyRoundToken(IDS.round, INVITE_CAPABILITY))?.state).toBe('expired')
    mocks.roundFindOne.mockResolvedValueOnce({
      status: 'invited',
      workspaceId: IDS.workspace,
      inviteTokenExpiry: new Date(Date.now() + 60_000),
    })
    expect((await verifyRoundToken(IDS.round, INVITE_CAPABILITY))?.state).toBe('ok')
  })

  it('makes every unused invite token dead while its workspace is tombstoned', async () => {
    mocks.roundFindOne.mockResolvedValueOnce({
      workspaceId: IDS.workspace,
      status: 'invited',
      inviteTokenExpiry: new Date(Date.now() + 60_000),
    })
    mocks.workspaceExists.mockResolvedValueOnce(null)

    await expect(verifyRoundToken(IDS.round, INVITE_CAPABILITY)).resolves.toBeNull()
  })

  it('rejects malformed ids and tokens before querying HireRound', async () => {
    expect(await verifyRoundToken('bad', INVITE_CAPABILITY)).toBeNull()
    expect(await verifyRoundToken(IDS.round, 'bad')).toBeNull()
    expect(mocks.roundFindOne).not.toHaveBeenCalled()
  })
})

describe('revokeRound', () => {
  it('kills the control session, durably requests runtime revocation, and snapshots the Hire actor', async () => {
    const revokedAt = new Date()
    const round = {
      _id: IDS.round,
      workspaceId: IDS.workspace,
      applicationId: IDS.application,
      revokedAt,
    }
    mocks.roundFindOneAndUpdate.mockResolvedValueOnce(round)
    mocks.roundFindOne.mockResolvedValueOnce({ ...round, revocationState: 'confirmed' })

    await revokeRound(CTX, IDS.round)

    expect(mocks.roundFindOneAndUpdate).toHaveBeenCalledWith(
      {
        _id: IDS.round,
        workspaceId: IDS.workspace,
        status: { $nin: ['completed', 'revoked'] },
      },
      expect.objectContaining({
        $set: expect.objectContaining({
          status: 'revoked',
          revocationState: 'pending',
          revokedByMemberId: IDS.member,
          revokedByName: 'HR One',
        }),
        $unset: { live: 1 },
      }),
      { new: true },
    )
    expect(mocks.revokeGuestAccess).toHaveBeenCalledWith(
      expect.objectContaining({ roundId: IDS.round }),
    )
    expect(mocks.deliverRuntimeRevocation).toHaveBeenCalledWith(
      IDS.workspace,
      IDS.round,
    )
    expect(mocks.appendEvent).toHaveBeenCalledWith(
      IDS.workspace,
      IDS.application,
      expect.objectContaining({
        type: 'ai_round_revoked',
        actorMemberId: IDS.member,
        actorName: 'HR One',
      }),
    )
  })
})
