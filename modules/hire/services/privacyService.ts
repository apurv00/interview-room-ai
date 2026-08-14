import { createHash, randomBytes } from 'node:crypto'
import mongoose from 'mongoose'
import { HireAiInviteDelivery } from '../models/HireAiInviteDelivery'
import { HireApplication } from '../models/HireApplication'
import { HireCandidate } from '../models/HireCandidate'
import { HireConsentReceipt } from '../models/HireConsentReceipt'
import { HireEmailOutbox } from '../models/HireEmailOutbox'
import { HireEngineHandoff } from '../models/HireEngineHandoff'
import { HireGuestSession } from '../models/HireGuestSession'
import { HireHumanKitDelivery } from '../models/HireHumanKitDelivery'
import { HireHumanRound } from '../models/HireHumanRound'
import { HireHumanScorecard } from '../models/HireHumanScorecard'
import { HireInterviewAttempt } from '../models/HireInterviewAttempt'
import { HireInterviewKit } from '../models/HireInterviewKit'
import { HireInterviewResult } from '../models/HireInterviewResult'
import { HireIntakeTask } from '../models/HireIntakeTask'
import { HireInvitationBatchItem } from '../models/HireInvitationBatchItem'
import { HireMediaAsset } from '../models/HireMediaAsset'
import {
  HirePrivacyRequest,
  type IHirePrivacyRequest,
} from '../models/HirePrivacyRequest'
import { HireRound } from '../models/HireRound'
import { HireScreeningGate } from '../models/HireScreeningGate'
import { connectHireControlDB } from './hireControlBoundary'
import {
  claimHireCandidatePiiWriteFence,
  HireCandidatePiiTombstoneError,
} from './hireCandidatePrivacyWriteFence'
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
  const coordinate = {
    workspaceId: round.workspaceId,
    candidateId: round.candidateId,
  }
  const verificationSecret = randomBytes(32).toString('hex')
  const verificationCapabilityHash = digest(verificationSecret)
  const verificationExpiresAt = new Date(
    now.getTime() + PRIVACY_VERIFICATION_TTL_MS,
  )
  let request: IHirePrivacyRequest | null = null
  let candidateEmail: string | null = null
  const dbSession = await mongoose.startSession()
  try {
    await dbSession.withTransaction(async () => {
      // Transactions may retry the callback. Do not return an email or a
      // request from an aborted attempt.
      request = null
      candidateEmail = null

      // This is the same row-level fence used by Hire candidate-data writes.
      // A privacy request that commits first is therefore visible to any
      // retried candidate-authorized operation before it can write new data.
      await claimHireCandidatePiiWriteFence({
        ...coordinate,
        session: dbSession,
      })

      const candidate = await HireCandidate.findOne({
        _id: round.candidateId,
        workspaceId: round.workspaceId,
        piiAnonymizedAt: { $exists: false },
      })
        .select('_id workspaceId email')
        .session(dbSession)
        .lean()
      if (!candidate) {
        throw new HirePrivacyError(
          'This privacy request link is invalid',
          'PRIVACY_LINK_INVALID',
          410,
        )
      }

      candidateEmail = candidate.email
      request = await HirePrivacyRequest.findOneAndUpdate(
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
        { new: true, session: dbSession },
      )
      if (request) return

      try {
        const [created] = await HirePrivacyRequest.create(
          [
            {
              ...coordinate,
              requestedViaRoundId: round._id,
              verificationEmailHash: digest(candidate.email.toLowerCase()),
              verificationCapabilityHash,
              verificationExpiresAt,
              status: 'pending_verification',
              live: true,
              requestedAt: now,
            },
          ],
          { session: dbSession },
        )
        request = created
      } catch (error) {
        if (
          !error ||
          typeof error !== 'object' ||
          (error as { code?: number }).code !== 11000
        ) {
          throw error
        }
        request = await HirePrivacyRequest.findOne({
          ...coordinate,
          live: true,
        }).session(dbSession)
        if (!request) throw error
      }
    })
  } catch (error) {
    // A verified deletion that wins the shared fence must not recreate a live
    // request or expose whether that candidate ever existed.
    if (error instanceof HireCandidatePiiTombstoneError) {
      throw new HirePrivacyError(
        'This privacy request link is invalid',
        'PRIVACY_LINK_INVALID',
        410,
      )
    }
    throw error
  } finally {
    await dbSession.endSession()
  }

  // TypeScript cannot follow writes made in a retriable transaction callback;
  // make the committed callback output explicit at the boundary.
  const committedRequest = request as IHirePrivacyRequest | null
  const committedCandidateEmail = candidateEmail as string | null
  if (!committedRequest || !committedCandidateEmail) {
    throw new HirePrivacyError(
      'This privacy request link is invalid',
      'PRIVACY_LINK_INVALID',
      410,
    )
  }
  if (committedRequest.status !== 'pending_verification') {
    throw new HirePrivacyError(
      'A verified privacy request is already being processed',
      'PRIVACY_REQUEST_CONFLICT',
      409,
    )
  }
  return {
    request: committedRequest,
    requestCapability: encodeWorkspaceResourceCapability(
      round.workspaceId.toString(),
      committedRequest._id.toString(),
      verificationSecret,
    ),
    email: committedCandidateEmail,
    emailHint: obfuscateHireEmail(committedCandidateEmail),
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

      // Take the same candidate-row transaction fence used by invitation
      // creation and provider-egress authorization before enumerating or
      // mutating dependent records. This gives verified deletion a defined
      // linearization point: if it wins first, later invitation authorization
      // sees the tombstone/live request and cannot call the provider.
      await claimHireCandidatePiiWriteFence({
        workspaceId: request.workspaceId,
        candidateId: request.candidateId,
        session: dbSession,
      })

      // Deletion-request PII cleanup is part of the verified transaction, not
      // a later retention sweep. Enumerate the candidate's tenant-owned
      // coordinates first so every destructive write carries the complete
      // workspace/candidate/application[/round] authority tuple.
      const applicationCoordinates = await HireApplication.find(scope)
        .select('_id')
        .session(dbSession)
        .lean()
      const applicationIds = applicationCoordinates.map((application) => application._id)
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
        // A human interview kit is an interviewer capability over this
        // candidate's brief. Verified deletion wins the same PII fence used
        // by delivery authorization, so remove all recovery material, the
        // public capability, scorecard prose, and round coordinates in this
        // transaction before the candidate can be anonymized. These are
        // deliberately separate from AI runtime objects: no runtime request
        // is ever made for a human round.
        () => HireHumanKitDelivery.deleteMany(scope, { session: dbSession }),
        () => HireInterviewKit.deleteMany(scope, { session: dbSession }),
        () => HireHumanScorecard.deleteMany(scope, { session: dbSession }),
        () => HireHumanRound.deleteMany(scope, { session: dbSession }),
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
        // A completed task normally clears its payload, but a retry or
        // recovery task may still hold the original resume and supplied PII.
        // Delete only the candidate's exact tenant-owned task coordinates as
        // part of the verified deletion transaction.
        () => HireIntakeTask.deleteMany(scope, { session: dbSession }),
        // A Phase-2 batch never stores recipient PII, but an unsent item
        // could otherwise resolve this candidate's now-anonymized email at
        // delivery time. Terminally cancel it in the same candidate fence
        // transaction; the batch worker treats cancelled items as immutable.
        () => HireInvitationBatchItem.updateMany(
          {
            ...scope,
            status: { $in: ['pending', 'sending', 'failed'] },
          },
          {
            $set: { status: 'cancelled', cancelledAt: now },
            $unset: { claimToken: 1, leaseExpiresAt: 1 },
          },
          { session: dbSession },
        ),
        // Gate snapshots are normally immutable audit records. A verified
        // deletion is the narrow exception: retain aggregate counters and
        // policy facts, but remove every candidate/application coordinate
        // that can re-link the snapshot to the deleted person.
        () => HireScreeningGate.updateMany(
          {
            workspaceId: request.workspaceId,
            $or: [
              { 'rankedApplications.candidateId': request.candidateId },
              { 'rankedApplications.applicationId': { $in: applicationIds } },
              { 'exceptions.applicationId': { $in: applicationIds } },
            ],
          },
          {
            $pull: {
              rankedApplications: {
                $or: [
                  { candidateId: request.candidateId },
                  { applicationId: { $in: applicationIds } },
                ],
              },
              exceptions: { applicationId: { $in: applicationIds } },
            },
          },
          { session: dbSession, overwriteImmutable: true },
        ),
        () =>
          applicationIds.length === 0
            ? Promise.resolve()
            : HireScreeningGate.updateMany(
                {
                  workspaceId: request.workspaceId,
                  'cutLine.applicationId': { $in: applicationIds },
                },
                { $unset: { 'cutLine.applicationId': 1 } },
                { session: dbSession, overwriteImmutable: true },
              ),
        // Redact every durable item, including already-sent/cancelled ones.
        // The status and non-identifying aggregate facts survive, but no item
        // can resolve the deleted candidate, application, round, or provider
        // delivery trace. `overwriteImmutable` is intentionally scoped to
        // this privacy transaction because application/candidate IDs are
        // immutable in all normal workflow code.
        () => HireInvitationBatchItem.updateMany(
          { ...scope, privacyRedactedAt: { $exists: false } },
          {
            $set: { privacyRedactedAt: now },
            $unset: {
              applicationId: 1,
              candidateId: 1,
              roundId: 1,
              inviteDeliveryId: 1,
              deliveryStatus: 1,
              providerMessageId: 1,
              lastError: 1,
              skipReason: 1,
              claimToken: 1,
              leaseExpiresAt: 1,
            },
          },
          { session: dbSession, overwriteImmutable: true },
        ),
        () => HireApplication.updateMany(
          scope,
          {
            $unset: {
              applicantSubmissions: 1,
              'events.$[sensitiveEvent].note': 1,
            },
          },
          {
            session: dbSession,
            arrayFilters: [{
              'sensitiveEvent.type': {
                $in: [
                  'ai_round_sent',
                  'human_round_logged',
                  'human_kit_sent',
                  'human_kit_delivery_failed',
                  'human_kit_reminded',
                  'human_kit_revoked',
                  'human_scorecard_submitted',
                ],
              },
            }],
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
              screeningProfile: 1,
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
