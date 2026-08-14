import { randomUUID } from 'node:crypto'
import mongoose, { type ClientSession } from 'mongoose'
import { AppError, NotFoundError } from '@shared/errors'
import { logger } from '@shared/logger'
import { inngest } from '@shared/services/inngest'
import {
  HireApplication,
  HireJob,
  HirePrivacyRequest,
  HireWorkspace,
  activeHireWorkspaceLifecycleFilter,
  claimHireCandidatePiiWriteFence,
  claimNonTerminalHireApplicationDispatchFence,
  HireCandidatePiiTombstoneError,
  resolveWorkspaceWriteAuthority,
  type MembershipContext,
  withActiveHireWorkspaceWriteTransaction,
} from '@hire-decision-boundary'
import {
  HIRE_ASSESSMENT_EXPORT_EXPIRY_MS,
  HIRE_ASSESSMENT_EXPORT_LEASE_MS,
  HIRE_ASSESSMENT_EXPORT_MAX_ATTEMPTS,
  HireAssessmentExport,
  hireAssessmentExportObjectKey,
  type HireAssessmentExportCoordinate,
  type HireAssessmentExportFailureCode,
  type HireAssessmentExportStatus,
  type IHireAssessmentExport,
} from '../models/HireAssessmentExport'
import { buildHireDecisionView, HireDecisionError } from './decisionAggregateService'
import { connectHireDecisionDB } from './hireDecisionBoundary'
import { generateHireAssessmentPdf, hireAssessmentPdfFilename } from './hireAssessmentPdfService'
import { hireAssessmentExportStorage } from './hireAssessmentExportStorage'
import { ensureHireAssessmentExportCleanupTombstone } from './hireAssessmentExportCleanupService'
import type { HireDecisionView } from '../types'

const OBJECT_ID = /^[a-f0-9]{24}$/i
const OPERATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const RETRY_BASE_MS = 60_000
const RETRY_MAX_MS = 60 * 60_000

/** Keep the minute sweep tenant-fair and bounded. */
export const HIRE_ASSESSMENT_EXPORT_RECOVERY_LIMIT_PER_WORKSPACE = 10

export interface HireAssessmentExportMemberView {
  id: string
  status: HireAssessmentExportStatus
  requestedAt: Date
  expiresAt: Date
  readyAt: Date | null
}

export interface HireAssessmentExportRequestInput {
  applicationId: string
  operationId: string
}

export interface HireAssessmentExportRequestResult {
  export: HireAssessmentExportMemberView
  created: boolean
}

/** This is an in-memory route handoff, never a URL or a persistence DTO. */
export interface HireAssessmentExportDownload {
  filename: string
  contentType: 'application/pdf'
  body: Buffer
}

export type HireAssessmentExportProcessResult =
  | 'ready'
  | 'retry_scheduled'
  | 'cancelled'
  | 'skipped'

class HireAssessmentExportUnavailableError extends AppError {
  constructor(code: 'ASSESSMENT_EXPORT_UNAVAILABLE' | 'ASSESSMENT_EXPORT_EXPIRED') {
    super('The assessment export is no longer available', 410, code)
    this.name = 'HireAssessmentExportUnavailableError'
  }
}

function objectId(value: string, label: string): mongoose.Types.ObjectId {
  if (!OBJECT_ID.test(value)) throw new AppError(`Invalid ${label}`, 400, 'INVALID_ID')
  return new mongoose.Types.ObjectId(value)
}

function assertOperationId(operationId: string): void {
  if (!OPERATION_ID.test(operationId)) {
    throw new AppError('Invalid assessment export operation id', 400, 'INVALID_OPERATION_ID')
  }
}

function exportCoordinate(row: Pick<IHireAssessmentExport,
  '_id' | 'workspaceId' | 'applicationId' | 'jobId' | 'candidateId'
>): HireAssessmentExportCoordinate {
  return {
    workspaceId: row.workspaceId.toString(),
    jobId: row.jobId.toString(),
    applicationId: row.applicationId.toString(),
    candidateId: row.candidateId.toString(),
    exportId: row._id.toString(),
  }
}

function serializeMemberView(row: Pick<IHireAssessmentExport,
  '_id' | 'status' | 'requestedAt' | 'expiresAt' | 'readyAt'
>): HireAssessmentExportMemberView {
  return {
    id: row._id.toString(),
    status: row.status,
    requestedAt: row.requestedAt,
    expiresAt: row.expiresAt,
    readyAt: row.readyAt ?? null,
  }
}

function isDuplicateKey(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 11000
}

function retryDueAt(now: Date, attempts: number): Date {
  const delay = Math.min(
    RETRY_MAX_MS,
    RETRY_BASE_MS * 2 ** Math.max(0, Math.min(attempts - 1, 6)),
  )
  return new Date(now.getTime() + delay)
}

function isAuthorityLoss(error: unknown): boolean {
  if (error instanceof HireCandidatePiiTombstoneError) return true
  return error instanceof AppError && [
    'WORKSPACE_DELETION_PENDING',
    'MEMBER_REMOVED',
    'CANDIDATE_PRIVACY_PENDING',
    'HIRE_CANDIDATE_PII_TOMBSTONED',
    'APPLICATION_NOT_ELIGIBLE',
    'JOB_NOT_OPEN',
    'ASSESSMENT_EXPORT_UNAVAILABLE',
    'ASSESSMENT_EXPORT_EXPIRED',
  ].includes(error.code)
}

/**
 * Read and claim the application/candidate inside the caller's active
 * workspace transaction. The candidate write fence serializes this snapshot
 * authorization against verified privacy deletion.
 */
async function assertExportScope(input: {
  workspaceId: mongoose.Types.ObjectId
  applicationId: mongoose.Types.ObjectId
  jobId?: mongoose.Types.ObjectId
  candidateId?: mongoose.Types.ObjectId
  now: Date
  session: ClientSession
}) {
  const application = await HireApplication.findOne(
    {
      _id: input.applicationId,
      workspaceId: input.workspaceId,
      ...(input.jobId ? { jobId: input.jobId } : {}),
      ...(input.candidateId ? { candidateId: input.candidateId } : {}),
    },
    null,
    { session: input.session },
  )
  if (!application) throw new HireAssessmentExportUnavailableError('ASSESSMENT_EXPORT_UNAVAILABLE')

  // A job close writes the same HireJob document. Claiming it here makes a
  // close linearize before any report snapshot/render/upload can proceed.
  const jobClaim = await HireJob.updateOne(
    {
      _id: application.jobId,
      workspaceId: input.workspaceId,
      status: 'open',
    },
    { $inc: { intakeWriteVersion: 1 } },
    { session: input.session },
  )
  if (jobClaim.matchedCount !== 1) {
    throw new AppError('Assessment exports require an open job', 409, 'JOB_NOT_OPEN')
  }

  const privacy = await HirePrivacyRequest.exists({
    workspaceId: input.workspaceId,
    candidateId: application.candidateId,
    live: true,
  }).session(input.session)
  if (privacy) {
    throw new AppError(
      'Candidate personal data is unavailable for an assessment export',
      410,
      'CANDIDATE_PRIVACY_PENDING',
    )
  }
  await claimHireCandidatePiiWriteFence({
    workspaceId: input.workspaceId,
    candidateId: application.candidateId,
    session: input.session,
  })
  // A report is decision evidence, not an archival egress channel. Sharing
  // its snapshot after a member closes/withdraws the application would race
  // the same terminal decision fence used by Hire invitations.
  await claimNonTerminalHireApplicationDispatchFence({
    workspaceId: input.workspaceId,
    applicationId: application._id,
    jobId: application.jobId,
    candidateId: application.candidateId,
    now: input.now,
    session: input.session,
  })
  return application
}

async function authorizeMemberApplication(
  ctx: MembershipContext,
  applicationId: mongoose.Types.ObjectId,
  now: Date,
) {
  return withActiveHireWorkspaceWriteTransaction(
    ctx.workspace._id,
    ctx.membership._id,
    (session) => assertExportScope({
      workspaceId: ctx.workspace._id,
      applicationId,
      now,
      session,
    }),
  )
}

function assertDecisionCoordinates(
  decision: HireDecisionView,
  input: { workspaceId: mongoose.Types.ObjectId; applicationId: mongoose.Types.ObjectId; jobId: mongoose.Types.ObjectId; candidateId: mongoose.Types.ObjectId },
): void {
  if (
    decision.coordinates.workspaceId !== input.workspaceId.toString() ||
    decision.coordinates.applicationId !== input.applicationId.toString() ||
    decision.coordinates.jobId !== input.jobId.toString() ||
    decision.coordinates.candidateId !== input.candidateId.toString()
  ) {
    throw new AppError('Assessment export evidence changed while it was authorized', 409, 'ASSESSMENT_EXPORT_RACE')
  }
}

/**
 * `buildHireDecisionView` is already a safe DTO, but the durable boundary
 * still deep-picks it. This prevents a future internal-only field from being
 * silently persisted just because the read-model type grows.
 */
function cloneHireAssessmentDecisionSnapshot(decision: HireDecisionView): HireDecisionView {
  const cloneSource = (source: HireDecisionView['humanScorecards']['total']) => ({
    count: source.count,
    recommendations: {
      strong_yes: source.recommendations.strong_yes,
      yes: source.recommendations.yes,
      no: source.recommendations.no,
      strong_no: source.recommendations.strong_no,
    },
    dimensions: source.dimensions.map((dimension) => ({
      key: dimension.key,
      count: dimension.count,
      mean: dimension.mean,
      min: dimension.min,
      max: dimension.max,
      reviewerSpread: dimension.reviewerSpread,
    })),
  })
  return {
    coordinates: {
      workspaceId: decision.coordinates.workspaceId,
      applicationId: decision.coordinates.applicationId,
      jobId: decision.coordinates.jobId,
      candidateId: decision.coordinates.candidateId,
    },
    candidateBrief: {
      candidateName: decision.candidateBrief.candidateName,
      jobTitle: decision.candidateBrief.jobTitle,
      ...(decision.candidateBrief.location ? { location: decision.candidateBrief.location } : {}),
      ...(decision.candidateBrief.experienceYears !== undefined
        ? { experienceYears: decision.candidateBrief.experienceYears }
        : {}),
    },
    aiAssessments: decision.aiAssessments.map((assessment) => ({
      completedAt: new Date(assessment.completedAt),
      overallScore: assessment.overallScore,
      ...(assessment.recommendation ? { recommendation: assessment.recommendation } : {}),
      ...(assessment.confidence ? { confidence: assessment.confidence } : {}),
      dimensions: assessment.dimensions.map((dimension) => ({
        key: dimension.key,
        ...(dimension.label ? { label: dimension.label } : {}),
        score: dimension.score,
      })),
    })),
    humanScorecards: {
      total: cloneSource(decision.humanScorecards.total),
      member: cloneSource(decision.humanScorecards.member),
      kit: cloneSource(decision.humanScorecards.kit),
    },
    externalVerdicts: {
      count: decision.externalVerdicts.count,
      recommendations: {
        strong_yes: decision.externalVerdicts.recommendations.strong_yes,
        yes: decision.externalVerdicts.recommendations.yes,
        no: decision.externalVerdicts.recommendations.no,
        strong_no: decision.externalVerdicts.recommendations.strong_no,
      },
    },
  }
}

function sameCreateScope(
  row: Pick<IHireAssessmentExport, 'applicationId'>,
  applicationId: mongoose.Types.ObjectId,
): boolean {
  return row.applicationId.toString() === applicationId.toString()
}

async function emitHireAssessmentExportRequested(input: {
  workspaceId: string
  exportId: string
}): Promise<void> {
  // Event discipline: the worker reloads all private fields from Hire control.
  await inngest.send({ name: 'hire/assessment-export.requested', data: input })
}

export async function dispatchHireAssessmentExport(input: {
  workspaceId: string
  exportId: string
}): Promise<void> {
  objectId(input.workspaceId, 'workspace id')
  objectId(input.exportId, 'assessment export id')
  await emitHireAssessmentExportRequested(input)
}

/** A lost latency kick never invalidates the already-committed durable request. */
export async function kickHireAssessmentExport(input: {
  workspaceId: string
  exportId: string
}): Promise<void> {
  try {
    await dispatchHireAssessmentExport(input)
  } catch {
    logger.warn({ workspaceId: input.workspaceId, exportId: input.exportId }, 'hire: assessment export dispatch deferred to recovery')
  }
}

/**
 * Capture the safe decision DTO only after an active member/candidate fence,
 * then repeat that fence in the creation transaction. The snapshot is private
 * to the worker and cannot acquire a raw resume, contact field, media id, or
 * audit/event data as it crosses the async boundary.
 */
export async function requestHireAssessmentExport(
  ctx: MembershipContext,
  input: HireAssessmentExportRequestInput,
): Promise<HireAssessmentExportRequestResult> {
  await connectHireDecisionDB()
  assertOperationId(input.operationId)
  const applicationId = objectId(input.applicationId, 'application id')
  const now = new Date()
  const authorizedApplication = await authorizeMemberApplication(ctx, applicationId, now)

  let decision: HireDecisionView
  try {
    decision = await buildHireDecisionView({
      workspaceId: ctx.workspace._id.toString(),
      applicationId: applicationId.toString(),
    })
  } catch (error) {
    if (error instanceof HireDecisionError) throw new NotFoundError('Application')
    throw error
  }
  assertDecisionCoordinates(decision, {
    workspaceId: ctx.workspace._id,
    applicationId,
    jobId: authorizedApplication.jobId,
    candidateId: authorizedApplication.candidateId,
  })
  const decisionSnapshot = cloneHireAssessmentDecisionSnapshot(decision)

  const exportId = new mongoose.Types.ObjectId()
  const expiresAt = new Date(now.getTime() + HIRE_ASSESSMENT_EXPORT_EXPIRY_MS)
  let result: HireAssessmentExportRequestResult
  try {
    result = await withActiveHireWorkspaceWriteTransaction(
      ctx.workspace._id,
      ctx.membership._id,
      async (session) => {
        const existing = await HireAssessmentExport.findOne(
          { workspaceId: ctx.workspace._id, creationOperationId: input.operationId },
          null,
          { session },
        )
        if (existing) {
          if (!sameCreateScope(existing, applicationId)) {
            throw new AppError('That operation id was used for another assessment export', 409, 'OPERATION_ID_REUSED')
          }
          return { export: serializeMemberView(existing), created: false }
        }

        const application = await assertExportScope({
          workspaceId: ctx.workspace._id,
          applicationId,
          jobId: authorizedApplication.jobId,
          candidateId: authorizedApplication.candidateId,
          now,
          session,
        })
        assertDecisionCoordinates(decision, {
          workspaceId: ctx.workspace._id,
          applicationId: application._id,
          jobId: application.jobId,
          candidateId: application.candidateId,
        })

        const [created] = await HireAssessmentExport.create([
          {
            _id: exportId,
            workspaceId: ctx.workspace._id,
            applicationId: application._id,
            jobId: application.jobId,
            candidateId: application.candidateId,
            creationOperationId: input.operationId,
            objectKey: hireAssessmentExportObjectKey({
              workspaceId: ctx.workspace._id.toString(),
              applicationId: application._id.toString(),
              jobId: application.jobId.toString(),
              candidateId: application.candidateId.toString(),
              exportId: exportId.toString(),
            }),
            decisionSnapshot,
            requestedAt: now,
            expiresAt,
            status: 'pending',
            attempts: 0,
            nextRetryAt: now,
          },
        ], { session })
        return { export: serializeMemberView(created), created: true }
      },
    )
  } catch (error) {
    if (isDuplicateKey(error)) {
      const existing = await HireAssessmentExport.findOne({
        workspaceId: ctx.workspace._id,
        creationOperationId: input.operationId,
      })
      if (existing) {
        if (!sameCreateScope(existing, applicationId)) {
          throw new AppError('That operation id was used for another assessment export', 409, 'OPERATION_ID_REUSED')
        }
        return { export: serializeMemberView(existing), created: false }
      }
    }
    if (error instanceof HireCandidatePiiTombstoneError) {
      throw new HireAssessmentExportUnavailableError('ASSESSMENT_EXPORT_UNAVAILABLE')
    }
    throw error
  }

  if (result.created) {
    await kickHireAssessmentExport({
      workspaceId: ctx.workspace._id.toString(),
      exportId: result.export.id,
    })
  }
  return result
}

/** Member status stays opaque: no object key, snapshot, failure detail, or URL. */
export async function getHireAssessmentExportStatus(
  ctx: MembershipContext,
  exportId: string,
): Promise<HireAssessmentExportMemberView> {
  await connectHireDecisionDB()
  const id = objectId(exportId, 'assessment export id')
  const now = new Date()
  return withActiveHireWorkspaceWriteTransaction(
    ctx.workspace._id,
    ctx.membership._id,
    async (session) => {
      const row = await HireAssessmentExport.findOne(
        { _id: id, workspaceId: ctx.workspace._id },
        null,
        { session },
      )
      if (!row) throw new NotFoundError('Assessment export')
      // Cron redaction is intentionally asynchronous. Never advertise a
      // ready/downloadable report during the short interval after expiry and
      // before the worker transitions it to cancelled/redacted.
      if (row.expiresAt <= now) {
        throw new HireAssessmentExportUnavailableError('ASSESSMENT_EXPORT_EXPIRED')
      }
      await assertExportScope({
        workspaceId: ctx.workspace._id,
        applicationId: row.applicationId,
        jobId: row.jobId,
        candidateId: row.candidateId,
        now,
        session,
      })
      return serializeMemberView(row)
    },
  )
}

/**
 * Authorization and the private object read share one transaction. A privacy
 * or workspace-deletion fence that wins first makes the read impossible; this
 * function never returns a signed URL that could outlive that decision.
 */
export async function downloadHireAssessmentExport(
  ctx: MembershipContext,
  exportId: string,
): Promise<HireAssessmentExportDownload> {
  await connectHireDecisionDB()
  const id = objectId(exportId, 'assessment export id')
  const now = new Date()
  return withActiveHireWorkspaceWriteTransaction(
    ctx.workspace._id,
    ctx.membership._id,
    async (session) => {
      const row = await HireAssessmentExport.findOne(
        {
          _id: id,
          workspaceId: ctx.workspace._id,
          status: 'ready',
          expiresAt: { $gt: now },
        },
        null,
        { session },
      ).select('+objectKey')
      if (!row?.objectKey) throw new HireAssessmentExportUnavailableError('ASSESSMENT_EXPORT_EXPIRED')
      await assertExportScope({
        workspaceId: ctx.workspace._id,
        applicationId: row.applicationId,
        jobId: row.jobId,
        candidateId: row.candidateId,
        now,
        session,
      })
      const body = await hireAssessmentExportStorage.download({
        key: row.objectKey,
        coordinate: exportCoordinate(row),
      })
      return {
        filename: hireAssessmentPdfFilename(),
        contentType: 'application/pdf',
        body,
      }
    },
  )
}

async function selectWorkerRow(input: {
  workspaceId: mongoose.Types.ObjectId
  exportId: mongoose.Types.ObjectId
}): Promise<IHireAssessmentExport | null> {
  return HireAssessmentExport.findOne({
    _id: input.exportId,
    workspaceId: input.workspaceId,
  }).select('+objectKey +decisionSnapshot +claimToken')
}

async function deleteAndCancelExport(row: IHireAssessmentExport, now: Date): Promise<void> {
  const coordinate = exportCoordinate(row)
  // Persist the deletion obligation before any external delete or redaction.
  // A worker can otherwise pass its final fence, race cancellation, upload,
  // and crash with no remaining coordinate from which to delete the object.
  const cleanupNotBeforeAt = await ensureHireAssessmentExportCleanupTombstone({
    coordinate,
    requestedAt: now,
  })
  // Linearize cancellation before an external delete. If another worker had
  // just made the export ready, this CAS cancels/redacts that ready row too;
  // if the row is already cancelled or hard-purged, the retained tombstone
  // still owns repeated deletion safely.
  await HireAssessmentExport.updateOne(
    {
      _id: row._id,
      workspaceId: row.workspaceId,
      status: { $ne: 'cancelled' },
    },
    {
      $set: {
        status: 'cancelled',
        cancelledAt: now,
        objectCleanupPendingAt: cleanupNotBeforeAt,
      },
      $unset: {
        decisionSnapshot: 1,
        objectKey: 1,
        claimToken: 1,
        leaseExpiresAt: 1,
        nextRetryAt: 1,
        failureCode: 1,
        objectCleanupCompletedAt: 1,
        objectCleanupClaimToken: 1,
        objectCleanupLeaseExpiresAt: 1,
      },
    },
    { timestamps: false, overwriteImmutable: true },
  )
  if (row.objectKey) {
    await hireAssessmentExportStorage.delete({
      key: row.objectKey,
      coordinate,
    })
  }
}

async function claimExportForWorker(input: {
  row: IHireAssessmentExport
  authorityMemberId: mongoose.Types.ObjectId
  now: Date
}): Promise<IHireAssessmentExport | null> {
  const claimToken = randomUUID()
  return withActiveHireWorkspaceWriteTransaction(
    input.row.workspaceId,
    input.authorityMemberId,
    async (session) => {
      const claimed = await HireAssessmentExport.findOneAndUpdate(
        {
          _id: input.row._id,
          workspaceId: input.row.workspaceId,
          expiresAt: { $gt: input.now },
          $or: [
            {
              status: 'pending',
              nextRetryAt: { $lte: input.now },
              attempts: { $lt: HIRE_ASSESSMENT_EXPORT_MAX_ATTEMPTS },
            },
            {
              status: 'failed',
              nextRetryAt: { $lte: input.now },
              attempts: { $lt: HIRE_ASSESSMENT_EXPORT_MAX_ATTEMPTS },
            },
            {
              status: 'generating',
              leaseExpiresAt: { $lte: input.now },
              attempts: { $lt: HIRE_ASSESSMENT_EXPORT_MAX_ATTEMPTS },
            },
          ],
        },
        {
          $set: {
            status: 'generating',
            claimToken,
            leaseExpiresAt: new Date(input.now.getTime() + HIRE_ASSESSMENT_EXPORT_LEASE_MS),
          },
          $unset: {
            nextRetryAt: 1,
            failedAt: 1,
            failureCode: 1,
            objectCleanupPendingAt: 1,
            objectCleanupCompletedAt: 1,
            objectCleanupClaimToken: 1,
            objectCleanupLeaseExpiresAt: 1,
          },
          $inc: { attempts: 1 },
        },
        { new: true, session },
      ).select('+objectKey +decisionSnapshot +claimToken')
      if (!claimed) return null
      await assertExportScope({
        workspaceId: claimed.workspaceId,
        applicationId: claimed.applicationId,
        jobId: claimed.jobId,
        candidateId: claimed.candidateId,
        now: input.now,
        session,
      })
      return claimed
    },
  )
}

async function reauthorizeWorkerClaim(input: {
  row: IHireAssessmentExport
  authorityMemberId: mongoose.Types.ObjectId
  now: Date
}): Promise<boolean> {
  return withActiveHireWorkspaceWriteTransaction(
    input.row.workspaceId,
    input.authorityMemberId,
    async (session) => {
      const current = await HireAssessmentExport.findOne(
        {
          _id: input.row._id,
          workspaceId: input.row.workspaceId,
          status: 'generating',
          claimToken: input.row.claimToken,
          leaseExpiresAt: { $gt: input.now },
          expiresAt: { $gt: input.now },
        },
        null,
        { session },
      )
      if (!current) return false
      await assertExportScope({
        workspaceId: current.workspaceId,
        applicationId: current.applicationId,
        jobId: current.jobId,
        candidateId: current.candidateId,
        now: input.now,
        session,
      })
      return true
    },
  )
}

async function finalizeReadyExport(input: {
  row: IHireAssessmentExport
  authorityMemberId: mongoose.Types.ObjectId
  now: Date
  contentSizeBytes: number
}): Promise<boolean> {
  return withActiveHireWorkspaceWriteTransaction(
    input.row.workspaceId,
    input.authorityMemberId,
    async (session) => {
      const current = await HireAssessmentExport.findOne(
        {
          _id: input.row._id,
          workspaceId: input.row.workspaceId,
          status: 'generating',
          claimToken: input.row.claimToken,
          leaseExpiresAt: { $gt: input.now },
          expiresAt: { $gt: input.now },
        },
        null,
        { session },
      )
      if (!current) return false
      await assertExportScope({
        workspaceId: current.workspaceId,
        applicationId: current.applicationId,
        jobId: current.jobId,
        candidateId: current.candidateId,
        now: input.now,
        session,
      })
      const finalized = await HireAssessmentExport.updateOne(
        {
          _id: current._id,
          workspaceId: current.workspaceId,
          status: 'generating',
          claimToken: input.row.claimToken,
          leaseExpiresAt: { $gt: input.now },
          expiresAt: { $gt: input.now },
        },
        {
          $set: {
            status: 'ready',
            readyAt: input.now,
            contentSizeBytes: input.contentSizeBytes,
          },
          $unset: {
            claimToken: 1,
            leaseExpiresAt: 1,
            nextRetryAt: 1,
            failureCode: 1,
            failedAt: 1,
            objectCleanupPendingAt: 1,
            objectCleanupCompletedAt: 1,
            objectCleanupClaimToken: 1,
            objectCleanupLeaseExpiresAt: 1,
          },
        },
        { session, timestamps: false },
      )
      return finalized.matchedCount === 1
    },
  )
}

async function settleWorkerFailure(input: {
  row: IHireAssessmentExport
  now: Date
  failureCode: HireAssessmentExportFailureCode
  objectCleanupPendingAt?: Date
}): Promise<boolean> {
  const retryAt = input.row.attempts < HIRE_ASSESSMENT_EXPORT_MAX_ATTEMPTS
    ? retryDueAt(input.now, input.row.attempts)
    : undefined
  const settled = await HireAssessmentExport.updateOne(
    {
      _id: input.row._id,
      workspaceId: input.row.workspaceId,
      status: 'generating',
      claimToken: input.row.claimToken,
    },
    {
      $set: {
        status: 'failed',
        failedAt: input.now,
        failureCode: input.failureCode,
        ...(retryAt ? { nextRetryAt: retryAt } : {}),
        ...(input.objectCleanupPendingAt
          ? { objectCleanupPendingAt: input.objectCleanupPendingAt }
          : {}),
      },
      $unset: {
        claimToken: 1,
        leaseExpiresAt: 1,
        ...(retryAt ? {} : { nextRetryAt: 1 }),
        ...(input.objectCleanupPendingAt
          ? { objectCleanupCompletedAt: 1, objectCleanupClaimToken: 1, objectCleanupLeaseExpiresAt: 1 }
          : {}),
      },
    },
    { timestamps: false },
  )
  return settled.matchedCount === 1
}

/**
 * A crash at the final allowed attempt must not strand a row in `generating`.
 * Terminalize the expired claim first, then best-effort delete the old object.
 * A competing ready transition makes the terminal CAS lose, so the stale
 * tombstone is retired without deleting the winner's deterministic key.
 */
async function finalizeExpiredExhaustedExport(
  row: IHireAssessmentExport,
  now: Date,
): Promise<void> {
  const cleanupNotBeforeAt = await ensureHireAssessmentExportCleanupTombstone({
    coordinate: exportCoordinate(row),
    requestedAt: now,
  })
  const finalized = await HireAssessmentExport.updateOne(
    {
      _id: row._id,
      workspaceId: row.workspaceId,
      status: 'generating',
      attempts: { $gte: HIRE_ASSESSMENT_EXPORT_MAX_ATTEMPTS },
      leaseExpiresAt: { $lte: now },
    },
    {
      $set: {
        status: 'failed',
        failedAt: now,
        failureCode: 'finalization_failed',
        objectCleanupPendingAt: cleanupNotBeforeAt,
      },
      $unset: {
        decisionSnapshot: 1,
        objectKey: 1,
        claimToken: 1,
        leaseExpiresAt: 1,
        nextRetryAt: 1,
        objectCleanupCompletedAt: 1,
        objectCleanupClaimToken: 1,
        objectCleanupLeaseExpiresAt: 1,
      },
    },
    { timestamps: false },
  )
  if (finalized.matchedCount === 1 && row.objectKey) {
    await hireAssessmentExportStorage.delete({
      key: row.objectKey,
      coordinate: exportCoordinate(row),
    })
  }
}

/** A deterministic object may survive a crash only until this retry or expiry cleanup. */
async function cleanExpiredExport(row: IHireAssessmentExport, now: Date): Promise<void> {
  await deleteAndCancelExport(row, now)
}

/**
 * Worker entry point. The event itself is IDs only; every private value is
 * reloaded in the Hire-control database and reauthorized before render,
 * before upload, and before ready finalization.
 */
export async function processHireAssessmentExport(input: {
  workspaceId: string
  exportId: string
  now?: Date
}): Promise<HireAssessmentExportProcessResult> {
  await connectHireDecisionDB()
  if (!OBJECT_ID.test(input.workspaceId) || !OBJECT_ID.test(input.exportId)) return 'skipped'
  const now = input.now ?? new Date()
  const workspaceId = new mongoose.Types.ObjectId(input.workspaceId)
  const exportId = new mongoose.Types.ObjectId(input.exportId)
  const row = await selectWorkerRow({ workspaceId, exportId })
  if (!row) return 'skipped'

  if (row.status === 'cancelled') return 'cancelled'
  if (row.expiresAt <= now) {
    await cleanExpiredExport(row, now)
    return 'cancelled'
  }
  if (
    row.status === 'generating' &&
    row.attempts >= HIRE_ASSESSMENT_EXPORT_MAX_ATTEMPTS &&
    row.leaseExpiresAt &&
    row.leaseExpiresAt <= now
  ) {
    await finalizeExpiredExhaustedExport(row, now)
    return 'skipped'
  }

  const authorityMemberId = await resolveWorkspaceWriteAuthority(workspaceId)
  if (!authorityMemberId) {
    await deleteAndCancelExport(row, now)
    return 'cancelled'
  }

  let claimed: IHireAssessmentExport | null
  try {
    claimed = await claimExportForWorker({ row, authorityMemberId, now })
  } catch (error) {
    if (isAuthorityLoss(error)) {
      await deleteAndCancelExport(row, now)
      return 'cancelled'
    }
    throw error
  }
  if (!claimed) return 'skipped'
  if (!claimed.objectKey || !claimed.decisionSnapshot || !claimed.claimToken || !claimed.leaseExpiresAt) {
    await settleWorkerFailure({ row: claimed, now, failureCode: 'finalization_failed' })
    return 'retry_scheduled'
  }
  const uploadLeaseExpiresAt = claimed.leaseExpiresAt

  let phase: 'render' | 'upload' | 'finalize' = 'render'
  try {
    // The render starts only after a fresh control-plane/candidate fence.
    if (!await reauthorizeWorkerClaim({ row: claimed, authorityMemberId, now: new Date() })) {
      return 'skipped'
    }
    const pdf = await generateHireAssessmentPdf(claimed.decisionSnapshot)

    // Do not hand an object to R2 after an intervening privacy/workspace loss.
    if (!await reauthorizeWorkerClaim({ row: claimed, authorityMemberId, now: new Date() })) {
      return 'skipped'
    }
    phase = 'upload'
    await hireAssessmentExportStorage.upload({
      key: claimed.objectKey,
      coordinate: exportCoordinate(claimed),
      body: pdf,
      leaseExpiresAt: uploadLeaseExpiresAt,
    })
    phase = 'finalize'

    const finalized = await finalizeReadyExport({
      row: claimed,
      authorityMemberId,
      now: new Date(),
      contentSizeBytes: pdf.byteLength,
    })
    if (finalized) return 'ready'

    const current = await selectWorkerRow({ workspaceId, exportId })
    if (!current || current.status === 'cancelled' || current.expiresAt <= new Date()) {
      await deleteAndCancelExport(claimed, new Date())
      return 'cancelled'
    }
    // A normal competing lease/ready transition must retain the deterministic
    // object for the winning worker. It did not lose to privacy/deletion.
    return 'skipped'
  } catch (error) {
    if (isAuthorityLoss(error)) {
      // If privacy/deletion won after the private upload, delete the object
      // before the durable row is redacted. A failed delete leaves the claim
      // recoverable for the minute sweep instead of pretending cleanup worked.
      await deleteAndCancelExport(claimed, new Date())
      return 'cancelled'
    }
    let objectCleanupPendingAt: Date | undefined
    if (phase !== 'render' && claimed.attempts >= HIRE_ASSESSMENT_EXPORT_MAX_ATTEMPTS) {
      // A PutObject request can succeed even when the caller loses its
      // response/finalization race. Keep a durable deletion obligation before
      // the best-effort immediate delete, then let global recovery settle it
      // only after the old worker lease is quiescent.
      objectCleanupPendingAt = await ensureHireAssessmentExportCleanupTombstone({
        coordinate: exportCoordinate(claimed),
        requestedAt: new Date(),
      })
    }
    const failureCode: HireAssessmentExportFailureCode = phase === 'render'
      ? 'render_failed'
      : phase === 'upload'
        ? 'storage_failed'
        : 'finalization_failed'
    const terminalized = await settleWorkerFailure({
      row: claimed,
      now: new Date(),
      failureCode,
      ...(objectCleanupPendingAt ? { objectCleanupPendingAt } : {}),
    })
    if (terminalized && objectCleanupPendingAt) {
      try {
        await hireAssessmentExportStorage.delete({
          key: claimed.objectKey,
          coordinate: exportCoordinate(claimed),
        })
      } catch (cleanupError) {
        logger.warn({ exportId: claimed._id.toString() }, 'hire: assessment export upload cleanup deferred')
      }
    }
    logger.warn({ exportId: claimed._id.toString(), failureCode }, 'hire: assessment export generation deferred')
    return 'retry_scheduled'
  }
}

/** Active roots only: background scans never enumerate a B2C collection. */
export async function listHireAssessmentExportWorkspaceIdsForSweep(): Promise<string[]> {
  await connectHireDecisionDB()
  const rows = await HireWorkspace.find({
    ...activeHireWorkspaceLifecycleFilter(),
  }).select('_id').sort({ _id: 1 }).lean()
  return rows.map((row) => row._id.toString())
}

/** Returns only opaque durable identifiers to the recovery job. */
export async function listDueHireAssessmentExportIds(input: {
  workspaceId: string
  limit?: number
  now?: Date
}): Promise<string[]> {
  await connectHireDecisionDB()
  if (!OBJECT_ID.test(input.workspaceId)) return []
  const now = input.now ?? new Date()
  const workspaceId = new mongoose.Types.ObjectId(input.workspaceId)
  const limit = Math.min(
    Math.max(1, input.limit ?? HIRE_ASSESSMENT_EXPORT_RECOVERY_LIMIT_PER_WORKSPACE),
    HIRE_ASSESSMENT_EXPORT_RECOVERY_LIMIT_PER_WORKSPACE,
  )
  const rows = await HireAssessmentExport.find({
    workspaceId,
    $or: [
      { status: { $ne: 'cancelled' }, expiresAt: { $lte: now } },
      {
        expiresAt: { $gt: now },
        $or: [
          {
            status: 'pending',
            nextRetryAt: { $lte: now },
            attempts: { $lt: HIRE_ASSESSMENT_EXPORT_MAX_ATTEMPTS },
          },
          {
            status: 'failed',
            nextRetryAt: { $lte: now },
            attempts: { $lt: HIRE_ASSESSMENT_EXPORT_MAX_ATTEMPTS },
          },
          {
            status: 'generating',
            leaseExpiresAt: { $lte: now },
            attempts: { $lt: HIRE_ASSESSMENT_EXPORT_MAX_ATTEMPTS },
          },
          {
            status: 'generating',
            leaseExpiresAt: { $lte: now },
            attempts: { $gte: HIRE_ASSESSMENT_EXPORT_MAX_ATTEMPTS },
          },
        ],
      },
    ],
  }).sort({ expiresAt: 1, nextRetryAt: 1, _id: 1 }).limit(limit).select('_id').lean()
  return rows.map((row) => row._id.toString())
}

export const __hireAssessmentExport = {
  retryDueAt,
  exportCoordinate,
  serializeMemberView,
  isAuthorityLoss,
  cloneHireAssessmentDecisionSnapshot,
}
