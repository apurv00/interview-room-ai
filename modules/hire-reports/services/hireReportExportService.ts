import { randomUUID } from 'node:crypto'
import mongoose, { type ClientSession } from 'mongoose'
import { AppError, NotFoundError } from '@shared/errors'
import { logger } from '@shared/logger'
import { inngest } from '@shared/services/inngest'
import {
  HireJob,
  HirePrivacyRequest,
  HireWorkspace,
  activeHirePrivacyRequestFilter,
  activeHireWorkspaceLifecycleFilter,
  claimHireCandidatePiiWriteFence,
  HireCandidatePiiTombstoneError,
  resolveWorkspaceWriteAuthority,
  type MembershipContext,
  withActiveHireWorkspaceWriteTransaction,
} from '@hire-decision-boundary'
import {
  HIRE_REPORT_EXPORT_EXPIRY_MS,
  HIRE_REPORT_EXPORT_LEASE_MS,
  HIRE_REPORT_EXPORT_MAX_ATTEMPTS,
  HireReportExport,
  hireReportExportObjectKey,
  type HireReportExportCoordinate,
  type IHireReportExport,
} from '../models/HireReportExport'
import { ensureHireReportExportCleanupTombstone } from './hireReportExportCleanupService'
import { connectHireReportDB } from './hireReportBoundary'
import { generateHireReportPdf, hireReportPdfFilename } from './hireReportPdfService'
import {
  HIRE_REPORT_EXPORT_CONTENT_TYPES,
  hireReportExportStorage,
} from './hireReportExportStorage'
import { generateHireReportXlsx, hireReportXlsxFilename } from './hireReportXlsxService'
import {
  buildHireJobCloseoutReportSnapshot,
  type HireReportSnapshotValidationError,
} from './reportSnapshotBuilders'
import type {
  HireJobCloseoutReportSnapshot,
  HireJobCloseoutReportSnapshotInput,
  HirePipelineStatusReportSnapshot,
  HireReportFormat,
  HireReportExportFailureCode,
  HireReportExportStatus,
  HireReportKind,
  HireReportScope,
  HireReportSnapshot,
  HireReportSnapshotBuildResult,
} from '../types'

const OBJECT_ID = /^[a-f0-9]{24}$/i
const OPERATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const RETRY_BASE_MS = 60_000
const RETRY_MAX_MS = 60 * 60_000

/** Keep minute recovery tenant-fair and bounded. */
export const HIRE_REPORT_EXPORT_RECOVERY_LIMIT_PER_WORKSPACE = 10

export interface HireReportExportMemberView {
  id: string
  reportKind: HireReportKind
  format: HireReportFormat
  status: HireReportExportStatus
  requestedAt: Date
  expiresAt: Date
  readyAt: Date | null
}

export interface HireReportExportRequestResult {
  export: HireReportExportMemberView
  created: boolean
}

/** A Hire-owned actor snapshot; callers must never supply a B2C user identity. */
export interface HireReportRequesterActor {
  memberId: string
  name: string
}

/** In-memory member download handoff only; this is never a signed/public URL. */
export interface HireReportExportDownload {
  filename: string
  contentType: string
  body: Buffer
}

export type HireReportExportProcessResult =
  | 'ready'
  | 'retry_scheduled'
  | 'cancelled'
  | 'expired'
  | 'skipped'

/**
 * An operations/report reader supplies this inside the active member
 * transaction. It must query only Hire-control records and build the frozen
 * aggregate with the pure builder; request bodies never carry report content.
 */
export interface HirePipelineStatusSnapshotFactory {
  (input: {
    workspaceId: mongoose.Types.ObjectId
    scope: HireReportScope
    jobId?: mongoose.Types.ObjectId
    now: Date
    session: ClientSession
  }): Promise<HireReportSnapshotBuildResult<HirePipelineStatusReportSnapshot>>
}

export interface RequestHirePipelineStatusReportInput {
  scope: HireReportScope
  jobId?: string
  format: HireReportFormat
  operationId: string
}

export interface CreateHireJobCloseoutReportInput {
  workspaceId: string
  jobId: string
  operationId: string
  /** The active Hire member that owns the enclosing job-close transaction. */
  requestedBy: HireReportRequesterActor
  /** Must be the caller's job-close transaction session. */
  session: ClientSession
  snapshotInput: HireJobCloseoutReportSnapshotInput
  now?: Date
}

class HireReportExportUnavailableError extends AppError {
  constructor(code: 'REPORT_EXPORT_UNAVAILABLE' | 'REPORT_EXPORT_EXPIRED') {
    super('The report export is no longer available', 410, code)
    this.name = 'HireReportExportUnavailableError'
  }
}

function objectId(value: string, label: string): mongoose.Types.ObjectId {
  if (!OBJECT_ID.test(value)) throw new AppError(`Invalid ${label}`, 400, 'INVALID_ID')
  return new mongoose.Types.ObjectId(value)
}

function requestedByName(value: unknown): string {
  if (typeof value !== 'string') {
    throw new AppError('Invalid report requester name', 400, 'INVALID_REPORT_REQUESTER')
  }
  const normalized = value.trim()
  if (!normalized || normalized.length > 120) {
    throw new AppError('Invalid report requester name', 400, 'INVALID_REPORT_REQUESTER')
  }
  return normalized
}

function reportRequesterFromMemberContext(ctx: MembershipContext): {
  requestedByMemberId: mongoose.Types.ObjectId
  requestedByName: string
} {
  return {
    requestedByMemberId: ctx.membership._id,
    // Both fields are Hire-owned membership data; a B2C User is never read.
    requestedByName: requestedByName(ctx.membership.name || ctx.membership.email),
  }
}

function reportRequesterFromInput(input: HireReportRequesterActor): {
  requestedByMemberId: mongoose.Types.ObjectId
  requestedByName: string
} {
  return {
    requestedByMemberId: objectId(input.memberId, 'report requester member id'),
    requestedByName: requestedByName(input.name),
  }
}

function assertOperationId(operationId: string): void {
  if (!OPERATION_ID.test(operationId)) {
    throw new AppError('Invalid report export operation id', 400, 'INVALID_OPERATION_ID')
  }
}

function assertPipelineRequest(input: RequestHirePipelineStatusReportInput): void {
  assertOperationId(input.operationId)
  if (input.scope !== 'workspace' && input.scope !== 'job') {
    throw new AppError('Invalid report scope', 400, 'INVALID_REPORT_SCOPE')
  }
  if (input.format !== 'pdf' && input.format !== 'xlsx') {
    throw new AppError('Invalid report format', 400, 'INVALID_REPORT_FORMAT')
  }
  if (input.scope === 'job') {
    if (!input.jobId) throw new AppError('A job report requires a job id', 400, 'INVALID_REPORT_SCOPE')
    objectId(input.jobId, 'job id')
  } else if (input.jobId !== undefined) {
    throw new AppError('A workspace report cannot include a job id', 400, 'INVALID_REPORT_SCOPE')
  }
}

function exportCoordinate(row: Pick<IHireReportExport,
  '_id' | 'workspaceId' | 'jobId' | 'reportKind' | 'reportScope' | 'format'
>): HireReportExportCoordinate {
  return {
    workspaceId: row.workspaceId.toString(),
    reportId: row._id.toString(),
    reportKind: row.reportKind,
    reportScope: row.reportScope,
    format: row.format,
    ...(row.jobId ? { jobId: row.jobId.toString() } : {}),
  }
}

function serializeMemberView(row: Pick<IHireReportExport,
  '_id' | 'reportKind' | 'format' | 'status' | 'requestedAt' | 'expiresAt' | 'readyAt'
>): HireReportExportMemberView {
  return {
    id: row._id.toString(),
    reportKind: row.reportKind,
    format: row.format,
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
    'REPORT_EXPORT_UNAVAILABLE',
    'REPORT_EXPORT_EXPIRED',
  ].includes(error.code)
}

function privacyAggregateFenceFilter(version: number): Record<string, unknown> {
  // Phase-5 pipeline exports created before this field was introduced are
  // safely interpreted as epoch zero. Once any privacy lifecycle action
  // advances the workspace epoch, they fail closed like every new export.
  if (version === 0) {
    return {
      $or: [
        { privacyAggregateFenceVersion: 0 },
        { privacyAggregateFenceVersion: { $exists: false } },
      ],
    }
  }
  return { privacyAggregateFenceVersion: version }
}

function aggregatePrivacyFenceVersion(row: Pick<IHireReportExport,
  'privacyAggregateFenceVersion'
>): number {
  return row.privacyAggregateFenceVersion ?? 0
}

/**
 * Pipeline reports are aggregate-only and deliberately persist no candidate
 * coordinates. Their workspace epoch is therefore the privacy authority at
 * every egress boundary. Closeout reports retain the established, narrower
 * candidate-ID fence and intentionally bypass this aggregate epoch.
 */
async function hasActiveReportAggregatePrivacyFence(input: {
  row: Pick<IHireReportExport,
    'workspaceId' | 'reportKind' | 'privacyAggregateFenceVersion'
  >
  session: ClientSession
}): Promise<boolean> {
  if (input.row.reportKind !== 'pipeline_status') return true
  const workspace = await HireWorkspace.exists({
    $and: [
      { _id: input.row.workspaceId },
      activeHireWorkspaceLifecycleFilter(),
      privacyAggregateFenceFilter(aggregatePrivacyFenceVersion(input.row)),
    ],
  }).session(input.session)
  return Boolean(workspace)
}

/**
 * A close-out snapshot carries only the names of hired candidates. Its hidden
 * candidate IDs still pass each privacy write fence before report persistence,
 * re-render/upload, and member download. Aggregate pipeline reports carry no
 * candidate IDs, so their corresponding privacy authority is the workspace
 * aggregate epoch checked at each egress boundary above.
 */
async function assertReportPrivacyScope(input: {
  workspaceId: mongoose.Types.ObjectId
  candidateIds: readonly mongoose.Types.ObjectId[]
  now: Date
  session: ClientSession
}): Promise<void> {
  for (const candidateId of input.candidateIds) {
    const privacy = await HirePrivacyRequest.exists({
      workspaceId: input.workspaceId,
      candidateId,
      ...activeHirePrivacyRequestFilter(input.now),
    }).session(input.session)
    if (privacy) {
      throw new AppError('Candidate personal data is unavailable for a report export', 410, 'CANDIDATE_PRIVACY_PENDING')
    }
    await claimHireCandidatePiiWriteFence({
      workspaceId: input.workspaceId,
      candidateId,
      session: input.session,
    })
  }
}

function sameCreateScope(
  row: Pick<IHireReportExport, 'reportKind' | 'reportScope' | 'format' | 'jobId'>,
  expected: { reportKind: HireReportKind; reportScope: HireReportScope; format: HireReportFormat; jobId?: mongoose.Types.ObjectId },
): boolean {
  return (
    row.reportKind === expected.reportKind &&
    row.reportScope === expected.reportScope &&
    row.format === expected.format &&
    row.jobId?.toString() === expected.jobId?.toString()
  )
}

async function emitHireReportExportRequested(input: {
  workspaceId: string
  exportId: string
}): Promise<void> {
  // The event contains durable IDs only. The worker reloads every private field.
  await inngest.send({ name: 'hire/report-export.requested', data: input })
}

export async function dispatchHireReportExport(input: {
  workspaceId: string
  exportId: string
}): Promise<void> {
  objectId(input.workspaceId, 'workspace id')
  objectId(input.exportId, 'report export id')
  await emitHireReportExportRequested(input)
}

/** A lost latency kick never invalidates the already committed durable request. */
export async function kickHireReportExport(input: {
  workspaceId: string
  exportId: string
}): Promise<void> {
  try {
    await dispatchHireReportExport(input)
  } catch {
    logger.warn({ workspaceId: input.workspaceId, reportExportId: input.exportId }, 'hire: report export dispatch deferred to recovery')
  }
}

function assertPipelineSnapshotMatchesRequest(input: {
  result: HireReportSnapshotBuildResult<HirePipelineStatusReportSnapshot>
  scope: HireReportScope
}): void {
  if (
    input.result.snapshot.kind !== 'pipeline_status' ||
    input.result.snapshot.scope !== input.scope ||
    input.result.affectedCandidateIds.length !== 0
  ) {
    throw new AppError('Pipeline report snapshot did not match the authorized request', 409, 'REPORT_SNAPSHOT_RACE')
  }
}

/**
 * Create a member-requested pipeline report only from a report-reader factory
 * that runs inside an active workspace transaction. The factory receives no
 * request body snapshot and must return the pure builder's allowlisted result.
 */
export async function requestHirePipelineStatusReport(
  ctx: MembershipContext,
  input: RequestHirePipelineStatusReportInput,
  buildSnapshot: HirePipelineStatusSnapshotFactory,
): Promise<HireReportExportRequestResult> {
  await connectHireReportDB()
  assertPipelineRequest(input)
  const jobId = input.jobId ? objectId(input.jobId, 'job id') : undefined
  const now = new Date()
  const exportId = new mongoose.Types.ObjectId()
  const expiresAt = new Date(now.getTime() + HIRE_REPORT_EXPORT_EXPIRY_MS)
  const requester = reportRequesterFromMemberContext(ctx)
  const expected = {
    reportKind: 'pipeline_status' as const,
    reportScope: input.scope,
    format: input.format,
    ...(jobId ? { jobId } : {}),
  }

  let result: HireReportExportRequestResult
  try {
    result = await withActiveHireWorkspaceWriteTransaction(
      ctx.workspace._id,
      ctx.membership._id,
      async (session) => {
        const existing = await HireReportExport.findOne(
          { workspaceId: ctx.workspace._id, creationOperationId: input.operationId },
          null,
          { session },
        )
        if (existing) {
          if (!sameCreateScope(existing, expected)) {
            throw new AppError('That operation id was used for another report export', 409, 'OPERATION_ID_REUSED')
          }
          return { export: serializeMemberView(existing), created: false }
        }

        const built = await buildSnapshot({
          workspaceId: ctx.workspace._id,
          scope: input.scope,
          ...(jobId ? { jobId } : {}),
          now,
          session,
        })
        assertPipelineSnapshotMatchesRequest({ result: built, scope: input.scope })
        // The surrounding write transaction has already claimed the
        // workspace root. Reading its aggregate epoch after the frozen source
        // snapshot makes snapshot insertion conflict with a concurrent
        // privacy-start/anonymization transaction on the same root row.
        const workspace = await HireWorkspace.findOne(
          { _id: ctx.workspace._id },
          'privacyAggregateFenceVersion',
          { session },
        )
        if (!workspace) {
          throw new AppError('Workspace is unavailable for a report export', 410, 'WORKSPACE_DELETION_PENDING')
        }
        const [created] = await HireReportExport.create([
          {
            _id: exportId,
            workspaceId: ctx.workspace._id,
            ...(jobId ? { jobId } : {}),
            reportKind: 'pipeline_status',
            reportScope: input.scope,
            format: input.format,
            creationOperationId: input.operationId,
            ...requester,
            objectKey: hireReportExportObjectKey({
              workspaceId: ctx.workspace._id.toString(),
              reportId: exportId.toString(),
              reportKind: 'pipeline_status',
              reportScope: input.scope,
              format: input.format,
              ...(jobId ? { jobId: jobId.toString() } : {}),
            }),
            reportSnapshot: built.snapshot,
            affectedCandidateIds: [],
            privacyAggregateFenceVersion: workspace.privacyAggregateFenceVersion ?? 0,
            requestedAt: now,
            expiresAt,
            status: 'requested',
            attempts: 0,
            nextRetryAt: now,
          },
        ], { session })
        return { export: serializeMemberView(created), created: true }
      },
    )
  } catch (error) {
    if (isDuplicateKey(error)) {
      const existing = await HireReportExport.findOne({
        workspaceId: ctx.workspace._id,
        creationOperationId: input.operationId,
      })
      if (existing) {
        if (!sameCreateScope(existing, expected)) {
          throw new AppError('That operation id was used for another report export', 409, 'OPERATION_ID_REUSED')
        }
        return { export: serializeMemberView(existing), created: false }
      }
    }
    throw error
  }

  if (result.created) {
    await kickHireReportExport({
      workspaceId: ctx.workspace._id.toString(),
      exportId: result.export.id,
    })
  }
  return result
}

/**
 * Create the report obligation within the job-close transaction. The caller
 * owns the actual pipeline close fence and must invoke `kickHireReportExport`
 * only after that transaction commits; no external send happens here.
 */
export async function createHireJobCloseoutReport(
  input: CreateHireJobCloseoutReportInput,
): Promise<HireReportExportRequestResult> {
  await connectHireReportDB()
  assertOperationId(input.operationId)
  const workspaceId = objectId(input.workspaceId, 'workspace id')
  const jobId = objectId(input.jobId, 'job id')
  const requester = reportRequesterFromInput(input.requestedBy)
  const now = input.now ?? new Date()
  let built: HireReportSnapshotBuildResult<HireJobCloseoutReportSnapshot>
  try {
    built = buildHireJobCloseoutReportSnapshot(input.snapshotInput)
  } catch (error) {
    const snapshotError = error as HireReportSnapshotValidationError
    if (snapshotError?.name === 'HireReportSnapshotValidationError') {
      throw new AppError('Invalid job closeout report snapshot', 400, 'INVALID_REPORT_SNAPSHOT')
    }
    throw error
  }
  const candidateIds = built.affectedCandidateIds.map((candidateId) => objectId(candidateId, 'candidate id'))
  const expected = {
    reportKind: 'job_closeout' as const,
    reportScope: 'job' as const,
    format: 'pdf' as const,
    jobId,
  }
  const existing = await HireReportExport.findOne(
    { workspaceId, creationOperationId: input.operationId },
    null,
    { session: input.session },
  )
  if (existing) {
    if (!sameCreateScope(existing, expected)) {
      throw new AppError('That operation id was used for another report export', 409, 'OPERATION_ID_REUSED')
    }
    return { export: serializeMemberView(existing), created: false }
  }

  const job = await HireJob.findOne({ _id: jobId, workspaceId }, null, { session: input.session })
  if (!job) throw new NotFoundError('Job')
  await assertReportPrivacyScope({ workspaceId, candidateIds, now, session: input.session })

  const exportId = new mongoose.Types.ObjectId()
  const expiresAt = new Date(now.getTime() + HIRE_REPORT_EXPORT_EXPIRY_MS)
  try {
    const [created] = await HireReportExport.create([
      {
        _id: exportId,
        workspaceId,
        jobId,
        reportKind: 'job_closeout',
        reportScope: 'job',
        format: 'pdf',
        creationOperationId: input.operationId,
        ...requester,
        objectKey: hireReportExportObjectKey({
          workspaceId: workspaceId.toString(),
          reportId: exportId.toString(),
          reportKind: 'job_closeout',
          reportScope: 'job',
          format: 'pdf',
          jobId: jobId.toString(),
        }),
        reportSnapshot: built.snapshot,
        affectedCandidateIds: candidateIds,
        requestedAt: now,
        expiresAt,
        status: 'requested',
        attempts: 0,
        nextRetryAt: now,
      },
    ], { session: input.session })
    return { export: serializeMemberView(created), created: true }
  } catch (error) {
    if (isDuplicateKey(error)) {
      const duplicate = await HireReportExport.findOne(
        { workspaceId, creationOperationId: input.operationId },
        null,
        { session: input.session },
      )
      if (duplicate && sameCreateScope(duplicate, expected)) {
        return { export: serializeMemberView(duplicate), created: false }
      }
    }
    throw error
  }
}

/**
 * Returns only the member-safe lifecycle rows for the caller's workspace.
 * This query intentionally never selects snapshots, object keys, cleanup
 * coordinates, requester details, candidate IDs, or worker failure codes.
 */
export async function listHireReportExports(
  ctx: MembershipContext,
): Promise<HireReportExportMemberView[]> {
  await connectHireReportDB()
  const result = await withActiveHireWorkspaceWriteTransaction(
    ctx.workspace._id,
    ctx.membership._id,
    async (session) => {
      const rows = await HireReportExport.find(
        { workspaceId: ctx.workspace._id },
        '_id reportKind format status requestedAt expiresAt readyAt',
        { session },
      )
        .sort({ requestedAt: -1, _id: -1 })
        .limit(50)
        .lean()
      return rows.map((row) => serializeMemberView(row as Pick<IHireReportExport,
        '_id' | 'reportKind' | 'format' | 'status' | 'requestedAt' | 'expiresAt' | 'readyAt'
      >))
    },
  )
  return result
}

/** Member status is opaque: no storage key, snapshot, failure detail, or URL. */
export async function getHireReportExportStatus(
  ctx: MembershipContext,
  exportId: string,
): Promise<HireReportExportMemberView> {
  await connectHireReportDB()
  const id = objectId(exportId, 'report export id')
  const now = new Date()
  const result = await withActiveHireWorkspaceWriteTransaction(
    ctx.workspace._id,
    ctx.membership._id,
    async (session) => {
      const row = await HireReportExport.findOne(
        { _id: id, workspaceId: ctx.workspace._id },
        null,
        { session },
      ).select('+affectedCandidateIds +privacyAggregateFenceVersion')
      if (!row) throw new NotFoundError('Report export')
      if (row.expiresAt <= now || row.status === 'expired' || row.status === 'cancelled') {
        throw new HireReportExportUnavailableError('REPORT_EXPORT_EXPIRED')
      }
      if (!await hasActiveReportAggregatePrivacyFence({ row, session })) {
        // This commits the cleanup tombstone and redaction before the member
        // sees a terminal response, so a ready object cannot remain usable
        // after a privacy aggregate epoch changes.
        await terminalizeReport({
          row,
          now,
          status: 'cancelled',
          session,
          deleteImmediately: false,
        })
        return null
      }
      await assertReportPrivacyScope({
        workspaceId: ctx.workspace._id,
        candidateIds: row.affectedCandidateIds,
        now,
        session,
      })
      return serializeMemberView(row)
    },
  )
  if (!result) throw new HireReportExportUnavailableError('REPORT_EXPORT_UNAVAILABLE')
  return result
}

/**
 * Private-object read is fenced in the same active workspace transaction as
 * membership and closeout-candidate privacy. It never returns a signed URL.
 */
export async function downloadHireReportExport(
  ctx: MembershipContext,
  exportId: string,
): Promise<HireReportExportDownload> {
  await connectHireReportDB()
  const id = objectId(exportId, 'report export id')
  const now = new Date()
  const result = await withActiveHireWorkspaceWriteTransaction(
    ctx.workspace._id,
    ctx.membership._id,
    async (session) => {
      const row = await HireReportExport.findOne(
        {
          _id: id,
          workspaceId: ctx.workspace._id,
          status: 'ready',
          expiresAt: { $gt: now },
        },
        null,
        { session },
      ).select('+objectKey +affectedCandidateIds +privacyAggregateFenceVersion')
      if (!row?.objectKey) throw new HireReportExportUnavailableError('REPORT_EXPORT_EXPIRED')
      if (!await hasActiveReportAggregatePrivacyFence({ row, session })) {
        await terminalizeReport({
          row,
          now,
          status: 'cancelled',
          session,
          deleteImmediately: false,
        })
        return null
      }
      await assertReportPrivacyScope({
        workspaceId: ctx.workspace._id,
        candidateIds: row.affectedCandidateIds,
        now,
        session,
      })
      const body = await hireReportExportStorage.download({
        key: row.objectKey,
        coordinate: exportCoordinate(row),
      })
      return {
        filename: row.format === 'pdf'
          ? hireReportPdfFilename(row.reportKind)
          : hireReportXlsxFilename(row.reportKind),
        contentType: HIRE_REPORT_EXPORT_CONTENT_TYPES[row.format],
        body,
      }
    },
  )
  if (!result) throw new HireReportExportUnavailableError('REPORT_EXPORT_UNAVAILABLE')
  return result
}

async function selectWorkerRow(input: {
  workspaceId: mongoose.Types.ObjectId
  exportId: mongoose.Types.ObjectId
}): Promise<IHireReportExport | null> {
  return HireReportExport.findOne({
    _id: input.exportId,
    workspaceId: input.workspaceId,
  }).select('+objectKey +reportSnapshot +affectedCandidateIds +privacyAggregateFenceVersion +claimToken')
}

/**
 * The terminal state is persisted only after the cleanup tombstone. This is
 * the lifecycle linearization point: a later worker can always derive and
 * delete the exact artifact even when a process crashes after an upload.
 */
async function terminalizeReport(input: {
  row: IHireReportExport
  now: Date
  status: 'cancelled' | 'expired'
  session?: ClientSession
  deleteImmediately: boolean
}): Promise<void> {
  const coordinate = exportCoordinate(input.row)
  const cleanupNotBeforeAt = await ensureHireReportExportCleanupTombstone({
    coordinate,
    requestedAt: input.now,
    ...(input.session ? { session: input.session } : {}),
  })
  const terminalField = input.status === 'cancelled' ? 'cancelledAt' : 'expiredAt'
  await HireReportExport.updateOne(
    {
      _id: input.row._id,
      workspaceId: input.row.workspaceId,
      status: { $nin: ['cancelled', 'expired'] },
    },
    {
      $set: {
        status: input.status,
        [terminalField]: input.now,
        privacyRedactedAt: input.now,
        objectCleanupPendingAt: cleanupNotBeforeAt,
      },
      $unset: {
        reportSnapshot: 1,
        objectKey: 1,
        affectedCandidateIds: 1,
        claimToken: 1,
        leaseExpiresAt: 1,
        nextRetryAt: 1,
        failureCode: 1,
        objectCleanupCompletedAt: 1,
        objectCleanupClaimToken: 1,
        objectCleanupLeaseExpiresAt: 1,
      },
    },
    { timestamps: false, overwriteImmutable: true, ...(input.session ? { session: input.session } : {}) },
  )
  if (input.deleteImmediately && input.row.objectKey) {
    await hireReportExportStorage.delete({ key: input.row.objectKey, coordinate })
  }
}

/**
 * Lifecycle owners call this within their privacy/workspace/job transaction.
 * It never calls storage before that transaction commits; recovery consumes
 * the durable tombstone afterward.
 */
export async function markHireReportExportCancelledForLifecycle(input: {
  workspaceId: string
  exportId: string
  session: ClientSession
  now?: Date
}): Promise<boolean> {
  await connectHireReportDB()
  if (!OBJECT_ID.test(input.workspaceId) || !OBJECT_ID.test(input.exportId)) return false
  const row = await HireReportExport.findOne(
    {
      _id: new mongoose.Types.ObjectId(input.exportId),
      workspaceId: new mongoose.Types.ObjectId(input.workspaceId),
      status: { $nin: ['cancelled', 'expired'] },
    },
    null,
    { session: input.session },
  ).select('+objectKey +affectedCandidateIds')
  if (!row) return false
  await terminalizeReport({
    row,
    now: input.now ?? new Date(),
    status: 'cancelled',
    session: input.session,
    deleteImmediately: false,
  })
  return true
}

async function claimReportForWorker(input: {
  row: IHireReportExport
  authorityMemberId: mongoose.Types.ObjectId
  now: Date
}): Promise<IHireReportExport | 'cancelled' | null> {
  const claimToken = randomUUID()
  return withActiveHireWorkspaceWriteTransaction(
    input.row.workspaceId,
    input.authorityMemberId,
    async (session) => {
      if (!await hasActiveReportAggregatePrivacyFence({ row: input.row, session })) {
        await terminalizeReport({
          row: input.row,
          now: input.now,
          status: 'cancelled',
          session,
          deleteImmediately: false,
        })
        return 'cancelled' as const
      }
      const claimed = await HireReportExport.findOneAndUpdate(
        {
          _id: input.row._id,
          workspaceId: input.row.workspaceId,
          expiresAt: { $gt: input.now },
          $or: [
            {
              status: 'requested',
              nextRetryAt: { $lte: input.now },
              attempts: { $lt: HIRE_REPORT_EXPORT_MAX_ATTEMPTS },
            },
            {
              status: 'failed',
              nextRetryAt: { $lte: input.now },
              attempts: { $lt: HIRE_REPORT_EXPORT_MAX_ATTEMPTS },
            },
            {
              status: 'generating',
              leaseExpiresAt: { $lte: input.now },
              attempts: { $lt: HIRE_REPORT_EXPORT_MAX_ATTEMPTS },
            },
          ],
        },
        {
          $set: {
            status: 'generating',
            generatingAt: input.now,
            claimToken,
            leaseExpiresAt: new Date(input.now.getTime() + HIRE_REPORT_EXPORT_LEASE_MS),
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
      ).select('+objectKey +reportSnapshot +affectedCandidateIds +privacyAggregateFenceVersion +claimToken')
      if (!claimed) return null
      if (!await hasActiveReportAggregatePrivacyFence({ row: claimed, session })) {
        await terminalizeReport({
          row: claimed,
          now: input.now,
          status: 'cancelled',
          session,
          deleteImmediately: false,
        })
        return 'cancelled' as const
      }
      await assertReportPrivacyScope({
        workspaceId: claimed.workspaceId,
        candidateIds: claimed.affectedCandidateIds,
        now: input.now,
        session,
      })
      return claimed
    },
  )
}

async function reauthorizeWorkerClaim(input: {
  row: IHireReportExport
  authorityMemberId: mongoose.Types.ObjectId
  now: Date
}): Promise<boolean | 'cancelled'> {
  return withActiveHireWorkspaceWriteTransaction(
    input.row.workspaceId,
    input.authorityMemberId,
    async (session) => {
      const current = await HireReportExport.findOne(
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
      ).select('+affectedCandidateIds +privacyAggregateFenceVersion')
      if (!current) return false
      if (!await hasActiveReportAggregatePrivacyFence({ row: current, session })) {
        await terminalizeReport({
          row: current,
          now: input.now,
          status: 'cancelled',
          session,
          deleteImmediately: false,
        })
        return 'cancelled' as const
      }
      await assertReportPrivacyScope({
        workspaceId: current.workspaceId,
        candidateIds: current.affectedCandidateIds,
        now: input.now,
        session,
      })
      return true
    },
  )
}

async function finalizeReadyReport(input: {
  row: IHireReportExport
  authorityMemberId: mongoose.Types.ObjectId
  now: Date
  contentSizeBytes: number
}): Promise<boolean | 'cancelled'> {
  return withActiveHireWorkspaceWriteTransaction(
    input.row.workspaceId,
    input.authorityMemberId,
    async (session) => {
      const current = await HireReportExport.findOne(
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
      ).select('+affectedCandidateIds +privacyAggregateFenceVersion')
      if (!current) return false
      if (!await hasActiveReportAggregatePrivacyFence({ row: current, session })) {
        await terminalizeReport({
          row: current,
          now: input.now,
          status: 'cancelled',
          session,
          deleteImmediately: false,
        })
        return 'cancelled' as const
      }
      await assertReportPrivacyScope({
        workspaceId: current.workspaceId,
        candidateIds: current.affectedCandidateIds,
        now: input.now,
        session,
      })
      const finalized = await HireReportExport.updateOne(
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
  row: IHireReportExport
  now: Date
  failureCode: HireReportExportFailureCode
  objectCleanupPendingAt?: Date
}): Promise<boolean> {
  const retryAt = input.row.attempts < HIRE_REPORT_EXPORT_MAX_ATTEMPTS
    ? retryDueAt(input.now, input.row.attempts)
    : undefined
  // A terminal failed export cannot retain an immutable snapshot after its
  // cleanup obligation is durable. Retriable failures keep their frozen input.
  const redactTerminalFailure = Boolean(input.objectCleanupPendingAt && !retryAt)
  const settled = await HireReportExport.updateOne(
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
        ...(input.objectCleanupPendingAt ? { objectCleanupPendingAt: input.objectCleanupPendingAt } : {}),
        ...(redactTerminalFailure ? { privacyRedactedAt: input.now } : {}),
      },
      $unset: {
        claimToken: 1,
        leaseExpiresAt: 1,
        ...(retryAt ? {} : { nextRetryAt: 1 }),
        ...(input.objectCleanupPendingAt
          ? { objectCleanupCompletedAt: 1, objectCleanupClaimToken: 1, objectCleanupLeaseExpiresAt: 1 }
          : {}),
        ...(redactTerminalFailure
          ? { reportSnapshot: 1, objectKey: 1, affectedCandidateIds: 1 }
          : {}),
      },
    },
    {
      timestamps: false,
      ...(redactTerminalFailure ? { overwriteImmutable: true } : {}),
    },
  )
  return settled.matchedCount === 1
}

async function finalizeExpiredExhaustedReport(row: IHireReportExport, now: Date): Promise<void> {
  const cleanupNotBeforeAt = await ensureHireReportExportCleanupTombstone({
    coordinate: exportCoordinate(row),
    requestedAt: now,
  })
  const finalized = await HireReportExport.updateOne(
    {
      _id: row._id,
      workspaceId: row.workspaceId,
      status: 'generating',
      attempts: { $gte: HIRE_REPORT_EXPORT_MAX_ATTEMPTS },
      leaseExpiresAt: { $lte: now },
    },
    {
      $set: {
        status: 'failed',
        failedAt: now,
        failureCode: 'finalization_failed',
        privacyRedactedAt: now,
        objectCleanupPendingAt: cleanupNotBeforeAt,
      },
      $unset: {
        reportSnapshot: 1,
        objectKey: 1,
        affectedCandidateIds: 1,
        claimToken: 1,
        leaseExpiresAt: 1,
        nextRetryAt: 1,
        objectCleanupCompletedAt: 1,
        objectCleanupClaimToken: 1,
        objectCleanupLeaseExpiresAt: 1,
      },
    },
    { timestamps: false, overwriteImmutable: true },
  )
  if (finalized.matchedCount === 1 && row.objectKey) {
    await hireReportExportStorage.delete({
      key: row.objectKey,
      coordinate: exportCoordinate(row),
    })
  }
}

async function generateArtifact(input: {
  snapshot: HireReportSnapshot
  format: HireReportFormat
}): Promise<Buffer> {
  return input.format === 'pdf'
    ? generateHireReportPdf(input.snapshot)
    : generateHireReportXlsx(input.snapshot)
}

/**
 * Worker entry point. Its event carries IDs only; it reloads private values,
 * holds an explicit lease, rechecks fences before render/upload/finalization,
 * and writes only to the private deterministic artifact key.
 */
export async function processHireReportExport(input: {
  workspaceId: string
  exportId: string
  now?: Date
}): Promise<HireReportExportProcessResult> {
  await connectHireReportDB()
  if (!OBJECT_ID.test(input.workspaceId) || !OBJECT_ID.test(input.exportId)) return 'skipped'
  const now = input.now ?? new Date()
  const workspaceId = new mongoose.Types.ObjectId(input.workspaceId)
  const exportId = new mongoose.Types.ObjectId(input.exportId)
  const row = await selectWorkerRow({ workspaceId, exportId })
  if (!row) return 'skipped'
  if (row.status === 'cancelled') return 'cancelled'
  if (row.status === 'expired') return 'expired'
  if (row.expiresAt <= now) {
    await terminalizeReport({ row, now, status: 'expired', deleteImmediately: true })
    return 'expired'
  }
  if (
    row.status === 'generating' &&
    row.attempts >= HIRE_REPORT_EXPORT_MAX_ATTEMPTS &&
    row.leaseExpiresAt &&
    row.leaseExpiresAt <= now
  ) {
    await finalizeExpiredExhaustedReport(row, now)
    return 'skipped'
  }

  const authorityMemberId = await resolveWorkspaceWriteAuthority(workspaceId)
  if (!authorityMemberId) {
    await terminalizeReport({ row, now, status: 'cancelled', deleteImmediately: true })
    return 'cancelled'
  }

  let claimed: IHireReportExport | 'cancelled' | null
  try {
    claimed = await claimReportForWorker({ row, authorityMemberId, now })
  } catch (error) {
    if (isAuthorityLoss(error)) {
      await terminalizeReport({ row, now, status: 'cancelled', deleteImmediately: true })
      return 'cancelled'
    }
    throw error
  }
  if (claimed === 'cancelled') return 'cancelled'
  if (!claimed) return 'skipped'
  if (!claimed.objectKey || !claimed.reportSnapshot || !claimed.claimToken || !claimed.leaseExpiresAt) {
    await settleWorkerFailure({ row: claimed, now, failureCode: 'finalization_failed' })
    return 'retry_scheduled'
  }
  const uploadLeaseExpiresAt = claimed.leaseExpiresAt

  let phase: 'render' | 'upload' | 'finalize' = 'render'
  try {
    const beforeRender = await reauthorizeWorkerClaim({ row: claimed, authorityMemberId, now: new Date() })
    if (beforeRender === 'cancelled') return 'cancelled'
    if (!beforeRender) {
      return 'skipped'
    }
    const artifact = await generateArtifact({
      snapshot: claimed.reportSnapshot,
      format: claimed.format,
    })
    const beforeUpload = await reauthorizeWorkerClaim({ row: claimed, authorityMemberId, now: new Date() })
    if (beforeUpload === 'cancelled') return 'cancelled'
    if (!beforeUpload) {
      return 'skipped'
    }
    phase = 'upload'
    await hireReportExportStorage.upload({
      key: claimed.objectKey,
      coordinate: exportCoordinate(claimed),
      body: artifact,
      leaseExpiresAt: uploadLeaseExpiresAt,
    })
    phase = 'finalize'
    const finalized = await finalizeReadyReport({
      row: claimed,
      authorityMemberId,
      now: new Date(),
      contentSizeBytes: artifact.byteLength,
    })
    if (finalized === 'cancelled') return 'cancelled'
    if (finalized) return 'ready'

    const current = await selectWorkerRow({ workspaceId, exportId })
    if (!current || current.status === 'cancelled') return 'cancelled'
    if (current.status === 'expired') return 'expired'
    if (current.expiresAt <= new Date()) {
      await terminalizeReport({ row: claimed, now: new Date(), status: 'cancelled', deleteImmediately: true })
      return 'cancelled'
    }
    return 'skipped'
  } catch (error) {
    if (isAuthorityLoss(error)) {
      await terminalizeReport({ row: claimed, now: new Date(), status: 'cancelled', deleteImmediately: true })
      return 'cancelled'
    }
    let objectCleanupPendingAt: Date | undefined
    if (phase !== 'render' && claimed.attempts >= HIRE_REPORT_EXPORT_MAX_ATTEMPTS) {
      objectCleanupPendingAt = await ensureHireReportExportCleanupTombstone({
        coordinate: exportCoordinate(claimed),
        requestedAt: new Date(),
      })
    }
    const failureCode: HireReportExportFailureCode = phase === 'render'
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
        await hireReportExportStorage.delete({
          key: claimed.objectKey,
          coordinate: exportCoordinate(claimed),
        })
      } catch {
        logger.warn({ reportExportId: claimed._id.toString() }, 'hire: report export upload cleanup deferred')
      }
    }
    logger.warn({ reportExportId: claimed._id.toString(), failureCode }, 'hire: report export generation deferred')
    return 'retry_scheduled'
  }
}

/** Active Hire-control roots only; no recovery scan enumerates B2C records. */
export async function listHireReportExportWorkspaceIdsForSweep(): Promise<string[]> {
  await connectHireReportDB()
  const rows = await HireWorkspace.find({
    ...activeHireWorkspaceLifecycleFilter(),
  }).select('_id').sort({ _id: 1 }).lean()
  return rows.map((row) => row._id.toString())
}

/** Returns only opaque durable IDs to the recovery job. */
export async function listDueHireReportExportIds(input: {
  workspaceId: string
  limit?: number
  now?: Date
}): Promise<string[]> {
  await connectHireReportDB()
  if (!OBJECT_ID.test(input.workspaceId)) return []
  const now = input.now ?? new Date()
  const workspaceId = new mongoose.Types.ObjectId(input.workspaceId)
  const limit = Math.min(
    Math.max(1, input.limit ?? HIRE_REPORT_EXPORT_RECOVERY_LIMIT_PER_WORKSPACE),
    HIRE_REPORT_EXPORT_RECOVERY_LIMIT_PER_WORKSPACE,
  )
  const rows = await HireReportExport.find({
    workspaceId,
    $or: [
      { status: { $nin: ['cancelled', 'expired'] }, expiresAt: { $lte: now } },
      {
        expiresAt: { $gt: now },
        $or: [
          {
            status: 'requested',
            nextRetryAt: { $lte: now },
            attempts: { $lt: HIRE_REPORT_EXPORT_MAX_ATTEMPTS },
          },
          {
            status: 'failed',
            nextRetryAt: { $lte: now },
            attempts: { $lt: HIRE_REPORT_EXPORT_MAX_ATTEMPTS },
          },
          {
            status: 'generating',
            leaseExpiresAt: { $lte: now },
            attempts: { $lt: HIRE_REPORT_EXPORT_MAX_ATTEMPTS },
          },
          {
            status: 'generating',
            leaseExpiresAt: { $lte: now },
            attempts: { $gte: HIRE_REPORT_EXPORT_MAX_ATTEMPTS },
          },
        ],
      },
    ],
  }).sort({ expiresAt: 1, nextRetryAt: 1, _id: 1 }).limit(limit).select('_id').lean()
  return rows.map((row) => row._id.toString())
}

export const __hireReportExport = {
  retryDueAt,
  exportCoordinate,
  serializeMemberView,
  isAuthorityLoss,
  assertPipelineSnapshotMatchesRequest,
}
