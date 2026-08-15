import { randomUUID } from 'node:crypto'
import mongoose, { type ClientSession } from 'mongoose'
import { AppError } from '@shared/errors'
import { sendEmail } from '@shared/services/emailService'
import { inngest } from '@shared/services/inngest'
import {
  HIRE_HUMAN_KIT_MAX_ATTEMPTS,
  HireApplication,
  HireCandidate,
  HireHumanKitDelivery,
  HireHumanRound,
  HireJob,
  HireOnboardingTestDrive,
  HirePrivacyRequest,
  HireWorkspace,
  HireWorkspaceMember,
  activeHirePrivacyRequestFilter,
  activeHireWorkspaceLifecycleFilter,
} from '@hire-digest-boundary'
import { buildHireDailyDigestEmail } from '../emails/hireDailyDigestEmail'
import { HireDigestOutbox, HireDigestPreference, type IHireDigestOutbox } from '../models'
import {
  HIRE_DIGEST_CLAIM_LEASE_MS,
  HIRE_DIGEST_MAX_ATTEMPTS,
  HIRE_DIGEST_RECOVERY_LIMIT_PER_WORKSPACE,
  type HireDigestMemberView,
  type HireDigestOutboxMemberView,
  type HireDigestPayload,
} from '../types'
import type { UpdateHireDigestPreferenceInput } from '../validators/hireDigest'
import { authorizeHireDigestEgress, connectHireDigestDB, withActiveHireDigestMemberTransaction } from './hireDigestBoundary'

/** Structural Hire-member authority; no root-barrel runtime dependency. */
export interface HireDigestMembershipContext {
  workspace: { _id: mongoose.Types.ObjectId }
  membership: {
    _id: mongoose.Types.ObjectId
    name?: string
    email: string
  }
}

const OBJECT_ID = /^[a-f0-9]{24}$/i

export interface HireDigestProcessResult {
  processed: boolean
  outcome?: 'sent' | 'retry_scheduled' | 'failed' | 'cancelled'
}

function objectId(value: string, label: string): mongoose.Types.ObjectId {
  if (!OBJECT_ID.test(value)) throw new AppError(`Invalid ${label}`, 400, 'INVALID_ID')
  return new mongoose.Types.ObjectId(value)
}

function actorName(ctx: HireDigestMembershipContext): string {
  return (ctx.membership.name || ctx.membership.email).trim().slice(0, 120)
}

function utcPeriodKey(now: Date): string {
  return now.toISOString().slice(0, 10)
}

function retryDueAt(now: Date, attempts: number): Date {
  return new Date(now.getTime() + Math.min(60 * 60_000, 60_000 * 2 ** Math.max(0, attempts - 1)))
}

function memberView(preference: { enabled: boolean; updatedAt?: Date }): HireDigestMemberView {
  return {
    enabled: preference.enabled,
    updatedAt: preference.updatedAt ?? null,
  }
}

function outboxMemberView(row: Pick<IHireDigestOutbox, '_id' | 'periodKey' | 'status' | 'sentAt'>): HireDigestOutboxMemberView {
  return {
    id: row._id.toString(),
    periodKey: row.periodKey,
    status: row.status,
    sentAt: row.sentAt ?? null,
  }
}

interface HireOnboardingDigestExclusions {
  jobIds: mongoose.Types.ObjectId[]
  candidateIds: mongoose.Types.ObjectId[]
  applicationIds: mongoose.Types.ObjectId[]
}

interface HirePrivacyDigestExclusions {
  candidateIds: mongoose.Types.ObjectId[]
}

/**
 * Practice test-drive graphs remain marked until their lifecycle cleanup
 * finishes. Read just their opaque coordinates before building aggregate-only
 * digest counts so a member's own practice run cannot inflate real workflow
 * updates. Keep this serial with snapshot queries when a transaction session
 * is supplied: Mongoose transactions do not support parallel operations.
 */
async function loadHireOnboardingDigestExclusions(input: {
  workspaceId: mongoose.Types.ObjectId
  session?: ClientSession
}): Promise<HireOnboardingDigestExclusions> {
  let query = HireOnboardingTestDrive.find({
    workspaceId: input.workspaceId,
    excludeFromAggregates: true,
  }).select('jobId candidateId applicationId')
  if (input.session) query = query.session(input.session)
  const rows = await query.lean()
  return {
    jobIds: rows.map((row) => row.jobId),
    candidateIds: rows.map((row) => row.candidateId),
    applicationIds: rows.map((row) => row.applicationId),
  }
}

/**
 * Aggregate snapshots must never count a candidate after either a live
 * privacy request or a retention anonymization. The workspace root fence held
 * by the caller makes these serial reads a single snapshot boundary.
 */
async function loadHirePrivacyDigestExclusions(input: {
  workspaceId: mongoose.Types.ObjectId
  now: Date
  session?: ClientSession
}): Promise<HirePrivacyDigestExclusions> {
  let liveRequestQuery = HirePrivacyRequest.find({
    workspaceId: input.workspaceId,
    ...activeHirePrivacyRequestFilter(input.now),
  }).select('candidateId')
  if (input.session) liveRequestQuery = liveRequestQuery.session(input.session)
  const liveRequests = await liveRequestQuery.lean()

  let anonymizedCandidateQuery = HireCandidate.find({
    workspaceId: input.workspaceId,
    piiAnonymizedAt: { $exists: true },
  }).select('_id')
  if (input.session) anonymizedCandidateQuery = anonymizedCandidateQuery.session(input.session)
  const anonymizedCandidates = await anonymizedCandidateQuery.lean()

  const candidateIds = new Map<string, mongoose.Types.ObjectId>()
  for (const candidateId of [
    ...liveRequests.map((request) => request.candidateId),
    ...anonymizedCandidates.map((candidate) => candidate._id),
  ]) {
    candidateIds.set(candidateId.toString(), candidateId)
  }
  return { candidateIds: Array.from(candidateIds.values()) }
}

function omitOnboardingCoordinates(
  exclusions: HireOnboardingDigestExclusions,
  privacyCandidateIds: mongoose.Types.ObjectId[] = [],
): Record<string, unknown> {
  const candidateIds = new Map<string, mongoose.Types.ObjectId>()
  for (const candidateId of [...exclusions.candidateIds, ...privacyCandidateIds]) {
    candidateIds.set(candidateId.toString(), candidateId)
  }
  return {
    ...(exclusions.jobIds.length > 0 ? { jobId: { $nin: exclusions.jobIds } } : {}),
    ...(candidateIds.size > 0 ? { candidateId: { $nin: Array.from(candidateIds.values()) } } : {}),
    ...(exclusions.applicationIds.length > 0 ? { applicationId: { $nin: exclusions.applicationIds } } : {}),
  }
}

/** Current member's explicit preference. Absence is the safe default: off. */
export async function getHireDigestPreference(ctx: HireDigestMembershipContext): Promise<HireDigestMemberView> {
  await connectHireDigestDB()
  const preference = await HireDigestPreference.findOne({
    workspaceId: ctx.workspace._id,
    memberId: ctx.membership._id,
  }).select('enabled updatedAt')
  return preference ? memberView(preference) : { enabled: false, updatedAt: null }
}

/**
 * Opt-in/out mutation. Disabling is also a same-transaction cancellation of
 * every unfinished digest for this member, so it serializes with egress.
 */
export async function updateHireDigestPreference(
  ctx: HireDigestMembershipContext,
  input: UpdateHireDigestPreferenceInput,
  now = new Date(),
): Promise<HireDigestMemberView> {
  return withActiveHireDigestMemberTransaction({ workspaceId: ctx.workspace._id, memberId: ctx.membership._id }, async (session) => {
    const preference = await HireDigestPreference.findOneAndUpdate(
      { workspaceId: ctx.workspace._id, memberId: ctx.membership._id },
      {
        $set: {
          enabled: input.enabled,
          updatedByMemberId: ctx.membership._id,
          updatedByName: actorName(ctx),
        },
        $inc: { writeFenceVersion: 1 },
      },
      {
        upsert: true,
        new: true,
        session,
        setDefaultsOnInsert: true,
        runValidators: true,
      },
    )
    if (!input.enabled) {
      await cancelHireDigestOutboxesForScope({
        workspaceId: ctx.workspace._id,
        memberId: ctx.membership._id,
        now,
        session,
      })
    }
    return memberView(preference)
  })
}

/** Safe summary used only for immutable digest snapshots; no candidate data leaves this function. */
export async function buildHireDigestPayload(input: {
  workspaceId: mongoose.Types.ObjectId
  workspaceName: string
  now: Date
  session?: ClientSession
}): Promise<HireDigestPayload> {
  const options = input.session ? { session: input.session } : undefined
  // Mongo/Mongoose does not support parallel operations on one transaction
  // session. Keep these independent aggregate reads serial when a caller is
  // taking an immutable snapshot under a member/workspace fence.
  const exclusions = await loadHireOnboardingDigestExclusions({
    workspaceId: input.workspaceId,
    session: input.session,
  })
  const privacyExclusions = await loadHirePrivacyDigestExclusions({
    workspaceId: input.workspaceId,
    now: input.now,
    session: input.session,
  })
  const aggregateCoordinateExclusions = omitOnboardingCoordinates(
    exclusions,
    privacyExclusions.candidateIds,
  )
  const openJobs = await HireJob.countDocuments(
    {
      workspaceId: input.workspaceId,
      status: 'open',
      ...(exclusions.jobIds.length > 0 ? { _id: { $nin: exclusions.jobIds } } : {}),
    },
    options,
  )
  const awaitingDecision = await HireApplication.countDocuments(
    {
      workspaceId: input.workspaceId,
      stage: { $in: ['shortlist', 'offer'] },
      ...aggregateCoordinateExclusions,
    },
    options,
  )
  const pendingScorecards = await HireHumanRound.countDocuments(
    {
      workspaceId: input.workspaceId,
      status: 'pending_scorecard',
      ...aggregateCoordinateExclusions,
    },
    options,
  )
  const terminalKitDeliveryFailures = await HireHumanKitDelivery.countDocuments(
    {
      workspaceId: input.workspaceId,
      purpose: 'initial',
      status: 'failed',
      attempts: { $gte: HIRE_HUMAN_KIT_MAX_ATTEMPTS },
      ...aggregateCoordinateExclusions,
    },
    options,
  )
  return {
    workspaceName: input.workspaceName,
    generatedAt: input.now,
    openJobs,
    awaitingDecision,
    pendingScorecards,
    terminalKitDeliveryFailures,
  }
}

/**
 * Create the unique current-UTC-period outbox item for one opted-in member.
 * It is safe for duplicate cron/event invocation because Mongo owns the
 * workspace/member/period uniqueness barrier.
 */
export async function ensureHireDailyDigestOutbox(input: {
  workspaceId: string
  memberId: string
  periodKey?: string
  now?: Date
}): Promise<{ outbox: HireDigestOutboxMemberView | null; created: boolean }> {
  const workspaceId = objectId(input.workspaceId, 'workspace id')
  const memberId = objectId(input.memberId, 'member id')
  const now = input.now ?? new Date()
  const periodKey = input.periodKey ?? utcPeriodKey(now)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(periodKey)) {
    throw new AppError('Invalid digest period', 400, 'INVALID_DIGEST_PERIOD')
  }

  return withActiveHireDigestMemberTransaction({ workspaceId, memberId }, async (session) => {
    const preference = await HireDigestPreference.findOne(
      {
        workspaceId,
        memberId,
        enabled: true,
      },
      null,
      { session },
    )
    if (!preference) return { outbox: null, created: false }

    const member = await HireWorkspaceMember.findOne({ _id: memberId, workspaceId, authState: 'active' }, null, { session }).select(
      'email name',
    )
    const workspace = await HireWorkspace.findOne({ _id: workspaceId }, null, { session }).select(
      'name privacyAggregateFenceVersion',
    )
    if (!member || !workspace) return { outbox: null, created: false }

    // Mongoose sessions do not support parallel work. Keep the snapshot reads
    // sequential while the transaction holds the workspace/member authority.
    const payload = await buildHireDigestPayload({
      workspaceId,
      workspaceName: workspace.name,
      now,
      session,
    })
    const inserted = await HireDigestOutbox.updateOne(
      { workspaceId, memberId, periodKey },
      {
        $setOnInsert: {
          workspaceId,
          memberId,
          periodKey,
          recipientEmail: member.email,
          recipientName: member.name,
          payload,
          status: 'pending',
          sendAfter: now,
          attempts: 0,
          egressFenceVersion: 0,
          privacyAggregateFenceVersion: workspace.privacyAggregateFenceVersion ?? 0,
        },
      },
      {
        upsert: true,
        session,
        setDefaultsOnInsert: true,
      },
    )
    const row = await HireDigestOutbox.findOne({ workspaceId, memberId, periodKey }, null, { session })
    if (!row) throw new AppError('Could not create digest delivery', 409, 'DIGEST_OUTBOX_RACE')
    return {
      outbox: outboxMemberView(row),
      created: inserted.upsertedCount === 1,
    }
  })
}

/** Cron helper: it receives already tenant-scoped roots and never emits recipient data. */
export async function scheduleHireDailyDigestsForWorkspace(input: { workspaceId: string; now?: Date }): Promise<string[]> {
  await connectHireDigestDB()
  const workspaceId = objectId(input.workspaceId, 'workspace id')
  const now = input.now ?? new Date()
  const preferences = await HireDigestPreference.find({
    workspaceId,
    enabled: true,
  })
    .select('memberId')
    .sort({ memberId: 1 })
    .lean()
  const created: string[] = []
  for (const preference of preferences) {
    try {
      const result = await ensureHireDailyDigestOutbox({
        workspaceId: workspaceId.toString(),
        memberId: preference.memberId.toString(),
        now,
      })
      if (result.created && result.outbox) created.push(result.outbox.id)
    } catch (error) {
      // A member/workspace can be removed after this scheduler page reads an
      // opt-in preference. That is expected lifecycle authority loss, not a
      // reason to starve the other opted-in members in this workspace.
      if (error instanceof AppError && error.code === 'MEMBER_REMOVED') continue
      if (error instanceof AppError && error.code === 'WORKSPACE_DELETION_PENDING') break
      throw error
    }
  }
  return created
}

/**
 * Scheduler roots are active Hire-control workspaces only. The per-workspace
 * creation transaction remains the final membership/opt-in authority check.
 */
export async function listActiveHireDigestWorkspaceIds(): Promise<string[]> {
  await connectHireDigestDB()
  const rows = await HireWorkspace.find(activeHireWorkspaceLifecycleFilter()).select('_id').sort({ _id: 1 }).lean()
  return rows.map((row) => row._id.toString())
}

/** Emit only durable coordinates; the worker reloads the select-hidden row. */
export async function dispatchHireDailyDigest(input: { workspaceId: string; outboxId: string }): Promise<void> {
  await inngest.send({ name: 'hire/digest.requested', data: input })
}

function dueDigestFilter(workspaceId: mongoose.Types.ObjectId, now: Date) {
  return {
    workspaceId,
    $or: [
      {
        attempts: { $lt: HIRE_DIGEST_MAX_ATTEMPTS },
        sendAfter: { $lte: now },
        $or: [{ status: { $in: ['pending', 'failed'] } }, { status: 'sending', leaseExpiresAt: { $lte: now } }],
      },
      // A worker can die after taking its final lease. Select that expired
      // row only so claimHireDigestOutbox can terminalize it; this branch can
      // never satisfy the normal below-cap claim branch after finalization.
      {
        status: 'sending',
        attempts: { $gte: HIRE_DIGEST_MAX_ATTEMPTS },
        leaseExpiresAt: { $lte: now },
      },
    ],
  }
}

/** Enumerates only opaque durable ids for a one-workspace recovery page. */
export async function listDueHireDigestOutboxIds(input: { workspaceId: string; limit?: number; now?: Date }): Promise<string[]> {
  await connectHireDigestDB()
  const workspaceId = objectId(input.workspaceId, 'workspace id')
  const rows = await HireDigestOutbox.find(dueDigestFilter(workspaceId, input.now ?? new Date()))
    .select('_id')
    .sort({ sendAfter: 1, _id: 1 })
    .limit(input.limit ?? HIRE_DIGEST_RECOVERY_LIMIT_PER_WORKSPACE)
    .lean()
  return rows.map((row) => row._id.toString())
}

async function finalizeExhaustedDigestLease(input: {
  workspaceId: mongoose.Types.ObjectId
  outboxId: mongoose.Types.ObjectId
  now: Date
}): Promise<boolean> {
  const result = await HireDigestOutbox.updateOne(
    {
      _id: input.outboxId,
      workspaceId: input.workspaceId,
      status: 'sending',
      attempts: { $gte: HIRE_DIGEST_MAX_ATTEMPTS },
      leaseExpiresAt: { $lte: input.now },
    },
    {
      $set: { status: 'failed', failureCode: 'max_attempts' },
      $unset: { claimToken: 1, leaseExpiresAt: 1 },
    },
  )
  return result.modifiedCount === 1
}

async function claimHireDigestOutbox(input: {
  workspaceId: mongoose.Types.ObjectId
  outboxId: mongoose.Types.ObjectId
  now: Date
}): Promise<IHireDigestOutbox | null> {
  await finalizeExhaustedDigestLease(input)
  const claimToken = randomUUID()
  const row = await HireDigestOutbox.findOneAndUpdate(
    {
      _id: input.outboxId,
      ...dueDigestFilter(input.workspaceId, input.now),
    },
    {
      $set: {
        status: 'sending',
        claimToken,
        leaseExpiresAt: new Date(input.now.getTime() + HIRE_DIGEST_CLAIM_LEASE_MS),
      },
      $inc: { attempts: 1 },
    },
    { new: true },
  ).select('+recipientEmail +recipientName +payload +claimToken +providerMessageId')
  return row
}

/**
 * Exact worker authorization. It rechecks opt-in/member/workspace authority
 * and writes every fence before returning the recipient snapshot for egress.
 */
async function authorizeHireDigestOutboxEgress(input: { row: IHireDigestOutbox; now: Date }): Promise<IHireDigestOutbox | null> {
  return authorizeHireDigestEgress({
    workspaceId: input.row.workspaceId,
    memberId: input.row.memberId,
    privacyAggregateFenceVersion: input.row.privacyAggregateFenceVersion ?? 0,
    work: async (session) => {
      const optedIn = await HireDigestPreference.updateOne(
        {
          workspaceId: input.row.workspaceId,
          memberId: input.row.memberId,
          enabled: true,
        },
        { $inc: { writeFenceVersion: 1 } },
        { session, timestamps: false },
      )
      if (optedIn.matchedCount !== 1) return null
      const authorized = await HireDigestOutbox.findOneAndUpdate(
        {
          _id: input.row._id,
          workspaceId: input.row.workspaceId,
          memberId: input.row.memberId,
          status: 'sending',
          claimToken: input.row.claimToken,
          leaseExpiresAt: { $gt: input.now },
        },
        { $inc: { egressFenceVersion: 1 } },
        { new: true, session },
      ).select('+recipientEmail +recipientName +payload +claimToken +providerMessageId')
      return authorized
    },
  })
}

async function cancelClaimedHireDigestOutbox(input: { row: IHireDigestOutbox; now: Date }): Promise<void> {
  await HireDigestOutbox.updateOne(
    {
      _id: input.row._id,
      workspaceId: input.row.workspaceId,
      memberId: input.row.memberId,
      status: 'sending',
      claimToken: input.row.claimToken,
    },
    {
      $set: { status: 'cancelled', cancelledAt: input.now },
      $unset: { claimToken: 1, leaseExpiresAt: 1 },
    },
  )
}

/** Process exactly one opaque outbox id; provider egress is never part of an event payload. */
export async function processHireDailyDigest(input: {
  workspaceId: string
  outboxId: string
  now?: Date
}): Promise<HireDigestProcessResult> {
  await connectHireDigestDB()
  const now = input.now ?? new Date()
  const row = await claimHireDigestOutbox({
    workspaceId: objectId(input.workspaceId, 'workspace id'),
    outboxId: objectId(input.outboxId, 'digest outbox id'),
    now,
  })
  if (!row) return { processed: false }

  const authorized = await authorizeHireDigestOutboxEgress({ row, now })
  if (!authorized) {
    await cancelClaimedHireDigestOutbox({ row, now })
    return { processed: true, outcome: 'cancelled' }
  }

  const email = buildHireDailyDigestEmail({
    recipientName: authorized.recipientName,
    payload: authorized.payload,
  })
  const delivered = await sendEmail({
    to: authorized.recipientEmail,
    subject: email.subject,
    html: email.html,
    text: email.text,
    idempotencyKey: `hire-digest:${authorized._id.toString()}`,
    privacySafeLog: true,
  })
  if (delivered.ok) {
    const settled = await HireDigestOutbox.updateOne(
      {
        _id: authorized._id,
        workspaceId: authorized.workspaceId,
        memberId: authorized.memberId,
        status: 'sending',
        claimToken: authorized.claimToken,
      },
      {
        $set: {
          status: 'sent',
          sentAt: now,
          ...(delivered.id ? { providerMessageId: delivered.id } : {}),
        },
        $unset: { claimToken: 1, leaseExpiresAt: 1 },
      },
    )
    return settled.modifiedCount === 1 ? { processed: true, outcome: 'sent' } : { processed: false }
  }

  const terminal = authorized.attempts >= HIRE_DIGEST_MAX_ATTEMPTS
  const settled = await HireDigestOutbox.updateOne(
    {
      _id: authorized._id,
      workspaceId: authorized.workspaceId,
      memberId: authorized.memberId,
      status: 'sending',
      claimToken: authorized.claimToken,
    },
    terminal
      ? {
          $set: { status: 'failed', failureCode: 'provider_unavailable' },
          $unset: { claimToken: 1, leaseExpiresAt: 1 },
        }
      : {
          $set: {
            status: 'failed',
            failureCode: 'provider_unavailable',
            sendAfter: retryDueAt(now, authorized.attempts),
          },
          $unset: { claimToken: 1, leaseExpiresAt: 1 },
        },
  )
  if (settled.modifiedCount !== 1) return { processed: false }
  return { processed: true, outcome: terminal ? 'failed' : 'retry_scheduled' }
}

/**
 * Shared lifecycle port. Callers provide their enclosing transaction so
 * membership removal, privacy/workspace teardown, and a worker's exact claim
 * all serialize through the same durable row.
 */
export async function cancelHireDigestOutboxesForScope(input: {
  workspaceId: mongoose.Types.ObjectId
  memberId?: mongoose.Types.ObjectId
  now: Date
  session: ClientSession
}): Promise<void> {
  await HireDigestOutbox.updateMany(
    {
      workspaceId: input.workspaceId,
      ...(input.memberId ? { memberId: input.memberId } : {}),
      status: { $in: ['pending', 'sending', 'failed'] },
    },
    {
      $set: { status: 'cancelled', cancelledAt: input.now },
      $unset: { claimToken: 1, leaseExpiresAt: 1 },
    },
    { session: input.session },
  )
}

/**
 * Candidate privacy-request creation, verified deletion, and retention
 * anonymization share this transaction port. It advances the same workspace
 * row claimed by snapshot creation and exact egress authorization, then
 * permanently cancels every unfinished immutable aggregate captured before
 * the change. No candidate coordinate enters a digest row, event, or log.
 */
export async function invalidateHireDigestAggregateSnapshotsForPrivacy(input: {
  workspaceId: mongoose.Types.ObjectId
  now: Date
  session: ClientSession
}): Promise<void> {
  await HireWorkspace.updateOne(
    { _id: input.workspaceId },
    { $inc: { writeFenceVersion: 1, privacyAggregateFenceVersion: 1 } },
    { session: input.session },
  )
  await cancelHireDigestOutboxesForScope(input)
}

/**
 * Lifecycle revocation is stronger than cancelling today's rows: it disables
 * the opt-in itself before cancelling unfinished outboxes. A workspace restore
 * or a removed member can therefore never silently resume recurring mail.
 */
export async function disableHireDigestDeliveryForScope(input: {
  workspaceId: mongoose.Types.ObjectId
  memberId?: mongoose.Types.ObjectId
  now: Date
  session: ClientSession
}): Promise<void> {
  await HireDigestPreference.updateMany(
    {
      workspaceId: input.workspaceId,
      ...(input.memberId ? { memberId: input.memberId } : {}),
      enabled: true,
    },
    {
      $set: { enabled: false },
      $inc: { writeFenceVersion: 1 },
    },
    { session: input.session },
  )
  await cancelHireDigestOutboxesForScope(input)
}
