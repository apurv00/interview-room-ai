import { describe, it, expect, vi, beforeEach } from 'vitest'
import crypto from 'crypto'

vi.mock('@shared/db/connection', () => ({
  connectDB: vi.fn().mockResolvedValue(undefined),
}))
const mockSendEmail = vi.fn().mockResolvedValue({ ok: true, id: 'email-1' })
vi.mock('@shared/services/emailService', () => ({
  sendEmail: (...a: unknown[]) => mockSendEmail(...a),
}))
vi.mock('@shared/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}))
const mockAppendEvent = vi.fn().mockResolvedValue(undefined)
vi.mock('../services/pipelineService', () => ({
  appendApplicationEvent: (...a: unknown[]) => mockAppendEvent(...a),
}))

const mockRound = {
  create: vi.fn(),
  find: vi.fn(),
  findOne: vi.fn(),
  findOneAndUpdate: vi.fn(),
  updateOne: vi.fn(),
}
const mockJob = { findOne: vi.fn() }
const mockCandidate = { findOne: vi.fn() }
const mockApplication = { findOne: vi.fn() }
const mockWorkspaceModel = { findById: vi.fn() }

vi.mock('../models', () => ({
  HireRound: {
    create: (...a: unknown[]) => mockRound.create(...a),
    find: (...a: unknown[]) => mockRound.find(...a),
    findOne: (...a: unknown[]) => mockRound.findOne(...a),
    findOneAndUpdate: (...a: unknown[]) => mockRound.findOneAndUpdate(...a),
    updateOne: (...a: unknown[]) => mockRound.updateOne(...a),
  },
  HireJob: { findOne: (...a: unknown[]) => mockJob.findOne(...a) },
  HireCandidate: { findOne: (...a: unknown[]) => mockCandidate.findOne(...a) },
  HireApplication: { findOne: (...a: unknown[]) => mockApplication.findOne(...a) },
  HireWorkspace: { findById: (...a: unknown[]) => mockWorkspaceModel.findById(...a) },
}))

import {
  sendAiRound,
  verifyRoundToken,
  recordConsent,
  bindGuestUser,
  prepareRound,
  revokeRound,
  sha256,
  AI_ROUND_INTERVIEW_TYPE,
} from '../services/aiRoundService'
import type { MembershipContext } from '../services/workspaceService'

const CTX = {
  workspace: { _id: 'ws-A', name: 'Acme' },
  membership: { _id: 'm1', userId: 'u1', email: 'hr@acme.com', name: 'HR One' },
} as unknown as MembershipContext

const ROUND_ID = 'aaaaaaaaaaaaaaaaaaaaaaaa'
const RAW_TOKEN = 'ab'.repeat(32) // 64 hex chars

beforeEach(() => {
  vi.clearAllMocks()
  mockSendEmail.mockResolvedValue({ ok: true, id: 'email-1' })
})

describe('sendAiRound', () => {
  function armHappyPath() {
    mockApplication.findOne.mockResolvedValue({ _id: 'a1', jobId: 'j1', candidateId: 'c1' })
    mockJob.findOne.mockResolvedValue({
      _id: 'j1',
      title: 'Backend Engineer',
      jdText: 'Great JD text here',
      status: 'open',
    })
    mockCandidate.findOne.mockResolvedValue({
      _id: 'c1',
      email: 'jane@ex.com',
      name: 'Jane Doe',
    })
    mockRound.find.mockResolvedValue([])
    mockRound.create.mockImplementation((doc: Record<string, unknown>) =>
      Promise.resolve({ ...doc, _id: { toString: () => ROUND_ID } })
    )
  }

  it('stores only the sha256 of the token; the raw token appears only in the URL', async () => {
    armHappyPath()
    const result = await sendAiRound(CTX, {
      applicationId: 'a1',
      experience: '3-6',
      duration: 15,
    })
    const doc = mockRound.create.mock.calls[0][0]
    const rawToken = new URL(result.inviteUrl).searchParams.get('token')!
    expect(rawToken).toMatch(/^[a-f0-9]{64}$/)
    expect(doc.inviteTokenHash).toBe(sha256(rawToken))
    expect(doc.inviteTokenHash).not.toBe(rawToken)
    expect(result.inviteUrl).toContain(`/candidate/${ROUND_ID}?token=`)
  })

  it('stamps workspace scoping, config, a round-unique jdHash, and the candidate identity', async () => {
    armHappyPath()
    await sendAiRound(CTX, { applicationId: 'a1', experience: '7+', duration: 30 })
    const doc = mockRound.create.mock.calls[0][0]
    expect(doc.workspaceId).toBe('ws-A')
    expect(doc.candidateEmail).toBe('jane@ex.com')
    expect(doc.live).toBe(true)
    // Workspace has no explicit setting → magic_link default, snapshotted.
    expect(doc.authMode).toBe('magic_link')
    // jdSnapshot = job JD + a per-round reference line; jdHash covers the
    // snapshot, making the match key unique per round (cross-tenant claim fix).
    expect(doc.jdSnapshot).toContain('Great JD text here')
    expect(doc.jdSnapshot).toContain(`[Interview reference: HR-${doc._id.toString()}]`)
    expect(doc.jdHash).toBe(crypto.createHash('sha256').update(doc.jdSnapshot).digest('hex'))
    expect(doc.jdHash).not.toBe(
      crypto.createHash('sha256').update('Great JD text here').digest('hex')
    )
    expect(doc.config).toEqual({
      role: 'Backend Engineer',
      interviewType: AI_ROUND_INTERVIEW_TYPE,
      experience: '7+',
      duration: 30,
    })
    const expiryMs = doc.inviteTokenExpiry.getTime() - Date.now()
    expect(expiryMs).toBeGreaterThan(6.9 * 24 * 3600 * 1000)
    expect(expiryMs).toBeLessThan(7.1 * 24 * 3600 * 1000)
  })

  it('clamps a >100-char job title to the engine role contract', async () => {
    armHappyPath()
    const longTitle = 'Senior Staff Backend Platform Engineer '.repeat(4) // 156 chars
    mockJob.findOne.mockResolvedValue({
      _id: 'j1',
      title: longTitle,
      jdText: 'Great JD text here',
      status: 'open',
    })
    await sendAiRound(CTX, { applicationId: 'a1', experience: '3-6', duration: 15 })
    const doc = mockRound.create.mock.calls[0][0]
    expect(doc.config.role).toBe(longTitle.slice(0, 100))
    expect(doc.config.role.length).toBe(100)
  })

  it('maps a duplicate-live-round race (E11000 on the partial unique index) to 409', async () => {
    armHappyPath()
    mockRound.create.mockRejectedValue(Object.assign(new Error('dup'), { code: 11000 }))
    await expect(
      sendAiRound(CTX, { applicationId: 'a1', experience: '3-6', duration: 15 })
    ).rejects.toMatchObject({ code: 'ROUND_IN_FLIGHT', statusCode: 409 })
  })

  it('emails the candidate and records the send in the application event log', async () => {
    armHappyPath()
    await sendAiRound(CTX, { applicationId: 'a1', experience: '3-6', duration: 15 })
    expect(mockSendEmail.mock.calls[0][0].to).toBe('jane@ex.com')
    expect(mockAppendEvent).toHaveBeenCalledWith(
      'ws-A',
      'a1',
      expect.objectContaining({ type: 'ai_round_sent', actorUserId: 'u1', actorName: 'HR One' })
    )
  })

  it('snapshots an otp workspace onto the round and into the invite copy', async () => {
    armHappyPath()
    const otpCtx = {
      ...CTX,
      workspace: { _id: 'ws-A', name: 'Acme', guestAuthMode: 'otp' },
    } as unknown as typeof CTX
    await sendAiRound(otpCtx, { applicationId: 'a1', experience: '3-6', duration: 15 })
    expect(mockRound.create.mock.calls[0][0].authMode).toBe('otp')
    // The invite email must explain the code step, not promise direct entry.
    expect(mockSendEmail.mock.calls[0][0].html).toContain('6-digit code')
  })

  it('blocks a second live round (ROUND_IN_FLIGHT)', async () => {
    armHappyPath()
    mockRound.find.mockResolvedValue([
      { _id: 'r0', status: 'invited', inviteTokenExpiry: new Date(Date.now() + 3600_000) },
    ])
    await expect(
      sendAiRound(CTX, { applicationId: 'a1', experience: '3-6', duration: 15 })
    ).rejects.toMatchObject({ code: 'ROUND_IN_FLIGHT' })
    expect(mockRound.create).not.toHaveBeenCalled()
  })

  it('supersedes an expired pre-auth round explicitly (revoke + audit event + resend)', async () => {
    armHappyPath()
    mockRound.find.mockResolvedValue([
      { _id: 'r0', status: 'invited', inviteTokenExpiry: new Date(Date.now() - 3600_000) },
    ])
    await sendAiRound(CTX, { applicationId: 'a1', experience: '3-6', duration: 15 })
    const [filter, update] = mockRound.updateOne.mock.calls[0]
    expect(filter).toMatchObject({ _id: 'r0', workspaceId: 'ws-A' })
    expect(update.$set.status).toBe('revoked')
    expect(update.$unset).toEqual({ live: 1 })
    // The supersede is a witnessed action — it must appear in the audit log.
    expect(mockAppendEvent).toHaveBeenCalledWith(
      'ws-A',
      'a1',
      expect.objectContaining({ type: 'ai_round_revoked' })
    )
    expect(mockRound.create).toHaveBeenCalled()
  })

  it('refuses non-open jobs', async () => {
    armHappyPath()
    mockJob.findOne.mockResolvedValue({ _id: 'j1', status: 'on_hold', jdText: 'x', title: 't' })
    await expect(
      sendAiRound(CTX, { applicationId: 'a1', experience: '3-6', duration: 15 })
    ).rejects.toMatchObject({ code: 'JOB_NOT_OPEN' })
  })
})

describe('verifyRoundToken', () => {
  it('queries by token hash, never the raw token', async () => {
    mockRound.findOne.mockResolvedValue(null)
    await verifyRoundToken(ROUND_ID, RAW_TOKEN)
    expect(mockRound.findOne).toHaveBeenCalledWith({
      _id: ROUND_ID,
      inviteTokenHash: sha256(RAW_TOKEN),
    })
  })

  it('rejects malformed ids/tokens without touching the DB', async () => {
    expect(await verifyRoundToken('nope', RAW_TOKEN)).toBeNull()
    expect(await verifyRoundToken(ROUND_ID, 'short')).toBeNull()
    expect(mockRound.findOne).not.toHaveBeenCalled()
  })

  it('maps round state: revoked > completed > expired > ok', async () => {
    mockRound.findOne.mockResolvedValue({ revokedAt: new Date(), status: 'invited' })
    expect((await verifyRoundToken(ROUND_ID, RAW_TOKEN))?.state).toBe('revoked')

    mockRound.findOne.mockResolvedValue({ status: 'completed' })
    expect((await verifyRoundToken(ROUND_ID, RAW_TOKEN))?.state).toBe('completed')

    mockRound.findOne.mockResolvedValue({
      status: 'invited',
      inviteTokenExpiry: new Date(Date.now() - 1000),
    })
    expect((await verifyRoundToken(ROUND_ID, RAW_TOKEN))?.state).toBe('expired')

    // The RAW link dies at expiry regardless of round status — a leaked
    // link must never outlive its advertised deadline. Mid-flow resume
    // happens through the authenticated /prepare path, not the raw token.
    mockRound.findOne.mockResolvedValue({
      status: 'prepared',
      inviteTokenExpiry: new Date(Date.now() - 1000),
    })
    expect((await verifyRoundToken(ROUND_ID, RAW_TOKEN))?.state).toBe('expired')

    mockRound.findOne.mockResolvedValue({
      status: 'prepared',
      inviteTokenExpiry: new Date(Date.now() + 3600_000),
    })
    expect((await verifyRoundToken(ROUND_ID, RAW_TOKEN))?.state).toBe('ok')
  })
})

describe('recordConsent', () => {
  it('sets consent only once (first acceptance wins)', async () => {
    mockRound.findOne.mockResolvedValue({
      _id: ROUND_ID,
      status: 'invited',
      inviteTokenExpiry: new Date(Date.now() + 3600_000),
    })
    mockRound.findOneAndUpdate.mockResolvedValue({ _id: ROUND_ID, consentAt: new Date() })
    await recordConsent(ROUND_ID, RAW_TOKEN, { userAgent: 'UA' })
    const [filter, update] = mockRound.findOneAndUpdate.mock.calls[0]
    expect(filter).toMatchObject({ _id: ROUND_ID, consentAt: { $exists: false } })
    expect(update.$set.consentVersion).toBeTruthy()
    expect(update.$set.status).toBe('consented')
  })

  it('rejects invalid links with 410', async () => {
    mockRound.findOne.mockResolvedValue(null)
    await expect(recordConsent(ROUND_ID, RAW_TOKEN, {})).rejects.toMatchObject({
      statusCode: 410,
    })
  })
})

describe('bindGuestUser', () => {
  it('refuses to bind before consent is recorded — the gate holds for direct API callers', async () => {
    mockRound.findOne.mockResolvedValue({
      _id: ROUND_ID,
      status: 'invited',
      inviteTokenExpiry: new Date(Date.now() + 3600_000),
      consentAt: undefined,
    })
    await expect(bindGuestUser(ROUND_ID, RAW_TOKEN, 'guest-1')).rejects.toMatchObject({
      code: 'CONSENT_REQUIRED',
    })
    expect(mockRound.findOneAndUpdate).not.toHaveBeenCalled()
  })
})

describe('prepareRound', () => {
  it('requires the round to be bound to the calling guest user', async () => {
    mockRound.findOne.mockResolvedValue(null)
    await expect(prepareRound(ROUND_ID, 'other-user')).rejects.toMatchObject({ statusCode: 404 })
    expect(mockRound.findOne).toHaveBeenCalledWith({ _id: ROUND_ID, guestUserId: 'other-user' })
  })

  it('returns the immutable jdSnapshot (not live job text) and opens the reconciliation window once', async () => {
    const jdSnapshot = `The JD\n\n[Interview reference: HR-${ROUND_ID}]`
    mockRound.findOne.mockResolvedValue({
      _id: ROUND_ID,
      workspaceId: 'ws-A',
      jobId: 'j1',
      status: 'auth_verified',
      consentAt: new Date(),
      inviteTokenExpiry: new Date(Date.now() + 3600_000),
      jdSnapshot,
      config: { role: 'Backend Engineer', interviewType: 'behavioral', experience: '3-6', duration: 15 },
    })
    mockWorkspaceModel.findById.mockResolvedValue({ name: 'Acme' })
    mockRound.findOneAndUpdate.mockResolvedValue({ _id: ROUND_ID, preparedAt: new Date() })

    const { config } = await prepareRound(ROUND_ID, 'guest-1')
    expect(config).toEqual({
      role: 'Backend Engineer',
      interviewType: 'behavioral',
      experience: '3-6',
      duration: 15,
      jobDescription: jdSnapshot,
      targetCompany: 'Acme',
    })
    // The live HireJob is never consulted — a post-send JD edit can neither
    // change the assessment nor break the reconciliation hash.
    expect(mockJob.findOne).not.toHaveBeenCalled()
    const [filter] = mockRound.findOneAndUpdate.mock.calls[0]
    expect(filter).toMatchObject({ _id: ROUND_ID, preparedAt: { $exists: false } })
  })

  it('refuses revoked and unconsented rounds', async () => {
    mockRound.findOne.mockResolvedValue({ _id: ROUND_ID, revokedAt: new Date() })
    await expect(prepareRound(ROUND_ID, 'g')).rejects.toMatchObject({ statusCode: 410 })

    mockRound.findOne.mockResolvedValue({ _id: ROUND_ID, status: 'auth_verified' })
    await expect(prepareRound(ROUND_ID, 'g')).rejects.toMatchObject({ code: 'CONSENT_REQUIRED' })
  })

  it('enforces the post-auth grace ceiling — a lingering NextAuth session cannot re-prepare forever', async () => {
    mockRound.findOne.mockResolvedValue({
      _id: ROUND_ID,
      status: 'prepared',
      consentAt: new Date(),
      inviteTokenExpiry: new Date(Date.now() - 15 * 24 * 3600 * 1000),
      jdSnapshot: 'jd',
      config: { role: 'R', interviewType: 'behavioral', experience: '3-6', duration: 15 },
    })
    await expect(prepareRound(ROUND_ID, 'guest-1')).rejects.toMatchObject({
      statusCode: 410,
      code: 'ROUND_LINK_INVALID',
    })
  })
})

describe('revokeRound', () => {
  it('is workspace-scoped and only touches non-terminal rounds', async () => {
    mockRound.findOneAndUpdate.mockResolvedValue({ _id: ROUND_ID, applicationId: 'a1' })
    await revokeRound(CTX, ROUND_ID)
    const [filter, update] = mockRound.findOneAndUpdate.mock.calls[0]
    expect(filter).toMatchObject({
      _id: ROUND_ID,
      workspaceId: 'ws-A',
      status: { $nin: ['completed', 'revoked'] },
    })
    expect(update.$set.status).toBe('revoked')
    expect(update.$set.revokedBy).toBe('u1')
    expect(update.$unset).toEqual({ live: 1 })
    expect(mockAppendEvent).toHaveBeenCalledWith(
      'ws-A',
      'a1',
      expect.objectContaining({ type: 'ai_round_revoked' })
    )
  })
})
