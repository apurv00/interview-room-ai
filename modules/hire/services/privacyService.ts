import { createHash, randomBytes } from 'node:crypto'
import mongoose from 'mongoose'
import { HireAiInviteDelivery } from '../models/HireAiInviteDelivery'
import { HireApplication } from '../models/HireApplication'
import { HireCandidate } from '../models/HireCandidate'
import { HireConsentReceipt } from '../models/HireConsentReceipt'
import { HireEmailOutbox } from '../models/HireEmailOutbox'
import { HireEngineHandoff } from '../models/HireEngineHandoff'
import { HireGuestSession } from '../models/HireGuestSession'
import { HireInterviewAttempt } from '../models/HireInterviewAttempt'
import { HireInterviewResult } from '../models/HireInterviewResult'
import { HireMediaAsset } from '../models/HireMediaAsset'
import {
  HirePrivacyRequest,
  type IHirePrivacyRequest,
} from '../models/HirePrivacyRequest'
import { HireRound } from '../models/HireRound'
import { connectHireControlDB } from './hireControlBoundary'
import { deliverRuntimeRevocation } from './engineRevocationService'
import {
  decodeWorkspaceCapability,
  decodeWorkspaceResourceCapability,
  encodeWorkspaceResourceCapability,
} from './workspaceCapability'

const OBJECT_ID = /^[a-f0-9]{24}$/i
export const PRIVACY_VERIFICATION_TTL_MS = 10 * 60 * 1000

export class HirePrivacyError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'PRIVACY_LINK_INVALID'
      | 'PRIVACY_REQUEST_INVALID'
      | 'PRIVACY_REQUEST_CONFLICT',
    readonly status: number,
  ) {
    super(message)
    this.name = 'HirePrivacyError'
  }
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

export function obfuscateHireEmail(email: string): string {
  const [local, domain] = email.split('@')
  if (!local || !domain) return '***'
  return `${local.slice(0, 1)}***@${domain}`
}

export async function createHirePrivacyRequestFromInvite(input: {
  roundId: string
  inviteCapability: string
  now?: Date
}): Promise<{
  request: IHirePrivacyRequest
  requestCapability: string
  email: string
  emailHint: string
}> {
  const invite = decodeWorkspaceCapability(input.inviteCapability)
  if (!OBJECT_ID.test(input.roundId) || !invite) {
    throw new HirePrivacyError(
      'This privacy request link is invalid',
      'PRIVACY_LINK_INVALID',
      410,
    )
  }
  await connectHireControlDB()
  const now = input.now ?? new Date()
  // Deliberately accepts an expired/revoked interview invitation: deletion
  // rights outlive interview access. Mailbox OTP remains the second factor.
  const round = await HireRound.findOne({
    _id: input.roundId,
    workspaceId: invite.workspaceId,
    inviteTokenHash: digest(invite.secret),
  }).lean()
  if (!round) {
    throw new HirePrivacyError(
      'This privacy request link is invalid',
      'PRIVACY_LINK_INVALID',
      410,
    )
  }
  const candidate = await HireCandidate.findOne({
    _id: round.candidateId,
    workspaceId: round.workspaceId,
  })
    .select('_id workspaceId email')
    .lean()
  if (!candidate) {
    throw new HirePrivacyError(
      'This privacy request link is invalid',
      'PRIVACY_LINK_INVALID',
      410,
    )
  }

  const coordinate = {
    workspaceId: round.workspaceId,
    candidateId: round.candidateId,
  }
  const verificationSecret = randomBytes(32).toString('hex')
  const verificationCapabilityHash = digest(verificationSecret)
  const verificationExpiresAt = new Date(
    now.getTime() + PRIVACY_VERIFICATION_TTL_MS,
  )
  let request = await HirePrivacyRequest.findOneAndUpdate(
    {
      ...coordinate,
      status: 'pending_verification',
      live: true,
    },
    {
      $set: {
        requestedViaRoundId: round._id,
        verificationEmailHash: digest(candidate.email.toLowerCase()),
        verificationCapabilityHash,
        verificationExpiresAt,
        requestedAt: now,
      },
    },
    { new: true },
  )
  if (!request) {
    try {
      request = await HirePrivacyRequest.create({
        ...coordinate,
        requestedViaRoundId: round._id,
        verificationEmailHash: digest(candidate.email.toLowerCase()),
        verificationCapabilityHash,
        verificationExpiresAt,
        status: 'pending_verification',
        live: true,
        requestedAt: now,
      })
    } catch (error) {
      if (
        error &&
        typeof error === 'object' &&
        (error as { code?: number }).code === 11000
      ) {
        request = await HirePrivacyRequest.findOne({
          ...coordinate,
          live: true,
        })
      }
      if (!request) throw error
    }
  }
  if (request.status !== 'pending_verification') {
    throw new HirePrivacyError(
      'A verified privacy request is already being processed',
      'PRIVACY_REQUEST_CONFLICT',
      409,
    )
  }
  return {
    request,
    requestCapability: encodeWorkspaceResourceCapability(
      round.workspaceId.toString(),
      request._id.toString(),
      verificationSecret,
    ),
    email: candidate.email,
    emailHint: obfuscateHireEmail(candidate.email),
  }
}

export async function getHirePrivacyVerificationTarget(input: {
  requestCapability: string
  now?: Date
}): Promise<{ request: IHirePrivacyRequest; email: string }> {
  const capability = decodeWorkspaceResourceCapability(input.requestCapability)
  if (!capability) {
    throw new HirePrivacyError(
      'Privacy verification failed',
      'PRIVACY_REQUEST_INVALID',
      400,
    )
  }
  await connectHireControlDB()
  const now = input.now ?? new Date()
  const request = await HirePrivacyRequest.findOne({
    _id: capability.resourceId,
    workspaceId: capability.workspaceId,
    verificationCapabilityHash: digest(capability.secret),
    status: 'pending_verification',
    live: true,
    verificationExpiresAt: { $gt: now },
  })
  if (!request) {
    throw new HirePrivacyError(
      'Privacy verification failed',
      'PRIVACY_REQUEST_INVALID',
      400,
    )
  }
  const candidate = await HireCandidate.findOne({
    _id: request.candidateId,
    workspaceId: request.workspaceId,
  })
    .select('email')
    .lean()
  if (
    !candidate ||
    digest(candidate.email.toLowerCase()) !== request.verificationEmailHash
  ) {
    throw new HirePrivacyError(
      'Privacy verification failed',
      'PRIVACY_REQUEST_INVALID',
      400,
    )
  }
  return { request, email: candidate.email }
}

export async function applyVerifiedHirePrivacyRequest(input: {
  requestCapability: string
  now?: Date
}): Promise<{ workspaceId: string; candidateId: string }> {
  const capability = decodeWorkspaceResourceCapability(input.requestCapability)
  if (!capability) {
    throw new HirePrivacyError(
      'Privacy verification failed',
      'PRIVACY_REQUEST_INVALID',
      400,
    )
  }
  await connectHireControlDB()
  const now = input.now ?? new Date()
  const dbSession = await mongoose.startSession()
  try {
    let output: { workspaceId: string; candidateId: string } | undefined
    await dbSession.withTransaction(async () => {
      const request = await HirePrivacyRequest.findOneAndUpdate(
        {
          _id: capability.resourceId,
          workspaceId: capability.workspaceId,
          verificationCapabilityHash: digest(capability.secret),
          status: 'pending_verification',
          live: true,
          verificationExpiresAt: { $gt: now },
        },
        {
          $set: { status: 'processing', verifiedAt: now, processingAt: now },
        },
        { new: true, session: dbSession },
      )
      if (!request) {
        const existing = await HirePrivacyRequest.findOne({
          _id: capability.resourceId,
          workspaceId: capability.workspaceId,
          verificationCapabilityHash: digest(capability.secret),
          status: { $in: ['processing', 'completed'] },
        }).session(dbSession)
        if (!existing) {
          throw new HirePrivacyError(
            'Privacy verification failed',
            'PRIVACY_REQUEST_INVALID',
            400,
          )
        }
        output = {
          workspaceId: existing.workspaceId.toString(),
          candidateId: existing.candidateId.toString(),
        }
        return
      }
      const scope = {
        workspaceId: request.workspaceId,
        candidateId: request.candidateId,
      }
      output = {
        workspaceId: request.workspaceId.toString(),
        candidateId: request.candidateId.toString(),
      }

      // Deletion-request PII cleanup is part of the verified transaction, not
      // a later retention sweep. Enumerate the candidate's tenant-owned
      // coordinates first so every destructive write carries the complete
      // workspace/candidate/application[/round] authority tuple.
      const applicationCoordinates = await HireApplication.find(scope)
        .select('_id')
        .session(dbSession)
        .lean()
      const roundCoordinates = await HireRound.find(scope)
        .select('_id applicationId')
        .session(dbSession)
        .lean()

      if (applicationCoordinates.length > 0) {
        await HireEmailOutbox.bulkWrite(
          applicationCoordinates.map((application) => ({
            deleteMany: {
              filter: {
                workspaceId: request.workspaceId,
                candidateId: request.candidateId,
                applicationId: application._id,
              },
            },
          })),
          { session: dbSession },
        )
      }
      if (roundCoordinates.length > 0) {
        await HireAiInviteDelivery.deleteMany(
          {
            workspaceId: request.workspaceId,
            candidateId: request.candidateId,
            $or: roundCoordinates.map((round) => ({
              applicationId: round.applicationId,
              roundId: round._id,
            })),
          },
          { session: dbSession },
        )
        await HireConsentReceipt.bulkWrite(
          roundCoordinates.map((round) => ({
            updateMany: {
              filter: {
                workspaceId: request.workspaceId,
                candidateId: request.candidateId,
                applicationId: round.applicationId,
                roundId: round._id,
              },
              // Preserve the immutable consent version, disclosure digest,
              // accepted facts and timestamp; only device-derived PII goes.
              update: { $unset: { userAgent: 1, locale: 1 } },
              overwriteImmutable: true,
            },
          })),
          { session: dbSession },
        )
      }

      // The MongoDB driver does not support parallel operations on one
      // transaction session. Execute each scoped mutation in order so the
      // candidate-row privacy fence is a real serialization point.
      for (const mutate of [
        () => HireGuestSession.updateMany(
          { ...scope, active: true },
          { $set: { revokedAt: now }, $unset: { active: 1 } },
          { session: dbSession },
        ),
        () => HireInterviewAttempt.updateMany(
          { ...scope, live: true },
          { $set: { status: 'revoked' }, $unset: { live: 1 } },
          { session: dbSession },
        ),
        () => HireEngineHandoff.updateMany(
          { ...scope, revokedAt: { $exists: false } },
          { $set: { revokedAt: now } },
          { session: dbSession },
        ),
        // Every round receives a durable runtime-purge tombstone, including
        // an already-completed round. The signed runtime call is attempted
        // after commit and retried by the revocation worker until confirmed.
        () => HireRound.updateMany(
          scope,
          {
            $set: {
              revokedAt: now,
              revocationState: 'pending',
              revocationReason: 'Candidate privacy deletion request',
              runtimePurgeRequested: true,
            },
            $unset: { live: 1 },
          },
          { session: dbSession },
        ),
        () => HireRound.updateMany(
          { ...scope, status: { $nin: ['completed', 'revoked'] } },
          { $set: { status: 'revoked' } },
          { session: dbSession },
        ),
        () => HireMediaAsset.updateMany(
          { ...scope, state: { $ne: 'purged' } },
          {
            $set: { purgeEligibleAt: now, purgeReason: 'privacy_request' },
            $unset: { active: 1 },
          },
          { session: dbSession },
        ),
        () => HireInterviewResult.updateMany(
          { ...scope, piiPurgedAt: { $exists: false } },
          {
            $set: { piiPurgedAt: now },
            $unset: {
              rawEngineOutput: 1,
              projection: 1,
              evidenceIndex: 1,
            },
          },
          { session: dbSession },
        ),
        () => HireApplication.updateMany(
          scope,
          {
            $unset: {
              applicantSubmissions: 1,
              'events.$[inviteEvent].note': 1,
            },
          },
          {
            session: dbSession,
            arrayFilters: [{ 'inviteEvent.type': 'ai_round_sent' }],
          },
        ),
        () => HireApplication.updateMany(
          { ...scope, resumeMatch: { $exists: true } },
          {
            $set: {
              'resumeMatch.strengths': [],
              'resumeMatch.gaps': [],
              'resumeMatch.resumeHash': '0'.repeat(64),
              'resumeMatch.stale': true,
            },
          },
          { session: dbSession },
        ),
        // Legacy HireRound snapshots may contain answer/transcript PII. Keep
        // numeric scores/decisions, remove text evidence and identity snapshots.
        () => HireRound.updateMany(
          scope,
          {
            $set: {
              candidateEmail: `deleted-${request.candidateId.toString()}@privacy.invalid`,
            },
            $unset: {
              candidateName: 1,
              consentUserAgent: 1,
              'results.perQuestion': 1,
              'results.redFlags': 1,
              'results.topImprovements': 1,
            },
          },
          { session: dbSession },
        ),
        () => HireCandidate.updateOne(
          { _id: request.candidateId, workspaceId: request.workspaceId },
          {
            $set: {
              name: 'Deleted candidate',
              email: `deleted-${request.candidateId.toString()}@privacy.invalid`,
              piiAnonymizedAt: now,
              piiAnonymizationReason: 'privacy_request',
            },
            $unset: {
              phone: 1,
              resumeText: 1,
              resumeFileName: 1,
              anonymizationClaimToken: 1,
              anonymizationLeaseExpiresAt: 1,
              anonymizationLastError: 1,
            },
          },
          { session: dbSession },
        ),
      ]) {
        await mutate()
      }
    })
    if (!output) {
      throw new HirePrivacyError(
        'Privacy request could not be applied',
        'PRIVACY_REQUEST_CONFLICT',
        409,
      )
    }
    const applied = output
    const workspaceId = applied.workspaceId.toString()
    const rounds = await HireRound.find({
      workspaceId: applied.workspaceId,
      candidateId: applied.candidateId,
      runtimePurgeRequested: true,
      runtimePurgedAt: { $exists: false },
      revocationState: { $in: ['pending', 'failed'] },
    })
      .select('_id')
      .lean()
    await Promise.all(
      rounds.map((round) =>
        deliverRuntimeRevocation(workspaceId, round._id.toString()),
      ),
    )
    return applied
  } finally {
    await dbSession.endSession()
  }
}

export const __privacy = { digest }
