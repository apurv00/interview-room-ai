import mongoose from 'mongoose'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  mockOutbox,
  mockJob,
  mockPrivacy,
  mockWorkspace,
  mockCandidatePiiFence,
  CandidatePiiTombstoneError,
  mockWriteFence,
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
  mockPrivacy: { exists: vi.fn() },
  mockWorkspace: { findOneAndUpdate: vi.fn() },
  mockCandidatePiiFence: vi.fn(),
  CandidatePiiTombstoneError: class CandidatePiiTombstoneError extends Error {},
  mockWriteFence: vi.fn(),
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
vi.mock('../models/HirePrivacyRequest', () => ({
  HirePrivacyRequest: { exists: (...args: unknown[]) => mockPrivacy.exists(...args) },
}))
vi.mock('../models/HireWorkspace', () => ({
  HireWorkspace: {
    findOneAndUpdate: (...args: unknown[]) => mockWorkspace.findOneAndUpdate(...args),
  },
}))
vi.mock('../services/hireWorkspaceWriteFence', () => ({
  withActiveHireWorkspaceWriteTransaction: (...args: unknown[]) => mockWriteFence(...args),
}))
vi.mock('../services/workspaceService', () => ({
  activeHireWorkspaceLifecycleFilter: () => ({
    $or: [{ lifecycleState: 'active' }, { lifecycleState: { $exists: false } }],
  }),
}))
vi.mock('../services/hireCandidatePrivacyWriteFence', () => ({
  claimHireCandidatePiiWriteFence: (...args: unknown[]) => mockCandidatePiiFence(...args),
  HireCandidatePiiTombstoneError: CandidatePiiTombstoneError,
}))

import {
  buildJobCloseRejectionEmail,
  buildJobCloseRejectionEmailFromSnapshot,
  resolveJobCloseRejectionEmailSnapshot,
} from '../emails/jobCloseRejectionEmail'
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

function privacyExists(value: unknown) {
  return { session: vi.fn().mockResolvedValue(value) }
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
  mockWorkspace.findOneAndUpdate.mockResolvedValue({ _id: WORKSPACE_ID })
  mockCandidatePiiFence.mockResolvedValue(undefined)
  mockPrivacy.exists.mockReturnValue(privacyExists(null))
  mockWriteFence.mockImplementation(
    async (_workspaceId: unknown, _memberId: unknown, work: (value: unknown) => unknown) =>
      work(session),
  )
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

  it('resolves only the fixed placeholders and escapes custom plain-text copy for HTML', () => {
    const snapshot = resolveJobCloseRejectionEmailSnapshot({
      candidateName: '<img src=x onerror=alert(1)> Person',
      jobTitle: '<script>Backend</script>',
      workspaceName: 'Acme\r\nBcc: attacker@example.com',
      template: {
        subject: '{workspace_name}: {candidate_first_name} — {job_title}',
        body: 'Hi {candidate_first_name},\n\n<script>unsafe</script> for {job_title}.',
      },
    })
    const email = buildJobCloseRejectionEmailFromSnapshot(snapshot)

    expect(snapshot.subject).toBe('Acme Bcc: attacker@example.com: <img — <script>Backend</script>')
    expect(snapshot.body).not.toContain('Hired Jane')
    expect(email.html).toContain('&lt;script&gt;unsafe&lt;/script&gt;')
    expect(email.html).not.toContain('<script>unsafe</script>')
    expect(email.html).not.toContain('<img')
    expect(email.text).toBe(snapshot.body)
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
      kind: 'job_close_rejection',
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
    expect(mockCandidatePiiFence).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      candidateId: 'e'.repeat(24),
      session,
    })
    expect(mockPrivacy.exists).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      candidateId: 'e'.repeat(24),
      live: true,
    })
    expect(mockSendEmail).toHaveBeenCalledWith({
      to: 'candidate@example.com',
      subject: 'Acme: update on your Backend Engineer application',
      html: expect.any(String),
      text: expect.any(String),
      idempotencyKey: 'hire-close-rejection:outbox-1',
      privacySafeLog: true,
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

  it('uses the immutable per-recipient snapshot rather than re-rendering a retry', async () => {
    const legacyPayload = outboxRow().payload
    const row = {
      ...outboxRow(),
      recipientName: 'Changed after close',
      payload: {
        ...legacyPayload,
        jobTitle: 'Changed after close',
        workspaceName: 'Changed workspace',
        emailSnapshot: {
          subject: 'Frozen subject for Candidate One',
          body: 'Hi Candidate One,\n\nWe recorded this <script>as text</script>.',
        },
      },
    }
    mockOutbox.findOne.mockReturnValue(outboxFindOne(row))
    mockOutbox.findOneAndUpdate.mockResolvedValue(row)
    mockSendEmail.mockResolvedValue({ ok: true, id: 'resend-1' })

    await expect(processNextHireEmail(WORKSPACE_ID, NOW)).resolves.toMatchObject({ outcome: 'sent' })

    expect(mockSendEmail).toHaveBeenCalledWith(expect.objectContaining({
      subject: 'Frozen subject for Candidate One',
      text: 'Hi Candidate One,\n\nWe recorded this <script>as text</script>.',
      html: expect.stringContaining('&lt;script&gt;as text&lt;/script&gt;'),
    }))
    expect(mockSendEmail.mock.calls[0][0].text).not.toContain('Hired Jane')
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

  it('does not contact the provider when privacy deletion wins after due-row selection and before egress authorization', async () => {
    // The worker has already read a due outbox row. Simulate verified privacy
    // deletion becoming live immediately before the in-transaction candidate
    // fence/claim, the only point at which a provider send is authorized.
    mockCandidatePiiFence.mockImplementation(async () => {
      mockPrivacy.exists.mockReturnValue(privacyExists({ _id: 'privacy-request-1' }))
    })

    await expect(processNextHireEmail(WORKSPACE_ID, NOW)).resolves.toEqual({
      processed: true,
      outboxId: 'outbox-1',
      outcome: 'cancelled',
    })

    expect(mockCandidatePiiFence).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      candidateId: 'e'.repeat(24),
      session,
    })
    expect(mockPrivacy.exists).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      candidateId: 'e'.repeat(24),
      live: true,
    })
    expect(mockOutbox.findOneAndUpdate).not.toHaveBeenCalled()
    expect(mockSendEmail).not.toHaveBeenCalled()
  })

  it('does not contact the provider when the candidate PII fence is already tombstoned', async () => {
    mockCandidatePiiFence.mockRejectedValue(new CandidatePiiTombstoneError())

    await expect(processNextHireEmail(WORKSPACE_ID, NOW)).resolves.toEqual({
      processed: true,
      outboxId: 'outbox-1',
      outcome: 'cancelled',
    })

    expect(mockOutbox.findOneAndUpdate).not.toHaveBeenCalled()
    expect(mockPrivacy.exists).not.toHaveBeenCalled()
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
