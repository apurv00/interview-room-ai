import { Types, type ClientSession } from 'mongoose'
import { JobApplication, ProductEvent } from '@shared/db/models'
import type { JobApplicationStatus } from '@shared/db/models/JobApplication'
import { withActiveJobsAccountWrite } from '@shared/services/jobsAccountFence'

export const INTERVIEW_OUTCOME_RESULTS = [
  'advanced',
  'waiting',
  'rejected',
  'offer',
  'skip',
] as const

export type InterviewOutcomeResult = typeof INTERVIEW_OUTCOME_RESULTS[number]
export type CanonicalInterviewOutcomeResult = Exclude<InterviewOutcomeResult, 'skip'>
export const INTERVIEW_OUTCOME_CORRECTION_STATUSES = [
  'interview_scheduled',
  'interviewed',
  'offer',
  'rejected',
  'ghosted',
  'withdrawn',
] as const
export type InterviewOutcomeCorrectionStatus =
  typeof INTERVIEW_OUTCOME_CORRECTION_STATUSES[number]
const CORRECTION_STATUS_SET = new Set<string>(INTERVIEW_OUTCOME_CORRECTION_STATUSES)

export interface RecordInterviewOutcomeInput {
  result: InterviewOutcomeResult
  /** One-based interview round being reported or deferred. */
  round: number
  /** Required only when changing the latest canonical report. This monotonic
   * token comes from the tracker projection, so a stale tab cannot overwrite
  * a newer correction (including an A→B→A cycle). */
  expectedRevision?: number
  /** Binds the correction to the lifecycle state the candidate saw. */
  expectedStatus?: InterviewOutcomeCorrectionStatus
}

interface OutcomeView {
  interviewRounds: number
  latestResult?: CanonicalInterviewOutcomeResult
  latestRound?: number
  latestReportedAt?: Date
  revision: number
  lastInterviewedAt?: Date
  lastDeferredRound?: number
  lastAskedAt?: Date
  askCount: number
}

export type RecordInterviewOutcomeResponse =
  | {
      ok: true
      changed: boolean
      deferred: boolean
      status: JobApplicationStatus
      outcome: OutcomeView
    }
  | {
      ok: false
      reason: 'not-found' | 'ineligible' | 'round-conflict'
      currentRound?: number
    }

interface ApplicationSnapshot {
  _id: Types.ObjectId
  status: JobApplicationStatus
  interviewDate?: Date
  interviewDateConfidence?: 'exact' | 'week' | 'unknown'
  outcome?: {
    interviewRounds?: unknown
    latestResult?: CanonicalInterviewOutcomeResult
    latestRound?: number
    latestReportedAt?: Date
    revision?: unknown
    lastInterviewedAt?: Date
    lastDeferredRound?: number
    lastAskedAt?: Date
    askCount?: number
  }
}

const MAX_CONTENTION_ATTEMPTS = 2

class OutcomeWriteRaceError extends Error {
  constructor() {
    super('interview outcome changed concurrently')
    this.name = 'OutcomeWriteRaceError'
  }
}

function completedRounds(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : 0
}

function askCount(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : 0
}

function outcomeRevision(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : 0
}

function statusFor(result: CanonicalInterviewOutcomeResult): JobApplicationStatus {
  if (result === 'advanced') return 'interview_scheduled'
  if (result === 'waiting') return 'interviewed'
  return result
}

function completedAt(snapshot: ApplicationSnapshot, now: Date): Date {
  const interviewDate = snapshot.interviewDate
  return snapshot.interviewDateConfidence === 'exact' &&
    interviewDate instanceof Date &&
    Number.isFinite(interviewDate.getTime()) &&
    interviewDate.getTime() <= now.getTime()
    ? interviewDate
    : now
}

function viewOf(snapshot: ApplicationSnapshot): OutcomeView {
  const outcome = snapshot.outcome ?? {}
  return {
    interviewRounds: completedRounds(outcome.interviewRounds),
    ...(outcome.latestResult ? { latestResult: outcome.latestResult } : {}),
    ...(outcome.latestRound !== undefined ? { latestRound: outcome.latestRound } : {}),
    ...(outcome.latestReportedAt ? { latestReportedAt: outcome.latestReportedAt } : {}),
    revision: outcomeRevision(outcome.revision),
    ...(outcome.lastInterviewedAt ? { lastInterviewedAt: outcome.lastInterviewedAt } : {}),
    ...(outcome.lastDeferredRound !== undefined
      ? { lastDeferredRound: outcome.lastDeferredRound }
      : {}),
    ...(outcome.lastAskedAt ? { lastAskedAt: outcome.lastAskedAt } : {}),
    askCount: askCount(outcome.askCount),
  }
}

function exactOptionalField(path: string, value: unknown): Record<string, unknown> {
  return value === undefined ? { [path]: { $exists: false } } : { [path]: value }
}

function snapshotFilter(
  userId: string,
  jobPostingId: string,
  snapshot: ApplicationSnapshot,
): Record<string, unknown> {
  const outcome = snapshot.outcome ?? {}
  return {
    _id: snapshot._id,
    userId,
    jobPostingId,
    status: snapshot.status,
    ...exactOptionalField('outcome.interviewRounds', outcome.interviewRounds),
    ...exactOptionalField('outcome.latestResult', outcome.latestResult),
    ...exactOptionalField('outcome.latestRound', outcome.latestRound),
    ...exactOptionalField('outcome.latestReportedAt', outcome.latestReportedAt),
    ...exactOptionalField('outcome.revision', outcome.revision),
    ...exactOptionalField('outcome.lastDeferredRound', outcome.lastDeferredRound),
  }
}

async function readApplication(
  userId: string,
  jobPostingId: string,
  session: ClientSession,
): Promise<ApplicationSnapshot | null> {
  return JobApplication
    .findOne({ userId, jobPostingId })
    .select([
      '_id',
      'status',
      'interviewDate',
      'interviewDateConfidence',
      'outcome.interviewRounds',
      'outcome.latestResult',
      'outcome.latestRound',
      'outcome.latestReportedAt',
      'outcome.revision',
      'outcome.lastInterviewedAt',
      'outcome.lastDeferredRound',
      'outcome.lastAskedAt',
      'outcome.askCount',
    ].join(' '))
    .session(session)
    .lean<ApplicationSnapshot | null>()
}

async function deferRound(
  userId: string,
  jobPostingId: string,
  snapshot: ApplicationSnapshot,
  round: number,
  now: Date,
  session: ClientSession,
): Promise<RecordInterviewOutcomeResponse> {
  const currentRound = completedRounds(snapshot.outcome?.interviewRounds)
  if (snapshot.outcome?.lastDeferredRound === round) {
    return {
      ok: true,
      changed: false,
      deferred: true,
      status: snapshot.status,
      outcome: viewOf(snapshot),
    }
  }
  if (snapshot.status !== 'interview_scheduled') {
    return { ok: false, reason: 'ineligible', currentRound }
  }
  if (round !== currentRound + 1) {
    return { ok: false, reason: 'round-conflict', currentRound }
  }

  const write = await JobApplication.updateOne(
    snapshotFilter(userId, jobPostingId, snapshot),
    {
      $set: {
        'outcome.lastDeferredRound': round,
        'outcome.lastAskedAt': now,
      },
      $inc: { 'outcome.askCount': 1 },
    },
    { session },
  )
  if ((write.modifiedCount ?? 0) !== 1) throw new OutcomeWriteRaceError()

  return {
    ok: true,
    changed: true,
    deferred: true,
    status: snapshot.status,
    outcome: {
      ...viewOf(snapshot),
      lastDeferredRound: round,
      lastAskedAt: now,
      askCount: askCount(snapshot.outcome?.askCount) + 1,
    },
  }
}

async function reportRound(
  userId: string,
  jobPostingId: string,
  snapshot: ApplicationSnapshot,
  result: CanonicalInterviewOutcomeResult,
  round: number,
  expectedRevision: number | undefined,
  expectedStatus: InterviewOutcomeCorrectionStatus | undefined,
  now: Date,
  session: ClientSession,
): Promise<RecordInterviewOutcomeResponse> {
  const currentRound = completedRounds(snapshot.outcome?.interviewRounds)
  const currentRevision = outcomeRevision(snapshot.outcome?.revision)
  const sameReport = snapshot.outcome?.latestRound === round &&
    snapshot.outcome.latestResult === result
  if (sameReport) {
    const hasExpectedToken = expectedRevision !== undefined || expectedStatus !== undefined
    if (hasExpectedToken) {
      const currentTokenStillMatches =
        expectedRevision === currentRevision &&
        expectedStatus === snapshot.status &&
        CORRECTION_STATUS_SET.has(snapshot.status)
      const committedCorrectionRetry =
        Number.isSafeInteger(expectedRevision) &&
        currentRevision === (expectedRevision as number) + 1 &&
        snapshot.status === statusFor(result)
      if (!currentTokenStillMatches && !committedCorrectionRetry) {
        return { ok: false, reason: 'round-conflict', currentRound }
      }
    }
    return {
      ok: true,
      changed: false,
      deferred: false,
      status: snapshot.status,
      outcome: viewOf(snapshot),
    }
  }

  const isNewRound = round === currentRound + 1
  const isCorrection = round === currentRound &&
    snapshot.outcome?.latestRound === round &&
    snapshot.outcome.latestResult !== undefined &&
    snapshot.outcome.latestReportedAt instanceof Date &&
    currentRevision > 0 &&
    CORRECTION_STATUS_SET.has(snapshot.status)

  if (isNewRound && snapshot.status !== 'interview_scheduled') {
    return { ok: false, reason: 'ineligible', currentRound }
  }
  if (!isNewRound && !isCorrection) {
    return { ok: false, reason: 'round-conflict', currentRound }
  }
  if (isNewRound && (expectedRevision !== undefined || expectedStatus !== undefined)) {
    return { ok: false, reason: 'round-conflict', currentRound }
  }
  if (isCorrection) {
    if (
      !Number.isSafeInteger(expectedRevision) ||
      expectedRevision !== currentRevision ||
      expectedStatus !== snapshot.status
    ) {
      return { ok: false, reason: 'round-conflict', currentRound }
    }
  }

  const nextStatus = statusFor(result)
  const nextRounds = isNewRound ? currentRound + 1 : currentRound
  const nextRevision = currentRevision + 1
  const isFollowUp = isCorrection &&
    snapshot.outcome?.latestResult === 'waiting' && result !== 'waiting'
  const offerReceived = result === 'offer'
  const statusChanged = snapshot.status !== nextStatus
  const interviewedAt = completedAt(snapshot, now)
  const set: Record<string, unknown> = {
    status: nextStatus,
    'outcome.interviewRounds': nextRounds,
    'outcome.latestResult': result,
    'outcome.latestRound': round,
    'outcome.latestReportedAt': now,
    'outcome.revision': nextRevision,
    'outcome.offerReceived': offerReceived,
  }
  if (isNewRound) set['outcome.lastInterviewedAt'] = interviewedAt

  const update: Record<string, unknown> = {
    $set: set,
    $unset: {
      interviewDate: 1,
      interviewDateConfidence: 1,
      interviewDatePreference: 1,
    },
  }
  if (statusChanged) {
    update.$push = {
      statusHistory: { status: nextStatus, at: now, source: 'user' },
    }
  }

  const write = await JobApplication.updateOne(
    snapshotFilter(userId, jobPostingId, snapshot),
    update,
    { session },
  )
  if ((write.modifiedCount ?? 0) !== 1) throw new OutcomeWriteRaceError()

  await ProductEvent.create([{
    name: 'jobs.outcome_reported',
    userId,
    jobPostingId,
    applicationId: snapshot._id,
    props: {
      result,
      round,
      correction: isCorrection && !isFollowUp,
      followUp: isFollowUp,
      revision: nextRevision,
      offer: offerReceived,
      fromStatus: snapshot.status,
      toStatus: nextStatus,
    },
    ts: now,
  }], { session })

  return {
    ok: true,
    changed: true,
    deferred: false,
    status: nextStatus,
    outcome: {
      ...viewOf(snapshot),
      interviewRounds: nextRounds,
      latestResult: result,
      latestRound: round,
      latestReportedAt: now,
      revision: nextRevision,
      ...(isNewRound ? { lastInterviewedAt: interviewedAt } : {}),
    },
  }
}

async function recordInsideTransaction(
  userId: string,
  jobPostingId: string,
  input: RecordInterviewOutcomeInput,
  now: Date,
  session: ClientSession,
): Promise<RecordInterviewOutcomeResponse> {
  const snapshot = await readApplication(userId, jobPostingId, session)
  if (!snapshot) return { ok: false, reason: 'not-found' }

  if (input.result === 'skip') {
    if (input.expectedRevision !== undefined || input.expectedStatus !== undefined) {
      return {
        ok: false,
        reason: 'round-conflict',
        currentRound: completedRounds(snapshot.outcome?.interviewRounds),
      }
    }
    return deferRound(userId, jobPostingId, snapshot, input.round, now, session)
  }
  return reportRound(
    userId,
    jobPostingId,
    snapshot,
    input.result,
    input.round,
    input.expectedRevision,
    input.expectedStatus,
    now,
    session,
  )
}

/**
 * Records one owner-authored interview outcome under the account-deletion
 * transaction fence. The application mutation and telemetry event commit as
 * one unit; snapshot predicates make retries converge without double-counting.
 */
export async function recordInterviewOutcome(
  userId: string,
  jobPostingId: string,
  input: RecordInterviewOutcomeInput,
  now: Date = new Date(),
): Promise<RecordInterviewOutcomeResponse> {
  for (let attempt = 1; attempt <= MAX_CONTENTION_ATTEMPTS; attempt += 1) {
    try {
      return await withActiveJobsAccountWrite(
        userId,
        (session) => recordInsideTransaction(userId, jobPostingId, input, now, session),
      )
    } catch (error) {
      if (!(error instanceof OutcomeWriteRaceError)) {
        throw error
      }
      if (attempt === MAX_CONTENTION_ATTEMPTS) {
        // The snapshot just lost its CAS, so its round is stale by
        // definition. The client refreshes instead of trusting it.
        return { ok: false, reason: 'round-conflict' }
      }
    }
  }
  throw new Error('unreachable interview outcome retry state')
}
