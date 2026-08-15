import mongoose, { type ClientSession } from 'mongoose'
import { HireReportExport } from '../models/HireReportExport'
import {
  createHireJobCloseoutReport,
  markHireReportExportCancelledForLifecycle,
  type HireReportExportRequestResult,
  type HireReportRequesterActor,
} from './hireReportExportService'
import { buildHireJobCloseoutReportSnapshotInputFromControlRecords } from './hireJobCloseoutReportSnapshotFactory'

export interface HireReportLifecycleScope {
  workspaceId: mongoose.Types.ObjectId
  jobId?: mongoose.Types.ObjectId
  candidateId?: mongoose.Types.ObjectId
}

export interface HireReportCloseoutLifecycleJob {
  _id: mongoose.Types.ObjectId
  title: string
  createdAt: Date
  status: 'open' | 'on_hold' | 'closed'
  closedAt?: Date
  closeNote?: string
}

/**
 * Cancel only report rows that can still hold report data. Candidate lifecycle
 * scopes additionally cancel every pipeline aggregate in that workspace:
 * aggregate exports intentionally have no candidate IDs, and their frozen
 * counts can otherwise predate a privacy start or anonymization. Closeout
 * reports retain their narrower candidate-coordinate policy. Each row is
 * terminalized through the report service so its cleanup tombstone is durable
 * before snapshot/key/affected-ID redaction. Callers never receive a key,
 * snapshot, error, or storage coordinate back.
 */
export async function cancelHireReportExportsForLifecycle(input: {
  scope: HireReportLifecycleScope
  cancelledAt: Date
  session: ClientSession
}): Promise<number> {
  const filter = {
    workspaceId: input.scope.workspaceId,
    status: { $nin: ['cancelled', 'expired'] },
    ...(input.scope.jobId ? { jobId: input.scope.jobId } : {}),
    ...(input.scope.candidateId
      ? {
          $or: [
            { affectedCandidateIds: input.scope.candidateId },
            { reportKind: 'pipeline_status' },
          ],
        }
      : {}),
  }
  const rows = await HireReportExport.find(filter)
    .select('_id')
    .session(input.session)
    .lean() as Array<{ _id: mongoose.Types.ObjectId }>

  let cancelled = 0
  // Mongo sessions do not permit parallel operations. `mark...` writes the
  // durable cleanup tombstone followed by terminal redaction for each row.
  for (const row of rows) {
    const didCancel = await markHireReportExportCancelledForLifecycle({
      workspaceId: input.scope.workspaceId.toString(),
      exportId: row._id.toString(),
      session: input.session,
      now: input.cancelledAt,
    })
    if (didCancel) cancelled += 1
  }
  return cancelled
}

/**
 * A terminal application decision or job close changes a live pipeline count,
 * so it invalidates only the affected aggregate pipeline exports: the
 * workspace-wide report and the report scoped to that job. Historical
 * closeout reports deliberately remain outside this policy; a new closeout is
 * created after a job-close transaction has reached its final state.
 */
export async function cancelHirePipelineStatusReportsForTerminalTransition(input: {
  workspaceId: mongoose.Types.ObjectId
  jobId: mongoose.Types.ObjectId
  cancelledAt: Date
  session: ClientSession
}): Promise<number> {
  const rows = await HireReportExport.find({
    workspaceId: input.workspaceId,
    reportKind: 'pipeline_status',
    status: { $nin: ['cancelled', 'expired'] },
    $or: [
      { reportScope: 'workspace' },
      { jobId: input.jobId },
    ],
  })
    .select('_id')
    .session(input.session)
    .lean() as Array<{ _id: mongoose.Types.ObjectId }>

  let cancelled = 0
  // Mongo sessions do not permit parallel operations. Each report must first
  // persist its individual object-cleanup tombstone before redaction.
  for (const row of rows) {
    const didCancel = await markHireReportExportCancelledForLifecycle({
      workspaceId: input.workspaceId.toString(),
      exportId: row._id.toString(),
      session: input.session,
      now: input.cancelledAt,
    })
    if (didCancel) cancelled += 1
  }
  return cancelled
}

/**
 * Create the immutable closeout report obligation inside the job-close
 * transaction. It returns `null` when the job is an onboarding test drive;
 * callers must kick a created export only after their enclosing transaction
 * commits.
 */
export async function createHireJobCloseoutReportForLifecycle(input: {
  workspaceId: mongoose.Types.ObjectId
  job: HireReportCloseoutLifecycleJob
  operationId: string
  requestedBy: HireReportRequesterActor
  session: ClientSession
  now: Date
}): Promise<HireReportExportRequestResult | null> {
  const snapshotInput = await buildHireJobCloseoutReportSnapshotInputFromControlRecords({
    workspaceId: input.workspaceId,
    job: input.job,
    now: input.now,
    session: input.session,
  })
  if (!snapshotInput) return null

  return createHireJobCloseoutReport({
    workspaceId: input.workspaceId.toString(),
    jobId: input.job._id.toString(),
    operationId: input.operationId,
    requestedBy: input.requestedBy,
    session: input.session,
    snapshotInput,
    now: input.now,
  })
}
