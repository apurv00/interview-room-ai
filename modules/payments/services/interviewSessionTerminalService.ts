import mongoose, { type ClientSession } from 'mongoose'
import { connectDB } from '@shared/db/connection'
import { InterviewSession } from '@shared/db/models/InterviewSession'
import { withSessionPersonalDataWriteTransaction } from '@shared/services/accountDeletion'
import { PR8_INTERVIEW_ENTITLEMENT_ENFORCEMENT_READY } from '@shared/services/pr8InterviewRollout'
import {
  INTERVIEW_AUTHORITY_DIGEST_DOMAINS,
  digestInterviewAuthority,
} from '@shared/services/interviewAuthorityDigest'
import { sha256CanonicalJson } from '../lib/canonicalJson'
import type { InterviewResultArtifact } from '../models/InterviewRuntime'
import {
  AuthoritativeInterviewRuntimeError,
  normalizeAuthoritativeInterviewConfig,
  settleAuthoritativeInterviewRuntimeInSession,
} from './authoritativeInterviewRuntimeService'

const OBJECT_ID_PATTERN = /^[a-f0-9]{24}$/
const UUID_V4_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/
const TERMINAL_END_REASONS = [
  'normal',
  'time_up',
  'user_ended',
  'usage_limit',
  'abandoned',
] as const

export type InterviewSessionTerminalStatus =
  | 'completed'
  | 'abandoned'
export type InterviewSessionTerminalEndReason =
  (typeof TERMINAL_END_REASONS)[number]

export type InterviewSessionTerminalErrorCode =
  | 'not_ready'
  | 'invalid_request'
  | 'not_found_or_ineligible'
  | 'authority_conflict'
  | 'persistence_conflict'
  | 'persistence_unavailable'

export class InterviewSessionTerminalError extends Error {
  constructor(
    readonly code: InterviewSessionTerminalErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'InterviewSessionTerminalError'
  }
}

export interface InterviewSessionTerminalInput {
  userId: unknown
  sessionId: unknown
  operationId: unknown
  status: unknown
  endReason: unknown
  transcript: unknown
  evaluations: unknown
  speechMetrics: unknown
  liveTranscriptWords: unknown
}

interface InterviewSessionTerminalComponentDigests {
  readonly [key: string]: string
  transcript: string
  evaluations: string
  speechMetrics: string
  liveTranscriptWords: string
}

export interface InterviewSessionTerminalResult
  extends InterviewResultArtifact {
  contractVersion: 1
  success: true
  operationId: string
  sessionId: string
  status: InterviewSessionTerminalStatus
  completedAt: string
  endReason: InterviewSessionTerminalEndReason
  answeredCount: number
  durationActualSeconds: number
}

export interface TerminalSessionRecord {
  id: string
  userId: string
  status: string
  deletionPendingAt?: Date
  startedAt?: Date
  completedAt?: Date
  config: unknown
  transcript: unknown[]
  evaluations: unknown[]
  speechMetrics: unknown[]
  liveTranscriptWords: unknown[]
  answeredCount?: number
  durationActualSeconds?: number
  endReason?: string
  wasTruncatedByTimer?: boolean[]
}

export interface InterviewSessionTerminalStore {
  load(input: {
    session: ClientSession
    userId: mongoose.Types.ObjectId
    sessionId: mongoose.Types.ObjectId
  }): Promise<TerminalSessionRecord | null>
  writeTerminalMetadata(
    input: {
      sessionId: mongoose.Types.ObjectId
      userId: mongoose.Types.ObjectId
      startedAt: Date
      endReason: InterviewSessionTerminalEndReason
      durationActualSeconds: number
      answeredCount: number
      wasTruncatedByTimer: boolean[]
      transcript: unknown[]
      evaluations: unknown[]
      speechMetrics: unknown[]
      liveTranscriptWords: unknown[]
    },
    session: ClientSession,
  ): Promise<TerminalSessionRecord | null>
}

export interface InterviewSessionTerminalTransactionRunner {
  run<T>(
    input: { userId: string; sessionId: string },
    work: (
      session: ClientSession,
      userId: mongoose.Types.ObjectId,
      sessionId: mongoose.Types.ObjectId,
    ) => Promise<T>,
  ): Promise<T>
}

export interface InterviewSessionTerminalDependencies {
  ready?: boolean
  runtimeWritesReady?: boolean
  now?: () => Date
  store?: InterviewSessionTerminalStore
  transactionRunner?: InterviewSessionTerminalTransactionRunner
  settleRuntime?: typeof settleAuthoritativeInterviewRuntimeInSession
}

interface NormalizedTerminalInput {
  userId: string
  sessionId: string
  operationId: string
  status: InterviewSessionTerminalStatus
  endReason: InterviewSessionTerminalEndReason
  transcript: unknown[]
  evaluations: unknown[]
  speechMetrics: unknown[]
  liveTranscriptWords: unknown[]
}

function failure(
  code: InterviewSessionTerminalErrorCode,
  message: string,
  cause?: unknown,
): InterviewSessionTerminalError {
  return new InterviewSessionTerminalError(
    code,
    message,
    cause === undefined ? undefined : { cause },
  )
}

function exactObjectId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !OBJECT_ID_PATTERN.test(value)) {
    throw failure(
      'invalid_request',
      `${label} must be a canonical ObjectId`,
    )
  }
  return value
}

function exactDate(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime())
}

function normalizedInput(
  input: InterviewSessionTerminalInput,
): NormalizedTerminalInput {
  const userId = exactObjectId(input.userId, 'userId')
  const sessionId = exactObjectId(input.sessionId, 'sessionId')
  if (
    typeof input.operationId !== 'string' ||
    !UUID_V4_PATTERN.test(input.operationId)
  ) {
    throw failure(
      'invalid_request',
      'operationId must be a canonical UUID v4',
    )
  }
  if (input.status !== 'completed' && input.status !== 'abandoned') {
    throw failure('invalid_request', 'Terminal status is invalid')
  }
  if (
    typeof input.endReason !== 'string' ||
    !TERMINAL_END_REASONS.includes(
      input.endReason as InterviewSessionTerminalEndReason,
    ) ||
    (
      input.status === 'abandoned' &&
      input.endReason !== 'abandoned'
    ) ||
    (
      input.status === 'completed' &&
      input.endReason === 'abandoned'
    )
  ) {
    throw failure(
      'invalid_request',
      'Terminal status and end reason disagree',
    )
  }
  if (
    !Array.isArray(input.transcript) ||
    !Array.isArray(input.evaluations) ||
    !Array.isArray(input.speechMetrics) ||
    !Array.isArray(input.liveTranscriptWords)
  ) {
    throw failure(
      'invalid_request',
      'Terminal interview artifacts must be arrays',
    )
  }
  return {
    userId,
    sessionId,
    operationId: input.operationId,
    status: input.status,
    endReason:
      input.endReason as InterviewSessionTerminalEndReason,
    transcript: input.transcript,
    evaluations: input.evaluations,
    speechMetrics: input.speechMetrics,
    liveTranscriptWords: input.liveTranscriptWords,
  }
}

function observedNow(provider?: () => Date): Date {
  const now = provider?.() ?? new Date()
  if (!exactDate(now)) {
    throw failure('invalid_request', 'Terminal clock is invalid')
  }
  return new Date(now)
}

function componentDigests(
  row: Pick<
    TerminalSessionRecord,
    | 'transcript'
    | 'evaluations'
    | 'speechMetrics'
    | 'liveTranscriptWords'
  >,
): InterviewSessionTerminalComponentDigests {
  return {
    transcript: sha256CanonicalJson(row.transcript),
    evaluations: sha256CanonicalJson(row.evaluations),
    speechMetrics: sha256CanonicalJson(row.speechMetrics),
    liveTranscriptWords:
      sha256CanonicalJson(row.liveTranscriptWords),
  }
}

function truncationFlags(evaluations: unknown[]): boolean[] {
  return evaluations.map(
    (evaluation) =>
      Boolean(
        evaluation &&
        typeof evaluation === 'object' &&
        !Array.isArray(evaluation) &&
        (evaluation as Record<string, unknown>).status ===
          'truncated',
      ),
  )
}

function exactOwnedRow(
  row: TerminalSessionRecord | null,
  input: NormalizedTerminalInput,
): TerminalSessionRecord {
  if (
    !row ||
    row.id !== input.sessionId ||
    row.userId !== input.userId ||
    row.deletionPendingAt !== undefined ||
    !exactDate(row.startedAt) ||
    !Array.isArray(row.transcript) ||
    !Array.isArray(row.evaluations) ||
    !Array.isArray(row.speechMetrics) ||
    !Array.isArray(row.liveTranscriptWords) ||
    !['in_progress', input.status].includes(row.status)
  ) {
    throw failure(
      'not_found_or_ineligible',
      'Owned active interview session was not found',
    )
  }
  return row
}

function exactTerminalReplayMetadata(
  row: TerminalSessionRecord,
  input: NormalizedTerminalInput,
  maximumDurationSeconds: number,
): void {
  const expectedTruncationFlags = truncationFlags(row.evaluations)
  if (
    row.status !== input.status ||
    !exactDate(row.completedAt) ||
    row.endReason !== input.endReason ||
    !Number.isInteger(row.answeredCount) ||
    row.answeredCount !== row.evaluations.length ||
    !Number.isInteger(row.durationActualSeconds) ||
    row.durationActualSeconds! < 0 ||
    row.durationActualSeconds! > maximumDurationSeconds ||
    !Array.isArray(row.wasTruncatedByTimer) ||
    row.wasTruncatedByTimer.length !== row.evaluations.length ||
    row.wasTruncatedByTimer.some(
      (value, index) =>
        typeof value !== 'boolean' ||
        value !== expectedTruncationFlags[index],
    )
  ) {
    throw failure(
      'authority_conflict',
      'Terminal interview receipt linkage is invalid',
    )
  }
}

function exactTerminalComponents(
  row: TerminalSessionRecord,
  input: NormalizedTerminalInput,
): void {
  if (
    sha256CanonicalJson(componentDigests(row)) !==
    sha256CanonicalJson(componentDigests(input))
  ) {
    throw failure(
      'authority_conflict',
      'Terminal interview artifacts disagree with the durable session',
    )
  }
}

function terminalReceipt(input: {
  terminal: NormalizedTerminalInput
  completedAt: Date
  answeredCount: number
  durationActualSeconds: number
}): InterviewSessionTerminalResult {
  return {
    contractVersion: 1,
    success: true,
    operationId: input.terminal.operationId,
    sessionId: input.terminal.sessionId,
    status: input.terminal.status,
    completedAt: input.completedAt.toISOString(),
    endReason: input.terminal.endReason,
    answeredCount: input.answeredCount,
    durationActualSeconds: input.durationActualSeconds,
  }
}

function exactTerminalArtifact(
  value: InterviewResultArtifact | undefined,
  expected: InterviewSessionTerminalResult,
): void {
  if (
    !value ||
    sha256CanonicalJson(value) !== sha256CanonicalJson(expected)
  ) {
    throw failure(
      'persistence_conflict',
      'Runtime terminal receipt does not match the session',
    )
  }
}

function terminalRow(
  value: Record<string, unknown>,
): TerminalSessionRecord {
  return {
    id: String(value._id),
    userId: String(value.userId),
    status: String(value.status ?? ''),
    deletionPendingAt: exactDate(value.deletionPendingAt)
      ? new Date(value.deletionPendingAt)
      : undefined,
    startedAt: exactDate(value.startedAt)
      ? new Date(value.startedAt)
      : undefined,
    completedAt: exactDate(value.completedAt)
      ? new Date(value.completedAt)
      : undefined,
    config: value.config,
    transcript: Array.isArray(value.transcript)
      ? value.transcript
      : [],
    evaluations: Array.isArray(value.evaluations)
      ? value.evaluations
      : [],
    speechMetrics: Array.isArray(value.speechMetrics)
      ? value.speechMetrics
      : [],
    liveTranscriptWords: Array.isArray(value.liveTranscriptWords)
      ? value.liveTranscriptWords
      : [],
    answeredCount:
      typeof value.answeredCount === 'number'
        ? value.answeredCount
        : undefined,
    durationActualSeconds:
      typeof value.durationActualSeconds === 'number'
        ? value.durationActualSeconds
        : undefined,
    endReason:
      typeof value.endReason === 'string'
        ? value.endReason
        : undefined,
    wasTruncatedByTimer: Array.isArray(value.wasTruncatedByTimer)
      ? value.wasTruncatedByTimer as boolean[]
      : undefined,
  }
}

const TERMINAL_SESSION_PROJECTION =
  'userId status deletionPendingAt startedAt completedAt config ' +
  'transcript evaluations speechMetrics liveTranscriptWords ' +
  'answeredCount durationActualSeconds endReason wasTruncatedByTimer'

const mongoTerminalStore: InterviewSessionTerminalStore = {
  async load(input) {
    const row = await InterviewSession.findOne({
      _id: input.sessionId,
      userId: input.userId,
      deletionPendingAt: { $exists: false },
    })
      .select(TERMINAL_SESSION_PROJECTION)
      .session(input.session)
      .lean()
    return row
      ? terminalRow(row as unknown as Record<string, unknown>)
      : null
  },
  async writeTerminalMetadata(input, session) {
    const row = await InterviewSession.findOneAndUpdate(
      {
        _id: input.sessionId,
        userId: input.userId,
        status: 'in_progress',
        startedAt: input.startedAt,
        completedAt: { $exists: false },
        deletionPendingAt: { $exists: false },
      },
      {
        $set: {
          endReason: input.endReason,
          durationActualSeconds: input.durationActualSeconds,
          answeredCount: input.answeredCount,
          wasTruncatedByTimer: input.wasTruncatedByTimer,
          transcript: input.transcript,
          evaluations: input.evaluations,
          speechMetrics: input.speechMetrics,
          liveTranscriptWords: input.liveTranscriptWords,
        },
      },
      {
        returnDocument: 'after',
        runValidators: true,
        session,
      },
    )
      .select(TERMINAL_SESSION_PROJECTION)
      .lean()
    return row
      ? terminalRow(row as unknown as Record<string, unknown>)
      : null
  },
}

const defaultTransactionRunner:
InterviewSessionTerminalTransactionRunner = {
  async run(input, work) {
    await connectDB()
    return withSessionPersonalDataWriteTransaction(
      input.userId,
      input.sessionId,
      work,
    )
  },
}

function translateFailure(error: unknown): never {
  if (error instanceof InterviewSessionTerminalError) throw error
  if (error instanceof AuthoritativeInterviewRuntimeError) {
    if (error.code === 'not_ready') {
      throw failure(
        'not_ready',
        'Authoritative interview terminal writes are not ready',
      )
    }
    if (
      error.code === 'invalid_user_id' ||
      error.code === 'invalid_session_id' ||
      error.code === 'invalid_operation_id' ||
      error.code === 'invalid_operation_kind' ||
      error.code === 'invalid_digest' ||
      error.code === 'invalid_result_artifact'
    ) {
      throw failure(
        'invalid_request',
        'Authoritative interview terminal request is invalid',
        error,
      )
    }
    if (
      error.code === 'session_not_found' ||
      error.code === 'runtime_not_found'
    ) {
      throw failure(
        'not_found_or_ineligible',
        'Owned active interview session was not found',
        error,
      )
    }
    throw failure(
      error.code.includes('persistence') ||
        error.code === 'runtime_conflict' ||
        error.code === 'turn_persistence_conflict'
        ? 'persistence_conflict'
        : 'authority_conflict',
      'Authoritative runtime rejected terminal settlement',
      error,
    )
  }
  throw failure(
    'persistence_unavailable',
    'Interview terminal state could not be persisted',
    error,
  )
}

export async function terminateInterviewSession(
  rawInput: InterviewSessionTerminalInput,
  dependencies: InterviewSessionTerminalDependencies = {},
): Promise<InterviewSessionTerminalResult> {
  const hasOverrides = Object.values(dependencies).some(
    (value) => value !== undefined,
  )
  if (hasOverrides && process.env.NODE_ENV !== 'test') {
    throw failure(
      'invalid_request',
      'Interview terminal overrides are test-only',
    )
  }
  if (
    (dependencies.ready ??
      PR8_INTERVIEW_ENTITLEMENT_ENFORCEMENT_READY) !== true
  ) {
    throw failure(
      'not_ready',
      'Authoritative interview terminal writes are not ready',
    )
  }

  const input = normalizedInput(rawInput)
  const now = observedNow(dependencies.now)
  const store = dependencies.store ?? mongoTerminalStore
  const runner =
    dependencies.transactionRunner ?? defaultTransactionRunner
  const settle =
    dependencies.settleRuntime ??
    settleAuthoritativeInterviewRuntimeInSession

  try {
    return await runner.run(
      { userId: input.userId, sessionId: input.sessionId },
      async (session, claimedUserId, claimedSessionId) => {
        if (
          claimedUserId.toHexString() !== input.userId ||
          claimedSessionId.toHexString() !== input.sessionId ||
          typeof session.inTransaction !== 'function' ||
          session.inTransaction() !== true
        ) {
          throw failure(
            'persistence_conflict',
            'Interview terminal transaction claim is invalid',
          )
        }
        let row = exactOwnedRow(
          await store.load({
            session,
            userId: claimedUserId,
            sessionId: claimedSessionId,
          }),
          input,
        )
        const config = normalizeAuthoritativeInterviewConfig(
          row.config,
        )

        let completedAt: Date
        let answeredCount: number
        let durationActualSeconds: number
        if (row.status === 'in_progress') {
          completedAt = now
          answeredCount = row.evaluations.length
          durationActualSeconds = Math.min(
            config.duration * 60,
            Math.max(
              0,
              Math.floor(
                (completedAt.getTime() -
                  row.startedAt!.getTime()) /
                  1_000,
              ),
            ),
          )
          const updated = await store.writeTerminalMetadata(
            {
              sessionId: claimedSessionId,
              userId: claimedUserId,
              startedAt: row.startedAt!,
              endReason: input.endReason,
              durationActualSeconds,
              answeredCount:
                input.evaluations.length,
              wasTruncatedByTimer:
                truncationFlags(input.evaluations),
              transcript: input.transcript,
              evaluations: input.evaluations,
              speechMetrics: input.speechMetrics,
              liveTranscriptWords:
                input.liveTranscriptWords,
            },
            session,
          )
          if (!updated) {
            throw failure(
              'persistence_conflict',
              'Interview terminal metadata changed concurrently',
            )
          }
          row = exactOwnedRow(updated, input)
          answeredCount = input.evaluations.length
          exactTerminalComponents(row, input)
        } else {
          exactTerminalReplayMetadata(
            row,
            input,
            config.duration * 60,
          )
          exactTerminalComponents(row, input)
          completedAt = row.completedAt!
          answeredCount = row.answeredCount!
          durationActualSeconds = row.durationActualSeconds!
        }

        const receipt = terminalReceipt({
          terminal: input,
          completedAt,
          answeredCount,
          durationActualSeconds,
        })
        const requestDigest = digestInterviewAuthority(
          INTERVIEW_AUTHORITY_DIGEST_DOMAINS
            .terminalRequest,
          {
            schemaVersion: 1,
            operationId: input.operationId,
            operationKind:
              input.status === 'completed'
                ? 'complete_session'
                : 'abandon_session',
            receipt,
          },
        )
        const settled = await settle(
          {
            userId: input.userId,
            sessionId: input.sessionId,
            operationId: input.operationId,
            operationKind:
              input.status === 'completed'
                ? 'complete_session'
                : 'abandon_session',
            requestDigest,
            resultArtifact: receipt,
          },
          {
            session,
            claimedUserId,
            claimedSessionId,
          },
          {
            now: () => new Date(completedAt),
            writesReady: dependencies.runtimeWritesReady,
          },
        )
        if (
          settled.state !== 'completed' ||
          settled.operationId !== input.operationId ||
          settled.operationKind !==
            (
              input.status === 'completed'
                ? 'complete_session'
                : 'abandon_session'
            ) ||
          settled.runtime.state !== input.status
        ) {
          throw failure(
            'persistence_conflict',
            'Runtime terminal settlement postcondition failed',
          )
        }
        exactTerminalArtifact(settled.resultArtifact, receipt)

        const finalRow = exactOwnedRow(
          await store.load({
            session,
            userId: claimedUserId,
            sessionId: claimedSessionId,
          }),
          input,
        )
        exactTerminalReplayMetadata(
          finalRow,
          input,
          config.duration * 60,
        )
        exactTerminalComponents(finalRow, input)
        if (
          finalRow.completedAt!.getTime() !==
            completedAt.getTime() ||
          finalRow.answeredCount !== answeredCount ||
          finalRow.durationActualSeconds !==
            durationActualSeconds ||
          sha256CanonicalJson(componentDigests(finalRow)) !==
            sha256CanonicalJson(componentDigests(input))
        ) {
          throw failure(
            'persistence_conflict',
            'Session terminal receipt postcondition failed',
          )
        }
        return receipt
      },
    )
  } catch (error) {
    translateFailure(error)
  }
}
