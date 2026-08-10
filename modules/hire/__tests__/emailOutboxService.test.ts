import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  mockOutbox,
  mockJob,
  mockWriteFence,
  mockSendEmail,
  mockConnectHireControlDB,
  mockWorkspaceIds,
  session,
} = vi.hoisted(() => ({
  mockOutbox: {
    find: vi.fn(),
    findOneAndUpdate: vi.fn(),
    updateMany: vi.fn(),
    updateOne: vi.fn(),
  },
  mockJob: { exists: vi.fn() },
  mockWriteFence: vi.fn(),
  mockSendEmail: vi.fn(),
  mockConnectHireControlDB: vi.fn(),
  mockWorkspaceIds: vi.fn(),
  session: { id: 'session-1' },
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
    findOneAndUpdate: (...args: unknown[]) => mockOutbox.findOneAndUpdate(...args),
    updateMany: (...args: unknown[]) => mockOutbox.updateMany(...args),
    updateOne: (...args: unknown[]) => mockOutbox.updateOne(...args),
  },
}))
vi.mock('../models/HireJob', () => ({
  HireJob: { exists: (...args: unknown[]) => mockJob.exists(...args) },
}))
vi.mock('../services/hireWorkspaceWriteFence', () => ({
  withActiveHireWorkspaceWriteTransaction: (...args: unknown[]) => mockWriteFence(...args),
}))

import { buildJobCloseRejectionEmail } from '../emails/jobCloseRejectionEmail'
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

function outboxRow(attempts = 1) {
  return {
    _id: { toString: () => 'outbox-1' },
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
  mockConnectHireControlDB.mockResolvedValue(undefined)
  mockWorkspaceIds.mockResolvedValue([WORKSPACE_ID])
  mockJob.exists.mockResolvedValue({ _id: JOB_ID })
  mockOutbox.find.mockReturnValue(outboxFind([]))
  mockOutbox.updateMany.mockResolvedValue({ modifiedCount: 0 })
  mockOutbox.updateOne.mockResolvedValue({ matchedCount: 1 })
  mockWriteFence.mockImplementation(
    async (_workspaceId: unknown, _memberId: unknown, work: (value: unknown) => unknown) =>
      work(session),
  )
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

describe('processNextHireEmail', () => {
  it('returns without a provider call when no due row can be claimed', async () => {
    mockOutbox.findOneAndUpdate.mockResolvedValue(null)
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

  it('drains each workspace through a scoped claim and continues after an idle tenant', async () => {
    const otherWorkspace = 'b'.repeat(24)
    mockWorkspaceIds.mockResolvedValue([WORKSPACE_ID, otherWorkspace])
    mockOutbox.findOneAndUpdate
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(outboxRow())
      .mockResolvedValueOnce(null)
    mockSendEmail.mockResolvedValue({ ok: true, id: 'resend-1' })

    await expect(processDueHireEmailsAcrossWorkspaces(5, NOW)).resolves.toEqual({
      processed: 1,
      failed: 0,
      workspaces: 2,
    })
    expect(mockOutbox.findOneAndUpdate.mock.calls.map(([filter]) => filter.workspaceId)).toEqual([
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
