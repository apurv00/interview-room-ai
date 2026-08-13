import { randomUUID } from 'crypto'
import mongoose from 'mongoose'
import type { IHireEmailOutbox } from '../models/HireEmailOutbox'
import { sendEmail } from '@shared/services/emailService'
import { NotFoundError } from '@shared/errors'
import { HireEmailOutbox } from '../models/HireEmailOutbox'
import { HireJob } from '../models/HireJob'
import { HireCandidate } from '../models/HireCandidate'
import { HirePrivacyRequest } from '../models/HirePrivacyRequest'
import { HireReengagementOptOut } from '../models/HireReengagementOptOut'
import { HireWorkspace } from '../models/HireWorkspace'
import { buildJobCloseRejectionEmail } from '../emails/jobCloseRejectionEmail'
import { buildJobReengagementEmail } from '../emails/jobReengagementEmail'
import { connectHireControlDB } from './hireControlBoundary'
import { buildHireReengagementOptOutUrl } from './reengagementOptOutService'
import { withActiveHireWorkspaceWriteTransaction } from './hireWorkspaceWriteFence'
import {
  claimHireCandidatePiiWriteFence,
  HireCandidatePiiTombstoneError,
} from './hireCandidatePrivacyWriteFence'
import {
  activeHireWorkspaceLifecycleFilter,
  type MembershipContext,
} from './workspaceService'
import { listHireWorkspaceIdsForSweep } from './workspaceSweepService'

export const HIRE_EMAIL_MAX_ATTEMPTS = 5
const CLAIM_LEASE_MS = 5 * 60_000

export interface HireEmailProcessResult {
  processed: boolean
  outboxId?: string
  outcome?: 'sent' | 'retry_scheduled' | 'failed' | 'cancelled'
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
    // `cancelled` is used only by talent-pool re-engagement mail and is not
    // included in this close-email delivery summary. Keep this defensive
    // branch so a legacy/misfiled row cannot corrupt numeric counters.
    if (row.status === 'cancelled') continue
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

interface ReengagementRecipient {
  name: string
  email: string
}

interface AuthorizedReengagementDelivery {
  row: IHireEmailOutbox
  recipient: ReengagementRecipient
}

function dueHireEmailFilter(workspaceId: string, now: Date) {
  return {
    workspaceId,
    attempts: { $lt: HIRE_EMAIL_MAX_ATTEMPTS },
    sendAfter: { $lte: now },
    $or: [
      { status: 'pending' },
      { status: 'sending', leaseExpiresAt: { $lte: now } },
    ],
  }
}

/**
 * Workspace lifecycle is the egress authority for every Hire email kind.
 * This must write, rather than merely read, the root row. That serializes a
 * committed provider authorization with workspace deletion on the same
 * document. Either authorization commits while active or deletion wins and
 * the worker retries against the tombstone.
 */
async function claimActiveHireWorkspaceEmailEgressFence(input: {
  workspaceId: string
  session: mongoose.ClientSession
}): Promise<boolean> {
  const workspace = await HireWorkspace.findOneAndUpdate(
    {
      _id: input.workspaceId,
      ...activeHireWorkspaceLifecycleFilter(),
    },
    { $inc: { writeFenceVersion: 1 } },
    { new: false, session: input.session },
  )
  return Boolean(workspace)
}

/**
 * The deletion transaction cancels all non-terminal rows. This is an exact,
 * session-bound fallback for a row selected before a worker observes that the
 * workspace is already deletion_pending.
 */
async function cancelDueEmailForWorkspaceDeletion(input: {
  row: IHireEmailOutbox
  workspaceId: string
  now: Date
  session: mongoose.ClientSession
}): Promise<void> {
  await HireEmailOutbox.updateOne(
    {
      ...dueHireEmailFilter(input.workspaceId, input.now),
      _id: input.row._id,
      jobId: input.row.jobId,
      applicationId: input.row.applicationId,
      candidateId: input.row.candidateId,
      kind: input.row.kind,
    },
    {
      $set: {
        status: 'cancelled',
        lastError: 'Workspace scheduled for deletion',
      },
      $unset: { claimToken: 1, leaseExpiresAt: 1 },
    },
    { session: input.session },
  )
}

/**
 * This transaction creates the authorization boundary immediately before the
 * provider call. The scheduler can read a due re-engagement row first, but
 * only this candidate-fenced transaction may turn it into `sending`.
 *
 * `sending + claimToken` is durable authorization state. It is written under
 * the same candidate-row fence used by verified privacy deletion and opt-out.
 * If either action wins first, this returns null and no provider egress occurs.
 * If this transaction wins, the provider egress was authorized before that
 * later action; its cleanup removes/cancels every recovery path so the worker
 * can never retry it after the candidate's change takes effect.
 */
async function authorizeReengagementEgress(input: {
  row: IHireEmailOutbox
  workspaceId: string
  claimToken: string
  now: Date
}): Promise<AuthorizedReengagementDelivery | null> {
  const { row, workspaceId, claimToken, now } = input
  const session = await mongoose.startSession()
  try {
    let authorizedDelivery: AuthorizedReengagementDelivery | null = null
    await session.withTransaction(async () => {
      // `withTransaction` may rerun this callback on a transient conflict.
      // Never carry an authorization produced by a failed/retried attempt to
      // the final callback outcome.
      authorizedDelivery = null
      const workspaceActive = await claimActiveHireWorkspaceEmailEgressFence({
        workspaceId,
        session,
      })
      if (!workspaceActive) {
        await cancelDueEmailForWorkspaceDeletion({
          row,
          workspaceId,
          now,
          session,
        })
        return
      }
      const scope = {
        workspaceId,
        candidateId: row.candidateId,
      }

      try {
        await claimHireCandidatePiiWriteFence({ ...scope, session })
      } catch (error) {
        if (!(error instanceof HireCandidatePiiTombstoneError)) throw error
        await cancelDueReengagement({
          row,
          workspaceId,
          now,
          reason: 'Candidate data is unavailable for talent-pool re-engagement',
          session,
        })
        return
      }

      // Keep these session-bound operations sequential. Mongoose transactions
      // explicitly prohibit Promise.all/parallel operations on one session.
      const candidate = (await HireCandidate.findOne({
        _id: row.candidateId,
        workspaceId,
        piiAnonymizedAt: { $exists: false },
      })
        .select('name email')
        .session(session)
        .lean()) as ReengagementRecipient | null
      const privacyPending = await HirePrivacyRequest.exists({
        ...scope,
        live: true,
        status: { $in: ['pending_verification', 'processing'] },
      }).session(session)
      const optedOut = await HireReengagementOptOut.exists(scope).session(session)

      if (!candidate || privacyPending || optedOut) {
        await cancelDueReengagement({
          row,
          workspaceId,
          now,
          reason: optedOut
            ? 'Candidate opted out of talent-pool re-engagement'
            : 'Candidate data is unavailable for talent-pool re-engagement',
          session,
        })
        return
      }

      // This exact lease claim is the egress authorization. It must be both
      // due and currently unclaimed/expired at commit time; a stale worker
      // cannot reach the provider.
      const authorized = await HireEmailOutbox.findOneAndUpdate(
        {
          ...dueHireEmailFilter(workspaceId, now),
          _id: row._id,
          jobId: row.jobId,
          applicationId: row.applicationId,
          candidateId: row.candidateId,
          kind: 'job_reengagement',
        },
        {
          $set: {
            status: 'sending',
            claimToken,
            leaseExpiresAt: new Date(now.getTime() + CLAIM_LEASE_MS),
          },
          $inc: { attempts: 1 },
        },
        { new: true, session },
      )
      if (!authorized) return
      authorizedDelivery = { row: authorized, recipient: candidate }
    })
    return authorizedDelivery
  } finally {
    await session.endSession()
  }
}

async function cancelDueReengagement(input: {
  row: IHireEmailOutbox
  workspaceId: string
  now: Date
  reason: string
  session: mongoose.ClientSession
}): Promise<void> {
  await HireEmailOutbox.updateOne(
    {
      ...dueHireEmailFilter(input.workspaceId, input.now),
      _id: input.row._id,
      jobId: input.row.jobId,
      applicationId: input.row.applicationId,
      candidateId: input.row.candidateId,
      kind: 'job_reengagement',
    },
    {
      $set: {
        status: 'cancelled',
        lastError: input.reason,
      },
      $unset: { claimToken: 1, leaseExpiresAt: 1 },
    },
    { session: input.session },
  )
}

async function cancelClaimedReengagement(input: {
  row: IHireEmailOutbox
  workspaceId: string
  claimToken: string
  reason: string
  session: mongoose.ClientSession
}): Promise<void> {
  await HireEmailOutbox.updateOne(
    {
      _id: input.row._id,
      workspaceId: input.workspaceId,
      jobId: input.row.jobId,
      applicationId: input.row.applicationId,
      candidateId: input.row.candidateId,
      kind: 'job_reengagement',
      status: 'sending',
      claimToken: input.claimToken,
    },
    {
      $set: { status: 'cancelled', lastError: input.reason },
      $unset: { claimToken: 1, leaseExpiresAt: 1 },
    },
    { session: input.session },
  )
}

/**
 * Close-rejection mail has no candidate-record read at egress, but it shares
 * the same workspace lifecycle authority as every other Hire email.
 */
async function authorizeJobCloseRejectionEgress(input: {
  row: IHireEmailOutbox
  workspaceId: string
  claimToken: string
  now: Date
}): Promise<IHireEmailOutbox | null> {
  const { row, workspaceId, claimToken, now } = input
  const session = await mongoose.startSession()
  try {
    let authorized: IHireEmailOutbox | null = null
    await session.withTransaction(async () => {
      // A transaction callback may retry. Only its final exact outbox claim
      // is a valid provider authorization.
      authorized = null
      const workspaceActive = await claimActiveHireWorkspaceEmailEgressFence({
        workspaceId,
        session,
      })
      if (!workspaceActive) {
        await cancelDueEmailForWorkspaceDeletion({
          row,
          workspaceId,
          now,
          session,
        })
        return
      }

      authorized = await HireEmailOutbox.findOneAndUpdate(
        {
          ...dueHireEmailFilter(workspaceId, now),
          _id: row._id,
          jobId: row.jobId,
          applicationId: row.applicationId,
          candidateId: row.candidateId,
          kind: 'job_close_rejection',
        },
        {
          $set: {
            status: 'sending',
            claimToken,
            leaseExpiresAt: new Date(now.getTime() + CLAIM_LEASE_MS),
          },
          $inc: { attempts: 1 },
        },
        { new: true, session },
      )
    })
    return authorized
  } finally {
    await session.endSession()
  }
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
  // Choosing a re-engagement row is deliberately read-only. Its only worker
  // claim is made below inside the candidate-fenced authorization transaction.
  const dueRow = await HireEmailOutbox.findOne(dueHireEmailFilter(workspaceId, now)).sort({
    sendAfter: 1,
    _id: 1,
  })
  if (!dueRow) return { processed: false }

  const claimToken = randomUUID()
  if (dueRow.kind === 'job_reengagement') {
    const authorized = await authorizeReengagementEgress({
      row: dueRow,
      workspaceId,
      claimToken,
      now,
    })
    if (!authorized) {
      return { processed: true, outboxId: dueRow._id.toString(), outcome: 'cancelled' }
    }
    const { row, recipient } = authorized

    const optOutUrl = buildHireReengagementOptOutUrl({
      workspaceId: workspaceId.toString(),
      candidateId: row.candidateId.toString(),
      outboxId: row._id.toString(),
      now,
    })
    const template = buildJobReengagementEmail({
      candidateName: recipient.name,
      jobTitle: row.payload.jobTitle,
      workspaceName: row.payload.workspaceName,
      optOutUrl,
    })
    const sent = await sendEmail({
      to: recipient.email,
      subject: template.subject,
      html: template.html,
      text: template.text,
      idempotencyKey: `hire-reengagement:${row._id.toString()}`,
      headers: {
        'List-Unsubscribe': `<${optOutUrl}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
    })
    return recordHireEmailDelivery({ row, workspaceId, claimToken, now, sent })
  }

  const row = await authorizeJobCloseRejectionEgress({
    row: dueRow,
    workspaceId,
    claimToken,
    now,
  })
  if (!row) {
    return { processed: true, outboxId: dueRow._id.toString(), outcome: 'cancelled' }
  }

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

  return recordHireEmailDelivery({ row, workspaceId, claimToken, now, sent })
}

async function recordHireEmailDelivery(input: {
  row: IHireEmailOutbox
  workspaceId: string
  claimToken: string
  now: Date
  sent: Awaited<ReturnType<typeof sendEmail>>
}): Promise<HireEmailProcessResult> {
  const { row, workspaceId, claimToken, now, sent } = input
  if (!row) throw new Error('Cannot record an empty Hire email outbox row')

  if (row.kind === 'job_reengagement') {
    return recordReengagementEmailDelivery(input)
  }

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

/**
 * A re-engagement message may be retried only if the candidate remains
 * eligible after a provider rejection. The second candidate-fenced
 * transaction makes opt-out/deletion linearizable with requeueing: either the
 * settlement wins and a later opt-out cancels the newly pending row, or the
 * opt-out/deletion wins and this row is cancelled/deleted instead of retried.
 */
async function recordReengagementEmailDelivery(input: {
  row: IHireEmailOutbox
  workspaceId: string
  claimToken: string
  now: Date
  sent: Awaited<ReturnType<typeof sendEmail>>
}): Promise<HireEmailProcessResult> {
  const { row, workspaceId, claimToken, now, sent } = input
  if (sent.ok) {
    const recorded = await HireEmailOutbox.updateOne(
      {
        _id: row._id,
        workspaceId,
        candidateId: row.candidateId,
        kind: 'job_reengagement',
        status: 'sending',
        claimToken,
      },
      {
        $set: {
          status: 'sent',
          sentAt: now,
          ...(sent.id ? { providerMessageId: sent.id } : {}),
        },
        $unset: { claimToken: 1, leaseExpiresAt: 1, lastError: 1 },
      },
    )
    // A verified deletion can remove the row after its committed egress
    // authorization but before this bookkeeping write. The provider call was
    // pre-deletion authorized; returning cancelled rather than throwing keeps
    // the deleted row from becoming an accidental recovery/retry path.
    if (recorded.matchedCount !== 1) {
      return { processed: true, outboxId: row._id.toString(), outcome: 'cancelled' }
    }
    return { processed: true, outboxId: row._id.toString(), outcome: 'sent' }
  }

  const session = await mongoose.startSession()
  try {
    let outcome: HireEmailProcessResult['outcome'] = 'cancelled'
    await session.withTransaction(async () => {
      // As above, reset between automatic transaction retries so a prior
      // attempt cannot leak a retry outcome past a later opt-out/deletion.
      outcome = 'cancelled'
      const scope = { workspaceId, candidateId: row.candidateId }
      try {
        await claimHireCandidatePiiWriteFence({ ...scope, session })
      } catch (error) {
        if (!(error instanceof HireCandidatePiiTombstoneError)) throw error
        await cancelClaimedReengagement({
          row,
          workspaceId,
          claimToken,
          reason: 'Candidate data is unavailable for talent-pool re-engagement',
          session,
        })
        return
      }

      const privacyPending = await HirePrivacyRequest.exists({
        ...scope,
        live: true,
        status: { $in: ['pending_verification', 'processing'] },
      }).session(session)
      const optedOut = await HireReengagementOptOut.exists(scope).session(session)
      if (privacyPending || optedOut) {
        await cancelClaimedReengagement({
          row,
          workspaceId,
          claimToken,
          reason: optedOut
            ? 'Candidate opted out of talent-pool re-engagement'
            : 'Candidate data is unavailable for talent-pool re-engagement',
          session,
        })
        return
      }

      const terminal = row.attempts >= HIRE_EMAIL_MAX_ATTEMPTS
      const recorded = await HireEmailOutbox.updateOne(
        {
          _id: row._id,
          workspaceId,
          candidateId: row.candidateId,
          kind: 'job_reengagement',
          status: 'sending',
          claimToken,
        },
        {
          $set: {
            status: terminal ? 'failed' : 'pending',
            lastError: 'Transactional email provider did not accept the message',
            ...(terminal ? {} : { sendAfter: nextRetryAt(now, row.attempts) }),
          },
          $unset: { claimToken: 1, leaseExpiresAt: 1 },
        },
        { session },
      )
      if (recorded.matchedCount !== 1) return
      outcome = terminal ? 'failed' : 'retry_scheduled'
    })
    return { processed: true, outboxId: row._id.toString(), outcome }
  } finally {
    await session.endSession()
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
