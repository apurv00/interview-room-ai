import crypto from 'crypto'
import mongoose, { type ClientSession } from 'mongoose'
import { AppError, NotFoundError } from '@shared/errors'
import { HireApplication, type HireStage } from '@hire/models/HireApplication'
import { HireCandidate } from '@hire/models/HireCandidate'
import { HireJob } from '@hire/models/HireJob'
import {
  HirePrivacyRequest,
  activeHirePrivacyRequestFilter,
} from '@hire/models/HirePrivacyRequest'
import { HireCandidateStatusLink, type IHireCandidateStatusLink } from '../models'
import {
  CandidateStatusCapabilitySchema,
  CandidateStatusLinkIdSchema,
  IssueCandidateStatusLinkSchema,
} from '../validators/hireStatus'
import {
  CANDIDATE_STATUS_LINK_DEFAULT_EXPIRY_DAYS,
  CANDIDATE_STATUS_LINK_MAX_EXPIRY_DAYS,
  CANDIDATE_STATUS_LINK_PROGRESS_TOTAL,
  type CandidateStatusCapability,
  type CandidateStatusPublicView,
} from '../types'
import {
  CandidateStatusLinkPiiTombstoneError,
  claimCandidateStatusLinkPiiFence,
  connectHireStatusDB,
  resolveCandidateStatusWorkspaceAuthority,
  withCandidateStatusLinkTransaction,
} from './hireStatusBoundary'

const OBJECT_ID = /^[a-f0-9]{24}$/i
const PUBLIC_INACTIVE_CODES = new Set(['WORKSPACE_DELETION_PENDING', 'MEMBER_REMOVED'])

export interface CandidateStatusLinkAuthority {
  workspaceId: string
  memberId: string
  /** Server-derived Hire member name; never accepted from a public caller. */
  memberName: string
}

export interface IssueCandidateStatusLinkInput {
  applicationId: string
  operationId: string
  /** Service-enforced 1..90 day policy; callers may omit it for the 30-day default. */
  expiresInDays?: number
}

export interface CandidateStatusLinkMemberView {
  id: string
  applicationId: string
  active: boolean
  expiresAt: Date
  revokedAt: Date | null
}

export interface IssueCandidateStatusLinkResult {
  link: CandidateStatusLinkMemberView
  /** Present exactly once; its fragment contains the raw secret. */
  statusUrl: string | null
  created: boolean
}

export class CandidateStatusLinkInactiveError extends Error {
  constructor() {
    super('Candidate status link is no longer active')
    this.name = 'CandidateStatusLinkInactiveError'
  }
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function requireObjectId(value: string, label: string): mongoose.Types.ObjectId {
  if (!OBJECT_ID.test(value)) throw new AppError(`Invalid ${label}`, 400, 'INVALID_ID')
  return new mongoose.Types.ObjectId(value)
}

function requireActorName(value: string, label: string): string {
  const normalized = typeof value === 'string' ? value.trim() : ''
  if (!normalized || normalized.length > 120) {
    throw new AppError(`Invalid ${label}`, 400, 'INVALID_ACTOR')
  }
  return normalized
}

function inactiveStatusLink(): CandidateStatusLinkInactiveError {
  return new CandidateStatusLinkInactiveError()
}

function parseCandidateStatusCapability(raw: unknown): CandidateStatusCapability | null {
  const parsed = CandidateStatusCapabilitySchema.safeParse(raw)
  if (!parsed.success) return null
  const [workspaceId, applicationId, jobId, candidateId, linkId, secret] = parsed.data
    .trim()
    .toLowerCase()
    .split('.')
  return { workspaceId, applicationId, jobId, candidateId, linkId, secret }
}

export function encodeCandidateStatusCapability(input: CandidateStatusCapability): string {
  const capability = [
    input.workspaceId,
    input.applicationId,
    input.jobId,
    input.candidateId,
    input.linkId,
    input.secret,
  ]
    .map((coordinate) => coordinate.toLowerCase())
    .join('.')
  if (!CandidateStatusCapabilitySchema.safeParse(capability).success) {
    throw new Error('Invalid candidate status capability coordinate')
  }
  return capability
}

export function candidateStatusUrl(input: CandidateStatusCapability): string {
  const origin = (process.env.HIRE_PUBLIC_URL || 'https://hire.interviewprep.guru').replace(
    /\/$/,
    '',
  )
  const capability = encodeCandidateStatusCapability(input)
  return `${origin}/candidate-status/${input.linkId.toLowerCase()}#status=${encodeURIComponent(capability)}`
}

function serializeMemberLink(
  link: Pick<
    IHireCandidateStatusLink,
    '_id' | 'applicationId' | 'active' | 'expiresAt' | 'revokedAt'
  >,
): CandidateStatusLinkMemberView {
  return {
    id: link._id.toString(),
    applicationId: link.applicationId.toString(),
    active: link.active,
    expiresAt: link.expiresAt,
    revokedAt: link.revokedAt ?? null,
  }
}

/** Explicit neutral mapping. No raw Hire stage, result, PII, or private note can leak. */
export function serializeCandidateStatus(stage: HireStage): CandidateStatusPublicView {
  switch (stage) {
    case 'new':
      return {
        phase: 'received',
        progress: { current: 1, total: CANDIDATE_STATUS_LINK_PROGRESS_TOTAL },
      }
    case 'screened':
      return {
        phase: 'under_review',
        progress: { current: 1, total: CANDIDATE_STATUS_LINK_PROGRESS_TOTAL },
      }
    case 'interviewing':
      return {
        phase: 'interviewing',
        progress: { current: 2, total: CANDIDATE_STATUS_LINK_PROGRESS_TOTAL },
      }
    case 'shortlist':
      return {
        phase: 'under_review',
        progress: { current: 2, total: CANDIDATE_STATUS_LINK_PROGRESS_TOTAL },
      }
    case 'offer':
      return {
        phase: 'decision',
        progress: { current: 3, total: CANDIDATE_STATUS_LINK_PROGRESS_TOTAL },
      }
    case 'hired':
    case 'rejected':
    case 'withdrawn':
      return {
        phase: 'concluded',
        progress: { current: 3, total: CANDIDATE_STATUS_LINK_PROGRESS_TOTAL },
      }
  }
}

function isDuplicateKey(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 11000
}

function isPublicInactiveError(error: unknown): boolean {
  return (
    error instanceof CandidateStatusLinkInactiveError ||
    error instanceof CandidateStatusLinkPiiTombstoneError ||
    (error instanceof AppError && PUBLIC_INACTIVE_CODES.has(error.code))
  )
}

function existingIssueResult(input: {
  link: IHireCandidateStatusLink
  applicationId: mongoose.Types.ObjectId
}): IssueCandidateStatusLinkResult {
  if (input.link.applicationId.toString() !== input.applicationId.toString()) {
    throw new AppError(
      'That operation id was used for another status link',
      409,
      'OPERATION_ID_REUSED',
    )
  }
  return {
    link: serializeMemberLink(input.link),
    statusUrl: null,
    created: false,
  }
}

async function assertStatusLinkScope(input: {
  link: IHireCandidateStatusLink
  now: Date
  session: ClientSession
}): Promise<{ stage: HireStage }> {
  const application = await HireApplication.findOne(
    {
      _id: input.link.applicationId,
      workspaceId: input.link.workspaceId,
      jobId: input.link.jobId,
      candidateId: input.link.candidateId,
    },
    null,
    { session: input.session },
  ).select('stage')
  const job = await HireJob.exists({
    _id: input.link.jobId,
    workspaceId: input.link.workspaceId,
  }).session(input.session)
  const candidate = await HireCandidate.exists({
    _id: input.link.candidateId,
    workspaceId: input.link.workspaceId,
    piiAnonymizedAt: { $exists: false },
  }).session(input.session)
  const privacy = await HirePrivacyRequest.exists({
    workspaceId: input.link.workspaceId,
    candidateId: input.link.candidateId,
    ...activeHirePrivacyRequestFilter(input.now),
  }).session(input.session)
  if (!application || !job || !candidate || privacy) throw inactiveStatusLink()
  await claimCandidateStatusLinkPiiFence({
    workspaceId: input.link.workspaceId,
    candidateId: input.link.candidateId,
    session: input.session,
  })
  return { stage: application.stage }
}

async function loadActiveCandidateStatusLink(input: {
  capability: CandidateStatusCapability
  now: Date
  session: ClientSession
}): Promise<IHireCandidateStatusLink | null> {
  return HireCandidateStatusLink.findOne(
    {
      _id: input.capability.linkId,
      workspaceId: input.capability.workspaceId,
      applicationId: input.capability.applicationId,
      jobId: input.capability.jobId,
      candidateId: input.capability.candidateId,
      secretHash: sha256(input.capability.secret),
      active: true,
      status: 'active',
      expiresAt: { $gt: input.now },
      revokedAt: { $exists: false },
    },
    null,
    { session: input.session },
  ).select('+secretHash')
}

/**
 * Issue a distinct, copy-once fragment URL. This core does not send email;
 * future lifecycle code owns delivery and may retain only the public URL in
 * the request that receives it.
 */
export async function issueCandidateStatusLink(
  authority: CandidateStatusLinkAuthority,
  input: IssueCandidateStatusLinkInput,
): Promise<IssueCandidateStatusLinkResult> {
  await connectHireStatusDB()
  const validatedInput = IssueCandidateStatusLinkSchema.safeParse(input)
  if (!validatedInput.success) {
    throw new AppError('Invalid candidate status-link input', 400, 'INVALID_STATUS_LINK_INPUT')
  }
  const workspaceId = requireObjectId(authority.workspaceId, 'workspace id')
  const memberId = requireObjectId(authority.memberId, 'member id')
  const memberName = requireActorName(authority.memberName, 'member name')
  const applicationId = requireObjectId(validatedInput.data.applicationId, 'application id')
  const expiresInDays =
    validatedInput.data.expiresInDays ?? CANDIDATE_STATUS_LINK_DEFAULT_EXPIRY_DAYS
  const issuedAt = new Date()
  const expiresAt = new Date(issuedAt.getTime() + expiresInDays * 86_400_000)
  const linkId = new mongoose.Types.ObjectId()
  const rawSecret = crypto.randomBytes(32).toString('hex')
  try {
    return await withCandidateStatusLinkTransaction(workspaceId, memberId, async (session) => {
      const existing = await HireCandidateStatusLink.findOne(
        {
          workspaceId,
          applicationId,
          issuanceOperationId: validatedInput.data.operationId,
        },
        null,
        { session },
      )
      if (existing) return existingIssueResult({ link: existing, applicationId })

      const application = await HireApplication.findOne({ _id: applicationId, workspaceId }, null, {
        session,
      }).select('_id jobId candidateId')
      if (!application) throw new NotFoundError('Application')
      const job = await HireJob.exists({
        _id: application.jobId,
        workspaceId,
      }).session(session)
      const candidate = await HireCandidate.exists({
        _id: application.candidateId,
        workspaceId,
        piiAnonymizedAt: { $exists: false },
      }).session(session)
      const privacy = await HirePrivacyRequest.exists({
        workspaceId,
        candidateId: application.candidateId,
        ...activeHirePrivacyRequestFilter(issuedAt),
      }).session(session)
      if (!job || !candidate) throw new NotFoundError('Application')
      if (privacy)
        throw new AppError(
          'Candidate privacy request is in progress',
          409,
          'CANDIDATE_PRIVACY_PENDING',
        )
      await claimCandidateStatusLinkPiiFence({
        workspaceId,
        candidateId: application.candidateId,
        session,
      })
      const [created] = await HireCandidateStatusLink.create(
        [
          {
            _id: linkId,
            workspaceId,
            applicationId: application._id,
            jobId: application.jobId,
            candidateId: application.candidateId,
            issuedByMemberId: memberId,
            issuedByName: memberName,
            issuanceOperationId: validatedInput.data.operationId,
            secretHash: sha256(rawSecret),
            issuedAt,
            expiresAt,
            active: true,
            status: 'active',
          },
        ],
        { session },
      )
      return {
        link: serializeMemberLink(created),
        statusUrl: candidateStatusUrl({
          workspaceId: workspaceId.toString(),
          applicationId: application._id.toString(),
          jobId: application.jobId.toString(),
          candidateId: application.candidateId.toString(),
          linkId: linkId.toString(),
          secret: rawSecret,
        }),
        created: true,
      }
    })
  } catch (error) {
    // A racing, committed creator wins; recovery intentionally cannot recover
    // the raw secret, preserving hash-only copy-once semantics.
    if (isDuplicateKey(error)) {
      const existing = await HireCandidateStatusLink.findOne({
        workspaceId,
        applicationId,
        issuanceOperationId: validatedInput.data.operationId,
      })
      if (existing) return existingIssueResult({ link: existing, applicationId })
    }
    if (error instanceof CandidateStatusLinkPiiTombstoneError) {
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
 * Member-facing lifecycle list. It deliberately omits a capability, hash,
 * candidate identity, job identity, and revocation reason.
 */
export async function listCandidateStatusLinks(input: {
  workspaceId: string
  applicationId: string
}): Promise<CandidateStatusLinkMemberView[]> {
  await connectHireStatusDB()
  const workspaceId = requireObjectId(input.workspaceId, 'workspace id')
  const applicationId = requireObjectId(input.applicationId, 'application id')
  const application = await HireApplication.exists({
    _id: applicationId,
    workspaceId,
  })
  if (!application) throw new NotFoundError('Application')
  const links = await HireCandidateStatusLink.find({
    workspaceId,
    applicationId,
  }).sort({ createdAt: -1 })
  return links.map((link) => serializeMemberLink(link))
}

/**
 * Resolve an anonymous capability to the intentionally minimal public view.
 * Every malformed, expired, revoked, cross-coordinate, privacy, workspace,
 * or membership failure returns null so HTTP can use one uniform inactive
 * response.
 */
export async function resolveCandidateStatusLink(input: {
  linkId: string
  capability: string
}): Promise<CandidateStatusPublicView | null> {
  await connectHireStatusDB()
  if (!CandidateStatusLinkIdSchema.safeParse(input.linkId).success) return null
  const capability = parseCandidateStatusCapability(input.capability)
  if (!capability || capability.linkId !== input.linkId.toLowerCase()) return null
  const workspaceId = new mongoose.Types.ObjectId(capability.workspaceId)
  const authorityMemberId = await resolveCandidateStatusWorkspaceAuthority(workspaceId)
  if (!authorityMemberId) return null
  const now = new Date()
  try {
    return await withCandidateStatusLinkTransaction(
      workspaceId,
      authorityMemberId,
      async (session) => {
        const link = await loadActiveCandidateStatusLink({
          capability,
          now,
          session,
        })
        if (!link) throw inactiveStatusLink()
        const scope = await assertStatusLinkScope({ link, now, session })
        // This exact conditional claim makes public bootstrap conflict with a
        // concurrent revoke after every scope/privacy fence has succeeded.
        const claimed = await HireCandidateStatusLink.updateOne(
          {
            _id: link._id,
            workspaceId: link.workspaceId,
            applicationId: link.applicationId,
            jobId: link.jobId,
            candidateId: link.candidateId,
            secretHash: sha256(capability.secret),
            active: true,
            status: 'active',
            expiresAt: { $gt: now },
            revokedAt: { $exists: false },
          },
          { $set: { updatedAt: now } },
          { session, timestamps: false },
        )
        if (claimed.matchedCount !== 1) throw inactiveStatusLink()
        return serializeCandidateStatus(scope.stage)
      },
    )
  } catch (error) {
    if (isPublicInactiveError(error)) return null
    throw error
  }
}

/**
 * Member-only explicit revoke. Lifecycle integrations can instead call the
 * scope helper below inside their own transaction.
 */
export async function revokeCandidateStatusLink(input: {
  authority: CandidateStatusLinkAuthority
  linkId: string
}): Promise<CandidateStatusLinkMemberView> {
  await connectHireStatusDB()
  const workspaceId = requireObjectId(input.authority.workspaceId, 'workspace id')
  const memberId = requireObjectId(input.authority.memberId, 'member id')
  const memberName = requireActorName(input.authority.memberName, 'member name')
  const linkId = requireObjectId(input.linkId, 'status link id')
  const now = new Date()
  const link = await withCandidateStatusLinkTransaction(workspaceId, memberId, async (session) => {
    const updated = await HireCandidateStatusLink.findOneAndUpdate(
      {
        _id: linkId,
        workspaceId,
        active: true,
        status: 'active',
        revokedAt: { $exists: false },
      },
      {
        $set: {
          active: false,
          status: 'revoked',
          revokedAt: now,
          revokedByMemberId: memberId,
          revokedByName: memberName,
          revocationReason: 'Recruiter revoked the candidate status link',
        },
        $unset: { secretHash: 1 },
      },
      { new: true, session },
    )
    if (!updated) throw new NotFoundError('Active candidate status link')
    return updated
  })
  return serializeMemberLink(link)
}

/**
 * Narrow lifecycle port: callers pass their own existing transaction. This
 * module deliberately does not hook privacy, retention, pipeline, or purge
 * flows itself.
 */
interface CandidateStatusLinkLifecycleRevocationInput {
  workspaceId: mongoose.Types.ObjectId
  candidateId?: mongoose.Types.ObjectId
  applicationId?: mongoose.Types.ObjectId
  reason: string
  at: Date
  session: ClientSession
}

function lifecycleRevocationFilter(
  input: CandidateStatusLinkLifecycleRevocationInput,
  allowWorkspaceScope: boolean,
) {
  if (!allowWorkspaceScope && !input.candidateId && !input.applicationId) {
    throw new Error('Candidate status-link revocation requires a candidate or application scope')
  }
  return {
    workspaceId: input.workspaceId,
    ...(input.candidateId ? { candidateId: input.candidateId } : {}),
    ...(input.applicationId ? { applicationId: input.applicationId } : {}),
    active: true,
    status: 'active',
    revokedAt: { $exists: false },
  }
}

async function revokeCandidateStatusLinksInTransaction(
  input: CandidateStatusLinkLifecycleRevocationInput,
  allowWorkspaceScope: boolean,
): Promise<void> {
  await HireCandidateStatusLink.updateMany(
    lifecycleRevocationFilter(input, allowWorkspaceScope),
    {
      $set: {
        active: false,
        status: 'revoked',
        revokedAt: input.at,
        revocationReason: input.reason.slice(0, 160),
      },
      $unset: { secretHash: 1 },
    },
    { session: input.session },
  )
}

export async function revokeCandidateStatusLinksForScope(
  input: CandidateStatusLinkLifecycleRevocationInput,
): Promise<void> {
  await revokeCandidateStatusLinksInTransaction(input, false)
}

/**
 * Deliberately separate from the candidate/application helper: a workspace
 * lifecycle caller must opt into revoking every status link explicitly.
 */
export async function revokeCandidateStatusLinksForWorkspace(
  input: Omit<
    CandidateStatusLinkLifecycleRevocationInput,
    'candidateId' | 'applicationId'
  >,
): Promise<void> {
  await revokeCandidateStatusLinksInTransaction(input, true)
}

export const __candidateStatusLink = {
  parseCandidateStatusCapability,
  serializeCandidateStatus,
  serializeMemberLink,
}
