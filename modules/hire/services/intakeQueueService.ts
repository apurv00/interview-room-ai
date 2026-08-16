import { randomUUID } from 'node:crypto'
import mongoose, { type ClientSession } from 'mongoose'
import { z } from 'zod'
import { AppError, NotFoundError } from '@shared/errors'
import { logger } from '@shared/logger'
import {
  isSupportedDocumentType,
  parseDocument,
  UnsupportedFileTypeError,
} from '@shared/services/documentParser'
import { inngest } from '@shared/services/inngest'
import {
  HIRE_INTAKE_TASK_MAX_PAYLOAD_BYTES,
  HireCandidate,
  HireIntakeTask,
  HireJob,
  HirePrivacyRequest,
  HireWorkspace,
  HireWorkspaceMember,
  type IHireIntakeTask,
  type IHireResumeMatch,
} from '../models'
import {
  resolveApplyToken,
  resolveWorkspaceWriteAuthority,
} from './applyPageService'
import { connectHireControlDB } from './hireControlBoundary'
import { intakeCandidate, intakeFromApplyPage } from './intakeService'
import {
  analyzeResumeForJob,
  extractAllEmails,
  type ResumeIntakeAnalysis,
} from './jdMatchService'
import type { MembershipContext } from './workspaceService'
import { activeHireWorkspaceLifecycleFilter } from './workspaceService'
import { withActiveHireWorkspaceWriteTransaction } from './hireWorkspaceWriteFence'
import { claimHireCandidatePiiWriteFence } from './hireCandidatePrivacyWriteFence'
import { sha256 } from './aiRoundService'
import { assertHireOnboardingTestDriveWriteIsolation } from '@hire-onboarding-boundary'

/**
 * Durable Phase 2 resume-intake queue.
 *
 * The request path stores an opaque, workspace-scoped task and emits only
 * `{ workspaceId, taskId }`.  Resume bytes, apply-link hashes, and supplied
 * identity remain in the Hire control database; no event and no B2C model
 * carries candidate identity.  The worker owns document parsing, advisory
 * scoring, deduping, and result persistence.
 */

const TASK_LEASE_MS = 10 * 60 * 1000
const MAX_TASK_ATTEMPTS = 5
const RETRY_BASE_MS = 30 * 1000
const RETRY_MAX_MS = 30 * 60 * 1000
const RESUME_TEXT_CAP = 50_000

/**
 * A task without a confirmed identity remains recruiter-recoverable briefly.
 * The separate raw-payload deadline below remains authoritative, so entering
 * `needs_identity` cannot restart the retention clock for a resume.
 */
export const HIRE_INTAKE_NEEDS_IDENTITY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000
const NEEDS_IDENTITY_CLEANUP_BATCH_SIZE = 20

/**
 * Raw resume bytes are transient intake data. They must have the same bounded
 * lifetime even when no email was available to associate the task with an
 * existing candidate deletion request.
 */
export const HIRE_INTAKE_RAW_PAYLOAD_RETENTION_MS = 7 * 24 * 60 * 60 * 1000
const RAW_PAYLOAD_CLEANUP_BATCH_SIZE = 20

const ObjectIdSchema = z.string().regex(/^[a-f0-9]{24}$/i)
const OptionalNameSchema = z.string().trim().min(1).max(120).optional()
const OptionalEmailSchema = z.string().trim().toLowerCase().email().max(254).optional()
const OptionalPhoneSchema = z.string().trim().min(1).max(32).optional()

export interface QueuedHireIntakeTask {
  taskId: string
  status: 'queued'
  /** Safe observation of the best-effort Inngest handoff. */
  dispatch: HireIntakeTaskDispatchView
}

export interface EnqueueMemberResumeIntakeInput {
  jobId: string
  fileName: string
  contentType: string
  payload: Buffer
  suppliedName?: string
  suppliedEmail?: string
  suppliedPhone?: string
}

export interface EnqueuePublicApplyIntakeInput {
  /** Raw capability is used only to resolve the live job, then discarded. */
  capability: string
  name: string
  email: string
  phone?: string
  fileName: string
  contentType: string
  payload: Buffer
}

export interface HireIntakeTaskView {
  taskId: string
  jobId: string
  source: 'bulk_upload' | 'apply_page'
  fileName: string
  status: IHireIntakeTask['status']
  attempts: number
  /** No provider exception text or candidate data appears in this view. */
  dispatch: HireIntakeTaskDispatchView
  lastError?: string
  queuedAt: Date
  statusChangedAt: Date
  needsIdentityAt?: Date
  completedAt?: Date
  failedAt?: Date
  cancelledAt?: Date
  candidateId?: string
  applicationId?: string
}

export interface HireIntakeTaskDispatchView {
  /** Event-handoff state, distinct from parsing/scoring task status. */
  status: 'pending' | 'dispatched' | 'failed'
  attempts: number
  /** A fixed code only; raw provider errors are never persisted here. */
  lastErrorCode?: 'inngest_dispatch_unavailable'
  lastErrorAt?: Date
  lastDispatchedAt?: Date
}

export interface SupplyHireIntakeIdentityInput {
  jobId: string
  taskId: string
  name?: string
  /** Required: a task can only leave needs_identity with a dedupe key. */
  email: string
}

export type HireIntakeWorkerOutcome =
  | { outcome: 'completed'; candidateId: string; applicationId: string }
  | { outcome: 'needs_identity' }
  | { outcome: 'failed' }
  | { outcome: 'cancelled' }
  | { outcome: 'deferred' }
  | { outcome: 'skipped' }

interface NormalizedTaskInput {
  jobId: mongoose.Types.ObjectId
  fileName: string
  contentType: string
  payload: Buffer
  suppliedName?: string
  suppliedEmail?: string
  suppliedPhone?: string
}

interface ClaimedTask extends IHireIntakeTask {
  payload: Buffer
}

interface ExistingCandidateState {
  candidateId?: mongoose.Types.ObjectId
  blockedMessage?: string
}

function requireObjectId(value: string, label: string): mongoose.Types.ObjectId {
  const parsed = ObjectIdSchema.safeParse(value)
  if (!parsed.success) {
    throw new AppError(`Invalid ${label}`, 400, 'INVALID_ID')
  }
  return new mongoose.Types.ObjectId(parsed.data)
}

function optionalValue<T>(schema: z.ZodType<T>, value: unknown, label: string): T | undefined {
  if (value === undefined) return undefined
  const parsed = schema.safeParse(value)
  if (!parsed.success) {
    throw new AppError(`Invalid ${label}`, 422, 'INVALID_INTAKE_IDENTITY')
  }
  return parsed.data
}

function normalizeTaskInput(input: {
  jobId: string
  fileName: string
  contentType: string
  payload: Buffer
  suppliedName?: string
  suppliedEmail?: string
  suppliedPhone?: string
}): NormalizedTaskInput {
  const fileName = input.fileName.trim()
  const contentType = input.contentType.trim().toLowerCase()
  if (!fileName || fileName.length > 255) {
    throw new AppError('A resume file name is required', 422, 'INVALID_FILE_NAME')
  }
  if (!contentType || contentType.length > 120) {
    throw new AppError('A valid resume content type is required', 422, 'INVALID_CONTENT_TYPE')
  }
  if (!isSupportedDocumentType(fileName)) {
    throw new AppError(
      'Please upload a PDF, DOCX or TXT file',
      415,
      'UNSUPPORTED_TYPE',
    )
  }
  if (!Buffer.isBuffer(input.payload) || input.payload.length < 1) {
    throw new AppError('A non-empty resume is required', 422, 'INVALID_FILE')
  }
  if (input.payload.length > HIRE_INTAKE_TASK_MAX_PAYLOAD_BYTES) {
    throw new AppError('Resume file is too large', 413, 'FILE_TOO_LARGE')
  }
  return {
    jobId: requireObjectId(input.jobId, 'job id'),
    fileName,
    contentType,
    // Copy the caller buffer so a mutable request buffer cannot change the
    // persisted content between validation and database insertion.
    payload: Buffer.from(input.payload),
    suppliedName: optionalValue(OptionalNameSchema, input.suppliedName, 'name'),
    suppliedEmail: optionalValue(OptionalEmailSchema, input.suppliedEmail, 'email'),
    suppliedPhone: optionalValue(OptionalPhoneSchema, input.suppliedPhone, 'phone'),
  }
}

function pendingDispatchView(): HireIntakeTaskDispatchView {
  return { status: 'pending', attempts: 0 }
}

function safeDispatchView(task: Pick<
  IHireIntakeTask,
  | 'dispatchStatus'
  | 'dispatchAttempts'
  | 'lastDispatchErrorCode'
  | 'lastDispatchErrorAt'
  | 'lastDispatchedAt'
>): HireIntakeTaskDispatchView {
  const status = task.dispatchStatus === 'dispatched' || task.dispatchStatus === 'failed'
    ? task.dispatchStatus
    : 'pending'
  const attempts = typeof task.dispatchAttempts === 'number' && task.dispatchAttempts >= 0
    ? task.dispatchAttempts
    : 0
  return {
    status,
    attempts,
    ...(task.lastDispatchErrorCode === 'inngest_dispatch_unavailable'
      ? { lastErrorCode: task.lastDispatchErrorCode }
      : {}),
    ...(task.lastDispatchErrorAt ? { lastErrorAt: task.lastDispatchErrorAt } : {}),
    ...(task.lastDispatchedAt ? { lastDispatchedAt: task.lastDispatchedAt } : {}),
  }
}

function safeTaskView(task: Pick<
  IHireIntakeTask,
  | '_id'
  | 'jobId'
  | 'source'
  | 'originalFileName'
  | 'status'
  | 'attempts'
  | 'dispatchStatus'
  | 'dispatchAttempts'
  | 'lastDispatchErrorCode'
  | 'lastDispatchErrorAt'
  | 'lastDispatchedAt'
  | 'lastError'
  | 'queuedAt'
  | 'statusChangedAt'
  | 'needsIdentityAt'
  | 'completedAt'
  | 'failedAt'
  | 'cancelledAt'
  | 'candidateId'
  | 'applicationId'
>): HireIntakeTaskView {
  return {
    taskId: task._id.toString(),
    jobId: task.jobId.toString(),
    source: task.source,
    fileName: task.originalFileName,
    status: task.status,
    attempts: task.attempts,
    dispatch: safeDispatchView(task),
    ...(task.lastError ? { lastError: task.lastError } : {}),
    queuedAt: task.queuedAt,
    statusChangedAt: task.statusChangedAt,
    ...(task.needsIdentityAt ? { needsIdentityAt: task.needsIdentityAt } : {}),
    ...(task.completedAt ? { completedAt: task.completedAt } : {}),
    ...(task.failedAt ? { failedAt: task.failedAt } : {}),
    ...(task.cancelledAt ? { cancelledAt: task.cancelledAt } : {}),
    ...(task.candidateId ? { candidateId: task.candidateId.toString() } : {}),
    ...(task.applicationId ? { applicationId: task.applicationId.toString() } : {}),
  }
}

function jobNotAccepting(): AppError {
  return new AppError(
    'This job is no longer accepting applications',
    409,
    'JOB_CLOSED',
  )
}

/**
 * If the submitted email already belongs to a Hire candidate, associate the
 * task immediately.  That lets the existing verified-deletion transaction
 * remove queued raw-resume tasks by its exact `{workspaceId,candidateId}`
 * coordinate. This is Hire-only identity resolution — it never consults a
 * B2C user/account table.
 */
async function existingCandidateState(input: {
  workspaceId: mongoose.Types.ObjectId
  email?: string
  now: Date
  session?: ClientSession
}): Promise<ExistingCandidateState> {
  if (!input.email) return {}
  let query = HireCandidate.findOne({
    workspaceId: input.workspaceId,
    email: input.email,
  })
    .select('_id piiAnonymizedAt')
  if (input.session) query = query.session(input.session)
  const candidate = await query
  if (!candidate) return {}
  if (candidate.piiAnonymizedAt) {
    return { blockedMessage: 'Candidate personal data has already been deleted' }
  }
  let privacyQuery = HirePrivacyRequest.exists({
    workspaceId: input.workspaceId,
    candidateId: candidate._id,
    live: true,
    $or: [
      { status: 'processing' },
      { status: 'pending_verification', verificationExpiresAt: { $gt: input.now } },
    ],
  })
  if (input.session) privacyQuery = privacyQuery.session(input.session)
  if (await privacyQuery) {
    return { blockedMessage: 'Candidate privacy request is in progress' }
  }
  return { candidateId: candidate._id }
}

async function emitHireIntakeRequested(input: {
  workspaceId: string
  taskId: string
}): Promise<void> {
  await inngest.send({
    name: 'hire/intake.requested',
    data: input,
  })
}

async function persistIntakeDispatchState(input: {
  workspaceId: string
  taskId: string
  dispatch: HireIntakeTaskDispatchView
}): Promise<void> {
  const at = input.dispatch.lastErrorAt ?? input.dispatch.lastDispatchedAt ?? new Date()
  if (input.dispatch.status === 'failed') {
    await HireIntakeTask.updateOne(
      { _id: input.taskId, workspaceId: input.workspaceId },
      {
        $set: {
          dispatchStatus: 'failed',
          lastDispatchErrorCode: 'inngest_dispatch_unavailable',
          lastDispatchErrorAt: at,
        },
        $inc: { dispatchAttempts: 1 },
      },
    )
    return
  }

  await HireIntakeTask.updateOne(
    { _id: input.taskId, workspaceId: input.workspaceId },
    {
      $set: {
        dispatchStatus: 'dispatched',
        lastDispatchedAt: at,
      },
      $inc: { dispatchAttempts: 1 },
      $unset: {
        lastDispatchErrorCode: 1,
        lastDispatchErrorAt: 1,
      },
    },
  )
}

/**
 * Best-effort immediate kick.  The durable task remains queued if Inngest is
 * temporarily unavailable; the cron recovery worker will claim it later.
 */
async function kickQueuedTask(
  task: QueuedHireIntakeTask,
  workspaceId: string,
): Promise<HireIntakeTaskDispatchView> {
  const attempts = task.dispatch.attempts + 1
  const at = new Date()
  try {
    await emitHireIntakeRequested({ workspaceId, taskId: task.taskId })
    const dispatch: HireIntakeTaskDispatchView = {
      status: 'dispatched',
      attempts,
      lastDispatchedAt: at,
    }
    try {
      await persistIntakeDispatchState({ workspaceId, taskId: task.taskId, dispatch })
    } catch {
      // The event was accepted, so do not relabel it as a failed dispatch if
      // an observability-only write races a completion or transient DB issue.
      logger.warn(
        { workspaceId, taskId: task.taskId },
        'hire intake queue dispatch accepted but observability state was not saved',
      )
    }
    return dispatch
  } catch {
    const dispatch: HireIntakeTaskDispatchView = {
      status: 'failed',
      attempts,
      lastErrorCode: 'inngest_dispatch_unavailable',
      lastErrorAt: at,
    }
    try {
      await persistIntakeDispatchState({ workspaceId, taskId: task.taskId, dispatch })
    } catch {
      // The task itself remains durable; the sweep can still discover it.
      logger.warn(
        { workspaceId, taskId: task.taskId },
        'hire intake queue dispatch failure state was not saved',
      )
    }
    logger.warn(
      { workspaceId, taskId: task.taskId },
      'hire intake queue dispatch failed; durable sweep will retry',
    )
    return dispatch
  }
}

/**
 * Store a recruiter-uploaded resume for asynchronous parsing and scoring.
 * All persistence is fenced by the current Hire member and workspace.
 */
export async function enqueueMemberResumeIntake(
  ctx: MembershipContext,
  input: EnqueueMemberResumeIntakeInput,
): Promise<QueuedHireIntakeTask> {
  await connectHireControlDB()
  const normalized = normalizeTaskInput(input)
  const workspaceId = ctx.workspace._id

  const existingJob = await HireJob.findOne({
    _id: normalized.jobId,
    workspaceId,
  }).select('status')
  if (!existingJob) throw new NotFoundError('Job')
  if (existingJob.status === 'closed') throw jobNotAccepting()

  const task = await withActiveHireWorkspaceWriteTransaction(
    workspaceId,
    ctx.membership._id,
    async (session) => {
      await assertHireOnboardingTestDriveWriteIsolation({
        workspaceId,
        jobId: normalized.jobId,
        session,
      })
      // Claim the job in the same transaction as the task. A close that
      // wins first prevents the task from being accepted at all.
      const jobClaim = await HireJob.updateOne(
        {
          _id: normalized.jobId,
          workspaceId,
          status: { $ne: 'closed' },
        },
        { $inc: { intakeWriteVersion: 1 } },
        { session },
      )
      if (jobClaim.matchedCount !== 1) throw jobNotAccepting()
      const existingCandidate = await existingCandidateState({
        workspaceId,
        email: normalized.suppliedEmail,
        now: new Date(),
        session,
      })
      if (existingCandidate.blockedMessage) {
        throw new AppError(
          existingCandidate.blockedMessage,
          409,
          'CANDIDATE_PRIVACY_PENDING',
        )
      }
      if (existingCandidate.candidateId) {
        await assertHireOnboardingTestDriveWriteIsolation({
          workspaceId,
          jobId: normalized.jobId,
          candidateId: existingCandidate.candidateId,
          session,
        })
        await claimHireCandidatePiiWriteFence({
          workspaceId,
          candidateId: existingCandidate.candidateId,
          session,
        })
      }
      const created = await HireIntakeTask.create(
        [
          {
            workspaceId,
            jobId: normalized.jobId,
            source: 'bulk_upload',
            originalFileName: normalized.fileName,
            originalContentType: normalized.contentType,
            originalFileSizeBytes: normalized.payload.length,
            payload: normalized.payload,
            ...(normalized.suppliedName ? { suppliedName: normalized.suppliedName } : {}),
            ...(normalized.suppliedEmail ? { suppliedEmail: normalized.suppliedEmail } : {}),
            ...(normalized.suppliedPhone ? { suppliedPhone: normalized.suppliedPhone } : {}),
            ...(existingCandidate.candidateId
              ? { candidateId: existingCandidate.candidateId }
              : {}),
            actorMemberId: ctx.membership._id,
            actorName: ctx.membership.name || ctx.membership.email,
            status: 'queued',
            attempts: 0,
            dispatchStatus: 'pending',
            dispatchAttempts: 0,
            queuedAt: new Date(),
            statusChangedAt: new Date(),
          },
        ],
        { session },
      )
      return created[0]
    },
  )

  const queued: QueuedHireIntakeTask = {
    taskId: task._id.toString(),
    status: 'queued',
    dispatch: pendingDispatchView(),
  }
  queued.dispatch = await kickQueuedTask(queued, workspaceId.toString())
  return queued
}

/**
 * Public applicant equivalent. It resolves the raw capability once, stores
 * only its hash, and returns null for every invalid/revoked/closed-link state
 * so callers can retain the public endpoint's uniform 404 posture.
 */
export async function enqueuePublicApplyIntake(
  input: EnqueuePublicApplyIntakeInput,
): Promise<QueuedHireIntakeTask | null> {
  await connectHireControlDB()
  const view = await resolveApplyToken(input.capability)
  if (!view) return null
  const authorityMemberId = await resolveWorkspaceWriteAuthority(view.job.workspaceId)
  if (!authorityMemberId) return null

  const normalized = normalizeTaskInput({
    jobId: view.job._id.toString(),
    fileName: input.fileName,
    contentType: input.contentType,
    payload: input.payload,
    suppliedName: input.name,
    suppliedEmail: input.email,
    suppliedPhone: input.phone,
  })

  let task: IHireIntakeTask
  try {
    task = await withActiveHireWorkspaceWriteTransaction(
      view.job.workspaceId,
      authorityMemberId,
      async (session) => {
        await assertHireOnboardingTestDriveWriteIsolation({
          workspaceId: view.job.workspaceId,
          jobId: view.job._id,
          session,
        })
        // Recheck exactly the hash resolved from the raw capability. A link
        // rotation/disable racing this request wins and no task is accepted.
        const jobClaim = await HireJob.updateOne(
          {
            _id: view.job._id,
            workspaceId: view.job.workspaceId,
            status: { $ne: 'closed' },
            applyPageEnabled: true,
            applyTokenHash: view.applyTokenHash,
          },
          { $inc: { intakeWriteVersion: 1 } },
          { session },
        )
        if (jobClaim.matchedCount !== 1) throw jobNotAccepting()
        const existingCandidate = await existingCandidateState({
          workspaceId: view.job.workspaceId,
          email: normalized.suppliedEmail,
          now: new Date(),
          session,
        })
        if (existingCandidate.blockedMessage) {
          throw new AppError(
            existingCandidate.blockedMessage,
            409,
            'CANDIDATE_PRIVACY_PENDING',
          )
        }
        if (existingCandidate.candidateId) {
          await assertHireOnboardingTestDriveWriteIsolation({
            workspaceId: view.job.workspaceId,
            jobId: normalized.jobId,
            candidateId: existingCandidate.candidateId,
            session,
          })
          await claimHireCandidatePiiWriteFence({
            workspaceId: view.job.workspaceId,
            candidateId: existingCandidate.candidateId,
            session,
          })
        }
        const created = await HireIntakeTask.create(
          [
            {
              workspaceId: view.job.workspaceId,
              jobId: normalized.jobId,
              source: 'apply_page',
              originalFileName: normalized.fileName,
              originalContentType: normalized.contentType,
              originalFileSizeBytes: normalized.payload.length,
              payload: normalized.payload,
              suppliedName: normalized.suppliedName,
              suppliedEmail: normalized.suppliedEmail,
              ...(normalized.suppliedPhone ? { suppliedPhone: normalized.suppliedPhone } : {}),
              ...(existingCandidate.candidateId
                ? { candidateId: existingCandidate.candidateId }
                : {}),
              applyTokenHash: view.applyTokenHash,
              actorName: 'Applicant (public apply page)',
              status: 'queued',
              attempts: 0,
              dispatchStatus: 'pending',
              dispatchAttempts: 0,
              queuedAt: new Date(),
              statusChangedAt: new Date(),
            },
          ],
          { session },
        )
        return created[0]
      },
    )
  } catch (error) {
    // A public caller must not be able to distinguish a link that never
    // existed from one that raced a workspace deletion/member removal.
    if (
      error instanceof AppError &&
      [
        'JOB_CLOSED',
        'MEMBER_REMOVED',
        'WORKSPACE_DELETION_PENDING',
        'CANDIDATE_PRIVACY_PENDING',
        'ONBOARDING_TEST_DRIVE_ISOLATED',
      ].includes(
        error.code,
      )
    ) {
      return null
    }
    throw error
  }

  const queued: QueuedHireIntakeTask = {
    taskId: task._id.toString(),
    status: 'queued',
    dispatch: pendingDispatchView(),
  }
  queued.dispatch = await kickQueuedTask(queued, view.job.workspaceId.toString())
  return queued
}

/** Explicit event emitter used by the recovery job; it carries IDs only. */
export async function dispatchHireIntakeTask(input: {
  workspaceId: string
  taskId: string
}): Promise<void> {
  await connectHireControlDB()
  const workspaceId = requireObjectId(input.workspaceId, 'workspace id')
  const taskId = requireObjectId(input.taskId, 'task id')
  await kickQueuedTask(
    {
      taskId: taskId.toString(),
      status: 'queued',
      dispatch: pendingDispatchView(),
    },
    workspaceId.toString(),
  )
}

/** Recruiter-visible task status. Hidden input bytes, apply hashes, and PII never leave here. */
export async function getHireIntakeTask(
  ctx: MembershipContext,
  input: { jobId: string; taskId: string },
): Promise<HireIntakeTaskView> {
  await connectHireControlDB()
  const jobId = requireObjectId(input.jobId, 'job id')
  const taskId = requireObjectId(input.taskId, 'task id')
  const task = await HireIntakeTask.findOne({
    _id: taskId,
    workspaceId: ctx.workspace._id,
    jobId,
  })
    .select(
      '_id jobId source originalFileName status attempts dispatchStatus dispatchAttempts lastDispatchErrorCode lastDispatchErrorAt lastDispatchedAt lastError queuedAt statusChangedAt needsIdentityAt completedAt failedAt cancelledAt candidateId applicationId',
    )
    .lean()
  if (!task) throw new NotFoundError('Intake task')
  return safeTaskView(task as unknown as IHireIntakeTask)
}

/**
 * A recruiter can supply a missing/confirmed email without re-uploading the
 * document. Only member-originated tasks expose this recovery path.
 */
export async function supplyHireIntakeIdentity(
  ctx: MembershipContext,
  input: SupplyHireIntakeIdentityInput,
): Promise<HireIntakeTaskView> {
  await connectHireControlDB()
  const jobId = requireObjectId(input.jobId, 'job id')
  const taskId = requireObjectId(input.taskId, 'task id')
  const email = optionalValue(OptionalEmailSchema, input.email, 'email')
  if (!email) throw new AppError('An email address is required', 422, 'NO_EMAIL')
  const name = optionalValue(OptionalNameSchema, input.name, 'name')
  const now = new Date()
  const task = await withActiveHireWorkspaceWriteTransaction(
    ctx.workspace._id,
    ctx.membership._id,
    async (session) => {
      await assertHireOnboardingTestDriveWriteIsolation({
        workspaceId: ctx.workspace._id,
        jobId,
        session,
      })
      const pendingTask = await HireIntakeTask.findOne({
        _id: taskId,
        workspaceId: ctx.workspace._id,
        jobId,
        source: 'bulk_upload',
        ...liveRawPayloadFilter(now),
        status: 'needs_identity',
      })
        .select('jobId candidateId applicationId')
        .session(session)
      if (pendingTask) {
        await assertHireOnboardingTestDriveWriteIsolation({
          workspaceId: ctx.workspace._id,
          jobId: pendingTask.jobId,
          ...(pendingTask.candidateId ? { candidateId: pendingTask.candidateId } : {}),
          ...(pendingTask.applicationId ? { applicationId: pendingTask.applicationId } : {}),
          session,
        })
      }
      const existingCandidate = await existingCandidateState({
        workspaceId: ctx.workspace._id,
        email,
        now,
        session,
      })
      if (existingCandidate.blockedMessage) {
        throw new AppError(
          existingCandidate.blockedMessage,
          409,
          'CANDIDATE_PRIVACY_PENDING',
        )
      }
      if (existingCandidate.candidateId) {
        await assertHireOnboardingTestDriveWriteIsolation({
          workspaceId: ctx.workspace._id,
          jobId,
          candidateId: existingCandidate.candidateId,
          session,
        })
        await claimHireCandidatePiiWriteFence({
          workspaceId: ctx.workspace._id,
          candidateId: existingCandidate.candidateId,
          session,
        })
      }
      return HireIntakeTask.findOneAndUpdate(
        {
          _id: taskId,
          workspaceId: ctx.workspace._id,
          jobId,
          source: 'bulk_upload',
          ...liveRawPayloadFilter(now),
          status: 'needs_identity',
        },
        {
          $set: {
            suppliedEmail: email,
            ...(name ? { suppliedName: name } : {}),
            ...(existingCandidate.candidateId
              ? { candidateId: existingCandidate.candidateId }
              : {}),
            status: 'queued',
            statusChangedAt: now,
            nextAttemptAt: now,
          },
          $unset: {
            claimToken: 1,
            claimedAt: 1,
            leaseExpiresAt: 1,
            needsIdentityAt: 1,
            lastError: 1,
            lastErrorAt: 1,
          },
        },
        { new: true, runValidators: true, session },
      )
    },
  )
  if (!task) {
    const visible = await HireIntakeTask.exists({
      _id: taskId,
      workspaceId: ctx.workspace._id,
      jobId,
    })
    if (!visible) throw new NotFoundError('Intake task')
    throw new AppError(
      'This intake task is not waiting for an email address',
      409,
      'TASK_NOT_WAITING_FOR_IDENTITY',
    )
  }
  const view = safeTaskView(task)
  const dispatch = await kickQueuedTask(
    { taskId: view.taskId, status: 'queued', dispatch: view.dispatch },
    ctx.workspace._id.toString(),
  )
  return { ...view, dispatch }
}

function dueTaskFilter(now: Date): Record<string, unknown> {
  return {
    $or: [
      {
        status: 'queued',
        $or: [
          { nextAttemptAt: { $exists: false } },
          { nextAttemptAt: null },
          { nextAttemptAt: { $lte: now } },
        ],
      },
      { status: 'processing', leaseExpiresAt: { $lte: now } },
    ],
  }
}

function rawPayloadCutoff(now: Date): Date {
  return new Date(now.getTime() - HIRE_INTAKE_RAW_PAYLOAD_RETENTION_MS)
}

function taskRawPayloadIsLive(task: Pick<IHireIntakeTask, 'queuedAt'>, now: Date): boolean {
  return task.queuedAt > rawPayloadCutoff(now)
}

function liveRawPayloadFilter(now: Date): Record<string, unknown> {
  return { queuedAt: { $gt: rawPayloadCutoff(now) } }
}

function staleRawPayloadTaskFilter(cutoff: Date, now: Date): Record<string, unknown> {
  return {
    queuedAt: { $lte: cutoff },
    $or: [
      { status: { $in: ['queued', 'needs_identity'] } },
      {
        status: 'processing',
        $or: [
          { leaseExpiresAt: { $lte: now } },
          { leaseExpiresAt: { $exists: false } },
          { leaseExpiresAt: null },
        ],
      },
    ],
  }
}

/** Tenant-scoped recovery query. The only global scan is workspace roots in the job wrapper. */
export async function listDueHireIntakeTaskIds(input: {
  workspaceId: string
  now?: Date
  limit?: number
}): Promise<string[]> {
  await connectHireControlDB()
  const workspaceId = requireObjectId(input.workspaceId, 'workspace id')
  const now = input.now ?? new Date()
  const limit = Math.min(Math.max(input.limit ?? 10, 1), 50)
  const tasks = await HireIntakeTask.find({
    workspaceId,
    ...liveRawPayloadFilter(now),
    ...dueTaskFilter(now),
  })
    .sort({ queuedAt: 1, _id: 1 })
    .limit(limit)
    .select('_id')
    .lean()
  return tasks.map((task) => task._id.toString())
}

/**
 * Scrub old queued or abandoned leased tasks without depending on a candidate
 * association. An active lease is allowed to finish; claim and provider
 * liveness checks independently reject the same deadline, so it cannot be
 * renewed into another model attempt after the raw-payload window closes.
 */
export async function cleanupExpiredHireIntakeRawPayloadTasks(input: {
  workspaceId: string
  now?: Date
  batchSize?: number
}): Promise<{ cancelled: number }> {
  await connectHireControlDB()
  const workspaceId = requireObjectId(input.workspaceId, 'workspace id')
  const now = input.now ?? new Date()
  const cutoff = rawPayloadCutoff(now)
  const batchSize = Math.min(
    Math.max(input.batchSize ?? RAW_PAYLOAD_CLEANUP_BATCH_SIZE, 1),
    50,
  )

  // Select only coordinates first so the expiry loop never reads a stale
  // resume or supplied contact data merely to erase it.
  const tasks = await HireIntakeTask.find({
    workspaceId,
    ...staleRawPayloadTaskFilter(cutoff, now),
  })
    .sort({ queuedAt: 1, _id: 1 })
    .limit(batchSize)
    .select('_id')
    .lean()
  if (tasks.length === 0) return { cancelled: 0 }

  const result = await HireIntakeTask.updateMany(
    {
      workspaceId,
      _id: { $in: tasks.map((task) => task._id) },
      ...staleRawPayloadTaskFilter(cutoff, now),
    },
    {
      $set: {
        status: 'cancelled',
        cancelledAt: now,
        statusChangedAt: now,
        lastError: 'Resume intake retention window expired',
        lastErrorAt: now,
      },
      $unset: terminalCleanupUnset(),
    },
    { runValidators: true },
  )
  return { cancelled: result.modifiedCount }
}

async function claimHireIntakeTask(input: {
  workspaceId: mongoose.Types.ObjectId
  taskId: mongoose.Types.ObjectId
  now: Date
}): Promise<{ task: ClaimedTask; claimToken: string } | null> {
  const claimToken = randomUUID()
  const task = await HireIntakeTask.findOneAndUpdate(
    {
      _id: input.taskId,
      workspaceId: input.workspaceId,
      ...liveRawPayloadFilter(input.now),
      ...dueTaskFilter(input.now),
    },
    {
      $set: {
        status: 'processing',
        claimToken,
        claimedAt: input.now,
        leaseExpiresAt: new Date(input.now.getTime() + TASK_LEASE_MS),
        statusChangedAt: input.now,
      },
      $unset: { nextAttemptAt: 1 },
      $inc: { attempts: 1 },
    },
    { new: true, runValidators: true },
  )
    .select('+payload +applyTokenHash')
  if (!task || !task.payload) return null
  return { task: task as ClaimedTask, claimToken }
}

async function renewTaskLease(input: {
  task: ClaimedTask
  claimToken: string
  now: Date
}): Promise<boolean> {
  const renewed = await HireIntakeTask.updateOne(
    {
      _id: input.task._id,
      workspaceId: input.task.workspaceId,
      // This write is the final authorization before provider or persistence
      // work. Repeating the immutable queuedAt deadline here closes the
      // check-to-write window between the caller's in-memory expiry check and
      // a worker lease renewal.
      ...liveRawPayloadFilter(input.now),
      status: 'processing',
      claimToken: input.claimToken,
    },
    {
      $set: { leaseExpiresAt: new Date(input.now.getTime() + TASK_LEASE_MS) },
    },
  )
  return renewed.matchedCount === 1
}

async function taskClaimIsLive(input: {
  task: ClaimedTask
  claimToken: string
  now: Date
}): Promise<boolean> {
  const taskFilter = {
    _id: input.task._id,
    workspaceId: input.task.workspaceId,
    ...liveRawPayloadFilter(input.now),
    status: 'processing',
    claimToken: input.claimToken,
    leaseExpiresAt: { $gt: input.now },
  }
  const jobFilter = {
    _id: input.task.jobId,
    workspaceId: input.task.workspaceId,
    status: { $ne: 'closed' },
    ...(input.task.source === 'apply_page'
      ? { applyPageEnabled: true, applyTokenHash: input.task.applyTokenHash }
      : {}),
  }
  const memberFilter = input.task.actorMemberId
    ? {
        _id: input.task.actorMemberId,
        workspaceId: input.task.workspaceId,
        authState: 'active',
      }
    : { workspaceId: input.task.workspaceId, authState: 'active' }
  const [task, job, workspace, member] = await Promise.all([
    HireIntakeTask.exists(taskFilter),
    HireJob.exists(jobFilter),
    HireWorkspace.exists({ _id: input.task.workspaceId, ...activeHireWorkspaceLifecycleFilter() }),
    HireWorkspaceMember.exists(memberFilter),
  ])
  return Boolean(task && job && workspace && member)
}

async function markClaimedTask(
  task: ClaimedTask,
  claimToken: string,
  update: Record<string, unknown>,
): Promise<boolean> {
  const result = await HireIntakeTask.updateOne(
    {
      _id: task._id,
      workspaceId: task.workspaceId,
      status: 'processing',
      claimToken,
    },
    update,
    { runValidators: true },
  )
  return result.matchedCount === 1
}

function terminalCleanupUnset(): Record<string, 1> {
  return {
    payload: 1,
    suppliedName: 1,
    suppliedEmail: 1,
    suppliedPhone: 1,
    claimToken: 1,
    claimedAt: 1,
    leaseExpiresAt: 1,
    nextAttemptAt: 1,
  }
}

function staleNeedsIdentityFilter(cutoff: Date): Record<string, unknown> {
  return {
    status: 'needs_identity',
    needsIdentityAt: { $lte: cutoff },
  }
}

/**
 * Cancel and scrub old identity-recovery tasks without relying on a candidate
 * association. The rechecked status/cutoff predicate makes this safe against
 * a recruiter who supplies an identity after the bounded ID scan: whichever
 * mutation wins determines the terminal/requeued state, and payload/identity
 * fields are only scrubbed when this cleanup still owns a stale task.
 */
export async function cleanupStaleHireIntakeNeedsIdentityTasks(input: {
  workspaceId: string
  now?: Date
  batchSize?: number
}): Promise<{ cancelled: number }> {
  await connectHireControlDB()
  const workspaceId = requireObjectId(input.workspaceId, 'workspace id')
  const now = input.now ?? new Date()
  const cutoff = new Date(now.getTime() - HIRE_INTAKE_NEEDS_IDENTITY_RETENTION_MS)
  const batchSize = Math.min(
    Math.max(input.batchSize ?? NEEDS_IDENTITY_CLEANUP_BATCH_SIZE, 1),
    50,
  )

  // Select only coordinates first so the recovery loop never reads a stale
  // resume or supplied contact data merely to expire it.
  const tasks = await HireIntakeTask.find({
    workspaceId,
    ...staleNeedsIdentityFilter(cutoff),
  })
    .sort({ needsIdentityAt: 1, _id: 1 })
    .limit(batchSize)
    .select('_id')
    .lean()
  if (tasks.length === 0) return { cancelled: 0 }

  const result = await HireIntakeTask.updateMany(
    {
      workspaceId,
      _id: { $in: tasks.map((task) => task._id) },
      ...staleNeedsIdentityFilter(cutoff),
    },
    {
      $set: {
        status: 'cancelled',
        cancelledAt: now,
        statusChangedAt: now,
        lastError: 'Identity confirmation window expired',
        lastErrorAt: now,
      },
      $unset: terminalCleanupUnset(),
    },
    { runValidators: true },
  )
  return { cancelled: result.modifiedCount }
}

async function cancelClaimedTask(input: {
  task: ClaimedTask
  claimToken: string
  message: string
  now: Date
}): Promise<boolean> {
  return markClaimedTask(input.task, input.claimToken, {
    $set: {
      status: 'cancelled',
      cancelledAt: input.now,
      statusChangedAt: input.now,
      lastError: input.message.slice(0, 2000),
      lastErrorAt: input.now,
    },
    $unset: terminalCleanupUnset(),
  })
}

async function failClaimedTask(input: {
  task: ClaimedTask
  claimToken: string
  message: string
  now: Date
}): Promise<boolean> {
  return markClaimedTask(input.task, input.claimToken, {
    $set: {
      status: 'failed',
      failedAt: input.now,
      statusChangedAt: input.now,
      lastError: input.message.slice(0, 2000),
      lastErrorAt: input.now,
    },
    $unset: terminalCleanupUnset(),
  })
}

async function waitForIdentity(input: {
  task: ClaimedTask
  claimToken: string
  message: string
  now: Date
}): Promise<boolean> {
  return markClaimedTask(input.task, input.claimToken, {
    $set: {
      status: 'needs_identity',
      needsIdentityAt: input.now,
      statusChangedAt: input.now,
      lastError: input.message.slice(0, 2000),
      lastErrorAt: input.now,
    },
    $unset: {
      claimToken: 1,
      claimedAt: 1,
      leaseExpiresAt: 1,
      nextAttemptAt: 1,
    },
  })
}

async function deferClaimedTask(input: {
  task: ClaimedTask
  claimToken: string
  message: string
  now: Date
}): Promise<'deferred' | 'failed' | 'skipped'> {
  if (input.task.attempts >= MAX_TASK_ATTEMPTS) {
    const changed = await failClaimedTask(input)
    return changed ? 'failed' : 'skipped'
  }
  const retryMs = Math.min(
    RETRY_MAX_MS,
    RETRY_BASE_MS * 2 ** Math.max(input.task.attempts - 1, 0),
  )
  const changed = await markClaimedTask(input.task, input.claimToken, {
    $set: {
      status: 'queued',
      statusChangedAt: input.now,
      nextAttemptAt: new Date(input.now.getTime() + retryMs),
      lastError: input.message.slice(0, 2000),
      lastErrorAt: input.now,
    },
    $unset: {
      claimToken: 1,
      claimedAt: 1,
      leaseExpiresAt: 1,
    },
  })
  return changed ? 'deferred' : 'skipped'
}

function nameFromFileName(fileName: string): string {
  const base = fileName.replace(/\.[^.]+$/, '').trim()
  return (base || 'Candidate').slice(0, 120)
}

function resumeMatchFromAnalysis(
  analysis: ResumeIntakeAnalysis | null,
  resumeText: string,
  jdText: string,
): IHireResumeMatch | undefined {
  if (!analysis) return undefined
  return {
    score: analysis.matchScore,
    strengths: analysis.strengths,
    gaps: analysis.gaps,
    scoredAt: new Date(),
    jdHash: sha256(jdText),
    resumeHash: sha256(resumeText),
  }
}

/**
 * Bind a parsed-email task to an already-existing candidate before it enters
 * the final intake transaction. A verified privacy deletion can now delete
 * this task with its existing exact candidate scope, and the claim filter
 * makes a concurrently deleted task lose before writing candidate data.
 */
async function associateClaimedTaskCandidate(input: {
  task: ClaimedTask
  claimToken: string
  email: string
  now: Date
}): Promise<'associated' | 'blocked' | 'lost'> {
  const state = await existingCandidateState({
    workspaceId: input.task.workspaceId,
    email: input.email,
    now: input.now,
  })
  if (state.blockedMessage) return 'blocked'
  if (!state.candidateId) return 'associated'
  const result = await HireIntakeTask.updateOne(
    {
      _id: input.task._id,
      workspaceId: input.task.workspaceId,
      status: 'processing',
      claimToken: input.claimToken,
    },
    { $set: { candidateId: state.candidateId } },
    { runValidators: true },
  )
  return result.matchedCount === 1 ? 'associated' : 'lost'
}

async function resolveWorkerMemberContext(task: ClaimedTask): Promise<MembershipContext | null> {
  if (!task.actorMemberId) return null
  const [workspace, membership] = await Promise.all([
    HireWorkspace.findOne({ _id: task.workspaceId, ...activeHireWorkspaceLifecycleFilter() }),
    HireWorkspaceMember.findOne({
      _id: task.actorMemberId,
      workspaceId: task.workspaceId,
      authState: 'active',
    }),
  ])
  if (!workspace || !membership) return null
  return { workspace, membership } as MembershipContext
}

async function resolveWorkerJob(task: ClaimedTask) {
  return HireJob.findOne({
    _id: task.jobId,
    workspaceId: task.workspaceId,
    status: { $ne: 'closed' },
    ...(task.source === 'apply_page'
      ? { applyPageEnabled: true, applyTokenHash: task.applyTokenHash }
      : {}),
  })
}

/**
 * Legacy tasks may predate the request-path fence. Recheck the immutable
 * task coordinates under an active workspace/member transaction before
 * parsing raw bytes, then terminally scrub a marked task rather than ever
 * retrying it into ordinary recruiting intake.
 */
async function cancelClaimedOnboardingTestDriveTaskIfNeeded(input: {
  task: ClaimedTask
  claimToken: string
  authorityMemberId: mongoose.Types.ObjectId
  now: Date
}): Promise<boolean> {
  try {
    await withActiveHireWorkspaceWriteTransaction(
      input.task.workspaceId,
      input.authorityMemberId,
      async (session) => {
        await assertHireOnboardingTestDriveWriteIsolation({
          workspaceId: input.task.workspaceId,
          jobId: input.task.jobId,
          ...(input.task.candidateId ? { candidateId: input.task.candidateId } : {}),
          ...(input.task.applicationId ? { applicationId: input.task.applicationId } : {}),
          session,
        })
      },
    )
    return false
  } catch (error) {
    if (!(error instanceof AppError) || error.code !== 'ONBOARDING_TEST_DRIVE_ISOLATED') {
      throw error
    }
    await cancelClaimedTask({
      task: input.task,
      claimToken: input.claimToken,
      now: input.now,
      message: 'Practice interview data is isolated from recruiting intake',
    })
    return true
  }
}

function isTerminalAuthorityError(error: unknown): boolean {
  return (
    error instanceof AppError &&
    [
      'JOB_CLOSED',
      'MEMBER_REMOVED',
      'WORKSPACE_DELETION_PENDING',
      'HIRE_CANDIDATE_PII_TOMBSTONED',
      'ONBOARDING_TEST_DRIVE_ISOLATED',
    ].includes(error.code)
  )
}

/**
 * Claim, parse, score, and persist exactly one task. This function is safe
 * for duplicate Inngest deliveries and cron recovery: a task lease is the
 * sole ownership proof, and every terminal mutation repeats workspace +
 * claim-token fencing.
 */
export async function processHireIntakeTask(input: {
  workspaceId: string
  taskId: string
  now?: Date
}): Promise<HireIntakeWorkerOutcome> {
  await connectHireControlDB()
  const workspaceId = requireObjectId(input.workspaceId, 'workspace id')
  const taskId = requireObjectId(input.taskId, 'task id')
  const now = input.now ?? new Date()
  const claimed = await claimHireIntakeTask({ workspaceId, taskId, now })
  if (!claimed) return { outcome: 'skipped' }
  const { task, claimToken } = claimed

  try {
    const job = await resolveWorkerJob(task)
    if (!job) {
      await cancelClaimedTask({
        task,
        claimToken,
        now,
        message: 'This job is no longer accepting applications',
      })
      return { outcome: 'cancelled' }
    }

    const workerMemberContext = task.source === 'bulk_upload'
      ? await resolveWorkerMemberContext(task)
      : null
    const publicAuthorityMemberId = task.source === 'apply_page'
      ? await resolveWorkspaceWriteAuthority(task.workspaceId)
      : null
    if (
      (task.source === 'bulk_upload' && !workerMemberContext) ||
      (task.source === 'apply_page' && !publicAuthorityMemberId)
    ) {
      await cancelClaimedTask({
        task,
        claimToken,
        now,
        message: 'The workspace member authority is no longer active',
      })
      return { outcome: 'cancelled' }
    }

    const authorityMemberId = task.source === 'bulk_upload'
      ? (workerMemberContext as MembershipContext).membership._id
      : publicAuthorityMemberId as mongoose.Types.ObjectId
    if (
      await cancelClaimedOnboardingTestDriveTaskIfNeeded({
        task,
        claimToken,
        authorityMemberId,
        now,
      })
    ) {
      return { outcome: 'cancelled' }
    }

    let parsed
    try {
      parsed = await parseDocument(task.payload, task.originalFileName)
    } catch (error) {
      const message = error instanceof UnsupportedFileTypeError
        ? error.message
        : 'We could not read this resume file'
      await failClaimedTask({ task, claimToken, now, message })
      return { outcome: 'failed' }
    }
    if (parsed.wordCount === 0 || (parsed.docType === 'pdf' && parsed.wordCount < 20)) {
      await failClaimedTask({
        task,
        claimToken,
        now,
        message: 'No readable text was found in this resume',
      })
      return { outcome: 'failed' }
    }

    const afterParseAt = new Date()
    if (!taskRawPayloadIsLive(task, afterParseAt)) {
      await cancelClaimedTask({
        task,
        claimToken,
        now: afterParseAt,
        message: 'Resume intake retention window expired',
      })
      return { outcome: 'cancelled' }
    }

    const resumeText = parsed.text.slice(0, RESUME_TEXT_CAP)
    const documentEmails = extractAllEmails(resumeText)
    const preModelEmail = task.suppliedEmail || documentEmails[0]
    if (preModelEmail) {
      const association = await associateClaimedTaskCandidate({
        task,
        claimToken,
        email: preModelEmail,
        now,
      })
      if (association === 'blocked') {
        await cancelClaimedTask({
          task,
          claimToken,
          now,
          message: 'Candidate privacy request prevents intake',
        })
        return { outcome: 'cancelled' }
      }
      if (association === 'lost') return { outcome: 'skipped' }
    }

    // Parsing can be slow, so renew before provider work. The provider
    // precondition repeats the task/job/workspace/member check for every
    // configured model attempt, including fallbacks.
    const beforeProviderAt = new Date()
    if (!taskRawPayloadIsLive(task, beforeProviderAt)) {
      await cancelClaimedTask({
        task,
        claimToken,
        now: beforeProviderAt,
        message: 'Resume intake retention window expired',
      })
      return { outcome: 'cancelled' }
    }
    if (!(await renewTaskLease({ task, claimToken, now: beforeProviderAt }))) {
      return { outcome: 'skipped' }
    }
    const analysis = await analyzeResumeForJob({
      resumeText,
      jdText: job.jdText,
      beforeProviderCall: async () =>
        taskClaimIsLive({ task, claimToken, now: new Date() }),
    })
    const modelEmail =
      analysis?.email && documentEmails.includes(analysis.email)
        ? analysis.email
        : null
    const email = task.suppliedEmail || modelEmail || documentEmails[0] || ''
    if (!email) {
      const beforeIdentityAt = new Date()
      if (!taskRawPayloadIsLive(task, beforeIdentityAt)) {
        await cancelClaimedTask({
          task,
          claimToken,
          now: beforeIdentityAt,
          message: 'Resume intake retention window expired',
        })
        return { outcome: 'cancelled' }
      }
      await waitForIdentity({
        task,
        claimToken,
        now: beforeIdentityAt,
        message: 'No email address was found in this resume',
      })
      return { outcome: 'needs_identity' }
    }

    const association = await associateClaimedTaskCandidate({
      task,
      claimToken,
      email,
      now: new Date(),
    })
    if (association === 'blocked') {
      await cancelClaimedTask({
        task,
        claimToken,
        now: new Date(),
        message: 'Candidate privacy request prevents intake',
      })
      return { outcome: 'cancelled' }
    }
    if (association === 'lost') return { outcome: 'skipped' }

    const beforePersistAt = new Date()
    if (!taskRawPayloadIsLive(task, beforePersistAt)) {
      await cancelClaimedTask({
        task,
        claimToken,
        now: beforePersistAt,
        message: 'Resume intake retention window expired',
      })
      return { outcome: 'cancelled' }
    }

    // A result must never land after a stale worker's lease has been taken.
    if (!(await renewTaskLease({ task, claimToken, now: beforePersistAt }))) {
      return { outcome: 'skipped' }
    }
    const name = task.suppliedName || analysis?.name || nameFromFileName(task.originalFileName)
    const result = task.source === 'bulk_upload'
      ? await intakeCandidate(workerMemberContext as MembershipContext, {
          jobId: task.jobId.toString(),
          name,
          email,
          phone: task.suppliedPhone || analysis?.phone || undefined,
          resumeText,
          resumeFileName: task.originalFileName,
          source: 'bulk_upload',
          resumeMatch: resumeMatchFromAnalysis(analysis, resumeText, job.jdText),
          screeningProfile: analysis
            ? {
                location: analysis.location,
                experienceYears: analysis.experienceYears,
              }
            : undefined,
          identityConfirmed: Boolean(task.suppliedEmail),
        })
      : await intakeFromApplyPage(
          job,
          {
            name,
            email,
            phone: task.suppliedPhone || analysis?.phone || undefined,
            resumeText,
            resumeFileName: task.originalFileName,
            resumeMatch: resumeMatchFromAnalysis(analysis, resumeText, job.jdText),
            screeningProfile: analysis
              ? {
                  location: analysis.location,
                  experienceYears: analysis.experienceYears,
                }
              : undefined,
          },
          {
            authorityMemberId: publicAuthorityMemberId as mongoose.Types.ObjectId,
            applyTokenHash: task.applyTokenHash as string,
          },
        )

    const completedAt = new Date()
    const completed = await markClaimedTask(task, claimToken, {
      $set: {
        status: 'completed',
        completedAt,
        statusChangedAt: completedAt,
        candidateId: new mongoose.Types.ObjectId(result.candidateId),
        applicationId: new mongoose.Types.ObjectId(result.applicationId),
      },
      $unset: {
        ...terminalCleanupUnset(),
        lastError: 1,
        lastErrorAt: 1,
        needsIdentityAt: 1,
      },
    })
    if (!completed) return { outcome: 'skipped' }
    return {
      outcome: 'completed',
      candidateId: result.candidateId,
      applicationId: result.applicationId,
    }
  } catch (error) {
    const at = new Date()
    // A provider or intake write can fail after its last authorization check.
    // Once the immutable raw-payload deadline has passed, that failure must
    // never requeue the task or retain it for identity recovery: scrub it
    // under the still-owned claim instead.
    if (!taskRawPayloadIsLive(task, at)) {
      await cancelClaimedTask({
        task,
        claimToken,
        now: at,
        message: 'Resume intake retention window expired',
      })
      return { outcome: 'cancelled' }
    }
    if (error instanceof AppError && error.code === 'IDENTITY_CONFLICT') {
      await waitForIdentity({
        task,
        claimToken,
        now: at,
        message: 'Confirm the candidate email before replacing the existing resume',
      })
      return { outcome: 'needs_identity' }
    }
    if (isTerminalAuthorityError(error)) {
      await cancelClaimedTask({
        task,
        claimToken,
        now: at,
        message: 'This task is no longer authorized to write candidate data',
      })
      return { outcome: 'cancelled' }
    }
    const message = error instanceof Error ? error.message : 'Resume intake failed'
    const deferred = await deferClaimedTask({ task, claimToken, now: at, message })
    logger.warn(
      { workspaceId: task.workspaceId.toString(), taskId: task._id.toString(), deferred },
      'hire intake worker deferred after a transient failure',
    )
    return { outcome: deferred }
  }
}

export const __hireIntakeQueue = {
  TASK_LEASE_MS,
  MAX_TASK_ATTEMPTS,
  RETRY_BASE_MS,
  RETRY_MAX_MS,
  dueTaskFilter,
  resumeMatchFromAnalysis,
}
