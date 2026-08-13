import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'crypto'

const mocks = vi.hoisted(() => ({
  connect: vi.fn().mockResolvedValue(undefined),
  create: vi.fn(),
  find: vi.fn(),
  findOne: vi.fn(),
  findOneAndUpdate: vi.fn(),
  updateOne: vi.fn(),
  roundFindOne: vi.fn(),
  roundExists: vi.fn(),
  applicationUpdateOne: vi.fn(),
  privacyExists: vi.fn(),
  candidateFence: vi.fn(),
  sendEmail: vi.fn(),
}))

vi.mock('../services/hireControlBoundary', () => ({
  connectHireControlDB: mocks.connect,
}))
vi.mock('@shared/services/emailService', () => ({ sendEmail: mocks.sendEmail }))
vi.mock('@shared/logger', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}))
vi.mock('../services/hireWorkspaceWriteFence', () => ({
  withActiveHireWorkspaceWriteTransaction: (
    _workspaceId: unknown,
    _memberId: unknown,
    work: (session: unknown) => Promise<unknown>,
  ) => work({ id: 'egress-auth-tx' }),
}))
vi.mock('../services/hireCandidatePrivacyWriteFence', async () => {
  const actual = await vi.importActual<typeof import('../services/hireCandidatePrivacyWriteFence')>(
    '../services/hireCandidatePrivacyWriteFence',
  )
  return {
    ...actual,
    claimHireCandidatePiiWriteFence: mocks.candidateFence,
  }
})
vi.mock('../models', () => ({
  HireAiInviteDelivery: {
    create: mocks.create,
    find: mocks.find,
    findOne: mocks.findOne,
    findOneAndUpdate: mocks.findOneAndUpdate,
    updateOne: mocks.updateOne,
  },
  HireRound: { findOne: mocks.roundFindOne, exists: mocks.roundExists },
  HireApplication: { updateOne: mocks.applicationUpdateOne },
  HirePrivacyRequest: { exists: mocks.privacyExists },
  TERMINAL_STAGES: ['hired', 'rejected', 'withdrawn'],
}))

import {
  createAiInviteDeliveryRecord,
  deliverAiInvite,
  getAiInviteDeliveryViews,
} from '../services/aiInviteDeliveryService'
import { HireCandidatePiiTombstoneError } from '../services/hireCandidatePrivacyWriteFence'
import type { MembershipContext } from '../services/workspaceService'

const IDS = {
  workspaceA: '111111111111111111111111',
  workspaceB: '222222222222222222222222',
  member: '333333333333333333333333',
  application: '444444444444444444444444',
  job: '555555555555555555555555',
  candidate: '666666666666666666666666',
  round: '777777777777777777777777',
  delivery: '888888888888888888888888',
}
const RAW_TOKEN = 'ab'.repeat(32)
const NOW = new Date('2026-08-10T12:00:00.000Z')
const EXPIRES = new Date('2026-08-17T12:00:00.000Z')
const KEY_A = Buffer.alloc(32, 1).toString('base64')
const KEY_B = Buffer.alloc(32, 2).toString('base64')

const CTX_A = {
  workspace: { _id: IDS.workspaceA, name: 'Acme' },
  membership: {
    _id: IDS.member,
    email: 'hr@acme.example',
    name: 'HR One',
  },
} as unknown as MembershipContext

function round(workspaceId = IDS.workspaceA) {
  return {
    _id: IDS.round,
    workspaceId,
    applicationId: IDS.application,
    jobId: IDS.job,
    candidateId: IDS.candidate,
    live: true,
    inviteTokenHash: createHash('sha256').update(RAW_TOKEN).digest('hex'),
    inviteTokenExpiry: EXPIRES,
    status: 'invited',
  }
}

function applyUpdate(target: Record<string, unknown>, update: Record<string, any>) {
  Object.assign(target, update.$set ?? {})
  for (const [key, value] of Object.entries(update.$inc ?? {})) {
    target[key] = Number(target[key] ?? 0) + Number(value)
  }
  for (const key of Object.keys(update.$unset ?? {})) delete target[key]
}

function sessionQuery<T>(value: T) {
  return { session: vi.fn().mockResolvedValue(value) }
}

async function createRecord() {
  return createAiInviteDeliveryRecord({
    workspaceId: IDS.workspaceA,
    applicationId: IDS.application,
    jobId: IDS.job,
    candidateId: IDS.candidate,
    roundId: IDS.round,
    recipientEmail: 'candidate@example.com',
    recipientName: 'Candidate One',
    jobTitle: 'Platform Engineer',
    workspaceName: 'Acme',
    verifyByCode: false,
    expiresAt: EXPIRES,
    rawToken: RAW_TOKEN,
    session: { id: 'transaction' } as never,
  })
}

describe('durable AI invite delivery', () => {
  let stored: Record<string, any>

  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv('HIRE_INVITE_DELIVERY_KEY_ID', 'key-a')
    vi.stubEnv('HIRE_INVITE_DELIVERY_KEY', KEY_A)
    vi.stubEnv('HIRE_INVITE_DELIVERY_KEY_ID_PREVIOUS', '')
    vi.stubEnv('HIRE_INVITE_DELIVERY_KEY_PREVIOUS', '')
    vi.stubEnv('HIRE_PUBLIC_URL', 'https://hire.interviewprep.guru')
    stored = {}
    mocks.create.mockImplementation(async (docs: Array<Record<string, unknown>>) => {
      stored = { _id: IDS.delivery, ...docs[0] }
      return [stored]
    })
    mocks.find.mockImplementation(async () => (stored._id ? [stored] : []))
    mocks.findOne.mockImplementation(async () => (stored._id ? stored : null))
    mocks.findOneAndUpdate.mockImplementation(async (
      filter: Record<string, any>,
      update: Record<string, any>,
    ) => {
      if (!stored._id || String(filter.workspaceId) !== String(stored.workspaceId)) return null
      if (filter.status === 'sending') {
        if (stored.status !== 'sending' || stored.claimToken !== filter.claimToken) return null
      } else if (stored.status === 'sent') {
        return null
      }
      applyUpdate(stored, update)
      return stored
    })
    mocks.updateOne.mockResolvedValue({ matchedCount: 1, modifiedCount: 1 })
    mocks.roundFindOne.mockResolvedValue(round())
    mocks.roundExists.mockReturnValue(sessionQuery({ _id: IDS.round }))
    mocks.applicationUpdateOne.mockResolvedValue({ matchedCount: 1 })
    mocks.privacyExists.mockReturnValue(sessionQuery(null))
    mocks.candidateFence.mockResolvedValue(undefined)
    mocks.sendEmail.mockResolvedValue({ ok: true, id: 'provider-1' })
  })

  it('persists authenticated ciphertext, never plaintext, and recovers only into a URL fragment', async () => {
    await createRecord()
    const persisted = mocks.create.mock.calls[0][0][0]
    expect(JSON.stringify(persisted)).not.toContain(RAW_TOKEN)
    expect(persisted).toMatchObject({
      keyId: 'key-a',
      envelopeVersion: 1,
      status: 'pending',
    })

    const views = await getAiInviteDeliveryViews(CTX_A, [round()] as never, NOW)
    const view = views.get(IDS.round)!
    const parsed = new URL(view.inviteUrl!)
    expect(parsed.search).toBe('')
    expect(parsed.hash).toContain(`${IDS.workspaceA}.${RAW_TOKEN}`)
    expect(mocks.find).toHaveBeenCalledWith({
      workspaceId: IDS.workspaceA,
      roundId: { $in: [IDS.round] },
    })
  })

  it('decrypts an unexpired envelope with the bounded previous key during rotation', async () => {
    await createRecord()
    vi.stubEnv('HIRE_INVITE_DELIVERY_KEY_ID', 'key-b')
    vi.stubEnv('HIRE_INVITE_DELIVERY_KEY', KEY_B)
    vi.stubEnv('HIRE_INVITE_DELIVERY_KEY_ID_PREVIOUS', 'key-a')
    vi.stubEnv('HIRE_INVITE_DELIVERY_KEY_PREVIOUS', KEY_A)

    const view = (await getAiInviteDeliveryViews(CTX_A, [round()] as never, NOW)).get(IDS.round)
    expect(view?.inviteUrl).toContain(RAW_TOKEN)
  })

  it('uses one stable provider idempotency key and makes retry after sent a no-op', async () => {
    await createRecord()
    // Match the test round to the encrypted raw token.
    const liveRound = {
      ...round(),
      inviteTokenHash: createHash('sha256').update(RAW_TOKEN).digest('hex'),
    }
    mocks.roundFindOne.mockResolvedValue(liveRound)

    const first = await deliverAiInvite(CTX_A, IDS.round, { now: NOW })
    const second = await deliverAiInvite(CTX_A, IDS.round, {
      now: new Date(NOW.getTime() + 1_000),
      manualRetry: true,
    })

    expect(first.emailSent).toBe(true)
    expect(second.emailSent).toBe(true)
    expect(mocks.sendEmail).toHaveBeenCalledOnce()
    expect(mocks.sendEmail).toHaveBeenCalledWith(expect.objectContaining({
      to: 'candidate@example.com',
      html: expect.stringContaining(`#invite=${IDS.workspaceA}.${RAW_TOKEN}`),
      idempotencyKey: `hire-ai-round:${IDS.round}`,
    }))
  })

  it('authorizes the exact delivery lease under the candidate privacy fence before provider egress', async () => {
    await createRecord()
    const order: string[] = []
    mocks.candidateFence.mockImplementation(async () => {
      order.push('candidate-fence')
    })
    mocks.applicationUpdateOne.mockImplementation(async (
      filter: Record<string, unknown>,
      update: Record<string, unknown>,
      options: Record<string, unknown>,
    ) => {
      expect(filter).toEqual({
        _id: IDS.application,
        workspaceId: IDS.workspaceA,
        jobId: IDS.job,
        candidateId: IDS.candidate,
        stage: { $nin: ['hired', 'rejected', 'withdrawn'] },
      })
      expect(update).toEqual({ $set: { updatedAt: NOW } })
      expect(options).toEqual({ session: { id: 'egress-auth-tx' }, timestamps: false })
      order.push('application-stage-fence')
      return { matchedCount: 1 }
    })
    mocks.findOneAndUpdate.mockImplementation(async (
      filter: Record<string, any>,
      update: Record<string, any>,
      options: Record<string, unknown>,
    ) => {
      if (!stored._id || String(filter.workspaceId) !== String(stored.workspaceId)) return null
      if (filter.status === 'sending') {
        expect(options).toMatchObject({ new: true })
        if (stored.status !== 'sending' || stored.claimToken !== filter.claimToken) return null
      } else if (stored.status === 'sent') {
        return null
      } else {
        expect(options).toMatchObject({ new: true, session: { id: 'egress-auth-tx' } })
        expect(filter).toMatchObject({
          workspaceId: IDS.workspaceA,
          roundId: IDS.round,
          applicationId: IDS.application,
          jobId: IDS.job,
          candidateId: IDS.candidate,
        })
        expect(update.$set).toMatchObject({ status: 'sending' })
      }
      applyUpdate(stored, update)
      order.push(filter.status === 'sending' ? 'recorded' : 'authorized')
      return stored
    })
    mocks.sendEmail.mockImplementation(async () => {
      order.push('provider')
      return { ok: true, id: 'provider-1' }
    })

    await expect(deliverAiInvite(CTX_A, IDS.round, { now: NOW })).resolves.toMatchObject({
      emailSent: true,
    })

    expect(mocks.privacyExists).toHaveBeenCalledWith({
      workspaceId: IDS.workspaceA,
      candidateId: IDS.candidate,
      live: true,
    })
    expect(mocks.candidateFence).toHaveBeenCalledWith({
      workspaceId: IDS.workspaceA,
      candidateId: IDS.candidate,
      session: { id: 'egress-auth-tx' },
    })
    expect(mocks.roundExists).toHaveBeenCalledWith(expect.objectContaining({
      _id: IDS.round,
      workspaceId: IDS.workspaceA,
      applicationId: IDS.application,
      jobId: IDS.job,
      candidateId: IDS.candidate,
      live: true,
    }))
    expect(order).toEqual([
      'candidate-fence',
      'application-stage-fence',
      'authorized',
      'provider',
      'recorded',
    ])
  })

  it('does not authorize provider egress when a terminal stage move wins the race', async () => {
    await createRecord()
    // This is the retry-visible result of the same application document write
    // performed by a terminal `moveStage` transaction.
    mocks.applicationUpdateOne.mockResolvedValueOnce({ matchedCount: 0 })

    await expect(deliverAiInvite(CTX_A, IDS.round, { now: NOW }))
      .rejects.toMatchObject({ code: 'APPLICATION_NOT_ELIGIBLE', statusCode: 409 })

    expect(mocks.roundExists).not.toHaveBeenCalled()
    expect(mocks.findOneAndUpdate).not.toHaveBeenCalled()
    expect(mocks.sendEmail).not.toHaveBeenCalled()
  })

  it('fails closed without a provider call when verified deletion wins the candidate fence', async () => {
    await createRecord()
    mocks.candidateFence.mockRejectedValueOnce(new HireCandidatePiiTombstoneError())

    await expect(deliverAiInvite(CTX_A, IDS.round, { now: NOW }))
      .rejects.toMatchObject({ code: 'HIRE_CANDIDATE_PII_TOMBSTONED', statusCode: 410 })

    expect(mocks.sendEmail).not.toHaveBeenCalled()
    expect(mocks.findOneAndUpdate).not.toHaveBeenCalled()
  })

  it('fails closed without a provider call while a live privacy request exists', async () => {
    await createRecord()
    mocks.privacyExists.mockReturnValueOnce(sessionQuery({ _id: 'privacy-request' }))

    await expect(deliverAiInvite(CTX_A, IDS.round, { now: NOW }))
      .rejects.toMatchObject({ code: 'CANDIDATE_PRIVACY_PENDING', statusCode: 409 })

    expect(mocks.candidateFence).not.toHaveBeenCalled()
    expect(mocks.sendEmail).not.toHaveBeenCalled()
    expect(mocks.findOneAndUpdate).not.toHaveBeenCalled()
  })

  it('fails closed on expiry, tampering, and cross-tenant lookup', async () => {
    await createRecord()
    const liveRound = {
      ...round(),
      inviteTokenHash: createHash('sha256').update(RAW_TOKEN).digest('hex'),
    }
    mocks.roundFindOne.mockResolvedValueOnce({
      ...liveRound,
      inviteTokenExpiry: new Date(NOW.getTime() - 1),
    })
    await expect(deliverAiInvite(CTX_A, IDS.round, { now: NOW }))
      .rejects.toMatchObject({ code: 'ROUND_NOT_ACTIVE' })

    stored.ciphertext = Buffer.from('tampered').toString('base64')
    mocks.roundFindOne.mockResolvedValueOnce(liveRound)
    await expect(deliverAiInvite(CTX_A, IDS.round, { now: NOW }))
      .rejects.toMatchObject({ code: 'INVITE_DELIVERY_RECOVERY_FAILED' })
    expect(mocks.sendEmail).not.toHaveBeenCalled()

    const ctxB = {
      ...CTX_A,
      workspace: { _id: IDS.workspaceB, name: 'Other' },
    } as unknown as MembershipContext
    mocks.roundFindOne.mockResolvedValueOnce(null)
    await expect(deliverAiInvite(ctxB, IDS.round, { now: NOW }))
      .rejects.toMatchObject({ statusCode: 404 })
    expect(mocks.roundFindOne).toHaveBeenLastCalledWith({
      _id: IDS.round,
      workspaceId: IDS.workspaceB,
    })
  })
})
