import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'

const mocks = vi.hoisted(() => ({
  connect: vi.fn().mockResolvedValue(undefined),
  send: vi.fn(),
  sendEmail: vi.fn(),
  transact: vi.fn(),
  candidateFence: vi.fn().mockResolvedValue(undefined),
  applicationFence: vi.fn().mockResolvedValue(undefined),
  workspaceExists: vi.fn(),
  workspaceFindOne: vi.fn(),
  memberFindOne: vi.fn(),
  jobExists: vi.fn(),
  jobFindOne: vi.fn(),
  privacyExists: vi.fn(),
  kitExists: vi.fn(),
  kitFind: vi.fn(),
  kitFindOne: vi.fn(),
  roundExists: vi.fn(),
  deliveryCreate: vi.fn(),
  deliveryFindOneAndUpdate: vi.fn(),
  deliveryFindOne: vi.fn(),
  deliveryFind: vi.fn(),
  deliveryUpdateOne: vi.fn(),
  deliveryUpdateMany: vi.fn(),
  appFindOne: vi.fn(),
  appUpdateOne: vi.fn(),
  loggerWarn: vi.fn(),
}))

vi.mock('../services/hireControlBoundary', () => ({ connectHireControlDB: mocks.connect }))
vi.mock('@shared/services/inngest', () => ({ inngest: { send: mocks.send } }))
vi.mock('@shared/services/emailService', () => ({ sendEmail: mocks.sendEmail }))
vi.mock('@shared/logger', () => ({ logger: { warn: mocks.loggerWarn, info: vi.fn(), error: vi.fn() } }))
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
vi.mock('../models', () => ({
  HireApplication: { findOne: mocks.appFindOne, updateOne: mocks.appUpdateOne },
  HireHumanKitDelivery: {
    create: mocks.deliveryCreate,
    findOneAndUpdate: mocks.deliveryFindOneAndUpdate,
    findOne: mocks.deliveryFindOne,
    find: mocks.deliveryFind,
    updateOne: mocks.deliveryUpdateOne,
    updateMany: mocks.deliveryUpdateMany,
  },
  HireHumanRound: { exists: mocks.roundExists },
  HireInterviewKit: {
    exists: mocks.kitExists,
    find: mocks.kitFind,
    findOne: mocks.kitFindOne,
  },
  HireJob: { exists: mocks.jobExists, findOne: mocks.jobFindOne },
  HirePrivacyRequest: { exists: mocks.privacyExists },
  HireWorkspace: { findOne: mocks.workspaceFindOne },
  HireWorkspaceMember: { findOne: mocks.memberFindOne },
}))

import {
  __humanKitDelivery,
  createHumanInterviewKitDelivery,
  dispatchHumanInterviewKitDelivery,
  deliverHumanInterviewKit,
  listDueHumanInterviewKitDeliveryIds,
  processHumanInterviewKitDelivery,
} from '../services/humanKitDeliveryService'
import type { MembershipContext } from '../services/workspaceService'

const IDS = {
  workspace: '111111111111111111111111',
  member: '222222222222222222222222',
  app: '333333333333333333333333',
  job: '444444444444444444444444',
  candidate: '555555555555555555555555',
  round: '666666666666666666666666',
  kit: '777777777777777777777777',
  delivery: '888888888888888888888888',
}
const SECRET = 'ab'.repeat(32)
const HASH = createHash('sha256').update(SECRET).digest('hex')
const NOW = new Date('2026-08-13T12:00:00.000Z')
const EXPIRES = new Date('2026-08-20T12:00:00.000Z')
const KEY = Buffer.alloc(32, 7).toString('base64')

const CTX = {
  workspace: { _id: IDS.workspace, name: 'Acme' },
  membership: { _id: IDS.member, name: 'HR', email: 'hr@acme.example' },
} as unknown as MembershipContext

function sessionValue<T>(value: T) {
  return { session: vi.fn().mockResolvedValue(value) }
}

function chainValue<T>(value: T) {
  return { select: vi.fn().mockReturnThis(), lean: vi.fn().mockResolvedValue(value) }
}

function kit(overrides: Record<string, unknown> = {}) {
  return {
    _id: IDS.kit,
    workspaceId: IDS.workspace,
    applicationId: IDS.app,
    jobId: IDS.job,
    candidateId: IDS.candidate,
    humanRoundId: IDS.round,
    secretHash: HASH,
    active: true,
    status: 'active',
    expiresAt: EXPIRES,
    select: vi.fn().mockReturnThis(),
    ...overrides,
  }
}

function delivery(overrides: Record<string, unknown> = {}) {
  return {
    _id: IDS.delivery,
    workspaceId: IDS.workspace,
    applicationId: IDS.app,
    jobId: IDS.job,
    candidateId: IDS.candidate,
    humanRoundId: IDS.round,
    kitId: IDS.kit,
    purpose: 'initial',
    recipientName: 'Jordan',
    recipientEmail: 'jordan@example.com',
    expiresAt: EXPIRES,
    dueAt: NOW,
    envelopeVersion: 1,
    keyId: 'key-a',
    ciphertext: '',
    iv: '',
    authTag: '',
    status: 'pending',
    attempts: 0,
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('HIRE_INVITE_DELIVERY_KEY_ID', 'key-a')
  vi.stubEnv('HIRE_INVITE_DELIVERY_KEY', KEY)
  vi.stubEnv('HIRE_INVITE_DELIVERY_KEY_ID_PREVIOUS', '')
  vi.stubEnv('HIRE_INVITE_DELIVERY_KEY_PREVIOUS', '')
  vi.stubEnv('HIRE_PUBLIC_URL', 'https://hire.example')
  mocks.sendEmail.mockResolvedValue({ ok: true, id: 'provider-1' })
  mocks.privacyExists.mockReturnValue(sessionValue(null))
  mocks.jobExists.mockReturnValue(sessionValue({ _id: IDS.job }))
  mocks.kitExists.mockReturnValue(sessionValue({ _id: IDS.kit }))
  mocks.roundExists.mockReturnValue(sessionValue({ _id: IDS.round }))
  mocks.kitFindOne.mockReturnValue({ select: vi.fn().mockResolvedValue(kit()) })
  mocks.workspaceFindOne.mockImplementation(() => chainValue({ name: 'Acme', _id: IDS.workspace }))
  mocks.memberFindOne.mockReturnValue({ sort: vi.fn().mockResolvedValue({ _id: IDS.member, workspaceId: IDS.workspace, name: 'HR', email: 'hr@acme.example' }) })
  mocks.jobFindOne.mockReturnValue(chainValue({ title: 'Engineer' }))
  mocks.appFindOne.mockReturnValue({ select: vi.fn().mockResolvedValue({ _id: IDS.app }) })
  mocks.appUpdateOne.mockResolvedValue({ matchedCount: 1 })
  mocks.deliveryUpdateOne.mockResolvedValue({ matchedCount: 1 })
  mocks.deliveryUpdateMany.mockResolvedValue({ modifiedCount: 0 })
})

describe('human interview-kit delivery', () => {
  it('seals the raw capability with human-only AAD and never persists plaintext', async () => {
    mocks.deliveryCreate.mockImplementation(async (docs: Array<Record<string, unknown>>) => [{ ...delivery(), ...docs[0] }])
    const created = await createHumanInterviewKitDelivery({
      workspaceId: IDS.workspace,
      applicationId: IDS.app,
      jobId: IDS.job,
      candidateId: IDS.candidate,
      humanRoundId: IDS.round,
      kitId: IDS.kit,
      purpose: 'initial',
      recipientName: 'Jordan',
      recipientEmail: 'jordan@example.com',
      workspaceName: 'Acme',
      jobTitle: 'Engineer',
      dueAt: NOW,
      expiresAt: EXPIRES,
      rawSecret: SECRET,
      session: { id: 'tx' } as never,
    })
    const persisted = mocks.deliveryCreate.mock.calls[0][0][0]
    expect(JSON.stringify(persisted)).not.toContain(SECRET)
    expect(created.ciphertext).not.toBe('')
    expect(__humanKitDelivery.open(created)).toBe(SECRET)
  })

  it('dispatches only IDs to Inngest', async () => {
    await dispatchHumanInterviewKitDelivery({ workspaceId: IDS.workspace, deliveryId: IDS.delivery })
    expect(mocks.send).toHaveBeenCalledWith({
      name: 'hire/human-kit.requested',
      data: { workspaceId: IDS.workspace, deliveryId: IDS.delivery },
    })
  })

  it('claims exactly the requested delivery id before egress and records retry timing on provider failure', async () => {
    const encrypted = __humanKitDelivery.seal(SECRET, {
      workspaceId: IDS.workspace,
      humanRoundId: IDS.round,
      kitId: IDS.kit,
      purpose: 'initial',
      expiresAt: EXPIRES,
    })
    const claimed = delivery({ ...encrypted, status: 'sending', claimToken: 'claim', attempts: 2 })
    mocks.deliveryFindOneAndUpdate
      .mockResolvedValueOnce(claimed)
      .mockResolvedValueOnce({ ...claimed, status: 'failed' })
    mocks.sendEmail.mockResolvedValueOnce({ ok: false })

    const result = await deliverHumanInterviewKit(CTX, IDS.kit, {
      deliveryId: IDS.delivery,
      purpose: 'initial',
      now: NOW,
    })

    expect(result.emailSent).toBe(false)
    expect(mocks.deliveryFindOneAndUpdate).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ _id: IDS.delivery, purpose: 'initial' }),
      expect.anything(),
      expect.objectContaining({ session: { id: 'tx' } }),
    )
    expect(mocks.sendEmail).toHaveBeenCalledWith(expect.objectContaining({
      privacySafeLog: true,
    }))
    const settle = mocks.deliveryFindOneAndUpdate.mock.calls[1][1]
    expect(settle.$set.dueAt).toEqual(__humanKitDelivery.retryDueAt(NOW, 2))
  })

  it('records one non-sensitive HR receipt when the initial delivery exhausts retries', async () => {
    const encrypted = __humanKitDelivery.seal(SECRET, {
      workspaceId: IDS.workspace,
      humanRoundId: IDS.round,
      kitId: IDS.kit,
      purpose: 'initial',
      expiresAt: EXPIRES,
    })
    const claimed = delivery({ ...encrypted, status: 'sending', claimToken: 'claim', attempts: 5 })
    mocks.deliveryFindOneAndUpdate
      .mockResolvedValueOnce(claimed)
      .mockResolvedValueOnce({ ...claimed, status: 'failed' })
    mocks.sendEmail.mockResolvedValueOnce({ ok: false })

    await expect(deliverHumanInterviewKit(CTX, IDS.kit, {
      deliveryId: IDS.delivery,
      purpose: 'initial',
      now: NOW,
    })).resolves.toMatchObject({ emailSent: false })

    expect(mocks.appUpdateOne).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: IDS.app,
        workspaceId: IDS.workspace,
        jobId: IDS.job,
        candidateId: IDS.candidate,
      }),
      expect.objectContaining({
        $push: expect.objectContaining({
          events: expect.objectContaining({
            type: 'human_kit_delivery_failed',
            actorName: 'System',
            operationId: `human-kit-delivery-failed:${IDS.delivery}`,
          }),
        }),
      }),
    )
    expect(JSON.stringify(mocks.appUpdateOne.mock.calls)).not.toContain('jordan@example.com')
    expect(JSON.stringify(mocks.appUpdateOne.mock.calls)).not.toContain(SECRET)
  })

  it('terminalizes an expired final-attempt lease without another provider egress', async () => {
    const encrypted = __humanKitDelivery.seal(SECRET, {
      workspaceId: IDS.workspace,
      humanRoundId: IDS.round,
      kitId: IDS.kit,
      purpose: 'initial',
      expiresAt: EXPIRES,
    })
    const exhausted = delivery({
      ...encrypted,
      status: 'sending',
      claimToken: 'expired-final-claim',
      leaseExpiresAt: new Date(NOW.getTime() - 1),
      attempts: __humanKitDelivery.MAX_ATTEMPTS,
    })
    mocks.deliveryFindOne.mockResolvedValue(exhausted)

    await expect(processHumanInterviewKitDelivery({
      workspaceId: IDS.workspace,
      deliveryId: IDS.delivery,
      now: NOW,
    })).resolves.toBe('skipped')

    expect(mocks.sendEmail).not.toHaveBeenCalled()
    expect(mocks.deliveryUpdateOne).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: IDS.delivery,
        workspaceId: IDS.workspace,
        status: 'sending',
        leaseExpiresAt: { $lte: NOW },
        attempts: { $gte: __humanKitDelivery.MAX_ATTEMPTS },
      }),
      expect.objectContaining({
        $set: expect.objectContaining({ status: 'failed' }),
        $unset: { claimToken: 1, leaseExpiresAt: 1 },
      }),
    )
    expect(mocks.appUpdateOne).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: IDS.workspace }),
      expect.objectContaining({
        $push: expect.objectContaining({
          events: expect.objectContaining({ type: 'human_kit_delivery_failed' }),
        }),
      }),
    )
  })

  it('returns an exhausted expired lease to recovery only for terminalization, not a sixth send', async () => {
    mocks.kitFind.mockReturnValue({
      select: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue([]) }),
    })
    mocks.deliveryFind.mockReturnValue({
      sort: vi.fn().mockReturnValue({
        limit: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnValue({
            lean: vi.fn().mockResolvedValue([{ _id: IDS.delivery }]),
          }),
        }),
      }),
    })

    await expect(listDueHumanInterviewKitDeliveryIds({ workspaceId: IDS.workspace, now: NOW }))
      .resolves.toEqual([IDS.delivery])

    expect(mocks.deliveryFind).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: expect.anything(),
      $or: expect.arrayContaining([
        { status: 'sending', leaseExpiresAt: { $lte: NOW } },
      ]),
    }))
  })

  it('reseals a reminder with reminder AAD so it can be recovered and sent', async () => {
    const initialEnvelope = __humanKitDelivery.seal(SECRET, {
      workspaceId: IDS.workspace,
      humanRoundId: IDS.round,
      kitId: IDS.kit,
      purpose: 'initial',
      expiresAt: EXPIRES,
    })
    const initial = delivery({
      ...initialEnvelope,
      status: 'sent',
      sentAt: new Date(NOW.getTime() - 24 * 60 * 60_000 - 1),
    })
    mocks.kitFind.mockReturnValue({
      select: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue([kit()]) }),
    })
    mocks.workspaceFindOne.mockResolvedValue({ name: 'Acme', _id: IDS.workspace })
    mocks.deliveryFindOne.mockResolvedValue(initial)
    mocks.deliveryFind.mockReturnValue({
      sort: vi.fn().mockReturnValue({
        limit: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue([]) }),
        }),
      }),
    })

    await expect(listDueHumanInterviewKitDeliveryIds({ workspaceId: IDS.workspace, now: NOW })).resolves.toEqual([])
    expect(mocks.loggerWarn).not.toHaveBeenCalled()

    const reminderInsert = mocks.deliveryUpdateOne.mock.calls.find(([, update]) =>
      Boolean((update as { $setOnInsert?: { purpose?: string } }).$setOnInsert?.purpose === 'reminder'),
    )?.[1] as { $setOnInsert: Record<string, unknown> } | undefined
    expect(reminderInsert).toBeDefined()
    const reminder = delivery({
      ...reminderInsert?.$setOnInsert,
      purpose: 'reminder',
      status: 'sending',
      claimToken: 'reminder-claim',
      attempts: 1,
    })
    expect(__humanKitDelivery.open(reminder)).toBe(SECRET)
    expect(reminder.ciphertext).not.toBe(initial.ciphertext)

    mocks.workspaceFindOne.mockImplementation(() => chainValue({ name: 'Acme', _id: IDS.workspace }))
    mocks.deliveryFindOneAndUpdate
      .mockResolvedValueOnce(reminder)
      .mockResolvedValueOnce({ ...reminder, status: 'sent', sentAt: NOW })
    await expect(deliverHumanInterviewKit(CTX, IDS.kit, {
      deliveryId: IDS.delivery,
      purpose: 'reminder',
      now: NOW,
    })).resolves.toMatchObject({ emailSent: true })
    expect(mocks.sendEmail).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: `hire-human-kit:${IDS.kit}:reminder`,
      privacySafeLog: true,
    }))
  })

  it('skips worker delivery before provider egress when the kit is no longer active', async () => {
    mocks.deliveryFindOne.mockResolvedValue(delivery())
    mocks.kitFindOne.mockReturnValue({ select: vi.fn().mockResolvedValue(kit({ active: false, status: 'revoked' })) })

    await expect(processHumanInterviewKitDelivery({
      workspaceId: IDS.workspace,
      deliveryId: IDS.delivery,
      now: NOW,
    })).resolves.toBe('skipped')
    expect(mocks.sendEmail).not.toHaveBeenCalled()
  })
})
