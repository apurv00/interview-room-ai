import { randomUUID } from 'node:crypto'
import mongoose, { type ClientSession } from 'mongoose'
import { AppError, NotFoundError } from '@shared/errors'
import { inngest } from '@shared/services/inngest'
import {
  HireApplication,
  TERMINAL_STAGES,
  type HireStage,
} from '../../hire/models/HireApplication'
import { HireCandidate } from '../../hire/models/HireCandidate'
import {
  HirePrivacyRequest,
  activeHirePrivacyRequestFilter,
} from '../../hire/models/HirePrivacyRequest'
import { HireJob } from '../../hire/models/HireJob'
import { HireWorkspace } from '../../hire/models/HireWorkspace'
import { HireWorkspaceMember } from '../../hire/models/HireWorkspaceMember'
import { connectHireControlDB } from '../../hire/services/hireControlBoundary'
import { activeHireWorkspaceLifecycleFilter } from '../../hire/services/hireWorkspaceLifecycleFilter'
import { withActiveHireWorkspaceWriteTransaction } from '../../hire/services/hireWorkspaceWriteFence'
import { moveStage } from '../../hire/services/pipelineService'
import type { MembershipContext } from '../../hire/services/workspaceService'
import {
  HireCandidateBulkOperation,
  HireCandidateBulkOperationItem,
  HIRE_CANDIDATE_BULK_ITEM_RETENTION_MS,
  HIRE_CANDIDATE_BULK_OPERATION_RETENTION_MS,
  type HireCandidateBulkAction,
  type HireCandidateBulkItemStatus,
  type HireCandidateBulkReasonCode,
  type IHireCandidateBulkOperation,
} from '../models'
import type {
  CreateHireCandidateBulkOperationInput,
  HireCandidateBulkOperationIssueQuery,
} from '../validators'
import {
  decodeBulkOperationIssueCursor,
  encodeBulkOperationIssueCursor,
} from './bulkOperationIssueCursor'

export const HIRE_CANDIDATE_BULK_MAX_SELECTION = 5000
export const HIRE_CANDIDATE_BULK_WORKER_BATCH_SIZE = 10
export const HIRE_CANDIDATE_BULK_MAX_ATTEMPTS = 5
export const HIRE_CANDIDATE_BULK_LEASE_MS = 5 * 60 * 1000
const HIRE_CANDIDATE_BULK_RETRY_BASE_MS = 30 * 1000
const HIRE_CANDIDATE_BULK_RETRY_MAX_MS = 15 * 60 * 1000
const HIRE_CANDIDATE_BULK_INSERT_BATCH_SIZE = 500
const HIRE_CANDIDATE_BULK_RECOVERY_LIMIT = 10

export interface CandidateSelectionSnapshotAuthority {
  selectionId: string
  jobId: string
  entries: Array<{ applicationId: string; expectedStage: HireStage }>
  count: number
  description: string
  expiresAt: Date
}

export type ReadCandidateSelectionSnapshot = (
  ctx: MembershipContext,
  input: {
    jobId: string
    selectionId: string
    session: ClientSession
  },
) => Promise<CandidateSelectionSnapshotAuthority>

export interface CandidateBulkOperationView {
  operationId: string
  jobId: string
  selectionId: string
  action: HireCandidateBulkAction
  expectedStage?: HireStage
  communication: 'none'
  reasonCode?: HireCandidateBulkReasonCode
  selectionDescription: string
  status: IHireCandidateBulkOperation['status']
  totalCount: number
  queuedCount: number
  processingCount: number
  succeededCount: number
  conflictCount: number
  failedCount: number
  dispatch: {
    status: IHireCandidateBulkOperation['dispatchStatus']
    attempts: number
    lastErrorCode?: 'inngest_dispatch_unavailable'
    lastErrorAt?: Date
    lastDispatchedAt?: Date
  }
  startedAt?: Date
  completedAt?: Date
  createdAt: Date
  updatedAt: Date
}

export interface CandidateBulkOperationIssueView {
  itemId: string
  applicationId: string
  expectedStage: HireStage
  status: Extract<HireCandidateBulkItemStatus, 'conflict' | 'failed'>
  code: string
  processedAt?: Date
}

export interface CandidateBulkOperationIssuePage {
  items: CandidateBulkOperationIssueView[]
  nextCursor: string | null
}

function actorName(ctx: MembershipContext): string {
  return ctx.membership.name || ctx.membership.email
}

const BULK_REASON_LABELS: Record<HireCandidateBulkReasonCode, string> = {
  requirements_mismatch: 'Requirements mismatch',
  position_closed: 'Position closed',
  duplicate_application: 'Duplicate application',
  candidate_withdrew: 'Candidate withdrew',
  role_filled: 'Role filled',
}

function stageEventNote(reasonCode?: HireCandidateBulkReasonCode): string | undefined {
  return reasonCode ? `Bulk reason: ${BULK_REASON_LABELS[reasonCode]}` : undefined
}

function operationView(operation: IHireCandidateBulkOperation): CandidateBulkOperationView {
  return {
    operationId: operation._id.toString(),
    jobId: operation.jobId.toString(),
    selectionId: operation.selectionSnapshotId.toString(),
    action: operation.action,
    ...(operation.expectedStage ? { expectedStage: operation.expectedStage } : {}),
    communication: operation.communication,
    ...(operation.reasonCode ? { reasonCode: operation.reasonCode } : {}),
    selectionDescription: operation.selectionDescription,
    status: operation.status,
    totalCount: operation.totalCount,
    queuedCount: operation.queuedCount,
    processingCount: operation.processingCount,
    succeededCount: operation.succeededCount,
    conflictCount: operation.conflictCount,
    failedCount: operation.failedCount,
    dispatch: {
      status: operation.dispatchStatus,
      attempts: operation.dispatchAttempts,
      ...(operation.lastDispatchErrorCode
        ? { lastErrorCode: operation.lastDispatchErrorCode }
        : {}),
      ...(operation.lastDispatchErrorAt
        ? { lastErrorAt: operation.lastDispatchErrorAt }
        : {}),
      ...(operation.lastDispatchedAt
        ? { lastDispatchedAt: operation.lastDispatchedAt }
        : {}),
    },
    ...(operation.startedAt ? { startedAt: operation.startedAt } : {}),
    ...(operation.completedAt ? { completedAt: operation.completedAt } : {}),
    createdAt: operation.createdAt,
    updatedAt: operation.updatedAt,
  }
}

function sameReplay(
  operation: IHireCandidateBulkOperation,
  input: CreateHireCandidateBulkOperationInput & { jobId: string },
): boolean {
  return (
    operation.jobId.toString() === input.jobId &&
    operation.selectionSnapshotId.toString() === input.selectionId &&
    operation.action === input.action &&
    (operation.expectedStage || undefined) === input.expectedStage &&
    operation.communication === input.communication &&
    (operation.reasonCode || undefined) === input.reasonCode &&
    operation.totalCount === input.confirmedCount
  )
}

function assertReplay(
  operation: IHireCandidateBulkOperation,
  input: CreateHireCandidateBulkOperationInput & { jobId: string },
): CandidateBulkOperationView {
  if (!sameReplay(operation, input)) {
    throw new AppError(
      'That operation id was already used for another bulk action',
      409,
      'BULK_OPERATION_ID_REUSED',
    )
  }
  return operationView(operation)
}

function retryAt(attempt: number, now: Date): Date {
  const delay = Math.min(
    HIRE_CANDIDATE_BULK_RETRY_BASE_MS * 2 ** Math.max(0, attempt - 1),
    HIRE_CANDIDATE_BULK_RETRY_MAX_MS,
  )
  return new Date(now.getTime() + delay)
}

function requireObjectIds(values: string[]): mongoose.Types.ObjectId[] {
  if (
    values.length < 1 ||
    values.length > HIRE_CANDIDATE_BULK_MAX_SELECTION ||
    values.some((value) => !mongoose.Types.ObjectId.isValid(value))
  ) {
    throw new AppError(
      `Bulk actions require 1-${HIRE_CANDIDATE_BULK_MAX_SELECTION} valid applications`,
      422,
      'INVALID_BULK_SELECTION',
    )
  }
  const unique = Array.from(new Set(values))
  if (unique.length !== values.length) {
    throw new AppError(
      'The candidate selection contains duplicate applications',
      409,
      'SELECTION_STALE',
    )
  }
  return unique.map((value) => new mongoose.Types.ObjectId(value))
}

async function readExistingOperation(
  ctx: MembershipContext,
  clientOperationId: string,
): Promise<IHireCandidateBulkOperation | null> {
  return HireCandidateBulkOperation.findOne({
    workspaceId: ctx.workspace._id,
    requestedByMemberId: ctx.membership._id,
    clientOperationId,
  })
}

/**
 * Persist one immutable, member-scoped action and all per-row expected-stage
 * coordinates in the same transaction. The browser never sends an
 * authoritative thousand-id payload: the application ids come only from the
 * server-side selection snapshot reader.
 */
export async function createHireCandidateBulkOperation(
  ctx: MembershipContext,
  input: CreateHireCandidateBulkOperationInput & { jobId: string },
  readSelection: ReadCandidateSelectionSnapshot,
): Promise<CandidateBulkOperationView> {
  await connectHireControlDB()
  const existing = await readExistingOperation(ctx, input.clientOperationId)
  if (existing) return assertReplay(existing, input)

  if (
    (input.action === 'reject' || input.action === 'withdraw') &&
    !input.reasonCode
  ) {
    throw new AppError(
      'A reason is required for a bulk reject or withdrawal',
      422,
      'BULK_REASON_REQUIRED',
    )
  }
  if (
    (input.action === 'reject' || input.action === 'withdraw') &&
    ((input.action === 'withdraw') !== (input.reasonCode === 'candidate_withdrew'))
  ) {
    throw new AppError('Choose a reason that matches the bulk action', 422, 'BULK_REASON_MISMATCH')
  }
  if (input.action === 'advance' && !input.expectedStage) {
    throw new AppError(
      'Choose candidates from one stage before advancing them',
      422,
      'BULK_EXPECTED_STAGE_REQUIRED',
    )
  }

  let created: IHireCandidateBulkOperation | undefined
  try {
    created = await withActiveHireWorkspaceWriteTransaction(
      ctx.workspace._id,
      ctx.membership._id,
      async (session) => {
        const snapshot = await readSelection(ctx, {
          jobId: input.jobId,
          selectionId: input.selectionId,
          session,
        })
        if (snapshot.jobId !== input.jobId) {
          throw new AppError(
            'The candidate selection belongs to another job',
            409,
            'SELECTION_SCOPE_MISMATCH',
          )
        }
        if (snapshot.expiresAt.getTime() <= Date.now()) {
          throw new AppError(
            'That candidate selection expired; refresh it before continuing',
            409,
            'SELECTION_EXPIRED',
          )
        }
        if (snapshot.count !== input.confirmedCount) {
          throw new AppError(
            'The candidate count changed; review the selection again',
            409,
            'SELECTION_COUNT_CHANGED',
          )
        }
        const applicationIds = requireObjectIds(
          snapshot.entries.map((entry) => entry.applicationId),
        )
        if (applicationIds.length !== snapshot.count) {
          throw new AppError(
            'The candidate selection is incomplete',
            409,
            'SELECTION_STALE',
          )
        }

        const job = await HireJob.findOne({
          _id: input.jobId,
          workspaceId: ctx.workspace._id,
          status: 'open',
        })
          .select('_id')
          .session(session)
        if (!job) {
          throw new AppError(
            'Candidate actions are available only while the job is open',
            409,
            'JOB_NOT_OPEN',
          )
        }

        const applications = await HireApplication.find({
          _id: { $in: applicationIds },
          workspaceId: ctx.workspace._id,
          jobId: job._id,
        })
          .select('_id candidateId stage')
          .sort({ _id: 1 })
          .session(session)
        if (applications.length !== applicationIds.length) {
          throw new AppError(
            'One or more candidates changed; refresh the selection',
            409,
            'SELECTION_STALE',
          )
        }
        const expectedStageByApplication = new Map(
          snapshot.entries.map((entry) => [entry.applicationId, entry.expectedStage]),
        )
        if (
          applications.some(
            (application) =>
              expectedStageByApplication.get(application._id.toString()) !==
              application.stage,
          )
        ) {
          throw new AppError(
            'One or more candidate stages changed; review the selection again',
            409,
            'SELECTION_STAGE_CHANGED',
          )
        }
        if (applications.some((application) => TERMINAL_STAGES.includes(application.stage))) {
          throw new AppError(
            'Terminal candidates cannot be changed in bulk',
            409,
            'BULK_TERMINAL_SELECTION',
          )
        }
        if (
          input.action === 'advance' &&
          applications.some(
            (application) => application.stage !== input.expectedStage,
          )
        ) {
          throw new AppError(
            'Advance requires candidates from one unchanged stage',
            409,
            'BULK_STAGE_MISMATCH',
          )
        }
        if (
          input.action === 'advance' &&
          applications.some((application) => application.stage === 'offer')
        ) {
          throw new AppError(
            'Offer outcomes must be recorded one candidate at a time',
            422,
            'BULK_OFFER_OUTCOME_FORBIDDEN',
          )
        }

        const candidateIds = applications.map((application) => application.candidateId)
        // Mongo transactions do not support parallel operations on one
        // session; keep these two privacy checks deliberately sequential.
        const candidateFence = await HireCandidate.updateMany({
          _id: { $in: candidateIds },
          workspaceId: ctx.workspace._id,
          piiAnonymizedAt: { $exists: false },
        }, { $inc: { privacyWriteFenceVersion: 1 } }, { session, timestamps: false })
        const privacyRequests = await HirePrivacyRequest.countDocuments({
          workspaceId: ctx.workspace._id,
          candidateId: { $in: candidateIds },
          ...activeHirePrivacyRequestFilter(new Date()),
        }).session(session)
        if (candidateFence.matchedCount !== candidateIds.length || privacyRequests > 0) {
          throw new AppError(
            'One or more candidates are unavailable for privacy reasons',
            409,
            'SELECTION_PRIVACY_PROTECTED',
          )
        }

        const operationId = new mongoose.Types.ObjectId()
        const now = new Date()
        const [operation] = await HireCandidateBulkOperation.create(
          [
            {
              _id: operationId,
              workspaceId: ctx.workspace._id,
              jobId: job._id,
              selectionSnapshotId: new mongoose.Types.ObjectId(snapshot.selectionId),
              requestedByMemberId: ctx.membership._id,
              requestedByName: actorName(ctx),
              clientOperationId: input.clientOperationId,
              action: input.action,
              expectedStage: input.expectedStage,
              communication: input.communication,
              reasonCode: input.reasonCode,
              selectionDescription: snapshot.description,
              status: 'queued',
              totalCount: applications.length,
              queuedCount: applications.length,
              processingCount: 0,
              succeededCount: 0,
              conflictCount: 0,
              failedCount: 0,
              dispatchStatus: 'pending',
              dispatchAttempts: 0,
              nextRecoveryAt: now,
            },
          ],
          { session },
        )
        for (let offset = 0; offset < applications.length; offset += HIRE_CANDIDATE_BULK_INSERT_BATCH_SIZE) {
          await HireCandidateBulkOperationItem.insertMany(
            applications
              .slice(offset, offset + HIRE_CANDIDATE_BULK_INSERT_BATCH_SIZE)
              .map((application) => ({
                workspaceId: ctx.workspace._id,
                jobId: job._id,
                bulkOperationId: operationId,
                applicationId: application._id,
                expectedStage:
                  expectedStageByApplication.get(application._id.toString()) ??
                  application.stage,
                rowOperationId: `bulk:${operationId.toString()}:${application._id.toString()}`,
                status: 'queued',
                attempts: 0,
                nextAttemptAt: now,
              })),
            { session, ordered: true },
          )
        }
        return operation
      },
    )
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      (error as { code?: number }).code === 11000
    ) {
      const replay = await readExistingOperation(ctx, input.clientOperationId)
      if (replay) return assertReplay(replay, input)
    }
    throw error
  }

  if (!created) throw new Error('Bulk operation was not persisted')
  await dispatchHireCandidateBulkOperation({
    workspaceId: ctx.workspace._id.toString(),
    operationId: created._id.toString(),
  })
  const refreshed = await HireCandidateBulkOperation.findOne({
    _id: created._id,
    workspaceId: ctx.workspace._id,
  })
  return operationView(refreshed ?? created)
}

export async function dispatchHireCandidateBulkOperation(input: {
  workspaceId: string
  operationId: string
}): Promise<void> {
  const attemptedAt = new Date()
  try {
    await inngest.send({
      name: 'hire/candidate-bulk-operation.requested',
      data: input,
    })
    await HireCandidateBulkOperation.updateOne(
      {
        _id: input.operationId,
        workspaceId: input.workspaceId,
        status: { $in: ['queued', 'processing'] },
      },
      {
        $set: { dispatchStatus: 'dispatched', lastDispatchedAt: attemptedAt },
        $unset: { lastDispatchErrorCode: 1, lastDispatchErrorAt: 1 },
        $inc: { dispatchAttempts: 1 },
      },
    )
  } catch {
    await HireCandidateBulkOperation.updateOne(
      {
        _id: input.operationId,
        workspaceId: input.workspaceId,
        status: { $in: ['queued', 'processing'] },
      },
      {
        $set: {
          dispatchStatus: 'failed',
          lastDispatchErrorCode: 'inngest_dispatch_unavailable',
          lastDispatchErrorAt: attemptedAt,
        },
        $inc: { dispatchAttempts: 1 },
      },
    )
  }
}

async function refreshOperationCounts(input: {
  workspaceId: mongoose.Types.ObjectId
  operationId: mongoose.Types.ObjectId
  now: Date
}): Promise<{ status: IHireCandidateBulkOperation['status']; hasRemainingWork: boolean }> {
  const grouped = await HireCandidateBulkOperationItem.aggregate<{
    _id: HireCandidateBulkItemStatus
    count: number
  }>([
    {
      $match: {
        workspaceId: input.workspaceId,
        bulkOperationId: input.operationId,
      },
    },
    { $group: { _id: '$status', count: { $sum: 1 } } },
  ])
  const counts = new Map(grouped.map((entry) => [entry._id, entry.count]))
  const queuedCount = counts.get('queued') ?? 0
  const processingCount = counts.get('processing') ?? 0
  const succeededCount = counts.get('succeeded') ?? 0
  const conflictCount = counts.get('conflict') ?? 0
  const failedCount = counts.get('failed') ?? 0
  const hasRemainingWork = queuedCount + processingCount > 0
  let nextRecoveryAt: Date | undefined
  if (hasRemainingWork) {
    const [queued, processing] = await Promise.all([
      HireCandidateBulkOperationItem.findOne({
        workspaceId: input.workspaceId,
        bulkOperationId: input.operationId,
        status: 'queued',
      })
        .select('nextAttemptAt')
        .sort({ nextAttemptAt: 1, _id: 1 })
        .lean(),
      HireCandidateBulkOperationItem.findOne({
        workspaceId: input.workspaceId,
        bulkOperationId: input.operationId,
        status: 'processing',
      })
        .select('leaseExpiresAt')
        .sort({ leaseExpiresAt: 1, _id: 1 })
        .lean(),
    ])
    const candidates = [queued?.nextAttemptAt, processing?.leaseExpiresAt].filter(
      (value): value is Date => value instanceof Date,
    )
    nextRecoveryAt = candidates.sort((left, right) => left.getTime() - right.getTime())[0]
  }
  const status: IHireCandidateBulkOperation['status'] = hasRemainingWork
    ? 'processing'
    : conflictCount + failedCount === 0
      ? 'completed'
      : succeededCount > 0
        ? 'partial'
        : 'failed'
  if (!hasRemainingWork) {
    await HireCandidateBulkOperationItem.updateMany(
      {
        workspaceId: input.workspaceId,
        bulkOperationId: input.operationId,
        purgeAt: { $exists: false },
      },
      {
        $set: {
          purgeAt: new Date(input.now.getTime() + HIRE_CANDIDATE_BULK_ITEM_RETENTION_MS),
        },
      },
    )
  }
  await HireCandidateBulkOperation.updateOne(
    { _id: input.operationId, workspaceId: input.workspaceId },
    {
      $set: {
        status,
        queuedCount,
        processingCount,
        succeededCount,
        conflictCount,
        failedCount,
        ...(nextRecoveryAt ? { nextRecoveryAt } : {}),
        ...(hasRemainingWork
          ? {}
          : {
              completedAt: input.now,
              purgeAt: new Date(
                input.now.getTime() + HIRE_CANDIDATE_BULK_OPERATION_RETENTION_MS,
              ),
            }),
      },
      ...(hasRemainingWork ? {} : { $unset: { nextRecoveryAt: 1 } }),
    },
  )
  return { status, hasRemainingWork }
}

async function loadWorkerContext(
  operation: IHireCandidateBulkOperation,
): Promise<MembershipContext | null> {
  const [workspace, membership] = await Promise.all([
    HireWorkspace.findOne({
      _id: operation.workspaceId,
      ...activeHireWorkspaceLifecycleFilter(),
    }),
    HireWorkspaceMember.findOne({
      _id: operation.requestedByMemberId,
      workspaceId: operation.workspaceId,
      authState: 'active',
    }),
  ])
  return workspace && membership ? { workspace, membership } : null
}

async function candidateAvailableForItem(input: {
  workspaceId: mongoose.Types.ObjectId
  jobId: mongoose.Types.ObjectId
  applicationId: mongoose.Types.ObjectId
  now: Date
}): Promise<boolean> {
  const application = await HireApplication.findOne({
    _id: input.applicationId,
    workspaceId: input.workspaceId,
    jobId: input.jobId,
  }).select('candidateId')
  if (!application) return false
  const [candidate, privacyRequest] = await Promise.all([
    HireCandidate.exists({
      _id: application.candidateId,
      workspaceId: input.workspaceId,
      piiAnonymizedAt: { $exists: false },
    }),
    HirePrivacyRequest.exists({
      workspaceId: input.workspaceId,
      candidateId: application.candidateId,
      ...activeHirePrivacyRequestFilter(input.now),
    }),
  ])
  return Boolean(candidate && !privacyRequest)
}

function terminalOutcomeForError(error: unknown): {
  status: 'conflict' | 'failed'
  code: string
} | null {
  if (!(error instanceof AppError)) return null
  if (error.statusCode >= 400 && error.statusCode < 500) {
    return { status: 'conflict', code: error.code || 'ACTION_CONFLICT' }
  }
  return null
}

async function settleClaim(input: {
  workspaceId: mongoose.Types.ObjectId
  itemId: mongoose.Types.ObjectId
  claimToken: string
  status: 'queued' | 'succeeded' | 'conflict' | 'failed'
  now: Date
  outcomeCode?: string
  nextAttemptAt?: Date
}): Promise<void> {
  const update: Record<string, unknown> = {
    status: input.status,
    ...(input.outcomeCode ? { outcomeCode: input.outcomeCode } : {}),
    ...(input.nextAttemptAt ? { nextAttemptAt: input.nextAttemptAt } : {}),
    ...(input.status === 'queued' ? {} : { processedAt: input.now }),
  }
  const result = await HireCandidateBulkOperationItem.updateOne(
    {
      _id: input.itemId,
      workspaceId: input.workspaceId,
      status: 'processing',
      claimToken: input.claimToken,
    },
    {
      $set: update,
      $unset: { claimToken: 1, leaseExpiresAt: 1 },
    },
  )
  if (
    result.matchedCount !== 1 &&
    !(await HireCandidateBulkOperationItem.exists({
      _id: input.itemId,
      workspaceId: input.workspaceId,
      privacyRedactedAt: { $exists: true },
    }))
  ) {
    throw new Error('Candidate bulk item claim changed before settlement')
  }
}

/** Process a bounded page. A lost worker lease safely replays `moveStage`'s row id. */
export async function processHireCandidateBulkOperation(input: {
  workspaceId: string
  operationId: string
  now?: Date
  batchSize?: number
}): Promise<{ outcome: string; processed: number; hasRemainingWork: boolean }> {
  await connectHireControlDB()
  if (
    !mongoose.Types.ObjectId.isValid(input.workspaceId) ||
    !mongoose.Types.ObjectId.isValid(input.operationId)
  ) {
    return { outcome: 'skipped', processed: 0, hasRemainingWork: false }
  }
  const now = input.now ?? new Date()
  const workspaceId = new mongoose.Types.ObjectId(input.workspaceId)
  const operationId = new mongoose.Types.ObjectId(input.operationId)
  const operation = await HireCandidateBulkOperation.findOne({
    _id: operationId,
    workspaceId,
    status: { $in: ['queued', 'processing'] },
  })
  if (!operation) return { outcome: 'skipped', processed: 0, hasRemainingWork: false }

  const ctx = await loadWorkerContext(operation)
  if (!ctx) {
    await HireCandidateBulkOperationItem.updateMany(
      {
        workspaceId,
        bulkOperationId: operationId,
        status: { $in: ['queued', 'processing'] },
      },
      {
        $set: {
          status: 'conflict',
          outcomeCode: 'ACTION_AUTHORITY_UNAVAILABLE',
          processedAt: now,
        },
        $unset: { claimToken: 1, leaseExpiresAt: 1 },
      },
    )
    await refreshOperationCounts({ workspaceId, operationId, now })
    return { outcome: 'authority_unavailable', processed: 0, hasRemainingWork: false }
  }

  await HireCandidateBulkOperation.updateOne(
    { _id: operationId, workspaceId, status: { $in: ['queued', 'processing'] } },
    {
      $set: {
        status: 'processing',
        ...(operation.startedAt ? {} : { startedAt: now }),
      },
    },
  )

  const batchSize = Math.max(
    1,
    Math.min(input.batchSize ?? HIRE_CANDIDATE_BULK_WORKER_BATCH_SIZE, 25),
  )
  await HireCandidateBulkOperationItem.updateMany(
    {
      workspaceId,
      bulkOperationId: operationId,
      status: 'processing',
      attempts: { $gte: HIRE_CANDIDATE_BULK_MAX_ATTEMPTS },
      leaseExpiresAt: { $lte: now },
    },
    {
      $set: {
        status: 'failed',
        outcomeCode: 'WORKER_CRASH_RETRY_EXHAUSTED',
        processedAt: now,
      },
      $unset: { claimToken: 1, leaseExpiresAt: 1 },
    },
  )
  let processed = 0
  for (let index = 0; index < batchSize; index += 1) {
    const claimToken = randomUUID()
    const item = await HireCandidateBulkOperationItem.findOneAndUpdate(
      {
        workspaceId,
        bulkOperationId: operationId,
        privacyRedactedAt: { $exists: false },
        $or: [
          {
            status: 'queued',
            attempts: { $lt: HIRE_CANDIDATE_BULK_MAX_ATTEMPTS },
            nextAttemptAt: { $lte: now },
          },
          // A worker may have committed the stage move and died before item
          // settlement. Always reclaim an expired processing lease: the
          // stable rowOperationId makes that replay idempotent.
          {
            status: 'processing',
            attempts: { $lt: HIRE_CANDIDATE_BULK_MAX_ATTEMPTS },
            leaseExpiresAt: { $lte: now },
          },
        ],
      },
      {
        $set: {
          status: 'processing',
          claimToken,
          leaseExpiresAt: new Date(now.getTime() + HIRE_CANDIDATE_BULK_LEASE_MS),
        },
        $inc: { attempts: 1 },
      },
      { new: true, sort: { _id: 1 } },
    )
    if (!item) break
    processed += 1

    try {
      if (!item.applicationId || !item.rowOperationId) {
        await settleClaim({
          workspaceId,
          itemId: item._id,
          claimToken,
          status: 'conflict',
          outcomeCode: 'ITEM_COORDINATE_UNAVAILABLE',
          now,
        })
        continue
      }
      if (
        !(await candidateAvailableForItem({
          workspaceId,
          jobId: operation.jobId,
          applicationId: item.applicationId,
          now,
        }))
      ) {
        await settleClaim({
          workspaceId,
          itemId: item._id,
          claimToken,
          status: 'conflict',
          outcomeCode: 'CANDIDATE_PRIVACY_UNAVAILABLE',
          now,
        })
        continue
      }
      await moveStage(ctx, item.applicationId.toString(), {
        action: operation.action,
        expectedFrom: item.expectedStage,
        operationId: item.rowOperationId,
        note: stageEventNote(operation.reasonCode),
        requirePrivacyAvailable: true,
      })
      await settleClaim({
        workspaceId,
        itemId: item._id,
        claimToken,
        status: 'succeeded',
        outcomeCode: 'APPLIED',
        now,
      })
    } catch (error) {
      const terminal = terminalOutcomeForError(error)
      if (terminal) {
        await settleClaim({
          workspaceId,
          itemId: item._id,
          claimToken,
          status: terminal.status,
          outcomeCode: terminal.code,
          now,
        })
      } else if (item.attempts >= HIRE_CANDIDATE_BULK_MAX_ATTEMPTS) {
        await settleClaim({
          workspaceId,
          itemId: item._id,
          claimToken,
          status: 'failed',
          outcomeCode: 'TRANSIENT_FAILURE_EXHAUSTED',
          now,
        })
      } else {
        await settleClaim({
          workspaceId,
          itemId: item._id,
          claimToken,
          status: 'queued',
          outcomeCode: 'TRANSIENT_RETRY',
          nextAttemptAt: retryAt(item.attempts, now),
          now,
        })
      }
    }
  }

  const counts = await refreshOperationCounts({ workspaceId, operationId, now })
  const dueNow = counts.hasRemainingWork
    ? await HireCandidateBulkOperationItem.exists({
        workspaceId,
        bulkOperationId: operationId,
        $or: [
          { status: 'queued', nextAttemptAt: { $lte: now } },
          { status: 'processing', leaseExpiresAt: { $lte: now } },
        ],
      })
    : null
  return {
    outcome: counts.status,
    processed,
    hasRemainingWork: Boolean(dueNow),
  }
}

export async function listDueHireCandidateBulkOperationIds(input: {
  workspaceId: string
  limit?: number
  now?: Date
}): Promise<string[]> {
  await connectHireControlDB()
  if (!mongoose.Types.ObjectId.isValid(input.workspaceId)) return []
  const workspaceId = new mongoose.Types.ObjectId(input.workspaceId)
  const now = input.now ?? new Date()
  const limit = Math.max(
    1,
    Math.min(input.limit ?? HIRE_CANDIDATE_BULK_RECOVERY_LIMIT, 25),
  )
  const operations = await HireCandidateBulkOperation.find({
    workspaceId,
    status: { $in: ['queued', 'processing'] },
    nextRecoveryAt: { $lte: now },
  })
    .select('_id')
    .sort({ nextRecoveryAt: 1, updatedAt: 1, _id: 1 })
    .limit(limit)
    .lean()
  return operations.map((operation) => operation._id.toString())
}

export async function getHireCandidateBulkOperation(
  ctx: MembershipContext,
  input: {
    jobId: string
    operationId: string
    issues: HireCandidateBulkOperationIssueQuery
  },
): Promise<{ operation: CandidateBulkOperationView; issues: CandidateBulkOperationIssuePage }> {
  await connectHireControlDB()
  if (
    !mongoose.Types.ObjectId.isValid(input.jobId) ||
    !mongoose.Types.ObjectId.isValid(input.operationId)
  ) {
    throw new NotFoundError('Bulk operation')
  }
  const operation = await HireCandidateBulkOperation.findOne({
    _id: input.operationId,
    workspaceId: ctx.workspace._id,
    jobId: input.jobId,
  })
  if (!operation) throw new NotFoundError('Bulk operation')

  const cursorScope = {
    workspaceId: ctx.workspace._id.toString(),
    jobId: operation.jobId.toString(),
    operationId: operation._id.toString(),
    memberId: ctx.membership._id.toString(),
    limit: input.issues.limit,
  }
  const cursorId = decodeBulkOperationIssueCursor(
    input.issues.cursor,
    cursorScope,
  )

  const issueFilter: Record<string, unknown> = {
    workspaceId: ctx.workspace._id,
    bulkOperationId: operation._id,
    status: { $in: ['conflict', 'failed'] },
    privacyRedactedAt: { $exists: false },
  }
  if (cursorId) issueFilter._id = { $gt: new mongoose.Types.ObjectId(cursorId) }
  const rows = await HireCandidateBulkOperationItem.find(issueFilter)
    .select('_id applicationId expectedStage status outcomeCode processedAt')
    .sort({ _id: 1 })
    .limit(input.issues.limit + 1)
    .lean()
  const hasMore = rows.length > input.issues.limit
  const visible = hasMore ? rows.slice(0, input.issues.limit) : rows
  return {
    operation: operationView(operation),
    issues: {
      items: visible.flatMap((row) => row.applicationId ? [{
        itemId: row._id.toString(), applicationId: row.applicationId.toString(),
        expectedStage: row.expectedStage, status: row.status as 'conflict' | 'failed',
        code: row.outcomeCode || 'ACTION_FAILED',
        ...(row.processedAt ? { processedAt: row.processedAt } : {}),
      }] : []),
      nextCursor: hasMore && visible.at(-1)
        ? encodeBulkOperationIssueCursor(
            visible.at(-1)!._id.toString(),
            cursorScope,
          )
        : null,
    },
  }
}
