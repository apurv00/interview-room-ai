import { createHash, randomBytes } from 'node:crypto'
import mongoose, { type ClientSession } from 'mongoose'
import { HireApplication } from '../models/HireApplication'
import {
  HireConsentReceipt,
  type HireConsentAcknowledgements,
} from '../models/HireConsentReceipt'
import { HireGuestSession, type IHireGuestSession } from '../models/HireGuestSession'
import { HireInterviewAttempt } from '../models/HireInterviewAttempt'
import { HireJob } from '../models/HireJob'
import { HireMediaAsset } from '../models/HireMediaAsset'
import { HireRound } from '../models/HireRound'
import { HireWorkspace } from '../models/HireWorkspace'
import {
  HIRE_AI_CONSENT_VERSION,
  HIRE_AI_DISCLOSURE_DIGEST,
  type HireConsentSnapshot,
  assertCompleteHireConsent,
  isRecognizedHireConsentSnapshot,
} from '../policies/aiInterviewConsent'
import { connectHireControlDB } from './hireControlBoundary'
import { decodeWorkspaceCapability } from './workspaceCapability'

const OBJECT_ID = /^[a-f0-9]{24}$/i
const GUEST_SECRET = /^[a-f0-9]{64}$/i
const GUEST_SESSION_TTL_MS = 8 * 60 * 60 * 1000

export function getHireGuestCookieName(
  environment: string | undefined = process.env.NODE_ENV,
): '__Host-hire_guest' | 'hire_guest' {
  return environment === 'production' ? '__Host-hire_guest' : 'hire_guest'
}

export const HIRE_GUEST_COOKIE_NAME = getHireGuestCookieName()
export const HIRE_GUEST_CSRF_HEADER = 'x-hire-csrf'

export class HireGuestAccessError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'INVALID_INVITE'
      | 'INVITE_EXPIRED'
      | 'GUEST_SESSION_INVALID'
      | 'GUEST_SESSION_CONFLICT'
      | 'ATTEMPT_NOT_READY',
    readonly status: number,
  ) {
    super(message)
    this.name = 'HireGuestAccessError'
  }
}

export interface HireGuestScope {
  sessionId: string
  workspaceId: string
  applicationId: string
  jobId: string
  candidateId: string
  roundId: string
  attemptId: string
  expiresAt: Date
}

export interface AcceptHireConsentInput {
  roundId: string
  inviteCapability: string
  accepted: Partial<Record<keyof HireConsentAcknowledgements, boolean>>
  userAgent?: string
  locale?: string
  now?: Date
}

export interface AcceptedHireConsent {
  scope: HireGuestScope
  credential: string
  csrfToken: string
  consentVersion: string
  disclosureDigest: string
  next: 'identity_photo' | 'resume'
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function encodeCredential(input: {
  workspaceId: string
  applicationId: string
  roundId: string
  attemptId: string
  secret: string
}): string {
  return [
    input.workspaceId,
    input.applicationId,
    input.roundId,
    input.attemptId,
    input.secret,
  ].join('.')
}

function decodeCredential(raw: string): {
  workspaceId: string
  applicationId: string
  roundId: string
  attemptId: string
  secret: string
} | null {
  const parts = raw.split('.')
  if (
    parts.length !== 5 ||
    parts.slice(0, 4).some((value) => !OBJECT_ID.test(value)) ||
    !GUEST_SECRET.test(parts[4])
  ) {
    return null
  }
  return {
    workspaceId: parts[0].toLowerCase(),
    applicationId: parts[1].toLowerCase(),
    roundId: parts[2].toLowerCase(),
    attemptId: parts[3].toLowerCase(),
    secret: parts[4].toLowerCase(),
  }
}

async function issueSession(
  scope: Omit<HireGuestScope, 'sessionId' | 'expiresAt'>,
  inviteExpiresAt: Date,
  now: Date,
  dbSession: ClientSession,
  consent: HireConsentSnapshot,
  next: AcceptedHireConsent['next'],
): Promise<AcceptedHireConsent> {
  const secret = randomBytes(32).toString('hex')
  const csrfToken = randomBytes(32).toString('hex')
  const expiresAt = new Date(
    Math.min(inviteExpiresAt.getTime(), now.getTime() + GUEST_SESSION_TTL_MS),
  )

  await HireGuestSession.updateMany(
    {
      workspaceId: scope.workspaceId,
      applicationId: scope.applicationId,
      roundId: scope.roundId,
      attemptId: scope.attemptId,
      active: true,
    },
    { $set: { revokedAt: now }, $unset: { active: 1 } },
    { session: dbSession },
  )
  const sessionId = new mongoose.Types.ObjectId()
  await HireGuestSession.create(
    [
      {
        _id: sessionId,
        ...scope,
        secretHash: digest(secret),
        csrfHash: digest(csrfToken),
        expiresAt,
        active: true,
      },
    ],
    { session: dbSession },
  )

  return {
    scope: { ...scope, sessionId: sessionId.toString(), expiresAt },
    credential: encodeCredential({
      workspaceId: scope.workspaceId,
      applicationId: scope.applicationId,
      roundId: scope.roundId,
      attemptId: scope.attemptId,
      secret,
    }),
    csrfToken,
    consentVersion: consent.consentVersion,
    disclosureDigest: consent.disclosureDigest,
    next,
  }
}

async function resolveCandidateNextStep(
  attempt: {
    _id: mongoose.Types.ObjectId
    status: string
    identityPhotoAssetId?: mongoose.Types.ObjectId
    startedAt?: Date
    recordingEpoch?: Date
  },
  coordinate: {
    workspaceId: string
    applicationId: string
    roundId: string
  },
  now: Date,
  dbSession: ClientSession,
): Promise<AcceptedHireConsent['next']> {
  if (attempt.status !== 'ready' && attempt.status !== 'in_progress') {
    return 'identity_photo'
  }
  if (
    !attempt.identityPhotoAssetId ||
    (attempt.status === 'in_progress' && (!attempt.startedAt || !attempt.recordingEpoch))
  ) {
    if (attempt.status === 'in_progress') {
      throw new HireGuestAccessError(
        'The active interview attempt cannot be resumed safely',
        'GUEST_SESSION_CONFLICT',
        409,
      )
    }
    return 'identity_photo'
  }
  const retainedPhoto = await HireMediaAsset.exists({
    _id: attempt.identityPhotoAssetId,
    workspaceId: coordinate.workspaceId,
    applicationId: coordinate.applicationId,
    roundId: coordinate.roundId,
    attemptId: attempt._id,
    kind: 'identity_photo',
    state: 'ready',
    active: true,
    $or: [
      { purgeEligibleAt: { $exists: false } },
      { purgeEligibleAt: { $gt: now } },
    ],
  }).session(dbSession)
  if (!retainedPhoto) {
    if (attempt.status === 'in_progress') {
      throw new HireGuestAccessError(
        'The saved identity photo is no longer available',
        'GUEST_SESSION_CONFLICT',
        409,
      )
    }
    return 'identity_photo'
  }
  return 'resume'
}

async function acceptOnce(
  input: AcceptHireConsentInput & { accepted: HireConsentAcknowledgements },
): Promise<AcceptedHireConsent> {
  const now = input.now ?? new Date()
  const invite = decodeWorkspaceCapability(input.inviteCapability)
  if (!invite) {
    throw new HireGuestAccessError(
      'This interview invitation is no longer valid',
      'INVALID_INVITE',
      410,
    )
  }
  const dbSession = await mongoose.startSession()
  try {
    let output: AcceptedHireConsent | undefined
    await dbSession.withTransaction(async () => {
      const round = await HireRound.findOne({
        _id: input.roundId,
        workspaceId: invite.workspaceId,
        inviteTokenHash: digest(invite.secret),
        inviteTokenExpiry: { $gt: now },
        status: { $nin: ['completed', 'revoked'] },
        revokedAt: { $exists: false },
      }).session(dbSession)
      if (!round) {
        throw new HireGuestAccessError(
          'This interview invitation is no longer valid',
          'INVITE_EXPIRED',
          410,
        )
      }

      const coordinate = {
        workspaceId: round.workspaceId.toString(),
        applicationId: round.applicationId.toString(),
        jobId: round.jobId.toString(),
        candidateId: round.candidateId.toString(),
        roundId: round._id.toString(),
      }
      const workspaceFence = await HireWorkspace.updateOne(
        {
          _id: coordinate.workspaceId,
          $or: [
            { lifecycleState: 'active' },
            { lifecycleState: { $exists: false } },
          ],
        },
        { $inc: { writeFenceVersion: 1 } },
        { session: dbSession },
      )
      if (workspaceFence.matchedCount !== 1) {
        throw new HireGuestAccessError(
          'This interview invitation is no longer valid',
          'INVITE_EXPIRED',
          410,
        )
      }
      const application = await HireApplication.exists({
        _id: coordinate.applicationId,
        workspaceId: coordinate.workspaceId,
        jobId: coordinate.jobId,
        candidateId: coordinate.candidateId,
      }).session(dbSession)
      if (!application) {
        throw new HireGuestAccessError(
          'This interview invitation is no longer valid',
          'INVALID_INVITE',
          410,
        )
      }

      let attempt = await HireInterviewAttempt.findOne({
        ...coordinate,
        live: true,
      }).session(dbSession)
      let consent: HireConsentSnapshot = {
        consentVersion: HIRE_AI_CONSENT_VERSION,
        disclosureDigest: HIRE_AI_DISCLOSURE_DIGEST,
      }

      if (!attempt) {
        const job = await HireJob.updateOne({ _id: coordinate.jobId, workspaceId: coordinate.workspaceId, status: 'open' }, { $inc: { intakeWriteVersion: 1, candidateReadVersion: 1 } }, { session: dbSession })
        if (job.matchedCount !== 1) throw new HireGuestAccessError('This interview invitation is no longer valid', 'INVITE_EXPIRED', 410)
        const [priorAttempts, attemptId, receiptId] = await Promise.all([
          HireInterviewAttempt.countDocuments(coordinate).session(dbSession),
          Promise.resolve(new mongoose.Types.ObjectId()),
          Promise.resolve(new mongoose.Types.ObjectId()),
        ])
        await HireConsentReceipt.create(
          [
            {
              _id: receiptId,
              ...coordinate,
              attemptId,
              consentVersion: HIRE_AI_CONSENT_VERSION,
              disclosureDigest: HIRE_AI_DISCLOSURE_DIGEST,
              accepted: input.accepted,
              acceptedAt: now,
              userAgent: input.userAgent?.slice(0, 512),
              locale: input.locale?.slice(0, 40),
            },
          ],
          { session: dbSession },
        )
        const created = await HireInterviewAttempt.create(
          [
            {
              _id: attemptId,
              ...coordinate,
              sequence: priorAttempts + 1,
              status: 'photo_pending',
              live: true,
              consentReceiptId: receiptId,
            },
          ],
          { session: dbSession },
        )
        attempt = created[0]
        await HireRound.updateOne(
          {
            _id: coordinate.roundId,
            workspaceId: coordinate.workspaceId,
            applicationId: coordinate.applicationId,
          },
          {
            $set: {
              status: 'consented',
              consentAt: now,
              consentVersion: HIRE_AI_CONSENT_VERSION,
              consentUserAgent: input.userAgent?.slice(0, 512),
            },
          },
          { session: dbSession },
        )
      } else {
        const receipt = await HireConsentReceipt.findOne({
          _id: attempt.consentReceiptId,
          ...coordinate,
          attemptId: attempt._id,
          'accepted.recording': true,
          'accepted.identityPhoto': true,
          'accepted.attentionMonitoring': true,
          'accepted.aiEvaluation': true,
        })
          .select('consentVersion disclosureDigest')
          .session(dbSession)
          .lean<Pick<HireConsentSnapshot, 'consentVersion' | 'disclosureDigest'> | null>()
        if (!isRecognizedHireConsentSnapshot(receipt)) {
          throw new HireGuestAccessError(
            'The active interview attempt has no valid consent receipt',
            'GUEST_SESSION_CONFLICT',
            409,
          )
        }
        consent = {
          consentVersion: receipt.consentVersion,
          disclosureDigest: receipt.disclosureDigest,
        }
      }

      const next = await resolveCandidateNextStep(attempt, coordinate, now, dbSession)
      output = await issueSession(
        { ...coordinate, attemptId: attempt._id.toString() },
        round.inviteTokenExpiry,
        now,
        dbSession,
        consent,
        next,
      )
    })
    if (!output) {
      throw new HireGuestAccessError('Could not start the interview', 'GUEST_SESSION_CONFLICT', 409)
    }
    return output
  } finally {
    await dbSession.endSession()
  }
}

export async function acceptHireConsentAndIssueGuestSession(
  input: AcceptHireConsentInput,
): Promise<AcceptedHireConsent> {
  assertCompleteHireConsent(input.accepted)
  if (!OBJECT_ID.test(input.roundId) || !decodeWorkspaceCapability(input.inviteCapability)) {
    throw new HireGuestAccessError(
      'This interview invitation is no longer valid',
      'INVALID_INVITE',
      410,
    )
  }
  await connectHireControlDB()
  const acceptedInput = { ...input, accepted: input.accepted }
  try {
    return await acceptOnce(acceptedInput)
  } catch (error) {
    if (error && typeof error === 'object' && (error as { code?: number }).code === 11000) {
      return acceptOnce(acceptedInput)
    }
    throw error
  }
}

export async function resolveHireGuestSession(input: {
  roundId: string
  credential?: string
  csrfToken?: string
  now?: Date
}): Promise<HireGuestScope> {
  const decoded = input.credential ? decodeCredential(input.credential) : null
  if (
    !decoded ||
    decoded.roundId !== input.roundId.toLowerCase() ||
    !input.csrfToken ||
    !GUEST_SECRET.test(input.csrfToken)
  ) {
    throw new HireGuestAccessError(
      'The candidate session is invalid',
      'GUEST_SESSION_INVALID',
      401,
    )
  }
  await connectHireControlDB()
  const now = input.now ?? new Date()
  const session = await HireGuestSession.findOne({
    workspaceId: decoded.workspaceId,
    applicationId: decoded.applicationId,
    roundId: decoded.roundId,
    attemptId: decoded.attemptId,
    secretHash: digest(decoded.secret),
    csrfHash: digest(input.csrfToken.toLowerCase()),
    active: true,
    revokedAt: { $exists: false },
    expiresAt: { $gt: now },
  }).lean<IHireGuestSession | null>()
  if (!session) {
    throw new HireGuestAccessError(
      'The candidate session is invalid',
      'GUEST_SESSION_INVALID',
      401,
    )
  }
  return {
    sessionId: session._id.toString(),
    workspaceId: session.workspaceId.toString(),
    applicationId: session.applicationId.toString(),
    jobId: session.jobId.toString(),
    candidateId: session.candidateId.toString(),
    roundId: session.roundId.toString(),
    attemptId: session.attemptId.toString(),
    expiresAt: session.expiresAt,
  }
}

export async function revokeHireGuestSessionsForCandidate(input: {
  workspaceId: string
  candidateId: string
  now?: Date
}): Promise<number> {
  await connectHireControlDB()
  const now = input.now ?? new Date()
  const result = await HireGuestSession.updateMany(
    { workspaceId: input.workspaceId, candidateId: input.candidateId, active: true },
    { $set: { revokedAt: now }, $unset: { active: 1 } },
  )
  return result.modifiedCount ?? 0
}

export const __identityConsent = {
  decodeCredential,
  digest,
  GUEST_SESSION_TTL_MS,
}
