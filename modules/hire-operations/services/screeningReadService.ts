import mongoose from 'mongoose'
import { AppError, NotFoundError } from '@shared/errors'
import {
  activeHirePrivacyRequestFilter,
  connectHireControlDB,
  HireApplication,
  HireCandidate,
  HireInvitationBatch,
  HireInvitationBatchItem,
  HireJob,
  HirePrivacyRequest,
  HireScreeningGate,
  type IHireInvitationBatch,
  type HireInvitationBatchItemDeliveryStatus,
  type HireInvitationBatchItemSelectionReason,
  type HireInvitationBatchItemStatus,
  type HireScreeningScoreState,
  type MembershipContext,
} from '@hire-operations-boundary'

const OBJECT_ID = /^[a-f0-9]{24}$/i

export const HIRE_SCREENING_RECIPIENT_DEFAULT_LIMIT = 25
export const HIRE_SCREENING_RECIPIENT_MAX_LIMIT = 50

export type ScreeningCandidateIdentityState =
  | 'available'
  | 'privacy_protected'
  | 'unavailable'

export interface ScreeningCandidateCoordinate {
  applicationId: string
  candidateId: string
}

export interface ScreeningMemberCandidateView {
  applicationId: string
  candidateId: string
  identityState: ScreeningCandidateIdentityState
  displayName: string | null
  email: string | null
  applicationUrl: string | null
}

export type ScreeningRecipientIssueCode =
  | 'privacy_redacted'
  | 'delivery_failed'
  | 'retry_scheduled'
  | 'delivery_cancelled'
  | 'delivery_skipped'

export interface ScreeningRecipientDeliveryView {
  id: string
  batchId: string
  applicationId: string | null
  candidate: ScreeningMemberCandidateView | null
  identityState: ScreeningCandidateIdentityState | 'privacy_redacted'
  rank: number | null
  score: number | null
  scoreState: HireScreeningScoreState
  selectionReason: HireInvitationBatchItemSelectionReason
  sendAfter: Date
  status: HireInvitationBatchItemStatus
  deliveryStatus: HireInvitationBatchItemDeliveryStatus | null
  attempts: number
  sentAt: Date | null
  issue: {
    code: ScreeningRecipientIssueCode
    message: string
  } | null
}

export interface JobScreeningMemberReadProjection {
  candidates: ScreeningMemberCandidateView[]
}

export interface ScreeningRecipientPage {
  recipients: ScreeningRecipientDeliveryView[]
  hasMore: boolean
  nextCursor: ScreeningRecipientCursor | null
}

export interface ScreeningRecipientCursor { itemId: string }

export interface ScreeningBatchCursor { wave: number; id: string }
export interface ScreeningBatchPage {
  batches: IHireInvitationBatch[]
  hasMore: boolean
  nextCursor: ScreeningBatchCursor | null
}

interface ApplicationRow {
  _id: mongoose.Types.ObjectId
  candidateId: mongoose.Types.ObjectId
}

interface CandidateRow {
  _id: mongoose.Types.ObjectId
  name: string
  email: string
}

interface InvitationItemRow {
  _id: mongoose.Types.ObjectId
  invitationBatchId: mongoose.Types.ObjectId
  applicationId?: mongoose.Types.ObjectId
  candidateId?: mongoose.Types.ObjectId
  privacyRedactedAt?: Date
  rank?: number
  score: number | null
  scoreState: HireScreeningScoreState
  selectionReason: HireInvitationBatchItemSelectionReason
  sendAfter: Date
  status: HireInvitationBatchItemStatus
  deliveryStatus?: HireInvitationBatchItemDeliveryStatus
  attempts: number
  sentAt?: Date
  lastError?: string
}

function unavailableCandidate(
  coordinate: ScreeningCandidateCoordinate,
  identityState: Exclude<ScreeningCandidateIdentityState, 'available'>,
): ScreeningMemberCandidateView {
  return {
    ...coordinate,
    identityState,
    displayName: null,
    email: null,
    applicationUrl: null,
  }
}

/**
 * Translate mutable worker detail into a stable member-facing message. Raw
 * provider errors and hidden delivery claims never cross the API boundary.
 */
function controlledRecipientIssue(
  item: InvitationItemRow,
): ScreeningRecipientDeliveryView['issue'] {
  if (item.privacyRedactedAt) {
    return {
      code: 'privacy_redacted',
      message: 'Candidate identity and delivery coordinates were removed for privacy.',
    }
  }
  if (item.status === 'failed') {
    return {
      code: 'delivery_failed',
      message: 'Invitation delivery failed after the available attempts.',
    }
  }
  if (item.status === 'pending' && item.lastError) {
    return {
      code: 'retry_scheduled',
      message: 'The last delivery attempt failed; an automatic retry is scheduled.',
    }
  }
  if (item.status === 'cancelled') {
    return {
      code: 'delivery_cancelled',
      message: 'Invitation delivery was cancelled before completion.',
    }
  }
  if (item.status === 'skipped') {
    return {
      code: 'delivery_skipped',
      message: 'Invitation delivery was skipped because the candidate is no longer eligible.',
    }
  }
  return null
}

function validObjectId(value: string): boolean {
  return OBJECT_ID.test(value)
}

function recipientPageSize(value: number | undefined): number {
  const limit = value ?? HIRE_SCREENING_RECIPIENT_DEFAULT_LIMIT
  if (!Number.isInteger(limit) || limit < 1 || limit > HIRE_SCREENING_RECIPIENT_MAX_LIMIT) {
    throw new AppError('Invalid recipient page limit', 400, 'INVALID_LIMIT')
  }
  return limit
}

async function loadCandidateViews(
  ctx: MembershipContext,
  jobId: mongoose.Types.ObjectId,
  candidateCoordinates: ScreeningCandidateCoordinate[],
  now: Date,
): Promise<ScreeningMemberCandidateView[]> {
  if (candidateCoordinates.length > 50)
    throw new AppError('Screening identity reads are limited to 50 candidates', 400, 'INVALID_LIMIT')
  const coordinatesByApplicationId = new Map<string, ScreeningCandidateCoordinate>()
  for (const coordinate of candidateCoordinates) {
    if (!validObjectId(coordinate.applicationId) || !validObjectId(coordinate.candidateId)) continue
    coordinatesByApplicationId.set(coordinate.applicationId, coordinate)
  }

  const coordinates = Array.from(coordinatesByApplicationId.values())
  const applicationIds = coordinates.map(
    (coordinate) => new mongoose.Types.ObjectId(coordinate.applicationId),
  )
  const applications = applicationIds.length
    ? ((await HireApplication.find({
        _id: { $in: applicationIds },
        workspaceId: ctx.workspace._id,
        jobId,
      })
        .select('_id candidateId')
        .lean()) as ApplicationRow[])
    : []
  const applicationsById = new Map(
    applications.map((application) => [application._id.toString(), application]),
  )
  const liveCandidateIds = Array.from(
    new Set(applications.map((application) => application.candidateId.toString())),
  ).map((candidateId) => new mongoose.Types.ObjectId(candidateId))
  const [candidates, activePrivacyRequests] = liveCandidateIds.length
    ? await Promise.all([
        HireCandidate.find({
          _id: { $in: liveCandidateIds },
          workspaceId: ctx.workspace._id,
          piiAnonymizedAt: { $exists: false },
        })
          .select('_id name email')
          .lean() as Promise<CandidateRow[]>,
        HirePrivacyRequest.find({
          workspaceId: ctx.workspace._id,
          candidateId: { $in: liveCandidateIds },
          ...activeHirePrivacyRequestFilter(now),
        })
          .select('candidateId')
          .lean(),
      ])
    : [[], []]
  const candidatesById = new Map(
    candidates.map((candidate) => [candidate._id.toString(), candidate]),
  )
  const privacyProtectedCandidateIds = new Set(
    activePrivacyRequests.map((request) => request.candidateId.toString()),
  )

  return coordinates.map((coordinate): ScreeningMemberCandidateView => {
    const application = applicationsById.get(coordinate.applicationId)
    if (!application || application.candidateId.toString() !== coordinate.candidateId) {
      return unavailableCandidate(coordinate, 'unavailable')
    }
    if (privacyProtectedCandidateIds.has(coordinate.candidateId)) {
      return unavailableCandidate(coordinate, 'privacy_protected')
    }
    const candidate = candidatesById.get(coordinate.candidateId)
    const displayName = candidate?.name?.trim()
    const email = candidate?.email?.trim()
    if (!displayName || !email) return unavailableCandidate(coordinate, 'unavailable')
    return {
      ...coordinate,
      identityState: 'available',
      displayName,
      email,
      applicationUrl: `/workspace/applications/${coordinate.applicationId}`,
    }
  })
}

/**
 * Member-only, read-time projection for screening review. Immutable gate and
 * batch rows stay non-PII: candidate identity is joined from current live
 * application/candidate rows and suppressed while privacy work is active.
 */
export async function getJobScreeningMemberReadProjection(
  ctx: MembershipContext,
  jobId: string,
  input: {
    candidateCoordinates?: ScreeningCandidateCoordinate[]
    now?: Date
  } = {},
): Promise<JobScreeningMemberReadProjection> {
  if (!validObjectId(jobId)) throw new AppError('Invalid job id', 400, 'INVALID_ID')
  await connectHireControlDB()

  const normalizedJobId = new mongoose.Types.ObjectId(jobId)
  const job = await HireJob.findOne({
    _id: normalizedJobId,
    workspaceId: ctx.workspace._id,
  })
    .select('_id')
    .lean()
  if (!job) throw new NotFoundError('Job')
  const candidateViews = await loadCandidateViews(
    ctx,
    normalizedJobId,
    input.candidateCoordinates ?? [],
    input.now ?? new Date(),
  )

  return { candidates: candidateViews }
}

export async function readJobScreeningGateBatches(
  ctx: MembershipContext,
  jobId: string,
  gateId: string,
  input: { limit: number; cursor?: ScreeningBatchCursor },
): Promise<ScreeningBatchPage> {
  if (!validObjectId(jobId) || !validObjectId(gateId) || !Number.isInteger(input.limit) ||
    input.limit < 1 || input.limit > 25 || (input.cursor && (!validObjectId(input.cursor.id) ||
    !Number.isInteger(input.cursor.wave) || input.cursor.wave < 1)))
    throw new AppError('Invalid screening batch page', 400, 'INVALID_SCREENING_BATCH_PAGE')
  await connectHireControlDB()
  const normalizedJobId = new mongoose.Types.ObjectId(jobId)
  const normalizedGateId = new mongoose.Types.ObjectId(gateId)
  const gate = await HireScreeningGate.findOne({
    _id: normalizedGateId, workspaceId: ctx.workspace._id, jobId: normalizedJobId,
  }).select('_id').lean()
  if (!gate) throw new NotFoundError('Screening gate')
  const batches = await HireInvitationBatch.find({
    workspaceId: ctx.workspace._id, jobId: normalizedJobId, screeningGateId: normalizedGateId,
    // Wave is unique within a gate; no ObjectId tie-break or blocking sort is
    // needed to traverse the existing gate/wave index deterministically.
    ...(input.cursor ? { wave: { $lt: input.cursor.wave } } : {}),
  }).sort({ wave: -1 }).limit(input.limit + 1)
  const page = batches.slice(0, input.limit)
  const last = page[page.length - 1]
  return {
    batches: page, hasMore: batches.length > input.limit,
    nextCursor: batches.length > input.limit && last
      ? { wave: last.wave, id: last._id.toString() } : null,
  }
}

/**
 * Read a bounded, stable page of one batch's delivery ledger. The API layer
 * authenticates and scope-binds the opaque cursor before this internal seek
 * coordinate reaches the service.
 */
export async function readJobScreeningBatchRecipients(
  ctx: MembershipContext,
  jobId: string,
  batchId: string,
  input: { cursor?: ScreeningRecipientCursor; limit?: number; now?: Date } = {},
): Promise<ScreeningRecipientPage> {
  if (!validObjectId(jobId) || !validObjectId(batchId)) {
    throw new AppError('Invalid screening recipient scope', 400, 'INVALID_ID')
  }
  const limit = recipientPageSize(input.limit)
  await connectHireControlDB()

  const normalizedJobId = new mongoose.Types.ObjectId(jobId)
  const normalizedBatchId = new mongoose.Types.ObjectId(batchId)
  const job = await HireJob.findOne({
    _id: normalizedJobId,
    workspaceId: ctx.workspace._id,
  })
    .select('_id')
    .lean()
  if (!job) throw new NotFoundError('Job')
  const batch = await HireInvitationBatch.findOne({
    _id: normalizedBatchId,
    workspaceId: ctx.workspace._id,
    jobId: normalizedJobId,
  })
    .select('_id')
    .lean()
  if (!batch) throw new NotFoundError('Invitation batch')

  if (input.cursor && !validObjectId(input.cursor.itemId)) {
    throw new AppError('Invalid recipient cursor', 400, 'INVALID_CURSOR')
  }
  const cursorId = input.cursor
    ? new mongoose.Types.ObjectId(input.cursor.itemId)
    : null
  const items = (await HireInvitationBatchItem.find({
    workspaceId: ctx.workspace._id,
    jobId: normalizedJobId,
    invitationBatchId: normalizedBatchId,
    ...(cursorId ? { _id: { $gt: cursorId } } : {}),
  })
    .select(
      '_id invitationBatchId applicationId candidateId privacyRedactedAt rank score scoreState selectionReason sendAfter status deliveryStatus attempts sentAt lastError',
    )
    .sort({ _id: 1 })
    .limit(limit + 1)
    .lean()) as InvitationItemRow[]
  const hasMore = items.length > limit
  const pageItems = items.slice(0, limit)
  const candidateViews = await loadCandidateViews(
    ctx,
    normalizedJobId,
    pageItems.flatMap((item) =>
      item.privacyRedactedAt || !item.applicationId || !item.candidateId
        ? []
        : [{
            applicationId: item.applicationId.toString(),
            candidateId: item.candidateId.toString(),
          }],
    ),
    input.now ?? new Date(),
  )
  const candidateViewsByApplicationId = new Map(
    candidateViews.map((candidate) => [candidate.applicationId, candidate]),
  )

  const recipients = pageItems.map((item): ScreeningRecipientDeliveryView => {
    if (item.privacyRedactedAt || !item.applicationId || !item.candidateId) {
      return {
        id: item._id.toString(),
        batchId: item.invitationBatchId.toString(),
        applicationId: null,
        candidate: null,
        identityState: 'privacy_redacted',
        rank: item.rank ?? null,
        score: item.score,
        scoreState: item.scoreState,
        selectionReason: item.selectionReason,
        sendAfter: item.sendAfter,
        status: item.status,
        deliveryStatus: item.deliveryStatus ?? null,
        attempts: item.attempts,
        sentAt: item.sentAt ?? null,
        issue: controlledRecipientIssue(item),
      }
    }
    const applicationId = item.applicationId.toString()
    const candidate = candidateViewsByApplicationId.get(applicationId) ?? null
    return {
      id: item._id.toString(),
      batchId: item.invitationBatchId.toString(),
      applicationId,
      candidate,
      identityState: candidate?.identityState ?? 'unavailable',
      rank: item.rank ?? null,
      score: item.score,
      scoreState: item.scoreState,
      selectionReason: item.selectionReason,
      sendAfter: item.sendAfter,
      status: item.status,
      deliveryStatus: item.deliveryStatus ?? null,
      attempts: item.attempts,
      sentAt: item.sentAt ?? null,
      issue: controlledRecipientIssue(item),
    }
  })
  const last = pageItems.at(-1)
  return {
    recipients,
    hasMore,
    nextCursor: hasMore && last
      ? { itemId: last._id.toString() }
      : null,
  }
}
