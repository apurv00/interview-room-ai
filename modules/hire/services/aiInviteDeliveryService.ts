import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from 'crypto'
import type { ClientSession } from 'mongoose'
import { AppError, NotFoundError } from '@shared/errors'
import { sendEmail } from '@shared/services/emailService'
import { logger } from '@shared/logger'
import { buildAiInviteEmail } from '../emails/aiInviteEmail'
import {
  HireAiInviteDelivery,
  HirePrivacyRequest,
  HireRound,
  type HireAiInviteDeliveryStatus,
  type IHireAiInviteDelivery,
  type IHireRound,
} from '../models'
import { connectHireControlDB } from './hireControlBoundary'
import { withActiveHireWorkspaceWriteTransaction } from './hireWorkspaceWriteFence'
import {
  claimHireCandidatePiiWriteFence,
  HireCandidatePiiTombstoneError,
} from './hireCandidatePrivacyWriteFence'
import { claimNonTerminalHireApplicationDispatchFence } from './hireApplicationDispatchFence'
import type { MembershipContext } from './workspaceService'
import { encodeWorkspaceCapability } from './workspaceCapability'

const AES_KEY_BYTES = 32
const GCM_IV_BYTES = 12
const CLAIM_LEASE_MS = 5 * 60_000

interface InviteEncryptionKey {
  id: string
  value: Buffer
}

interface DeliveryCoordinates {
  workspaceId: string
  roundId: string
  expiresAt: Date
}

export interface AiInviteDeliveryView {
  roundId: string
  status: HireAiInviteDeliveryStatus
  attempts: number
  expiresAt: Date
  sentAt: Date | null
  lastError: string | null
  inviteUrl: string | null
  recoverable: boolean
}

export interface AiInviteDeliveryResult {
  view: AiInviteDeliveryView
  emailSent: boolean
}

function decodeEncryptionKey(name: string, raw: string | undefined): Buffer {
  const encoded = raw?.trim() ?? ''
  const decoded = Buffer.from(encoded, 'base64')
  if (!encoded || decoded.length !== AES_KEY_BYTES || decoded.toString('base64') !== encoded) {
    throw new AppError(
      `${name} must be a canonical base64-encoded 32-byte key`,
      503,
      'INVITE_DELIVERY_KEY_UNAVAILABLE',
    )
  }
  return decoded
}

function inviteEncryptionKeys(): InviteEncryptionKey[] {
  const currentId = process.env.HIRE_INVITE_DELIVERY_KEY_ID?.trim()
  if (!currentId) {
    throw new AppError(
      'HIRE_INVITE_DELIVERY_KEY_ID is required',
      503,
      'INVITE_DELIVERY_KEY_UNAVAILABLE',
    )
  }
  const keys: InviteEncryptionKey[] = [{
    id: currentId,
    value: decodeEncryptionKey(
      'HIRE_INVITE_DELIVERY_KEY',
      process.env.HIRE_INVITE_DELIVERY_KEY,
    ),
  }]
  const previousId = process.env.HIRE_INVITE_DELIVERY_KEY_ID_PREVIOUS?.trim()
  const previousValue = process.env.HIRE_INVITE_DELIVERY_KEY_PREVIOUS?.trim()
  if (previousId || previousValue) {
    if (!previousId || !previousValue || previousId === currentId) {
      throw new AppError(
        'The previous invite-delivery key requires a distinct id and key',
        503,
        'INVITE_DELIVERY_KEY_UNAVAILABLE',
      )
    }
    keys.push({
      id: previousId,
      value: decodeEncryptionKey(
        'HIRE_INVITE_DELIVERY_KEY_PREVIOUS',
        previousValue,
      ),
    })
  }
  return keys
}

function authenticatedContext(input: DeliveryCoordinates): Buffer {
  return Buffer.from(
    JSON.stringify({
      v: 1,
      workspaceId: input.workspaceId,
      roundId: input.roundId,
      expiresAt: input.expiresAt.toISOString(),
    }),
    'utf8',
  )
}

function encryptToken(rawToken: string, coordinates: DeliveryCoordinates) {
  const key = inviteEncryptionKeys()[0]
  const iv = randomBytes(GCM_IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key.value, iv)
  cipher.setAAD(authenticatedContext(coordinates))
  const ciphertext = Buffer.concat([
    cipher.update(rawToken, 'utf8'),
    cipher.final(),
  ])
  return {
    envelopeVersion: 1 as const,
    keyId: key.id,
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
  }
}

function decryptToken(
  row: Pick<
    IHireAiInviteDelivery,
    'workspaceId' | 'roundId' | 'expiresAt' | 'keyId' | 'ciphertext' | 'iv' | 'authTag'
  >,
): string {
  const key = inviteEncryptionKeys().find((candidate) => candidate.id === row.keyId)
  if (!key) {
    throw new AppError(
      'The key needed to recover this invite is unavailable',
      503,
      'INVITE_DELIVERY_KEY_UNAVAILABLE',
    )
  }
  try {
    const coordinates = {
      workspaceId: row.workspaceId.toString(),
      roundId: row.roundId.toString(),
      expiresAt: new Date(row.expiresAt),
    }
    const decipher = createDecipheriv(
      'aes-256-gcm',
      key.value,
      Buffer.from(row.iv, 'base64'),
    )
    decipher.setAAD(authenticatedContext(coordinates))
    decipher.setAuthTag(Buffer.from(row.authTag, 'base64'))
    return Buffer.concat([
      decipher.update(Buffer.from(row.ciphertext, 'base64')),
      decipher.final(),
    ]).toString('utf8')
  } catch {
    throw new AppError(
      'The stored invite failed authenticated decryption',
      503,
      'INVITE_DELIVERY_RECOVERY_FAILED',
    )
  }
}

function appBaseUrl(): string {
  return (process.env.HIRE_PUBLIC_URL || 'https://hire.interviewprep.guru').replace(/\/$/, '')
}

function inviteUrl(workspaceId: string, roundId: string, rawToken: string): string {
  const capability = encodeWorkspaceCapability(workspaceId, rawToken)
  return `${appBaseUrl()}/candidate/${roundId}#invite=${encodeURIComponent(capability)}`
}

function tokenMatchesRound(rawToken: string, round: Pick<IHireRound, 'inviteTokenHash'>): boolean {
  return createHash('sha256').update(rawToken).digest('hex') === round.inviteTokenHash
}

function isRoundRecoverable(
  round: Pick<IHireRound, 'status' | 'revokedAt' | 'inviteTokenExpiry'>,
  now: Date,
): boolean {
  return (
    !round.revokedAt &&
    round.status !== 'revoked' &&
    round.status !== 'completed' &&
    round.inviteTokenExpiry > now
  )
}

function viewOf(
  row: IHireAiInviteDelivery,
  round: Pick<IHireRound, 'status' | 'revokedAt' | 'inviteTokenExpiry' | 'inviteTokenHash'>,
  now: Date,
): AiInviteDeliveryView {
  const recoverable = isRoundRecoverable(round, now) && row.expiresAt > now
  let url: string | null = null
  if (recoverable) {
    const token = decryptToken(row)
    if (!tokenMatchesRound(token, round)) {
      throw new AppError(
        'The stored invite no longer matches its round',
        503,
        'INVITE_DELIVERY_RECOVERY_FAILED',
      )
    }
    url = inviteUrl(row.workspaceId.toString(), row.roundId.toString(), token)
  }
  return {
    roundId: row.roundId.toString(),
    status: row.status,
    attempts: row.attempts,
    expiresAt: row.expiresAt,
    sentAt: row.sentAt ?? null,
    lastError: row.lastError ?? null,
    inviteUrl: url,
    recoverable,
  }
}

/** Called inside the same transaction that creates the hash-only round. */
export async function createAiInviteDeliveryRecord(input: {
  workspaceId: string
  applicationId: string
  jobId: string
  candidateId: string
  roundId: string
  recipientEmail: string
  recipientName: string
  jobTitle: string
  workspaceName: string
  verifyByCode: boolean
  expiresAt: Date
  rawToken: string
  session: ClientSession
}): Promise<IHireAiInviteDelivery> {
  const envelope = encryptToken(input.rawToken, {
    workspaceId: input.workspaceId,
    roundId: input.roundId,
    expiresAt: input.expiresAt,
  })
  const created = await HireAiInviteDelivery.create([{
    workspaceId: input.workspaceId,
    applicationId: input.applicationId,
    jobId: input.jobId,
    candidateId: input.candidateId,
    roundId: input.roundId,
    recipientEmail: input.recipientEmail,
    recipientName: input.recipientName,
    jobTitle: input.jobTitle,
    workspaceName: input.workspaceName,
    verifyByCode: input.verifyByCode,
    expiresAt: input.expiresAt,
    ...envelope,
    status: 'pending',
    attempts: 0,
    manualRetryCount: 0,
  }], { session: input.session })
  return created[0]
}

/** Authenticated recruiter reload/copy view, batched and tenant-scoped. */
export async function getAiInviteDeliveryViews(
  ctx: MembershipContext,
  rounds: Array<
    Pick<IHireRound, '_id' | 'status' | 'revokedAt' | 'inviteTokenExpiry' | 'inviteTokenHash'>
  >,
  now = new Date(),
): Promise<Map<string, AiInviteDeliveryView>> {
  await connectHireControlDB()
  const roundById = new Map(rounds.map((round) => [round._id.toString(), round]))
  if (roundById.size === 0) return new Map()
  const rows = await HireAiInviteDelivery.find({
    workspaceId: ctx.workspace._id,
    roundId: { $in: Array.from(roundById.keys()) },
  })
  const views = new Map<string, AiInviteDeliveryView>()
  for (const row of rows) {
    const round = roundById.get(row.roundId.toString())
    if (round) views.set(row.roundId.toString(), viewOf(row, round, now))
  }
  return views
}

async function existingDeliveryResult(
  ctx: MembershipContext,
  round: IHireRound,
  now: Date,
): Promise<AiInviteDeliveryResult> {
  const row = await HireAiInviteDelivery.findOne({
    workspaceId: ctx.workspace._id,
    roundId: round._id,
  })
  if (!row) throw new NotFoundError('AI invite delivery')
  if (!isRoundRecoverable(round, now) || row.expiresAt <= now) {
    throw new AppError('The interview invitation has expired', 410, 'ROUND_EXPIRED')
  }
  return { view: viewOf(row, round, now), emailSent: row.status === 'sent' }
}

/**
 * Persist the authorization for one provider egress under the same candidate
 * row fence used by verified privacy deletion. `sending + claimToken` is the
 * durable authorization marker: it is committed before the provider sees an
 * email, ties authorization to this exact lease, and is consumed by the
 * existing post-provider state transition.
 *
 * We intentionally do not hold a database transaction across the provider
 * call. The semantic boundary is the committed authorization marker: if a
 * verified deletion wins first, the candidate fence/live privacy check makes
 * authorization fail and no provider call is made. If authorization wins,
 * the send was authorized before deletion; the deletion transaction removes
 * the delivery record and prevents any recovery/retry egress afterwards.
 */
async function authorizeAiInviteDeliveryEgress(input: {
  ctx: MembershipContext
  round: IHireRound
  now: Date
  claimToken: string
  manualRetry: boolean
}): Promise<IHireAiInviteDelivery | null> {
  try {
    return await withActiveHireWorkspaceWriteTransaction(
      input.ctx.workspace._id,
      input.ctx.membership._id,
      async (session) => {
        const privacyRequest = await HirePrivacyRequest.exists({
          workspaceId: input.ctx.workspace._id,
          candidateId: input.round.candidateId,
          live: true,
        }).session(session)
        if (privacyRequest) {
          throw new AppError(
            'A candidate privacy request is in progress',
            409,
            'CANDIDATE_PRIVACY_PENDING',
          )
        }

        await claimHireCandidatePiiWriteFence({
          workspaceId: input.ctx.workspace._id,
          candidateId: input.round.candidateId,
          session,
        })

        // An existing round is not itself permission to email. Reclaim the
        // application under the same transaction as the delivery lease so a
        // terminal stage decision that won after the round was created blocks
        // provider egress as well.
        await claimNonTerminalHireApplicationDispatchFence({
          workspaceId: input.ctx.workspace._id,
          applicationId: input.round.applicationId,
          jobId: input.round.jobId,
          candidateId: input.round.candidateId,
          now: input.now,
          session,
        })

        // Re-read the active round in this transaction. Privacy deletion
        // revokes/un-lives rounds, so a stale preflight read cannot authorize
        // a message after deletion has already committed.
        const activeRound = await HireRound.exists({
          _id: input.round._id,
          workspaceId: input.ctx.workspace._id,
          applicationId: input.round.applicationId,
          jobId: input.round.jobId,
          candidateId: input.round.candidateId,
          live: true,
          status: { $nin: ['completed', 'revoked'] },
          revokedAt: { $exists: false },
          inviteTokenExpiry: { $gt: input.now },
        }).session(session)
        if (!activeRound) {
          throw new AppError(
            'The interview invitation is no longer active',
            410,
            'ROUND_NOT_ACTIVE',
          )
        }

        return HireAiInviteDelivery.findOneAndUpdate(
          {
            workspaceId: input.ctx.workspace._id,
            roundId: input.round._id,
            applicationId: input.round.applicationId,
            jobId: input.round.jobId,
            candidateId: input.round.candidateId,
            expiresAt: { $gt: input.now },
            $or: [
              { status: { $in: ['pending', 'failed'] } },
              { status: 'sending', leaseExpiresAt: { $lte: input.now } },
            ],
          },
          {
            $set: {
              status: 'sending',
              claimToken: input.claimToken,
              leaseExpiresAt: new Date(input.now.getTime() + CLAIM_LEASE_MS),
              ...(input.manualRetry
                ? {
                    lastManualRetryAt: input.now,
                    lastManualRetryByMemberId: input.ctx.membership._id,
                    lastManualRetryByName:
                      input.ctx.membership.name || input.ctx.membership.email,
                  }
                : {}),
            },
            $inc: {
              attempts: 1,
              ...(input.manualRetry ? { manualRetryCount: 1 } : {}),
            },
            $unset: { lastError: 1 },
          },
          { new: true, session },
        )
      },
    )
  } catch (error) {
    if (error instanceof HireCandidatePiiTombstoneError) {
      throw new AppError(
        'Candidate personal data is unavailable',
        410,
        'HIRE_CANDIDATE_PII_TOMBSTONED',
      )
    }
    throw error
  }
}

/**
 * Lease + stable provider key make retries safe across both pre-send and
 * post-provider-acceptance crashes. A recorded `sent` state is a no-op.
 */
export async function deliverAiInvite(
  ctx: MembershipContext,
  roundId: string,
  options: { manualRetry?: boolean; now?: Date } = {},
): Promise<AiInviteDeliveryResult> {
  await connectHireControlDB()
  const now = options.now ?? new Date()
  const round = await HireRound.findOne({
    _id: roundId,
    workspaceId: ctx.workspace._id,
  })
  if (!round) throw new NotFoundError('Round')
  if (!isRoundRecoverable(round, now)) {
    throw new AppError('The interview invitation is no longer active', 410, 'ROUND_NOT_ACTIVE')
  }

  const claimToken = randomUUID()
  const claimed = await authorizeAiInviteDeliveryEgress({
    ctx,
    round,
    now,
    claimToken,
    manualRetry: Boolean(options.manualRetry),
  })
  if (!claimed) return existingDeliveryResult(ctx, round, now)

  let rawToken: string
  try {
    rawToken = decryptToken(claimed)
    if (!tokenMatchesRound(rawToken, round)) throw new Error('token hash mismatch')
  } catch (error) {
    await HireAiInviteDelivery.updateOne(
      {
        _id: claimed._id,
        workspaceId: ctx.workspace._id,
        roundId: round._id,
        status: 'sending',
        claimToken,
      },
      {
        $set: {
          status: 'failed',
          lastError: 'Stored invitation could not be recovered safely',
        },
        $unset: { claimToken: 1, leaseExpiresAt: 1 },
      },
    )
    throw error
  }

  const recoveredUrl = inviteUrl(
    ctx.workspace._id.toString(),
    round._id.toString(),
    rawToken,
  )
  const email = buildAiInviteEmail({
    candidateName: claimed.recipientName,
    jobTitle: claimed.jobTitle,
    workspaceName: claimed.workspaceName,
    inviteUrl: recoveredUrl,
    expiryDays: Math.max(1, Math.ceil((claimed.expiresAt.getTime() - now.getTime()) / 86_400_000)),
    verifyByCode: claimed.verifyByCode,
  })

  let sent: Awaited<ReturnType<typeof sendEmail>>
  try {
    sent = await sendEmail({
      to: claimed.recipientEmail,
      subject: email.subject,
      html: email.html,
      text: email.text,
      idempotencyKey: `hire-ai-round:${round._id.toString()}`,
    })
  } catch (error) {
    logger.warn({ roundId: round._id.toString(), error }, 'hire: AI invite provider call failed')
    sent = { ok: false }
  }

  const recorded = await HireAiInviteDelivery.findOneAndUpdate(
    {
      _id: claimed._id,
      workspaceId: ctx.workspace._id,
      roundId: round._id,
      status: 'sending',
      claimToken,
    },
    {
      $set: sent.ok
        ? {
            status: 'sent',
            sentAt: now,
            ...(sent.id ? { providerMessageId: sent.id } : {}),
          }
        : {
            status: 'failed',
            lastError: 'Transactional email provider did not accept the invitation',
          },
      $unset: { claimToken: 1, leaseExpiresAt: 1 },
    },
    { new: true },
  )
  if (!recorded) {
    throw new Error('AI invite delivery lease was lost after the provider call')
  }
  return {
    view: viewOf(recorded, round, now),
    emailSent: sent.ok,
  }
}

export const __aiInviteDelivery = {
  CLAIM_LEASE_MS,
}
