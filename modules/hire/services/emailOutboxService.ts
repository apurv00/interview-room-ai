import { randomUUID } from 'crypto'
import { sendEmail } from '@shared/services/emailService'
import { NotFoundError } from '@shared/errors'
import { HireEmailOutbox } from '../models/HireEmailOutbox'
import { HireJob } from '../models/HireJob'
import { buildJobCloseRejectionEmail } from '../emails/jobCloseRejectionEmail'
import { connectHireControlDB } from './hireControlBoundary'
import { withActiveHireWorkspaceWriteTransaction } from './hireWorkspaceWriteFence'
import type { MembershipContext } from './workspaceService'
import { listHireWorkspaceIdsForSweep } from './workspaceSweepService'

export const HIRE_EMAIL_MAX_ATTEMPTS = 5
const CLAIM_LEASE_MS = 5 * 60_000

export interface HireEmailProcessResult {
  processed: boolean
  outboxId?: string
  outcome?: 'sent' | 'retry_scheduled' | 'failed'
}

export interface HireJobEmailDeliveryFailure {
  recipientEmail: string
  recipientName: string
  attempts: number
  lastError: string | null
  failedAt: Date
}

export interface HireJobEmailDeliverySummary {
  total: number
  pending: number
  sending: number
  sent: number
  failed: number
  failures: HireJobEmailDeliveryFailure[]
}

/**
 * Member-facing delivery state for one job. Both the existence check and the
 * outbox read are workspace-scoped so a guessed job id cannot disclose
 * recipients or even whether another tenant has delivery failures.
 */
export async function getJobCloseEmailDelivery(
  ctx: MembershipContext,
  jobId: string,
): Promise<HireJobEmailDeliverySummary> {
  await connectHireControlDB()
  const [jobExists, rows] = await Promise.all([
    HireJob.exists({ _id: jobId, workspaceId: ctx.workspace._id }),
    HireEmailOutbox.find({
      workspaceId: ctx.workspace._id,
      jobId,
      kind: 'job_close_rejection',
    })
      .select('recipientEmail recipientName status attempts lastError updatedAt')
      .sort({ createdAt: 1, _id: 1 }),
  ])
  if (!jobExists) throw new NotFoundError('Job')

  const summary: HireJobEmailDeliverySummary = {
    total: rows.length,
    pending: 0,
    sending: 0,
    sent: 0,
    failed: 0,
    failures: [],
  }
  for (const row of rows) {
    summary[row.status] += 1
    if (row.status === 'failed') {
      summary.failures.push({
        recipientEmail: row.recipientEmail,
        recipientName: row.recipientName,
        attempts: row.attempts,
        lastError: row.lastError ?? null,
        failedAt: row.updatedAt,
      })
    }
  }
  return summary
}

/**
 * Requeue only terminal failures for a single workspace/job. The original
 * outbox ids are retained, so the provider idempotency key remains stable
 * across automatic and manual delivery attempts. Active leases are never
 * disturbed because `sending` rows do not match this update.
 */
export async function retryFailedJobCloseEmails(
  ctx: MembershipContext,
  jobId: string,
  now = new Date(),
): Promise<{ requeued: number }> {
  return withActiveHireWorkspaceWriteTransaction(
    ctx.workspace._id,
    ctx.membership._id,
    async (session) => {
      const jobExists = await HireJob.exists({
        _id: jobId,
        workspaceId: ctx.workspace._id,
      }).session(session)
      if (!jobExists) throw new NotFoundError('Job')

      const result = await HireEmailOutbox.updateMany(
        {
          workspaceId: ctx.workspace._id,
          jobId,
          kind: 'job_close_rejection',
          status: 'failed',
        },
        {
          $set: {
            status: 'pending',
            attempts: 0,
            sendAfter: now,
            lastManualRetryAt: now,
            lastManualRetryByMemberId: ctx.membership._id,
            lastManualRetryByName: ctx.membership.name || ctx.membership.email,
          },
          $inc: { manualRetryCount: 1 },
          $unset: { claimToken: 1, leaseExpiresAt: 1 },
        },
        { session },
      )
      return { requeued: result.modifiedCount }
    },
  )
}

function nextRetryAt(now: Date, attempts: number): Date {
  const delayMs = Math.min(60 * 60_000, 2 ** Math.max(0, attempts - 1) * 60_000)
  return new Date(now.getTime() + delayMs)
}

/**
 * Claim and deliver one due message. The lease recovers a worker crash; the
 * provider idempotency key covers a retry after Resend accepted the email but
 * before Mongo recorded `sent`.
 */
export async function processNextHireEmail(
  workspaceId: string,
  now = new Date(),
): Promise<HireEmailProcessResult> {
  await connectHireControlDB()
  const claimToken = randomUUID()
  const row = await HireEmailOutbox.findOneAndUpdate(
    {
      workspaceId,
      attempts: { $lt: HIRE_EMAIL_MAX_ATTEMPTS },
      sendAfter: { $lte: now },
      $or: [
        { status: 'pending' },
        { status: 'sending', leaseExpiresAt: { $lte: now } },
      ],
    },
    {
      $set: {
        status: 'sending',
        claimToken,
        leaseExpiresAt: new Date(now.getTime() + CLAIM_LEASE_MS),
      },
      $inc: { attempts: 1 },
    },
    { new: true, sort: { sendAfter: 1, _id: 1 } },
  )
  if (!row) return { processed: false }

  const template = buildJobCloseRejectionEmail({
    candidateName: row.recipientName,
    jobTitle: row.payload.jobTitle,
    workspaceName: row.payload.workspaceName,
  })
  const sent = await sendEmail({
    to: row.recipientEmail,
    subject: template.subject,
    html: template.html,
    text: template.text,
    idempotencyKey: `hire-close-rejection:${row._id.toString()}`,
  })

  if (sent.ok) {
    const recorded = await HireEmailOutbox.updateOne(
      { _id: row._id, workspaceId, status: 'sending', claimToken },
      {
        $set: {
          status: 'sent',
          sentAt: now,
          ...(sent.id ? { providerMessageId: sent.id } : {}),
        },
        $unset: { claimToken: 1, leaseExpiresAt: 1, lastError: 1 },
      },
    )
    if (recorded.matchedCount !== 1) {
      throw new Error('Hire email was accepted but its outbox lease was lost')
    }
    return { processed: true, outboxId: row._id.toString(), outcome: 'sent' }
  }

  const terminal = row.attempts >= HIRE_EMAIL_MAX_ATTEMPTS
  const recorded = await HireEmailOutbox.updateOne(
    { _id: row._id, workspaceId, status: 'sending', claimToken },
    {
      $set: {
        status: terminal ? 'failed' : 'pending',
        lastError: 'Transactional email provider did not accept the message',
        ...(terminal ? {} : { sendAfter: nextRetryAt(now, row.attempts) }),
      },
      $unset: { claimToken: 1, leaseExpiresAt: 1 },
    },
  )
  if (recorded.matchedCount !== 1) {
    throw new Error('Hire email failure could not be recorded because its outbox lease was lost')
  }
  return {
    processed: true,
    outboxId: row._id.toString(),
    outcome: terminal ? 'failed' : 'retry_scheduled',
  }
}

/** Round-robin, tenant-scoped drain used by the control-plane scheduler. */
export async function processDueHireEmailsAcrossWorkspaces(
  maxMessages = 20,
  now = new Date(),
): Promise<{ processed: number; failed: number; workspaces: number }> {
  const workspaceIds = await listHireWorkspaceIdsForSweep()
  const active = new Set(workspaceIds)
  let processed = 0
  let failed = 0
  while (processed < maxMessages && active.size > 0) {
    for (const workspaceId of Array.from(active)) {
      if (processed >= maxMessages) break
      const result = await processNextHireEmail(workspaceId, now)
      if (!result.processed) {
        active.delete(workspaceId)
        continue
      }
      processed += 1
      if (result.outcome === 'failed') failed += 1
    }
  }
  return { processed, failed, workspaces: workspaceIds.length }
}
