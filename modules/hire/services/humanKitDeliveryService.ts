import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from 'crypto'
import type { ClientSession } from 'mongoose'
import mongoose from 'mongoose'
import { AppError, NotFoundError } from '@shared/errors'
import { logger } from '@shared/logger'
import { sendEmail } from '@shared/services/emailService'
import { inngest } from '@shared/services/inngest'
import { buildHumanInterviewKitEmail } from '../emails/humanInterviewKitEmail'
import {
  HireApplication,
  HireHumanKitDelivery,
  HireHumanRound,
  HireInterviewKit,
  HireJob,
  HirePrivacyRequest,
  HireWorkspace,
  HireWorkspaceMember,
  type HireHumanKitDeliveryPurpose,
  type IHireHumanKitDelivery,
  type IHireInterviewKit,
} from '../models'
import { connectHireControlDB } from './hireControlBoundary'
import { withActiveHireWorkspaceWriteTransaction } from './hireWorkspaceWriteFence'
import {
  claimHireCandidatePiiWriteFence,
  HireCandidatePiiTombstoneError,
} from './hireCandidatePrivacyWriteFence'
import { claimNonTerminalHireApplicationDispatchFence } from './hireApplicationDispatchFence'
import { encodeWorkspaceResourceCapability } from './workspaceCapability'
import { HIRE_HUMAN_KIT_MAX_ATTEMPTS } from './hireHumanKitDeliveryPolicy'
import type { MembershipContext } from './workspaceService'

const AES_KEY_BYTES = 32
const GCM_IV_BYTES = 12
const CLAIM_LEASE_MS = 5 * 60_000
const REMINDER_DELAY_MS = 24 * 60 * 60_000
export { HIRE_HUMAN_KIT_MAX_ATTEMPTS } from './hireHumanKitDeliveryPolicy'
const RETRY_BASE_MS = 60_000
const RETRY_MAX_MS = 60 * 60_000

export const HIRE_HUMAN_KIT_RECOVERY_LIMIT_PER_WORKSPACE = 10

function retryDueAt(now: Date, attempts: number): Date {
  const delay = Math.min(
    RETRY_MAX_MS,
    RETRY_BASE_MS * 2 ** Math.max(0, Math.min(attempts - 1, 6)),
  )
  return new Date(now.getTime() + delay)
}

async function emitHumanInterviewKitDeliveryRequested(input: {
  workspaceId: string
  deliveryId: string
}): Promise<void> {
  await inngest.send({ name: 'hire/human-kit.requested', data: input })
}

/**
 * Best-effort latency kick for a durable delivery row. The recovery cron owns
 * correctness, so a transient Inngest failure leaves the row pending rather
 * than failing round creation or placing any PII in an event payload.
 */
export async function dispatchHumanInterviewKitDelivery(input: {
  workspaceId: string
  deliveryId: string
}): Promise<void> {
  if (!mongoose.Types.ObjectId.isValid(input.workspaceId) || !mongoose.Types.ObjectId.isValid(input.deliveryId)) {
    throw new AppError('Invalid human interview kit delivery coordinate', 400, 'INVALID_ID')
  }
  await emitHumanInterviewKitDeliveryRequested(input)
}

export async function kickHumanInterviewKitDelivery(input: {
  workspaceId: string
  deliveryId: string
}): Promise<void> {
  try {
    await dispatchHumanInterviewKitDelivery(input)
  } catch {
    logger.warn({ workspaceId: input.workspaceId, deliveryId: input.deliveryId }, 'hire: human kit dispatch failed; recovery will retry')
  }
}

interface EncryptionKey {
  id: string
  value: Buffer
}

function decodeKey(name: string, raw: string | undefined): Buffer {
  const encoded = raw?.trim() ?? ''
  const decoded = Buffer.from(encoded, 'base64')
  if (!encoded || decoded.length !== AES_KEY_BYTES || decoded.toString('base64') !== encoded) {
    throw new AppError(`${name} must be a canonical base64-encoded 32-byte key`, 503, 'INVITE_DELIVERY_KEY_UNAVAILABLE')
  }
  return decoded
}

function encryptionKeys(): EncryptionKey[] {
  const currentId = process.env.HIRE_INVITE_DELIVERY_KEY_ID?.trim()
  if (!currentId) throw new AppError('HIRE_INVITE_DELIVERY_KEY_ID is required', 503, 'INVITE_DELIVERY_KEY_UNAVAILABLE')
  const keys: EncryptionKey[] = [{
    id: currentId,
    value: decodeKey('HIRE_INVITE_DELIVERY_KEY', process.env.HIRE_INVITE_DELIVERY_KEY),
  }]
  const previousId = process.env.HIRE_INVITE_DELIVERY_KEY_ID_PREVIOUS?.trim()
  const previous = process.env.HIRE_INVITE_DELIVERY_KEY_PREVIOUS?.trim()
  if (previousId || previous) {
    if (!previousId || !previous || previousId === currentId) {
      throw new AppError('The previous invite-delivery key requires a distinct id and key', 503, 'INVITE_DELIVERY_KEY_UNAVAILABLE')
    }
    keys.push({ id: previousId, value: decodeKey('HIRE_INVITE_DELIVERY_KEY_PREVIOUS', previous) })
  }
  return keys
}

function aad(input: {
  workspaceId: string
  humanRoundId: string
  kitId: string
  purpose: HireHumanKitDeliveryPurpose
  expiresAt: Date
}): Buffer {
  // A distinct protocol label prevents a human kit ciphertext from ever being
  // accepted by the AI delivery decrypter, even with a shared key rotation.
  return Buffer.from(JSON.stringify({ v: 1, protocol: 'hire-human-kit', ...input, expiresAt: input.expiresAt.toISOString() }), 'utf8')
}

function seal(rawSecret: string, input: {
  workspaceId: string
  humanRoundId: string
  kitId: string
  purpose: HireHumanKitDeliveryPurpose
  expiresAt: Date
}) {
  const key = encryptionKeys()[0]
  const iv = randomBytes(GCM_IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key.value, iv)
  cipher.setAAD(aad(input))
  const ciphertext = Buffer.concat([cipher.update(rawSecret, 'utf8'), cipher.final()])
  return {
    envelopeVersion: 1 as const,
    keyId: key.id,
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
  }
}

function open(row: Pick<IHireHumanKitDelivery,
  'workspaceId' | 'humanRoundId' | 'kitId' | 'purpose' | 'expiresAt' | 'keyId' | 'ciphertext' | 'iv' | 'authTag'
>): string {
  const key = encryptionKeys().find((candidate) => candidate.id === row.keyId)
  if (!key) throw new AppError('The key needed to recover this interview kit is unavailable', 503, 'HUMAN_KIT_RECOVERY_FAILED')
  try {
    const decipher = createDecipheriv('aes-256-gcm', key.value, Buffer.from(row.iv, 'base64'))
    decipher.setAAD(aad({
      workspaceId: row.workspaceId.toString(),
      humanRoundId: row.humanRoundId.toString(),
      kitId: row.kitId.toString(),
      purpose: row.purpose,
      expiresAt: new Date(row.expiresAt),
    }))
    decipher.setAuthTag(Buffer.from(row.authTag, 'base64'))
    return Buffer.concat([decipher.update(Buffer.from(row.ciphertext, 'base64')), decipher.final()]).toString('utf8')
  } catch {
    throw new AppError('The stored interview kit could not be recovered safely', 503, 'HUMAN_KIT_RECOVERY_FAILED')
  }
}

function publicUrl(workspaceId: string, kitId: string, secret: string): string {
  const origin = (process.env.HIRE_PUBLIC_URL || 'https://hire.interviewprep.guru').replace(/\/$/, '')
  return `${origin}/interview-kit/${kitId}#kit=${encodeURIComponent(encodeWorkspaceResourceCapability(workspaceId, kitId, secret))}`
}

function tokenMatchesKit(secret: string, kit: Pick<IHireInterviewKit, 'secretHash'>): boolean {
  return createHash('sha256').update(secret).digest('hex') === kit.secretHash
}

function isKitActive(kit: Pick<IHireInterviewKit, 'active' | 'status' | 'revokedAt' | 'expiresAt'>, now: Date): boolean {
  return kit.active === true && kit.status === 'active' && !kit.revokedAt && kit.expiresAt > now
}

export interface HumanInterviewKitDeliveryView {
  kitId: string
  status: IHireHumanKitDelivery['status']
  attempts: number
  purpose: HireHumanKitDeliveryPurpose
  expiresAt: Date
  sentAt: Date | null
  lastError: string | null
  kitUrl: string | null
  recoverable: boolean
}

export interface HumanInterviewKitDeliveryResult {
  view: HumanInterviewKitDeliveryView
  emailSent: boolean
}

function viewOf(row: IHireHumanKitDelivery, kit: IHireInterviewKit, now: Date): HumanInterviewKitDeliveryView {
  const recoverable = isKitActive(kit, now) && row.expiresAt > now && row.status !== 'cancelled'
  let kitUrl: string | null = null
  if (recoverable) {
    const secret = open(row)
    if (!tokenMatchesKit(secret, kit)) throw new AppError('The stored interview kit no longer matches its capability', 503, 'HUMAN_KIT_RECOVERY_FAILED')
    kitUrl = publicUrl(row.workspaceId.toString(), row.kitId.toString(), secret)
  }
  return {
    kitId: row.kitId.toString(),
    status: row.status,
    attempts: row.attempts,
    purpose: row.purpose,
    expiresAt: row.expiresAt,
    sentAt: row.sentAt ?? null,
    lastError: row.lastError ?? null,
    kitUrl,
    recoverable,
  }
}

/** Called inside the round-creation transaction. */
export async function createHumanInterviewKitDelivery(input: {
  workspaceId: string
  applicationId: string
  jobId: string
  candidateId: string
  humanRoundId: string
  kitId: string
  purpose: HireHumanKitDeliveryPurpose
  recipientName: string
  recipientEmail: string
  workspaceName: string
  jobTitle: string
  dueAt: Date
  expiresAt: Date
  rawSecret: string
  session: ClientSession
}): Promise<IHireHumanKitDelivery> {
  // Keep the authenticated-data shape exactly symmetric with `open()`. The
  // creation input also carries recipient PII and display fields, but neither
  // belongs in the cryptographic coordinate or can be reconstructed by the
  // recovery reader.
  const envelope = seal(input.rawSecret, {
    workspaceId: input.workspaceId,
    humanRoundId: input.humanRoundId,
    kitId: input.kitId,
    purpose: input.purpose,
    expiresAt: input.expiresAt,
  })
  const [created] = await HireHumanKitDelivery.create([{
    workspaceId: input.workspaceId,
    applicationId: input.applicationId,
    jobId: input.jobId,
    candidateId: input.candidateId,
    humanRoundId: input.humanRoundId,
    kitId: input.kitId,
    purpose: input.purpose,
    recipientName: input.recipientName,
    recipientEmail: input.recipientEmail,
    dueAt: input.dueAt,
    expiresAt: input.expiresAt,
    ...envelope,
    status: 'pending',
    attempts: 0,
  }], { session: input.session })
  return created
}

/**
 * Claim a precise pending/failed delivery under every lifecycle fence before
 * egress. `sending + claimToken` is the durable authorization linearization
 * point; no transaction is held across the email provider call.
 */
async function authorizeDelivery(input: {
  ctx: MembershipContext
  kit: IHireInterviewKit
  deliveryId?: string
  purpose?: HireHumanKitDeliveryPurpose
  now: Date
  claimToken: string
}): Promise<IHireHumanKitDelivery | null> {
  try {
    return await withActiveHireWorkspaceWriteTransaction(
      input.ctx.workspace._id,
      input.ctx.membership._id,
      async (session) => {
        await claimHireCandidatePiiWriteFence({
          workspaceId: input.ctx.workspace._id,
          candidateId: input.kit.candidateId,
          session,
        })
        const privacy = await HirePrivacyRequest.exists({
          workspaceId: input.ctx.workspace._id,
          candidateId: input.kit.candidateId,
          live: true,
        }).session(session)
        if (privacy) throw new AppError('A candidate privacy request is in progress', 409, 'CANDIDATE_PRIVACY_PENDING')
        await claimNonTerminalHireApplicationDispatchFence({
          workspaceId: input.ctx.workspace._id,
          applicationId: input.kit.applicationId,
          jobId: input.kit.jobId,
          candidateId: input.kit.candidateId,
          now: input.now,
          session,
        })
        const job = await HireJob.exists({
          _id: input.kit.jobId,
          workspaceId: input.ctx.workspace._id,
          status: 'open',
        }).session(session)
        if (!job) throw new AppError('The job is no longer open', 409, 'JOB_NOT_OPEN')
        const activeKit = await HireInterviewKit.exists({
          _id: input.kit._id,
          workspaceId: input.ctx.workspace._id,
          active: true,
          status: 'active',
          expiresAt: { $gt: input.now },
          revokedAt: { $exists: false },
        }).session(session)
        if (!activeKit) throw new AppError('The interview kit is no longer active', 410, 'HUMAN_KIT_NOT_ACTIVE')
        const currentRound = await HireHumanRound.exists({
          _id: input.kit.humanRoundId,
          workspaceId: input.ctx.workspace._id,
          applicationId: input.kit.applicationId,
          jobId: input.kit.jobId,
          candidateId: input.kit.candidateId,
          status: 'pending_scorecard',
          revokedAt: { $exists: false },
        }).session(session)
        if (!currentRound) throw new AppError('The human round is no longer active', 410, 'HUMAN_ROUND_NOT_ACTIVE')
        const base = {
          workspaceId: input.ctx.workspace._id,
          kitId: input.kit._id,
          applicationId: input.kit.applicationId,
          jobId: input.kit.jobId,
          candidateId: input.kit.candidateId,
          expiresAt: { $gt: input.now },
          ...(input.deliveryId ? { _id: input.deliveryId } : {}),
          ...(input.purpose ? { purpose: input.purpose } : {}),
        }
        return HireHumanKitDelivery.findOneAndUpdate(
          {
            ...base,
            $or: [
              { status: { $in: ['pending', 'failed'] }, dueAt: { $lte: input.now }, attempts: { $lt: HIRE_HUMAN_KIT_MAX_ATTEMPTS } },
              // A reclaimed lease is still an attempt. Without this cap, a
              // worker crash after the final claim could cause unlimited
              // provider egresses. Exhausted leases are terminalized by the
              // worker before this authorization path is reached.
              { status: 'sending', leaseExpiresAt: { $lte: input.now }, attempts: { $lt: HIRE_HUMAN_KIT_MAX_ATTEMPTS } },
            ],
          },
          {
            $set: {
              status: 'sending',
              claimToken: input.claimToken,
              leaseExpiresAt: new Date(input.now.getTime() + CLAIM_LEASE_MS),
            },
            $inc: { attempts: 1 },
            $unset: { lastError: 1, cancelledAt: 1 },
          },
          { new: true, session },
        )
      },
    )
  } catch (error) {
    if (error instanceof HireCandidatePiiTombstoneError) {
      throw new AppError('Candidate personal data is unavailable', 410, 'HIRE_CANDIDATE_PII_TOMBSTONED')
    }
    throw error
  }
}

async function memberContextForWorkspace(workspaceId: mongoose.Types.ObjectId): Promise<MembershipContext | null> {
  const [workspace, member] = await Promise.all([
    HireWorkspace.findOne({ _id: workspaceId, $or: [{ lifecycleState: 'active' }, { lifecycleState: { $exists: false } }] }),
    // Any live member supplies the transaction authority for a durable public
    // delivery task; it does not make them an email recipient or reviewer.
    HireWorkspaceMember.findOne({ workspaceId, authState: 'active' }).sort({ role: 1, createdAt: 1 }),
  ])
  return workspace && member ? { workspace, membership: member } : null
}

async function settleDelivery(input: {
  row: IHireHumanKitDelivery
  claimToken: string
  now: Date
  sent: { ok: boolean; id?: string }
}): Promise<IHireHumanKitDelivery | null> {
  return HireHumanKitDelivery.findOneAndUpdate(
    {
      _id: input.row._id,
      workspaceId: input.row.workspaceId,
      status: 'sending',
      claimToken: input.claimToken,
    },
    {
      $set: input.sent.ok
        ? { status: 'sent', sentAt: input.now, ...(input.sent.id ? { providerMessageId: input.sent.id } : {}) }
        : {
            status: 'failed',
            dueAt: retryDueAt(input.now, input.row.attempts),
            lastError: 'Transactional email provider did not accept the interview kit',
          },
      $unset: { claimToken: 1, leaseExpiresAt: 1 },
    },
    { new: true },
  )
}

/**
 * A final initial-delivery failure needs an HR-visible receipt. The detailed
 * provider failure remains on the protected delivery row; the application
 * audit records only the actionable fact that a replacement kit is needed.
 *
 * This is deliberately best-effort after the durable failure settlement. A
 * failure to append an audit event must not resurrect a spent delivery lease;
 * the member projection still exposes `terminalFailure` from that row.
 */
async function recordTerminalInitialDeliveryFailure(input: {
  row: IHireHumanKitDelivery
  now: Date
}): Promise<void> {
  if (input.row.purpose !== 'initial' || input.row.attempts < HIRE_HUMAN_KIT_MAX_ATTEMPTS) return
  const operationId = `human-kit-delivery-failed:${input.row._id.toString()}`
  try {
    await HireApplication.updateOne(
      {
        _id: input.row.applicationId,
        workspaceId: input.row.workspaceId,
        jobId: input.row.jobId,
        candidateId: input.row.candidateId,
        'events.operationId': { $ne: operationId },
      },
      {
        $push: {
          events: {
            type: 'human_kit_delivery_failed',
            actorName: 'System',
            note: 'Human interview-kit email could not be delivered after all retries',
            operationId,
            at: input.now,
          },
        },
      },
    )
  } catch {
    logger.warn(
      { deliveryId: input.row._id.toString() },
      'hire: could not append terminal human-kit delivery failure receipt',
    )
  }
}

/**
 * A worker can die after taking its final `sending` lease. This transition is
 * deliberately a no-egress terminalizer: recovery can dispatch the opaque
 * row ID, but it can never turn the exhausted lease into attempt six.
 */
async function finalizeExpiredExhaustedDelivery(input: {
  row: IHireHumanKitDelivery
  now: Date
}): Promise<boolean> {
  const finalized = await HireHumanKitDelivery.updateOne(
    {
      _id: input.row._id,
      workspaceId: input.row.workspaceId,
      applicationId: input.row.applicationId,
      jobId: input.row.jobId,
      candidateId: input.row.candidateId,
      status: 'sending',
      leaseExpiresAt: { $lte: input.now },
      attempts: { $gte: HIRE_HUMAN_KIT_MAX_ATTEMPTS },
    },
    {
      $set: {
        status: 'failed',
        lastError: 'Human interview-kit delivery lease expired after the maximum attempts',
      },
      $unset: { claimToken: 1, leaseExpiresAt: 1 },
    },
  )
  if (finalized.matchedCount !== 1) return false
  await recordTerminalInitialDeliveryFailure({ row: input.row, now: input.now })
  return true
}

async function deliveryResultForExisting(ctx: MembershipContext, kit: IHireInterviewKit, now: Date): Promise<HumanInterviewKitDeliveryResult> {
  const row = await HireHumanKitDelivery.findOne({ workspaceId: ctx.workspace._id, kitId: kit._id, purpose: 'initial' })
  if (!row) throw new NotFoundError('Human interview kit delivery')
  return { view: viewOf(row, kit, now), emailSent: row.status === 'sent' }
}

/** Member creation/retry delivery for the initial interviewer email. */
export async function deliverHumanInterviewKit(
  ctx: MembershipContext,
  kitId: string,
  options: { deliveryId?: string; purpose?: HireHumanKitDeliveryPurpose; now?: Date } = {},
): Promise<HumanInterviewKitDeliveryResult> {
  await connectHireControlDB()
  const now = options.now ?? new Date()
  const kit = await HireInterviewKit.findOne({ _id: kitId, workspaceId: ctx.workspace._id }).select('+secretHash')
  if (!kit) throw new NotFoundError('Interview kit')
  if (!isKitActive(kit, now)) throw new AppError('The interview kit is no longer active', 410, 'HUMAN_KIT_NOT_ACTIVE')
  const purpose = options.purpose ?? 'initial'
  const claimToken = randomUUID()
  const claimed = await authorizeDelivery({
    ctx,
    kit,
    ...(options.deliveryId ? { deliveryId: options.deliveryId } : {}),
    purpose,
    now,
    claimToken,
  })
  if (!claimed) return deliveryResultForExisting(ctx, kit, now)

  let secret: string
  try {
    secret = open(claimed)
    if (!tokenMatchesKit(secret, kit)) throw new Error('secret hash mismatch')
  } catch (error) {
    const markedFailed = await HireHumanKitDelivery.updateOne(
      { _id: claimed._id, workspaceId: ctx.workspace._id, status: 'sending', claimToken },
      {
        $set: {
          status: 'failed',
          dueAt: retryDueAt(now, claimed.attempts),
          lastError: 'Stored interview kit could not be recovered safely',
        },
        $unset: { claimToken: 1, leaseExpiresAt: 1 },
      },
    )
    if (markedFailed.matchedCount === 1) {
      await recordTerminalInitialDeliveryFailure({ row: claimed, now })
    }
    throw error
  }
  const [workspace, job] = await Promise.all([
    HireWorkspace.findOne({ _id: ctx.workspace._id }).select('name').lean(),
    HireJob.findOne({ _id: kit.jobId, workspaceId: ctx.workspace._id }).select('title').lean(),
  ])
  if (!workspace || !job) throw new AppError('The interview kit is no longer active', 410, 'HUMAN_KIT_NOT_ACTIVE')
  const template = buildHumanInterviewKitEmail({
    purpose: claimed.purpose,
    interviewerName: claimed.recipientName,
    workspaceName: workspace.name,
    jobTitle: job.title,
    kitUrl: publicUrl(ctx.workspace._id.toString(), kit._id.toString(), secret),
    expiryDays: Math.max(1, Math.ceil((claimed.expiresAt.getTime() - now.getTime()) / 86_400_000)),
  })
  let sent: { ok: boolean; id?: string }
  try {
    sent = await sendEmail({
      to: claimed.recipientEmail,
      subject: template.subject,
      html: template.html,
      text: template.text,
      idempotencyKey: `hire-human-kit:${kit._id.toString()}:${claimed.purpose}`,
      privacySafeLog: true,
    })
  } catch (error) {
    logger.warn({ kitId: kit._id.toString(), purpose: claimed.purpose }, 'hire: human interview kit provider call failed')
    sent = { ok: false }
  }
  const recorded = await settleDelivery({ row: claimed, claimToken, now, sent })
  if (!recorded) throw new Error('Human interview-kit delivery lease was lost after the provider call')
  if (!sent.ok) {
    await recordTerminalInitialDeliveryFailure({ row: claimed, now })
  }
  if (sent.ok) {
    // Initial and reminder rows each transition to sent once. Writing the
    // audit only after that durable settlement avoids a false receipt when a
    // provider accepts a message but our lease is lost before persistence.
    const app = await HireApplication.findOne({
      _id: claimed.applicationId,
      workspaceId: ctx.workspace._id,
      jobId: claimed.jobId,
      candidateId: claimed.candidateId,
    }).select('_id')
    if (app) {
      await HireApplication.updateOne(
        { _id: app._id, workspaceId: ctx.workspace._id },
        {
          $push: {
            events: {
              type: claimed.purpose === 'initial' ? 'human_kit_sent' : 'human_kit_reminded',
              actorName: 'System',
              note: claimed.purpose === 'initial'
                ? 'Human interview kit emailed'
                : 'One human interview-kit scorecard reminder emailed',
              at: now,
            },
          },
        },
      )
    }
  }
  return { view: viewOf(recorded, kit, now), emailSent: sent.ok }
}

/**
 * Create the single reminder only after an initial email has been sent for at
 * least 24 hours. This is a transaction-bound lifecycle operation—not merely
 * an upsert—so privacy, terminal-stage, close, and workspace deletion wins
 * cannot create new recipient PII after their decision commits.
 */
async function ensureReminderForKit(
  ctx: MembershipContext,
  kitId: mongoose.Types.ObjectId,
  now: Date,
): Promise<void> {
  await withActiveHireWorkspaceWriteTransaction(
    ctx.workspace._id,
    ctx.membership._id,
    async (session) => {
      const kit = await HireInterviewKit.findOne({
        _id: kitId,
        workspaceId: ctx.workspace._id,
        active: true,
        status: 'active',
        expiresAt: { $gt: now },
        revokedAt: { $exists: false },
      }, null, { session }).select('+secretHash')
      if (!kit) return
      await claimHireCandidatePiiWriteFence({
        workspaceId: ctx.workspace._id,
        candidateId: kit.candidateId,
        session,
      })
      const privacy = await HirePrivacyRequest.exists({
        workspaceId: ctx.workspace._id,
        candidateId: kit.candidateId,
        live: true,
      }).session(session)
      if (privacy) return
      await claimNonTerminalHireApplicationDispatchFence({
        workspaceId: ctx.workspace._id,
        applicationId: kit.applicationId,
        jobId: kit.jobId,
        candidateId: kit.candidateId,
        now,
        session,
      })
      const job = await HireJob.exists({
        _id: kit.jobId,
        workspaceId: ctx.workspace._id,
        status: 'open',
      }).session(session)
      if (!job) return
      const round = await HireHumanRound.exists({
        _id: kit.humanRoundId,
        workspaceId: ctx.workspace._id,
        applicationId: kit.applicationId,
        jobId: kit.jobId,
        candidateId: kit.candidateId,
        status: 'pending_scorecard',
        revokedAt: { $exists: false },
      }).session(session)
      if (!round) return
      const initial = await HireHumanKitDelivery.findOne({
        workspaceId: ctx.workspace._id,
        kitId: kit._id,
        purpose: 'initial',
        status: 'sent',
        sentAt: { $lte: new Date(now.getTime() - REMINDER_DELAY_MS) },
      }, null, { session })
      if (!initial) return
      // The envelope authenticates its delivery purpose. A reminder must
      // therefore recover the initial secret and seal a new envelope with
      // reminder AAD; copying the ciphertext would fail AES-GCM verification
      // before it could reach the provider.
      const rawSecret = open(initial)
      if (!tokenMatchesKit(rawSecret, kit)) {
        throw new AppError('The stored interview kit no longer matches its capability', 503, 'HUMAN_KIT_RECOVERY_FAILED')
      }
      const reminderEnvelope = seal(rawSecret, {
        workspaceId: ctx.workspace._id.toString(),
        humanRoundId: kit.humanRoundId.toString(),
        kitId: kit._id.toString(),
        purpose: 'reminder',
        expiresAt: kit.expiresAt,
      })
      await HireHumanKitDelivery.updateOne(
        { workspaceId: ctx.workspace._id, kitId: kit._id, purpose: 'reminder' },
        {
          $setOnInsert: {
            workspaceId: ctx.workspace._id,
            applicationId: kit.applicationId,
            jobId: kit.jobId,
            candidateId: kit.candidateId,
            humanRoundId: kit.humanRoundId,
            kitId: kit._id,
            purpose: 'reminder',
            recipientName: initial.recipientName,
            recipientEmail: initial.recipientEmail,
            dueAt: now,
            expiresAt: kit.expiresAt,
            ...reminderEnvelope,
            status: 'pending',
            attempts: 0,
          },
        },
        { upsert: true, session },
      )
    },
  )
}

export async function listDueHumanInterviewKitDeliveryIds(input: {
  workspaceId: string
  limit?: number
  now?: Date
}): Promise<string[]> {
  await connectHireControlDB()
  if (!mongoose.Types.ObjectId.isValid(input.workspaceId)) return []
  const now = input.now ?? new Date()
  const workspaceId = new mongoose.Types.ObjectId(input.workspaceId)
  const kits = await HireInterviewKit.find({
    workspaceId,
    active: true,
    status: 'active',
    expiresAt: { $gt: now },
  }).select('_id').lean()
  const ctx = await memberContextForWorkspace(workspaceId)
  if (!ctx) return []
  for (const kit of kits) {
    try {
      await ensureReminderForKit(ctx, kit._id, now)
    } catch (error) {
      // A lifecycle winner simply means this candidate no longer merits a
      // reminder. Unexpected DB failures leave the sent initial row intact
      // for the next bounded recovery pass.
      if (!(error instanceof AppError) || ![
        'WORKSPACE_DELETION_PENDING',
        'APPLICATION_NOT_ELIGIBLE',
        'JOB_NOT_OPEN',
        'HIRE_CANDIDATE_PII_TOMBSTONED',
      ].includes(error.code)) {
        logger.warn({ workspaceId: input.workspaceId, kitId: kit._id.toString() }, 'hire: human kit reminder creation deferred')
      }
    }
  }
  const rows = await HireHumanKitDelivery.find({
    workspaceId,
    expiresAt: { $gt: now },
    $or: [
      { status: { $in: ['pending', 'failed'] }, dueAt: { $lte: now }, attempts: { $lt: HIRE_HUMAN_KIT_MAX_ATTEMPTS } },
      { status: 'sending', leaseExpiresAt: { $lte: now } },
    ],
  }).sort({ dueAt: 1, _id: 1 }).limit(Math.min(Math.max(1, input.limit ?? HIRE_HUMAN_KIT_RECOVERY_LIMIT_PER_WORKSPACE), HIRE_HUMAN_KIT_RECOVERY_LIMIT_PER_WORKSPACE)).select('_id').lean()
  return rows.map((row) => row._id.toString())
}

/** Durable worker entry: all event payloads are only `{workspaceId,deliveryId}`. */
export async function processHumanInterviewKitDelivery(input: { workspaceId: string; deliveryId: string; now?: Date }): Promise<'sent' | 'retry_scheduled' | 'skipped'> {
  await connectHireControlDB()
  if (!mongoose.Types.ObjectId.isValid(input.workspaceId) || !mongoose.Types.ObjectId.isValid(input.deliveryId)) return 'skipped'
  const now = input.now ?? new Date()
  const workspaceId = new mongoose.Types.ObjectId(input.workspaceId)
  const row = await HireHumanKitDelivery.findOne({ _id: input.deliveryId, workspaceId })
  if (!row) return 'skipped'
  if (
    row.status === 'sending' &&
    row.attempts >= HIRE_HUMAN_KIT_MAX_ATTEMPTS &&
    row.leaseExpiresAt &&
    row.leaseExpiresAt <= now
  ) {
    await finalizeExpiredExhaustedDelivery({ row, now })
    return 'skipped'
  }
  const kit = await HireInterviewKit.findOne({ _id: row.kitId, workspaceId }).select('+secretHash')
  if (!kit || !isKitActive(kit, now)) return 'skipped'
  const ctx = await memberContextForWorkspace(workspaceId)
  if (!ctx) return 'skipped'
  try {
    const result = await deliverHumanInterviewKit(ctx, kit._id.toString(), {
      deliveryId: row._id.toString(),
      purpose: row.purpose,
      now,
    })
    return result.emailSent ? 'sent' : 'retry_scheduled'
  } catch (error) {
    if (error instanceof AppError && ['HUMAN_KIT_NOT_ACTIVE', 'JOB_NOT_OPEN', 'APPLICATION_NOT_ELIGIBLE', 'WORKSPACE_DELETION_PENDING', 'HIRE_CANDIDATE_PII_TOMBSTONED', 'CANDIDATE_PRIVACY_PENDING'].includes(error.code)) return 'skipped'
    logger.warn({ deliveryId: row._id.toString() }, 'hire: human interview kit delivery deferred')
    return 'retry_scheduled'
  }
}

export const __humanKitDelivery = {
  CLAIM_LEASE_MS,
  REMINDER_DELAY_MS,
  MAX_ATTEMPTS: HIRE_HUMAN_KIT_MAX_ATTEMPTS,
  aad,
  seal,
  open,
  retryDueAt,
  finalizeExpiredExhaustedDelivery,
}
