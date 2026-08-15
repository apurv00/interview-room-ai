import { randomUUID } from 'node:crypto'
import mongoose from 'mongoose'
import { AppError, NotFoundError } from '@shared/errors'
import { logger } from '@shared/logger'
import { inngest } from '@shared/services/inngest'
import {
  HireAiInviteDelivery,
  HireApplication,
  HireCandidate,
  HireInvitationBatch,
  HireInvitationBatchItem,
  HireJob,
  HirePrivacyRequest,
  HireRound,
  HireScreeningGate,
  HireWorkspace,
  HireWorkspaceMember,
  TERMINAL_STAGES,
  type IHireAiInviteDelivery,
  type IHireInvitationBatchItem,
  type IHireRound,
} from '../models'
import { sendAiRound } from './aiRoundService'
import { deliverAiInvite } from './aiInviteDeliveryService'
import { connectHireControlDB } from './hireControlBoundary'
import { withActiveHireWorkspaceWriteTransaction } from './hireWorkspaceWriteFence'
import { claimHireCandidatePiiWriteFence } from './hireCandidatePrivacyWriteFence'
import {
  activeHireWorkspaceLifecycleFilter,
  type MembershipContext,
} from './workspaceService'
import {
  assertHireOnboardingTestDriveWriteIsolation,
  isHireOnboardingTestDriveCoordinate,
} from '@hire-onboarding-boundary'

const OBJECT_ID = /^[a-f0-9]{24}$/i
const ITEM_CLAIM_LEASE_MS = 5 * 60_000
/** Keep manual recovery aligned with the deterministic initial-wave cadence. */
const SCREENING_INVITATION_RETRY_STAGGER_MS = 60_000
export const HIRE_SCREENING_INVITATION_MAX_ATTEMPTS = 5
export const HIRE_SCREENING_INVITATION_RECOVERY_LIMIT_PER_WORKSPACE = 10
export const HIRE_SCREENING_WATERFALL_MAX_COUNT = 100

/**
 * Screening gates deliberately use one fixed interview profile for now. The
 * gate freezes who may be invited; it does not silently expose a second
 * recruiter configuration surface. A later product decision can snapshot
 * these fields on the batch without changing durable delivery semantics.
 */
const SCREENING_AI_ROUND_INPUT = {
  experience: '3-6' as const,
  duration: 15 as const,
}

type DispatchOutcome =
  | { outcome: 'sent'; itemId: string; roundId: string }
  | { outcome: 'retry_scheduled'; itemId: string; roundId?: string }
  | { outcome: 'failed'; itemId: string; roundId?: string }
  | { outcome: 'skipped'; itemId: string; reason?: string }

interface ClaimedItem {
  item: IHireInvitationBatchItem
  claimToken: string
}

/**
 * A privacy-redacted item intentionally remains as a non-identifying
 * operational aggregate. Only this narrowed shape may reach a round or
 * encrypted-delivery lookup, so a future helper cannot accidentally turn a
 * redacted row back into a candidate-addressable dispatch.
 */
type DispatchableInvitationItem = IHireInvitationBatchItem & {
  applicationId: mongoose.Types.ObjectId
  candidateId: mongoose.Types.ObjectId
  privacyRedactedAt?: undefined
}

interface DispatchContext {
  ctx: MembershipContext
}

interface DeliveryAttempt {
  round: IHireRound
  delivery: IHireAiInviteDelivery | null
}

function requireObjectId(value: string, label: string): mongoose.Types.ObjectId {
  if (!OBJECT_ID.test(value)) {
    throw new AppError(`Invalid ${label}`, 400, 'INVALID_ID')
  }
  return new mongoose.Types.ObjectId(value)
}

function sameId(
  left: mongoose.Types.ObjectId | string | undefined,
  right: mongoose.Types.ObjectId | string | undefined,
): boolean {
  return Boolean(left && right && left.toString() === right.toString())
}

function isDispatchableInvitationItem(
  item: IHireInvitationBatchItem,
): item is DispatchableInvitationItem {
  return !item.privacyRedactedAt && Boolean(item.applicationId && item.candidateId)
}

function compactError(error: unknown): string {
  return error instanceof Error
    ? error.message.slice(0, 500)
    : 'Screening invitation delivery failed unexpectedly'
}

function isDuplicateKey(error: unknown): boolean {
  return !!error && typeof error === 'object' && (error as { code?: number }).code === 11000
}

function nextRetryAt(now: Date, attempts: number): Date {
  const delayMs = Math.min(60 * 60_000, 2 ** Math.max(0, attempts - 1) * 60_000)
  return new Date(now.getTime() + delayMs)
}

function roundIsDeliverable(round: IHireRound, now: Date): boolean {
  return (
    !round.revokedAt &&
    round.status !== 'revoked' &&
    round.status !== 'completed' &&
    round.inviteTokenExpiry > now
  )
}

function terminalRoundReason(error: unknown): string | null {
  if (!(error instanceof AppError)) return null
  if (error.code === 'ROUND_NOT_ACTIVE' || error.code === 'ROUND_EXPIRED') {
    return 'The linked AI interview is no longer active'
  }
  if (error.code === 'JOB_NOT_OPEN') return 'The job closed before this invitation was sent'
  if (error.code === 'MEMBER_REMOVED') return 'The confirming workspace member is no longer active'
  if (error.code === 'WORKSPACE_DELETION_PENDING') {
    return 'The workspace is scheduled for deletion'
  }
  if (error.code === 'HIRE_CANDIDATE_PII_TOMBSTONED') {
    return 'Candidate personal data was deleted before invitation delivery'
  }
  if (error.code === 'APPLICATION_NOT_ELIGIBLE') {
    return 'The application is no longer eligible for screening'
  }
  return null
}

/** Immediate low-latency kick. Mongo remains the source of truth for recovery. */
async function emitScreeningInvitationRequested(input: {
  workspaceId: string
  itemId: string
}): Promise<void> {
  await inngest.send({
    name: 'hire/screening-invitation.requested',
    data: input,
  })
}

/** IDs only — no candidate contact data travels through Inngest. */
export async function dispatchHireScreeningInvitationItem(input: {
  workspaceId: string
  itemId: string
}): Promise<void> {
  requireObjectId(input.workspaceId, 'workspace id')
  requireObjectId(input.itemId, 'screening invitation item id')
  await emitScreeningInvitationRequested(input)
}

/**
 * List a bounded, stable page of due work in one exact tenant. The recovery
 * scheduler loops tenants, so one large workspace cannot starve another.
 */
export async function listDueHireScreeningInvitationItemIds(input: {
  workspaceId: string
  limit?: number
  now?: Date
}): Promise<string[]> {
  await connectHireControlDB()
  const workspaceId = requireObjectId(input.workspaceId, 'workspace id')
  const now = input.now ?? new Date()
  const limit = Math.min(
    Math.max(1, input.limit ?? HIRE_SCREENING_INVITATION_RECOVERY_LIMIT_PER_WORKSPACE),
    HIRE_SCREENING_INVITATION_RECOVERY_LIMIT_PER_WORKSPACE,
  )
  const items = await HireInvitationBatchItem.find({
    workspaceId,
    privacyRedactedAt: { $exists: false },
    $or: [
      {
        status: 'pending',
        attempts: { $lt: HIRE_SCREENING_INVITATION_MAX_ATTEMPTS },
        sendAfter: { $lte: now },
      },
      {
        status: 'sending',
        $or: [
          { leaseExpiresAt: { $lte: now } },
          { leaseExpiresAt: { $exists: false } },
        ],
      },
    ],
  })
    .sort({ sendAfter: 1, _id: 1 })
    .limit(limit)
    .select('_id')
    .lean()
  return items.map((item) => item._id.toString())
}

async function claimInvitationItem(input: {
  workspaceId: mongoose.Types.ObjectId
  itemId: mongoose.Types.ObjectId
  now: Date
}): Promise<ClaimedItem | null> {
  const claimToken = randomUUID()
  const item = await HireInvitationBatchItem.findOneAndUpdate(
    {
      _id: input.itemId,
      workspaceId: input.workspaceId,
      privacyRedactedAt: { $exists: false },
      $or: [
        {
          status: 'pending',
          attempts: { $lt: HIRE_SCREENING_INVITATION_MAX_ATTEMPTS },
          sendAfter: { $lte: input.now },
        },
        {
          status: 'sending',
          $or: [
            { leaseExpiresAt: { $lte: input.now } },
            { leaseExpiresAt: { $exists: false } },
          ],
        },
      ],
    },
    {
      $set: {
        status: 'sending',
        claimToken,
        leaseExpiresAt: new Date(input.now.getTime() + ITEM_CLAIM_LEASE_MS),
      },
      $inc: { attempts: 1 },
      $unset: { skipReason: 1, skippedAt: 1 },
    },
    { new: true },
  )
  return item ? { item, claimToken } : null
}

async function refreshInvitationBatch(input: {
  workspaceId: mongoose.Types.ObjectId
  batchId: mongoose.Types.ObjectId
  now: Date
}): Promise<void> {
  const items = await HireInvitationBatchItem.find({
    workspaceId: input.workspaceId,
    invitationBatchId: input.batchId,
  })
    .select('status lastError')
    .lean()

  const sentCount = items.filter((item) => item.status === 'sent').length
  const failedItems = items.filter((item) => item.status === 'failed')
  const failedCount = failedItems.length
  const pending = items.some((item) => item.status === 'pending')
  const sending = items.some((item) => item.status === 'sending')

  const status = sending
    ? 'dispatching'
    : pending
      ? 'scheduled'
      : failedCount > 0
        ? 'failed'
        : 'completed'
  const update = {
    $set: {
      status,
      sentCount,
      failedCount,
      ...(status === 'completed' ? { completedAt: input.now } : {}),
      ...(status === 'failed'
        ? { lastError: failedItems[0]?.lastError ?? 'One or more invitations failed' }
        : {}),
    },
    $unset: {
      ...(status !== 'completed' ? { completedAt: 1 } : {}),
      ...(status !== 'failed' ? { lastError: 1 } : {}),
    },
  }
  await HireInvitationBatch.updateOne(
    {
      _id: input.batchId,
      workspaceId: input.workspaceId,
      status: { $ne: 'cancelled' },
    },
    update,
  )
}

async function markItemSkipped(input: {
  item: IHireInvitationBatchItem
  claimToken: string
  now: Date
  reason: string
}): Promise<boolean> {
  const changed = await HireInvitationBatchItem.updateOne(
    {
      _id: input.item._id,
      workspaceId: input.item.workspaceId,
      status: 'sending',
      claimToken: input.claimToken,
    },
    {
      $set: {
        status: 'skipped',
        skippedAt: input.now,
        skipReason: input.reason.slice(0, 500),
      },
      $unset: { claimToken: 1, leaseExpiresAt: 1, lastError: 1 },
    },
  )
  await refreshInvitationBatch({
    workspaceId: input.item.workspaceId,
    batchId: input.item.invitationBatchId,
    now: input.now,
  })
  return changed.matchedCount === 1
}

function linkFields(input: {
  round?: IHireRound
  delivery?: IHireAiInviteDelivery | null
}) {
  return {
    ...(input.round ? { roundId: input.round._id } : {}),
    ...(input.delivery
      ? {
          inviteDeliveryId: input.delivery._id,
          deliveryStatus: input.delivery.status,
          ...(input.delivery.providerMessageId
            ? { providerMessageId: input.delivery.providerMessageId }
            : {}),
        }
      : {}),
  }
}

function canLinkRound(item: IHireInvitationBatchItem, round: IHireRound): boolean {
  return !item.roundId || sameId(item.roundId, round._id)
}

async function markItemSent(input: {
  item: IHireInvitationBatchItem
  claimToken: string
  now: Date
  attempt: DeliveryAttempt
}): Promise<boolean> {
  if (!canLinkRound(input.item, input.attempt.round)) return false
  const changed = await HireInvitationBatchItem.updateOne(
    {
      _id: input.item._id,
      workspaceId: input.item.workspaceId,
      status: 'sending',
      claimToken: input.claimToken,
      ...(input.item.roundId ? { roundId: input.item.roundId } : {}),
    },
    {
      $set: {
        status: 'sent',
        sentAt: input.attempt.delivery?.sentAt ?? input.now,
        ...linkFields(input.attempt),
      },
      $unset: { claimToken: 1, leaseExpiresAt: 1, lastError: 1 },
    },
  )
  await refreshInvitationBatch({
    workspaceId: input.item.workspaceId,
    batchId: input.item.invitationBatchId,
    now: input.now,
  })
  return changed.matchedCount === 1
}

async function markItemRetry(input: {
  item: IHireInvitationBatchItem
  claimToken: string
  now: Date
  message: string
  attempt?: DeliveryAttempt
}): Promise<'retry_scheduled' | 'failed' | 'lost'> {
  if (input.attempt && !canLinkRound(input.item, input.attempt.round)) return 'lost'
  const terminal = input.item.attempts >= HIRE_SCREENING_INVITATION_MAX_ATTEMPTS
  const changed = await HireInvitationBatchItem.updateOne(
    {
      _id: input.item._id,
      workspaceId: input.item.workspaceId,
      status: 'sending',
      claimToken: input.claimToken,
      ...(input.item.roundId ? { roundId: input.item.roundId } : {}),
    },
    {
      $set: {
        status: terminal ? 'failed' : 'pending',
        lastError: input.message.slice(0, 2000),
        ...(terminal ? {} : { sendAfter: nextRetryAt(input.now, input.item.attempts) }),
        ...(input.attempt ? linkFields(input.attempt) : {}),
      },
      $unset: { claimToken: 1, leaseExpiresAt: 1 },
    },
  )
  await refreshInvitationBatch({
    workspaceId: input.item.workspaceId,
    batchId: input.item.invitationBatchId,
    now: input.now,
  })
  if (changed.matchedCount !== 1) return 'lost'
  return terminal ? 'failed' : 'retry_scheduled'
}

async function markBatchDispatching(item: IHireInvitationBatchItem): Promise<void> {
  await HireInvitationBatch.updateOne(
    {
      _id: item.invitationBatchId,
      workspaceId: item.workspaceId,
      status: { $in: ['planned', 'scheduled'] },
    },
    { $set: { status: 'dispatching' } },
  )
}

/**
 * Every read uses the item’s workspace/job/application/candidate tuple. This
 * makes a guessed item id indistinguishable from an absent item and leaves no
 * cross-tenant fallback path before the provider call.
 */
async function loadDispatchContext(
  item: DispatchableInvitationItem,
  now: Date,
): Promise<{ context: DispatchContext } | { skipReason: string }> {
  const [workspace, batch, gate, job, application, candidate, privacyRequest] = await Promise.all([
    HireWorkspace.findOne({
      _id: item.workspaceId,
      ...activeHireWorkspaceLifecycleFilter(),
    }),
    HireInvitationBatch.findOne({
      _id: item.invitationBatchId,
      workspaceId: item.workspaceId,
      jobId: item.jobId,
      screeningGateId: item.screeningGateId,
      status: { $in: ['planned', 'scheduled', 'dispatching'] },
    }),
    HireScreeningGate.findOne({
      _id: item.screeningGateId,
      workspaceId: item.workspaceId,
      jobId: item.jobId,
      status: 'confirmed',
    }),
    HireJob.findOne({
      _id: item.jobId,
      workspaceId: item.workspaceId,
      status: 'open',
    }),
    HireApplication.findOne({
      _id: item.applicationId,
      workspaceId: item.workspaceId,
      jobId: item.jobId,
      candidateId: item.candidateId,
      stage: { $nin: TERMINAL_STAGES },
    }),
    HireCandidate.findOne({
      _id: item.candidateId,
      workspaceId: item.workspaceId,
      piiAnonymizedAt: { $exists: false },
    }),
    HirePrivacyRequest.exists({
      workspaceId: item.workspaceId,
      candidateId: item.candidateId,
      live: true,
      $or: [
        { status: 'processing' },
        { status: 'pending_verification', verificationExpiresAt: { $gt: now } },
      ],
    }),
  ])

  if (!workspace) return { skipReason: 'The workspace is no longer active' }
  if (!batch) return { skipReason: 'This invitation batch is no longer dispatchable' }
  if (!gate) return { skipReason: 'This screening gate is no longer active' }
  if (!job) return { skipReason: 'The job closed before this invitation was sent' }
  if (!application) return { skipReason: 'The application is no longer eligible for screening' }
  if (!candidate) return { skipReason: 'Candidate personal data is unavailable' }
  if (privacyRequest) return { skipReason: 'A candidate privacy request is in progress' }

  const membership = await HireWorkspaceMember.findOne({
    _id: batch.createdByMemberId,
    workspaceId: item.workspaceId,
    authState: 'active',
  })
  if (!membership) return { skipReason: 'The confirming workspace member is no longer active' }
  return { context: { ctx: { workspace, membership } } }
}

async function itemLeaseIsStillOwned(input: {
  item: IHireInvitationBatchItem
  claimToken: string
}): Promise<boolean> {
  const owned = await HireInvitationBatchItem.exists({
    _id: input.item._id,
    workspaceId: input.item.workspaceId,
    status: 'sending',
    claimToken: input.claimToken,
    privacyRedactedAt: { $exists: false },
  })
  return Boolean(owned)
}

async function findItemRound(input: {
  item: DispatchableInvitationItem
  now: Date
}): Promise<IHireRound | null> {
  const scope = {
    workspaceId: input.item.workspaceId,
    applicationId: input.item.applicationId,
    jobId: input.item.jobId,
    candidateId: input.item.candidateId,
    kind: 'ai' as const,
  }
  if (input.item.roundId) {
    return HireRound.findOne({ _id: input.item.roundId, ...scope })
  }
  return HireRound.findOne({
    ...scope,
    live: true,
    status: { $nin: ['completed', 'revoked'] },
    revokedAt: { $exists: false },
    inviteTokenExpiry: { $gt: input.now },
  }).sort({ createdAt: -1, _id: -1 })
}

async function findDeliveryForRound(input: {
  item: DispatchableInvitationItem
  round: IHireRound
}): Promise<IHireAiInviteDelivery | null> {
  return HireAiInviteDelivery.findOne({
    workspaceId: input.item.workspaceId,
    _id: { $exists: true },
    roundId: input.round._id,
    applicationId: input.item.applicationId,
    jobId: input.item.jobId,
    candidateId: input.item.candidateId,
  })
}

async function recoverOrCreateDelivery(input: {
  item: DispatchableInvitationItem
  ctx: MembershipContext
  now: Date
}): Promise<DeliveryAttempt> {
  let round = await findItemRound({ item: input.item, now: input.now })
  if (round) {
    if (!roundIsDeliverable(round, input.now)) {
      throw new AppError('The linked AI interview is no longer active', 410, 'ROUND_NOT_ACTIVE')
    }
    await deliverAiInvite(input.ctx, round._id.toString(), { now: input.now })
    return {
      round,
      delivery: await findDeliveryForRound({ item: input.item, round }),
    }
  }

  try {
    const sent = await sendAiRound(input.ctx, {
      applicationId: input.item.applicationId.toString(),
      ...SCREENING_AI_ROUND_INPUT,
    })
    round = sent.round
  } catch (error) {
    // A recruiter or a second worker may have won the one-live-round race
    // after our preflight. Recover its exact workspace/application tuple
    // instead of issuing a second email.
    if (!(error instanceof AppError) || error.code !== 'ROUND_IN_FLIGHT') throw error
    round = await findItemRound({ item: input.item, now: input.now })
    if (!round) throw error
    if (!roundIsDeliverable(round, input.now)) {
      throw new AppError('The linked AI interview is no longer active', 410, 'ROUND_NOT_ACTIVE')
    }
    await deliverAiInvite(input.ctx, round._id.toString(), { now: input.now })
  }
  return {
    round,
    delivery: await findDeliveryForRound({ item: input.item, round }),
  }
}

/**
 * Process one immutable batch item. Its lease makes duplicate events and a
 * recovery sweep harmless; a stable delivery record/provider key handles the
 * narrower crash window after a provider accepts the message.
 */
export async function processHireScreeningInvitationItem(input: {
  workspaceId: string
  itemId: string
  now?: Date
}): Promise<DispatchOutcome> {
  await connectHireControlDB()
  const workspaceId = requireObjectId(input.workspaceId, 'workspace id')
  const itemId = requireObjectId(input.itemId, 'screening invitation item id')
  const now = input.now ?? new Date()
  const claimed = await claimInvitationItem({ workspaceId, itemId, now })
  if (!claimed) return { outcome: 'skipped', itemId: itemId.toString() }

  const { item, claimToken } = claimed
  try {
    // A pre-fence legacy item can still be replayed by Inngest. Its immutable
    // coordinates are sufficient to suppress delivery before any candidate
    // or encrypted-invite work is read/created.
    if (
      await isHireOnboardingTestDriveCoordinate({
        workspaceId: item.workspaceId,
        jobId: item.jobId,
        ...(item.candidateId ? { candidateId: item.candidateId } : {}),
        ...(item.applicationId ? { applicationId: item.applicationId } : {}),
      })
    ) {
      const reason = 'Practice interview data is isolated from screening delivery'
      await markItemSkipped({ item, claimToken, now, reason })
      return { outcome: 'skipped', itemId: item._id.toString(), reason }
    }
    // Privacy/retention cancellation normally prevents this claim entirely.
    // Keep this defensive guard for an item loaded from a legacy/migrating
    // collection where the identity coordinates have already been redacted.
    if (!isDispatchableInvitationItem(item)) {
      await markItemSkipped({
        item,
        claimToken,
        now,
        reason: 'Candidate personal data was deleted before invitation delivery',
      })
      return {
        outcome: 'skipped',
        itemId: item._id.toString(),
        reason: 'Candidate personal data was deleted before invitation delivery',
      }
    }
    const dispatchableItem = item
    const eligibility = await loadDispatchContext(dispatchableItem, now)
    if ('skipReason' in eligibility) {
      await markItemSkipped({ item, claimToken, now, reason: eligibility.skipReason })
      return { outcome: 'skipped', itemId: item._id.toString(), reason: eligibility.skipReason }
    }

    await markBatchDispatching(dispatchableItem)
    if (!(await itemLeaseIsStillOwned({ item: dispatchableItem, claimToken }))) {
      return { outcome: 'skipped', itemId: dispatchableItem._id.toString() }
    }

    const attempt = await recoverOrCreateDelivery({
      item: dispatchableItem,
      ctx: eligibility.context.ctx,
      now,
    })
    if (!canLinkRound(dispatchableItem, attempt.round)) {
      const reason = 'The batch item points at a different AI interview'
      await markItemSkipped({ item: dispatchableItem, claimToken, now, reason })
      return { outcome: 'skipped', itemId: dispatchableItem._id.toString(), reason }
    }
    if (attempt.delivery?.status === 'sent') {
      const persisted = await markItemSent({ item: dispatchableItem, claimToken, now, attempt })
      return persisted
        ? { outcome: 'sent', itemId: dispatchableItem._id.toString(), roundId: attempt.round._id.toString() }
        : { outcome: 'skipped', itemId: dispatchableItem._id.toString() }
    }

    const outcome = await markItemRetry({
      item: dispatchableItem,
      claimToken,
      now,
      message: attempt.delivery?.lastError ?? 'AI invitation delivery is still pending',
      attempt,
    })
    return outcome === 'retry_scheduled'
      ? { outcome, itemId: dispatchableItem._id.toString(), roundId: attempt.round._id.toString() }
      : outcome === 'failed'
        ? { outcome, itemId: dispatchableItem._id.toString(), roundId: attempt.round._id.toString() }
        : { outcome: 'skipped', itemId: dispatchableItem._id.toString() }
  } catch (error) {
    const skipReason = terminalRoundReason(error)
    if (skipReason) {
      await markItemSkipped({ item, claimToken, now, reason: skipReason })
      return { outcome: 'skipped', itemId: item._id.toString(), reason: skipReason }
    }
    const outcome = await markItemRetry({
      item,
      claimToken,
      now,
      message: compactError(error),
    })
    return outcome === 'retry_scheduled'
      ? { outcome, itemId: item._id.toString() }
      : outcome === 'failed'
        ? { outcome, itemId: item._id.toString() }
        : { outcome: 'skipped', itemId: item._id.toString() }
  }
}

/**
 * A recruiter can explicitly requeue only terminal delivery failures. The
 * original item, round, encrypted delivery record, and provider key survive,
 * so retrying never creates a duplicate candidate card or fresh invite token.
 */
export async function retryFailedHireScreeningInvitationBatch(
  ctx: MembershipContext,
  input: { jobId: string; batchId: string; now?: Date },
): Promise<{ requeued: number; itemIds: string[] }> {
  await connectHireControlDB()
  const jobId = requireObjectId(input.jobId, 'job id')
  const batchId = requireObjectId(input.batchId, 'screening invitation batch id')
  const now = input.now ?? new Date()
  const result = await withActiveHireWorkspaceWriteTransaction(
    ctx.workspace._id,
    ctx.membership._id,
    async (session) => {
      await assertHireOnboardingTestDriveWriteIsolation({
        workspaceId: ctx.workspace._id,
        jobId,
        session,
      })
      const job = await HireJob.findOne({
        _id: jobId,
        workspaceId: ctx.workspace._id,
        status: 'open',
      }).session(session)
      if (!job) {
        const exists = await HireJob.exists({ _id: jobId, workspaceId: ctx.workspace._id }).session(session)
        if (!exists) throw new NotFoundError('Job')
        throw new AppError('Screening invitations can only be retried for open jobs', 409, 'JOB_NOT_OPEN')
      }
      const batch = await HireInvitationBatch.findOne({
        _id: batchId,
        workspaceId: ctx.workspace._id,
        jobId,
        status: { $ne: 'cancelled' },
      }).session(session)
      if (!batch) throw new NotFoundError('Screening invitation batch')

      const failedItems = await HireInvitationBatchItem.find({
        workspaceId: ctx.workspace._id,
        invitationBatchId: batch._id,
        jobId,
        status: 'failed',
        privacyRedactedAt: { $exists: false },
      })
        .select('_id')
        .sort({ sendAfter: 1, _id: 1 })
        .session(session)
        .lean()
      if (failedItems.length === 0) return { requeued: 0, itemIds: [] }

      // Requeue every failed item on its own exact coordinate. This both
      // preserves an audit trail and restores the same one-minute cadence as
      // the original batch rather than turning a manual retry into a burst.
      const requeuedIds: string[] = []
      for (let index = 0; index < failedItems.length; index += 1) {
        const item = failedItems[index]
        const requeued = await HireInvitationBatchItem.updateOne(
          {
            _id: item._id,
            workspaceId: ctx.workspace._id,
            invitationBatchId: batch._id,
            jobId,
            status: 'failed',
            privacyRedactedAt: { $exists: false },
          },
          {
            $set: {
              status: 'pending',
              attempts: 0,
              sendAfter: new Date(now.getTime() + index * SCREENING_INVITATION_RETRY_STAGGER_MS),
              lastManualRetryAt: now,
              lastManualRetryByMemberId: ctx.membership._id,
              lastManualRetryByName: ctx.membership.name || ctx.membership.email,
            },
            $inc: { manualRetryCount: 1 },
            $unset: { claimToken: 1, leaseExpiresAt: 1, lastError: 1 },
          },
          { session },
        )
        if (requeued.matchedCount === 1) requeuedIds.push(item._id.toString())
      }
      if (requeuedIds.length === 0) return { requeued: 0, itemIds: [] }
      await HireInvitationBatch.updateOne(
        {
          _id: batch._id,
          workspaceId: ctx.workspace._id,
          status: { $ne: 'cancelled' },
        },
        {
          $set: { status: 'scheduled', failedCount: 0 },
          $unset: { lastError: 1, completedAt: 1 },
        },
        { session },
      )
      return { requeued: requeuedIds.length, itemIds: requeuedIds }
    },
  )

  // Kick only the first due item. Later staggered rows are durable and the
  // minute sweep will discover them at their own sendAfter time; emitting all
  // of them now merely creates harmless but noisy no-op events.
  for (const itemId of result.itemIds.slice(0, 1)) {
    try {
      await dispatchHireScreeningInvitationItem({
        workspaceId: ctx.workspace._id.toString(),
        itemId,
      })
    } catch (error) {
      logger.warn(
        { workspaceId: ctx.workspace._id.toString(), itemId, error },
        'hire screening invitation retry dispatch failed; recovery sweep will retry',
      )
    }
  }
  return result
}

/**
 * Explicit waterfall only: HR chooses the next bounded count from the frozen
 * gate’s fresh, ranked, unreserved remainder. It never sends or rejects on
 * its own; it merely creates a new scheduled wave for the normal worker.
 */
export async function createHireScreeningInvitationWaterfall(
  ctx: MembershipContext,
  input: {
    jobId: string
    gateId: string
    count: number
    sendAfter?: Date | string
    now?: Date
  },
): Promise<{ batchId: string; itemIds: string[]; count: number }> {
  await connectHireControlDB()
  const jobId = requireObjectId(input.jobId, 'job id')
  const gateId = requireObjectId(input.gateId, 'screening gate id')
  if (!Number.isInteger(input.count) || input.count < 1 || input.count > HIRE_SCREENING_WATERFALL_MAX_COUNT) {
    throw new AppError(
      `Waterfall count must be between 1 and ${HIRE_SCREENING_WATERFALL_MAX_COUNT}`,
      422,
      'INVALID_WATERFALL_COUNT',
    )
  }
  const now = input.now ?? new Date()
  const sendAfter = input.sendAfter === undefined
    ? now
    : new Date(input.sendAfter)
  if (Number.isNaN(sendAfter.getTime())) {
    throw new AppError('sendAfter must be a valid date', 422, 'INVALID_SEND_AFTER')
  }

  let result: { batchId: string; itemIds: string[]; count: number }
  try {
    result = await withActiveHireWorkspaceWriteTransaction(
      ctx.workspace._id,
      ctx.membership._id,
      async (session) => {
      await assertHireOnboardingTestDriveWriteIsolation({
        workspaceId: ctx.workspace._id,
        jobId,
        session,
      })
      const jobClaim = await HireJob.updateOne(
        { _id: jobId, workspaceId: ctx.workspace._id, status: 'open' },
        { $inc: { intakeWriteVersion: 1 } },
        { session },
      )
      if (jobClaim.matchedCount !== 1) {
        const exists = await HireJob.exists({ _id: jobId, workspaceId: ctx.workspace._id }).session(session)
        if (!exists) throw new NotFoundError('Job')
        throw new AppError('Waterfall invitations can only be queued for open jobs', 409, 'JOB_NOT_OPEN')
      }
      const gate = await HireScreeningGate.findOne({
        _id: gateId,
        workspaceId: ctx.workspace._id,
        jobId,
        status: 'confirmed',
      }).session(session)
      if (!gate) throw new NotFoundError('Screening gate')

      // Mongoose does not support concurrent operations on one transaction
      // session. Keep these reads sequential so the reservation snapshot and
      // the later unique-index backstop have real transactional semantics.
      const reservedItems = await HireInvitationBatchItem.find({
        workspaceId: ctx.workspace._id,
        screeningGateId: gate._id,
      })
        .select('applicationId')
        .session(session)
        .lean()
      const priorBatches = await HireInvitationBatch.find({
        workspaceId: ctx.workspace._id,
        screeningGateId: gate._id,
        jobId,
      })
        .select('wave')
        .session(session)
        .lean()
      const reservedApplicationIds = new Set(
        reservedItems.flatMap((item) =>
          item.applicationId ? [item.applicationId.toString()] : [],
        ),
      )
      const remainder = gate.rankedApplications.filter((entry) =>
        entry.rank !== undefined &&
        entry.scoreState === 'scored' &&
        entry.knockoutReasons.length === 0 &&
        // A documented manual exclusion remains a recruiter decision for
        // this frozen gate. Waterfall may progress past the cut line, but it
        // must never silently undo an explicit human exclusion.
        entry.selectionReason !== 'manual_exclude' &&
        !reservedApplicationIds.has(entry.applicationId.toString()),
      )
      const requested = remainder.slice(0, input.count)
      if (requested.length === 0) {
        throw new AppError(
          'No unreserved, ranked candidates remain for this waterfall',
          409,
          'WATERFALL_EMPTY',
        )
      }

      const requestedApplicationIds = requested.map((entry) => entry.applicationId)
      const requestedCandidateIds = requested.map((entry) => entry.candidateId)
      const applications = await HireApplication.find({
        workspaceId: ctx.workspace._id,
        jobId,
        _id: { $in: requestedApplicationIds },
        stage: { $nin: TERMINAL_STAGES },
      }).session(session)
      const candidates = await HireCandidate.find({
        workspaceId: ctx.workspace._id,
        _id: { $in: requestedCandidateIds },
        piiAnonymizedAt: { $exists: false },
      }).session(session)
      const applicationById = new Map(applications.map((application) => [application._id.toString(), application]))
      const candidateById = new Map(candidates.map((candidate) => [candidate._id.toString(), candidate]))
      const selected = requested.filter((entry) => {
        const application = applicationById.get(entry.applicationId.toString())
        const candidate = candidateById.get(entry.candidateId.toString())
        return Boolean(
          application &&
          candidate &&
          sameId(application.candidateId, entry.candidateId) &&
          sameId(candidate._id, entry.candidateId),
        )
      })
      if (selected.length === 0) {
        throw new AppError(
          'The remaining candidates are no longer eligible for invitations',
          409,
          'WATERFALL_EMPTY',
        )
      }

      // Coordinate the new reservation with verified privacy deletion. A
      // candidate that is deleted immediately after this point is cancelled
      // by the deletion transaction before a worker can resolve their email.
      for (const entry of selected) {
        const privacyRequest = await HirePrivacyRequest.exists({
          workspaceId: ctx.workspace._id,
          candidateId: entry.candidateId,
          live: true,
          $or: [
            { status: 'processing' },
            { status: 'pending_verification', verificationExpiresAt: { $gt: now } },
          ],
        }).session(session)
        if (privacyRequest) {
          throw new AppError(
            'A candidate privacy request is in progress',
            409,
            'CANDIDATE_PRIVACY_PENDING',
          )
        }
        await claimHireCandidatePiiWriteFence({
          workspaceId: ctx.workspace._id,
          candidateId: entry.candidateId,
          session,
        })
      }

      const wave = Math.max(0, ...priorBatches.map((batch) => batch.wave)) + 1
      const batchId = new mongoose.Types.ObjectId()
      const itemIds = selected.map(() => new mongoose.Types.ObjectId())
      await HireInvitationBatch.create(
        [{
          _id: batchId,
          workspaceId: ctx.workspace._id,
          jobId,
          screeningGateId: gate._id,
          wave,
          sendAfter,
          status: 'planned',
          plannedCount: selected.length,
          sentCount: 0,
          failedCount: 0,
          createdByMemberId: ctx.membership._id,
          createdByName: ctx.membership.name || ctx.membership.email,
        }],
        { session },
      )
      await HireInvitationBatchItem.create(
        selected.map((entry, index) => ({
          _id: itemIds[index],
          workspaceId: ctx.workspace._id,
          jobId,
          screeningGateId: gate._id,
          invitationBatchId: batchId,
          applicationId: entry.applicationId,
          candidateId: entry.candidateId,
          rank: entry.rank,
          score: entry.score,
          scoreState: entry.scoreState,
          selectionReason: 'waterfall',
          sendAfter: new Date(sendAfter.getTime() + index * 60_000),
          status: 'pending',
          attempts: 0,
          manualRetryCount: 0,
        })),
        { session },
      )
        return {
          batchId: batchId.toString(),
          itemIds: itemIds.map((itemId) => itemId.toString()),
          count: selected.length,
        }
      },
    )
  } catch (error) {
    // The unique workspace/application reservation is the final race fence
    // for two HR members confirming the same waterfall at once. Do not leak
    // a raw Mongo error or fall back to a second selection attempt.
    if (isDuplicateKey(error)) {
      throw new AppError(
        'One or more candidates was already reserved for a screening invitation',
        409,
        'SCREENING_APPLICATION_ALREADY_RESERVED',
      )
    }
    throw error
  }

  // Only immediately dispatch wave members that are already due. Future
  // staggered items stay in Mongo and are picked up by the minute recovery.
  if (sendAfter <= now) {
    try {
      await dispatchHireScreeningInvitationItem({
        workspaceId: ctx.workspace._id.toString(),
        itemId: result.itemIds[0],
      })
    } catch (error) {
      logger.warn(
        { workspaceId: ctx.workspace._id.toString(), batchId: result.batchId, error },
        'hire screening waterfall dispatch failed; recovery sweep will retry',
      )
    }
  }
  return result
}

export const __screeningInvitation = {
  ITEM_CLAIM_LEASE_MS,
  nextRetryAt,
}
