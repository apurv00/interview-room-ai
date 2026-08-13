import mongoose from 'mongoose'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  mockOutbox,
  mockJob,
  mockCandidate,
  mockPrivacyRequest,
  mockReengagementOptOut,
  mockReengagementOptOutUrl,
  mockWorkspace,
  mockWriteFence,
  mockCandidatePiiFence,
  MockHireCandidatePiiTombstoneError,
  mockSendEmail,
  mockConnectHireControlDB,
  mockWorkspaceIds,
  session,
} = vi.hoisted(() => ({
  mockOutbox: {
    find: vi.fn(),
    findOne: vi.fn(),
    findOneAndUpdate: vi.fn(),
    updateMany: vi.fn(),
    updateOne: vi.fn(),
  },
  mockJob: { exists: vi.fn() },
  mockCandidate: { findOne: vi.fn() },
  mockPrivacyRequest: { exists: vi.fn() },
  mockReengagementOptOut: { exists: vi.fn() },
  mockReengagementOptOutUrl: vi.fn(),
  mockWorkspace: { findOneAndUpdate: vi.fn() },
  mockWriteFence: vi.fn(),
  mockCandidatePiiFence: vi.fn(),
  MockHireCandidatePiiTombstoneError: class HireCandidatePiiTombstoneError extends Error {},
  mockSendEmail: vi.fn(),
  mockConnectHireControlDB: vi.fn(),
  mockWorkspaceIds: vi.fn(),
  session: (() => {
    const value = {
      id: 'session-1',
      withTransaction: vi.fn(),
      endSession: vi.fn(),
    }
    value.withTransaction.mockImplementation((work: (current: unknown) => unknown) => work(value))
    value.endSession.mockResolvedValue(undefined)
    return value
  })(),
}))

vi.mock('../services/hireControlBoundary', () => ({
  connectHireControlDB: (...args: unknown[]) => mockConnectHireControlDB(...args),
}))
vi.mock('../services/workspaceSweepService', () => ({
  listHireWorkspaceIdsForSweep: (...args: unknown[]) => mockWorkspaceIds(...args),
}))
vi.mock('@shared/services/emailService', () => ({
  sendEmail: (...args: unknown[]) => mockSendEmail(...args),
}))
vi.mock('../models/HireEmailOutbox', () => ({
  HireEmailOutbox: {
    find: (...args: unknown[]) => mockOutbox.find(...args),
    findOne: (...args: unknown[]) => mockOutbox.findOne(...args),
    findOneAndUpdate: (...args: unknown[]) => mockOutbox.findOneAndUpdate(...args),
    updateMany: (...args: unknown[]) => mockOutbox.updateMany(...args),
    updateOne: (...args: unknown[]) => mockOutbox.updateOne(...args),
  },
}))
vi.mock('../models/HireJob', () => ({
  HireJob: { exists: (...args: unknown[]) => mockJob.exists(...args) },
}))
vi.mock('../models/HireCandidate', () => ({
  HireCandidate: { findOne: (...args: unknown[]) => mockCandidate.findOne(...args) },
}))
vi.mock('../models/HirePrivacyRequest', () => ({
  HirePrivacyRequest: { exists: (...args: unknown[]) => mockPrivacyRequest.exists(...args) },
}))
vi.mock('../models/HireReengagementOptOut', () => ({
  HireReengagementOptOut: { exists: (...args: unknown[]) => mockReengagementOptOut.exists(...args) },
}))
vi.mock('../models/HireWorkspace', () => ({
  HireWorkspace: {
    findOneAndUpdate: (...args: unknown[]) => mockWorkspace.findOneAndUpdate(...args),
  },
}))
vi.mock('../services/reengagementOptOutService', () => ({
  buildHireReengagementOptOutUrl: (...args: unknown[]) => mockReengagementOptOutUrl(...args),
}))
vi.mock('../services/hireWorkspaceWriteFence', () => ({
  withActiveHireWorkspaceWriteTransaction: (...args: unknown[]) => mockWriteFence(...args),
}))
vi.mock('../services/hireCandidatePrivacyWriteFence', () => ({
  claimHireCandidatePiiWriteFence: (...args: unknown[]) => mockCandidatePiiFence(...args),
  HireCandidatePiiTombstoneError: MockHireCandidatePiiTombstoneError,
}))

import { buildJobCloseRejectionEmail } from '../emails/jobCloseRejectionEmail'
import { buildJobReengagementEmail } from '../emails/jobReengagementEmail'
import {
  HIRE_EMAIL_MAX_ATTEMPTS,
  getJobCloseEmailDelivery,
  processDueHireEmailsAcrossWorkspaces,
  processNextHireEmail,
  retryFailedJobCloseEmails,
} from '../services/emailOutboxService'

const NOW = new Date('2026-08-10T10:00:00.000Z')
const WORKSPACE_ID = 'a'.repeat(24)
const MEMBER_ID = 'b'.repeat(24)
const JOB_ID = 'c'.repeat(24)
const CTX = {
  workspace: { _id: WORKSPACE_ID },
  membership: {
    _id: MEMBER_ID,
    email: 'hr@acme.example',
    name: 'HR One',
  },
} as never

function outboxFind(rows: unknown[]) {
  return {
    select: vi.fn().mockReturnThis(),
    sort: vi.fn().mockResolvedValue(rows),
  }
}

function outboxFindOne(row: unknown) {
  return { sort: vi.fn().mockResolvedValue(row) }
}

function outboxRow(attempts = 1) {
  return {
    _id: { toString: () => 'outbox-1' },
    jobId: JOB_ID,
    applicationId: 'd'.repeat(24),
    candidateId: 'e'.repeat(24),
    kind: 'job_close_rejection',
    recipientEmail: 'candidate@example.com',
    recipientName: 'Candidate One',
    payload: {
      jobTitle: 'Backend Engineer',
      workspaceName: 'Acme',
      decisionNote: 'Hired Jane; do not disclose this internal note.',
      actorName: 'HR One',
    },
    attempts,
  }
}

function candidateFind(value: unknown) {
  const query = {
    select: vi.fn(),
    session: vi.fn(),
    lean: vi.fn().mockResolvedValue(value),
  }
  query.select.mockReturnValue(query)
  query.session.mockReturnValue(query)
  return query
}

function sessionQuery(value: unknown) {
  return { session: vi.fn().mockResolvedValue(value) }
}

beforeEach(() => {
  vi.clearAllMocks()
  session.withTransaction.mockImplementation((work: (current: unknown) => unknown) => work(session))
  session.endSession.mockResolvedValue(undefined)
  mockConnectHireControlDB.mockResolvedValue(undefined)
  mockWorkspaceIds.mockResolvedValue([WORKSPACE_ID])
  mockJob.exists.mockResolvedValue({ _id: JOB_ID })
  mockOutbox.find.mockReturnValue(outboxFind([]))
  mockOutbox.findOne.mockReturnValue(outboxFindOne(outboxRow()))
  mockOutbox.updateMany.mockResolvedValue({ modifiedCount: 0 })
  mockOutbox.updateOne.mockResolvedValue({ matchedCount: 1 })
  mockCandidate.findOne.mockReturnValue(candidateFind({
    name: 'Candidate One',
    email: 'candidate@example.com',
  }))
  mockPrivacyRequest.exists.mockImplementation(() => sessionQuery(null))
  mockReengagementOptOut.exists.mockImplementation(() => sessionQuery(null))
  mockReengagementOptOutUrl.mockReturnValue('https://hire.example/opt-out?capability=opaque')
  mockWorkspace.findOneAndUpdate.mockResolvedValue({ _id: WORKSPACE_ID })
  mockWriteFence.mockImplementation(
    async (_workspaceId: unknown, _memberId: unknown, work: (value: unknown) => unknown) =>
      work(session),
  )
  mockCandidatePiiFence.mockResolvedValue(undefined)
  vi.spyOn(mongoose, 'startSession').mockResolvedValue(session as never)
})

describe('job close rejection template', () => {
  it('escapes candidate-controlled HTML and never accepts the internal close note', () => {
    const template = buildJobCloseRejectionEmail({
      candidateName: '<img src=x onerror=alert(1)> Person',
      jobTitle: '<script>Backend</script>',
      workspaceName: 'Acme\r\nBcc: attacker@example.com',
    })

    expect(template.html).not.toContain('<script>')
    expect(template.html).not.toContain('<img src=x')
    expect(template.html).toContain('&lt;script&gt;Backend&lt;/script&gt;')
    expect(template.subject).not.toContain('\r')
    expect(template.subject).not.toContain('\n')
    expect(template).not.toHaveProperty('decisionNote')
  })
})

describe('job re-engagement template', () => {
  it('is transparent about prior consideration and escapes candidate-controlled values', () => {
    const template = buildJobReengagementEmail({
      candidateName: '<img src=x onerror=alert(1)> Ada',
      jobTitle: '<script>Platform</script>',
      workspaceName: 'Acme\r\nBcc: attacker@example.com',
      optOutUrl: 'https://hire.example/opt-out?capability=<unsafe>',
    })

    expect(template.html).toContain('previously connected')
    expect(template.html).toContain('Opt out here')
    expect(template.html).not.toContain('<script>')
    expect(template.html).not.toContain('<img src=x')
    expect(template.html).toContain('&lt;script&gt;Platform&lt;/script&gt;')
    expect(template.subject).not.toContain('\r')
    expect(template.subject).not.toContain('\n')
  })
})

describe('processNextHireEmail', () => {
  it('returns without a provider call when no due row can be claimed', async () => {
    mockOutbox.findOne.mockReturnValue(outboxFindOne(null))
    await expect(processNextHireEmail(WORKSPACE_ID, NOW)).resolves.toEqual({ processed: false })
    expect(mockSendEmail).not.toHaveBeenCalled()
  })

  it('claims with a recovery lease and records a provider-idempotent send', async () => {
    mockOutbox.findOneAndUpdate.mockResolvedValue(outboxRow())
    mockSendEmail.mockResolvedValue({ ok: true, id: 'resend-1' })

    await expect(processNextHireEmail(WORKSPACE_ID, NOW)).resolves.toEqual({
      processed: true,
      outboxId: 'outbox-1',
      outcome: 'sent',
    })

    const [claimFilter, claimUpdate] = mockOutbox.findOneAndUpdate.mock.calls[0]
    expect(claimFilter).toMatchObject({
      workspaceId: WORKSPACE_ID,
      attempts: { $lt: HIRE_EMAIL_MAX_ATTEMPTS },
      sendAfter: { $lte: NOW },
    })
    expect(claimUpdate.$set.status).toBe('sending')
    expect(claimUpdate.$set.claimToken).toMatch(/^[0-9a-f-]{36}$/)
    expect(claimUpdate.$inc).toEqual({ attempts: 1 })
    expect(mockWorkspace.findOneAndUpdate).toHaveBeenCalledWith(
      {
        _id: WORKSPACE_ID,
        $or: [{ lifecycleState: 'active' }, { lifecycleState: { $exists: false } }],
      },
      { $inc: { writeFenceVersion: 1 } },
      expect.objectContaining({ session }),
    )
    expect(mockSendEmail).toHaveBeenCalledWith({
      to: 'candidate@example.com',
      subject: 'Acme: update on your Backend Engineer application',
      html: expect.any(String),
      text: expect.any(String),
      idempotencyKey: 'hire-close-rejection:outbox-1',
    })
    const [, sentUpdate] = mockOutbox.updateOne.mock.calls[0]
    expect(mockOutbox.updateOne.mock.calls[0][0]).toMatchObject({
      workspaceId: WORKSPACE_ID,
    })
    expect(sentUpdate.$set).toMatchObject({
      status: 'sent',
      sentAt: NOW,
      providerMessageId: 'resend-1',
    })
  })

  it('reschedules provider failure with backoff and stops after the max attempt', async () => {
    mockOutbox.findOne
      .mockReturnValueOnce(outboxFindOne(outboxRow(2)))
      .mockReturnValueOnce(outboxFindOne(outboxRow(HIRE_EMAIL_MAX_ATTEMPTS)))
    mockOutbox.findOneAndUpdate.mockResolvedValueOnce(outboxRow(2))
    mockSendEmail.mockResolvedValue({ ok: false })

    await expect(processNextHireEmail(WORKSPACE_ID, NOW)).resolves.toMatchObject({
      outcome: 'retry_scheduled',
    })
    let failureUpdate = mockOutbox.updateOne.mock.calls[0][1]
    expect(failureUpdate.$set.status).toBe('pending')
    expect(failureUpdate.$set.sendAfter.getTime()).toBe(NOW.getTime() + 2 * 60_000)

    mockOutbox.findOneAndUpdate.mockResolvedValueOnce(outboxRow(HIRE_EMAIL_MAX_ATTEMPTS))
    await expect(processNextHireEmail(WORKSPACE_ID, NOW)).resolves.toMatchObject({ outcome: 'failed' })
    failureUpdate = mockOutbox.updateOne.mock.calls[1][1]
    expect(failureUpdate.$set.status).toBe('failed')
    expect(failureUpdate.$set).not.toHaveProperty('sendAfter')
  })

  it('throws if the lease is lost after provider acceptance', async () => {
    mockOutbox.findOneAndUpdate.mockResolvedValue(outboxRow())
    mockSendEmail.mockResolvedValue({ ok: true, id: 'resend-1' })
    mockOutbox.updateOne.mockResolvedValue({ matchedCount: 0 })

    await expect(processNextHireEmail(WORKSPACE_ID, NOW)).rejects.toThrow(/lease was lost/)
  })

  it('sends a re-engagement message only after a tenant-scoped privacy and opt-out recheck', async () => {
    const reengagement = {
      ...outboxRow(),
      kind: 'job_reengagement',
      candidateId: 'candidate-1',
    }
    mockOutbox.findOne.mockReturnValue(outboxFindOne(reengagement))
    mockOutbox.findOneAndUpdate.mockResolvedValue(reengagement)
    mockSendEmail.mockResolvedValue({ ok: true, id: 'resend-2' })

    await expect(processNextHireEmail(WORKSPACE_ID, NOW)).resolves.toMatchObject({
      outcome: 'sent',
    })

    expect(mockCandidate.findOne).toHaveBeenCalledWith({
      _id: 'candidate-1',
      workspaceId: WORKSPACE_ID,
      piiAnonymizedAt: { $exists: false },
    })
    expect(mockPrivacyRequest.exists).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      candidateId: 'candidate-1',
      live: true,
      status: { $in: ['pending_verification', 'processing'] },
    })
    expect(mockReengagementOptOut.exists).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      candidateId: 'candidate-1',
    })
    expect(mockReengagementOptOutUrl).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      candidateId: 'candidate-1',
      outboxId: 'outbox-1',
      now: NOW,
    })
    expect(mockSendEmail).toHaveBeenCalledWith({
      to: 'candidate@example.com',
      subject: 'Acme: an opportunity for Backend Engineer',
      html: expect.any(String),
      text: expect.any(String),
      idempotencyKey: 'hire-reengagement:outbox-1',
      headers: {
        'List-Unsubscribe': '<https://hire.example/opt-out?capability=opaque>',
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
    })
  })

  it('does not contact the provider for a deletion-pending workspace before a close-rejection claim', async () => {
    mockWorkspace.findOneAndUpdate.mockResolvedValue(null)

    await expect(processNextHireEmail(WORKSPACE_ID, NOW)).resolves.toEqual({
      processed: true,
      outboxId: 'outbox-1',
      outcome: 'cancelled',
    })

    expect(mockWorkspace.findOneAndUpdate).toHaveBeenCalledWith(
      {
        _id: WORKSPACE_ID,
        $or: [{ lifecycleState: 'active' }, { lifecycleState: { $exists: false } }],
      },
      { $inc: { writeFenceVersion: 1 } },
      expect.objectContaining({ session }),
    )
    expect(mockOutbox.findOneAndUpdate).not.toHaveBeenCalled()
    expect(mockOutbox.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: expect.anything(),
        workspaceId: WORKSPACE_ID,
        kind: 'job_close_rejection',
      }),
      expect.objectContaining({
        $set: expect.objectContaining({ status: 'cancelled' }),
      }),
      expect.objectContaining({ session }),
    )
    expect(mockSendEmail).not.toHaveBeenCalled()
  })

  it('does not contact the provider for a deletion-pending workspace before a re-engagement claim', async () => {
    mockOutbox.findOne.mockReturnValue(outboxFindOne({
      ...outboxRow(),
      kind: 'job_reengagement',
      candidateId: 'candidate-1',
    }))
    mockWorkspace.findOneAndUpdate.mockResolvedValue(null)

    await expect(processNextHireEmail(WORKSPACE_ID, NOW)).resolves.toEqual({
      processed: true,
      outboxId: 'outbox-1',
      outcome: 'cancelled',
    })

    expect(mockWorkspace.findOneAndUpdate).toHaveBeenCalledWith(
      {
        _id: WORKSPACE_ID,
        $or: [{ lifecycleState: 'active' }, { lifecycleState: { $exists: false } }],
      },
      { $inc: { writeFenceVersion: 1 } },
      expect.objectContaining({ session }),
    )
    expect(mockCandidatePiiFence).not.toHaveBeenCalled()
    expect(mockOutbox.findOneAndUpdate).not.toHaveBeenCalled()
    expect(mockOutbox.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: expect.anything(),
        workspaceId: WORKSPACE_ID,
        kind: 'job_reengagement',
      }),
      expect.objectContaining({
        $set: expect.objectContaining({ status: 'cancelled' }),
      }),
      expect.objectContaining({ session }),
    )
    expect(mockSendEmail).not.toHaveBeenCalled()
  })

  it('cancels a claimed re-engagement row without contacting the provider when that exact tenant opted out', async () => {
    mockOutbox.findOne.mockReturnValue(outboxFindOne({
      ...outboxRow(),
      kind: 'job_reengagement',
      candidateId: 'candidate-1',
    }))
    mockReengagementOptOut.exists.mockReturnValue(sessionQuery({ _id: 'optout-1' }))

    await expect(processNextHireEmail(WORKSPACE_ID, NOW)).resolves.toEqual({
      processed: true,
      outboxId: 'outbox-1',
      outcome: 'cancelled',
    })

    expect(mockReengagementOptOut.exists).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      candidateId: 'candidate-1',
    })
    expect(mockSendEmail).not.toHaveBeenCalled()
    expect(mockOutbox.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({ _id: expect.anything(), workspaceId: WORKSPACE_ID }),
      expect.objectContaining({
        $set: expect.objectContaining({ status: 'cancelled' }),
      }),
      expect.objectContaining({ session }),
    )
  })

  it('does not contact the provider when an opt-out wins after selection but before the fenced egress claim', async () => {
    const reengagement = {
      ...outboxRow(),
      kind: 'job_reengagement',
      candidateId: 'candidate-1',
    }
    mockOutbox.findOne.mockReturnValue(outboxFindOne(reengagement))
    mockCandidatePiiFence.mockImplementation(async () => {
      // Deterministically model opt-out committing after the read-only worker
      // selection and before this transaction's fresh suppression read.
      mockReengagementOptOut.exists.mockReturnValue(sessionQuery({ _id: 'optout-1' }))
    })

    await expect(processNextHireEmail(WORKSPACE_ID, NOW)).resolves.toMatchObject({
      outcome: 'cancelled',
    })

    expect(mockCandidatePiiFence).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: WORKSPACE_ID, candidateId: 'candidate-1' }),
    )
    expect(mockOutbox.findOneAndUpdate).not.toHaveBeenCalled()
    expect(mockSendEmail).not.toHaveBeenCalled()
  })

  it('does not contact the provider when a live privacy request wins after selection but before the fenced egress claim', async () => {
    const reengagement = {
      ...outboxRow(),
      kind: 'job_reengagement',
      candidateId: 'candidate-1',
    }
    mockOutbox.findOne.mockReturnValue(outboxFindOne(reengagement))
    mockOutbox.findOneAndUpdate.mockResolvedValue(reengagement)
    let privacyChecks = 0
    mockPrivacyRequest.exists.mockImplementation(() => {
      privacyChecks += 1
      return sessionQuery(privacyChecks === 1 ? null : { _id: 'privacy-1' })
    })
    // Model a write conflict with `createHirePrivacyRequestFromInvite`: the
    // first authorization callback rolled back, then its retry observes the
    // privacy creator's committed live request before it may call provider.
    session.withTransaction.mockImplementation(async (work: (current: unknown) => unknown) => {
      await work(session)
      await work(session)
    })

    await expect(processNextHireEmail(WORKSPACE_ID, NOW)).resolves.toMatchObject({
      outcome: 'cancelled',
    })

    expect(mockOutbox.findOneAndUpdate).toHaveBeenCalledTimes(1)
    expect(mockSendEmail).not.toHaveBeenCalled()
  })

  it('does not contact the provider if the exact outbox claim is lost after all eligibility checks', async () => {
    const reengagement = {
      ...outboxRow(),
      kind: 'job_reengagement',
      candidateId: 'candidate-1',
    }
    mockOutbox.findOne.mockReturnValue(outboxFindOne(reengagement))
    // Models deletion/revocation removing or reclaiming this exact item at
    // the final authorization compare-and-set.
    mockOutbox.findOneAndUpdate.mockResolvedValue(null)

    await expect(processNextHireEmail(WORKSPACE_ID, NOW)).resolves.toMatchObject({
      outcome: 'cancelled',
    })

    expect(mockOutbox.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: reengagement._id,
        workspaceId: WORKSPACE_ID,
        kind: 'job_reengagement',
      }),
      expect.objectContaining({
        $set: expect.objectContaining({ status: 'sending' }),
      }),
      expect.objectContaining({ new: true, session }),
    )
    expect(mockSendEmail).not.toHaveBeenCalled()
  })

  it('allows one provider call when authorization wins before a later live privacy request', async () => {
    const reengagement = {
      ...outboxRow(),
      kind: 'job_reengagement',
      candidateId: 'candidate-1',
    }
    const order: string[] = []
    mockOutbox.findOne.mockReturnValue(outboxFindOne(reengagement))
    mockCandidatePiiFence.mockImplementation(async () => {
      order.push('fence')
    })
    mockPrivacyRequest.exists.mockImplementation(() => {
      order.push('privacy-check')
      return sessionQuery(null)
    })
    mockOutbox.findOneAndUpdate.mockImplementation(async () => {
      order.push('authorized')
      // The request is created after the committed authorization; that must
      // not retroactively invalidate the already-authorized egress.
      mockPrivacyRequest.exists.mockReturnValue(sessionQuery({ _id: 'privacy-1' }))
      return reengagement
    })
    mockSendEmail.mockImplementation(async () => {
      order.push('provider')
      return { ok: true, id: 'resend-privacy-order' }
    })

    await expect(processNextHireEmail(WORKSPACE_ID, NOW)).resolves.toMatchObject({
      outcome: 'sent',
    })

    expect(order).toEqual(['fence', 'privacy-check', 'authorized', 'provider'])
    expect(mockSendEmail).toHaveBeenCalledTimes(1)
  })

  it('does not carry an authorization across a retried transaction callback', async () => {
    const reengagement = {
      ...outboxRow(),
      kind: 'job_reengagement',
      candidateId: 'candidate-1',
    }
    mockOutbox.findOne.mockReturnValue(outboxFindOne(reengagement))
    mockOutbox.findOneAndUpdate
      .mockResolvedValueOnce(reengagement)
      .mockResolvedValueOnce(null)
    // Model a driver retry after a transient conflict. The first callback's
    // authorization was rolled back; only the second callback may decide
    // whether provider egress is allowed.
    session.withTransaction.mockImplementation(async (work: (current: unknown) => unknown) => {
      await work(session)
      await work(session)
    })

    await expect(processNextHireEmail(WORKSPACE_ID, NOW)).resolves.toMatchObject({
      outcome: 'cancelled',
    })

    expect(mockOutbox.findOneAndUpdate).toHaveBeenCalledTimes(2)
    expect(mockSendEmail).not.toHaveBeenCalled()
  })

  it('does not schedule a retry when opt-out wins after a pre-opt-out authorized provider rejection', async () => {
    const reengagement = {
      ...outboxRow(),
      kind: 'job_reengagement',
      candidateId: 'candidate-1',
    }
    mockOutbox.findOne.mockReturnValue(outboxFindOne(reengagement))
    mockOutbox.findOneAndUpdate.mockResolvedValue({ ...reengagement, attempts: 2 })
    mockSendEmail.mockImplementation(async () => {
      // Provider rejection happens after authorization. The subsequent
      // settlement transaction must observe this choice and cancel, not put
      // the row back into pending for a later egress.
      mockReengagementOptOut.exists.mockReturnValue(sessionQuery({ _id: 'optout-1' }))
      return { ok: false }
    })

    await expect(processNextHireEmail(WORKSPACE_ID, NOW)).resolves.toMatchObject({
      outcome: 'cancelled',
    })

    expect(mockSendEmail).toHaveBeenCalledTimes(1)
    expect(mockOutbox.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'job_reengagement', claimToken: expect.any(String) }),
      expect.objectContaining({ $set: expect.objectContaining({ status: 'cancelled' }) }),
      expect.objectContaining({ session }),
    )
  })

  it('does not contact the provider when verified deletion wins the candidate fence', async () => {
    const reengagement = {
      ...outboxRow(),
      kind: 'job_reengagement',
      candidateId: 'candidate-1',
    }
    mockOutbox.findOne.mockReturnValue(outboxFindOne(reengagement))
    mockCandidatePiiFence.mockRejectedValue(new MockHireCandidatePiiTombstoneError())

    await expect(processNextHireEmail(WORKSPACE_ID, NOW)).resolves.toMatchObject({
      outcome: 'cancelled',
    })

    expect(mockOutbox.findOneAndUpdate).not.toHaveBeenCalled()
    expect(mockSendEmail).not.toHaveBeenCalled()
  })

  it('drains each workspace through a scoped claim and continues after an idle tenant', async () => {
    const otherWorkspace = 'b'.repeat(24)
    mockWorkspaceIds.mockResolvedValue([WORKSPACE_ID, otherWorkspace])
    mockOutbox.findOne
      .mockReturnValueOnce(outboxFindOne(null))
      .mockReturnValueOnce(outboxFindOne(outboxRow()))
      .mockReturnValueOnce(outboxFindOne(null))
    mockOutbox.findOneAndUpdate.mockResolvedValue(outboxRow())
    mockSendEmail.mockResolvedValue({ ok: true, id: 'resend-1' })

    await expect(processDueHireEmailsAcrossWorkspaces(5, NOW)).resolves.toEqual({
      processed: 1,
      failed: 0,
      workspaces: 2,
    })
    expect(mockOutbox.findOne.mock.calls.map(([filter]) => filter.workspaceId)).toEqual([
      WORKSPACE_ID,
      otherWorkspace,
      otherWorkspace,
    ])
  })
})

describe('member-facing terminal failure visibility', () => {
  it('returns a safe summary from workspace-and-job-scoped queries', async () => {
    const failedAt = new Date('2026-08-10T11:00:00.000Z')
    mockOutbox.find.mockReturnValue(
      outboxFind([
        { status: 'pending' },
        { status: 'sending' },
        { status: 'sent' },
        {
          status: 'failed',
          recipientEmail: 'candidate@example.com',
          recipientName: 'Candidate One',
          attempts: HIRE_EMAIL_MAX_ATTEMPTS,
          lastError: 'Provider rejected the message',
          updatedAt: failedAt,
        },
      ]),
    )

    await expect(getJobCloseEmailDelivery(CTX, JOB_ID)).resolves.toEqual({
      total: 4,
      pending: 1,
      sending: 1,
      sent: 1,
      failed: 1,
      failures: [
        {
          recipientEmail: 'candidate@example.com',
          recipientName: 'Candidate One',
          attempts: HIRE_EMAIL_MAX_ATTEMPTS,
          lastError: 'Provider rejected the message',
          failedAt,
        },
      ],
    })

    expect(mockJob.exists).toHaveBeenCalledWith({
      _id: JOB_ID,
      workspaceId: WORKSPACE_ID,
    })
    expect(mockOutbox.find).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      jobId: JOB_ID,
      kind: 'job_close_rejection',
    })
  })

  it('does not disclose delivery state for a job outside the workspace', async () => {
    mockJob.exists.mockResolvedValueOnce(null)
    mockOutbox.find.mockReturnValue(
      outboxFind([
        {
          status: 'failed',
          recipientEmail: 'other-tenant@example.com',
          recipientName: 'Other Tenant',
          attempts: 5,
          updatedAt: NOW,
        },
      ]),
    )

    await expect(getJobCloseEmailDelivery(CTX, JOB_ID)).rejects.toMatchObject({
      statusCode: 404,
      code: 'NOT_FOUND',
    })
  })
})

describe('manual terminal failure retry', () => {
  it('uses the active-workspace fence and requeues only scoped failed rows', async () => {
    const existsSession = vi.fn().mockResolvedValue({ _id: JOB_ID })
    mockJob.exists.mockReturnValueOnce({ session: existsSession })
    mockOutbox.updateMany.mockResolvedValueOnce({ modifiedCount: 2 })

    await expect(retryFailedJobCloseEmails(CTX, JOB_ID, NOW)).resolves.toEqual({
      requeued: 2,
    })

    expect(mockWriteFence).toHaveBeenCalledWith(WORKSPACE_ID, MEMBER_ID, expect.any(Function))
    expect(existsSession).toHaveBeenCalledWith(session)
    const [filter, update, options] = mockOutbox.updateMany.mock.calls[0]
    expect(filter).toEqual({
      workspaceId: WORKSPACE_ID,
      jobId: JOB_ID,
      kind: 'job_close_rejection',
      status: 'failed',
    })
    expect(update).toEqual({
      $set: {
        status: 'pending',
        attempts: 0,
        sendAfter: NOW,
        lastManualRetryAt: NOW,
        lastManualRetryByMemberId: MEMBER_ID,
        lastManualRetryByName: 'HR One',
      },
      $inc: { manualRetryCount: 1 },
      $unset: { claimToken: 1, leaseExpiresAt: 1 },
    })
    expect(JSON.stringify(update)).not.toContain('operationId')
    expect(options).toEqual({ session })
  })

  it('fails closed before touching outbox rows when the scoped job is absent', async () => {
    const existsSession = vi.fn().mockResolvedValue(null)
    mockJob.exists.mockReturnValueOnce({ session: existsSession })

    await expect(retryFailedJobCloseEmails(CTX, JOB_ID, NOW)).rejects.toMatchObject({
      statusCode: 404,
      code: 'NOT_FOUND',
    })
    expect(mockOutbox.updateMany).not.toHaveBeenCalled()
  })
})
