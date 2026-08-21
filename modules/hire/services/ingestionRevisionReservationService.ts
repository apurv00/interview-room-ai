import { randomUUID } from 'node:crypto'
import mongoose, { type ClientSession } from 'mongoose'
import {
  HireRound,
  type HireRoundIngestionReservation,
} from '../models/HireRound'

export const HIRE_INGESTION_RESERVATION_LEASE_MS = 10 * 60 * 1_000

export type HireIngestionStream = 'engineResult' | 'multimodalAnalysis'
export type HireIngestionPriorOutcome =
  | 'duplicate'
  | 'stale'
  | 'in_progress'

export type HireIngestionReservationDecision =
  | { outcome: 'acquired'; reservationToken: string }
  | { outcome: HireIngestionPriorOutcome }
  | { outcome: 'conflict'; reason: string }

interface ReservationCoordinate {
  stream: HireIngestionStream
  workspaceId: string
  applicationId: string
  roundId: string
  runtimeSessionId: string
  attempt: number
  revision: number
  eventId: string
  digest: string
}

interface ReserveHireRoundIngestionInput extends ReservationCoordinate {
  /** Result ingestion may establish the immutable runtime binding. */
  allowUnboundRuntimeSession: boolean
  persistReservation: (
    session: ClientSession,
  ) => Promise<HireIngestionPriorOutcome | null>
  now?: Date
}

interface CompleteHireRoundIngestionInput extends ReservationCoordinate {
  reservationToken: string
  terminalOutcome: 'processed' | 'stale'
  session: ClientSession
  set?: Record<string, unknown>
  unset?: Record<string, 1>
}

class RollbackReservation extends Error {
  constructor(readonly outcome: HireIngestionPriorOutcome) {
    super(outcome)
  }
}

function isDuplicateKeyError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 11000
  )
}

function reservationPath(stream: HireIngestionStream): string {
  return `ingestionReservations.${stream}`
}

function sameId(value: mongoose.Types.ObjectId | undefined, expected: string) {
  return value?.toString() === expected
}

function classifyExistingReservation(
  existing: HireRoundIngestionReservation | undefined,
  input: ReservationCoordinate,
): HireIngestionReservationDecision | 'retry' {
  if (!existing) return 'retry'
  if (!sameId(existing.runtimeSessionId, input.runtimeSessionId)) {
    return {
      outcome: 'conflict',
      reason: 'The round is already reserved for a different runtime session',
    }
  }
  if (
    existing.eventId === input.eventId &&
    (existing.attempt !== input.attempt ||
      existing.revision !== input.revision ||
      existing.digest !== input.digest)
  ) {
    return {
      outcome: 'conflict',
      reason: 'An ingestion event id was reused with different content',
    }
  }
  if (existing.attempt > input.attempt) return { outcome: 'stale' }
  if (existing.attempt < input.attempt) {
    return existing.status === 'reserved'
      ? { outcome: 'in_progress' }
      : 'retry'
  }
  if (existing.revision > input.revision) return { outcome: 'stale' }
  if (existing.revision === input.revision) {
    if (existing.digest !== input.digest) {
      return {
        outcome: 'conflict',
        reason: 'The same ingestion revision has different content',
      }
    }
    return {
      outcome:
        existing.status === 'processed'
          ? existing.terminalOutcome === 'stale'
            ? 'stale'
            : 'duplicate'
          : 'in_progress',
    }
  }
  return existing.status === 'reserved'
    ? { outcome: 'in_progress' }
    : 'retry'
}

/**
 * Atomically advances one monotonic round stream and writes its ingestion
 * event in the same transaction. No R2 or candidate-asset work may start
 * until this returns an acquired token.
 */
export async function reserveHireRoundIngestion(
  input: ReserveHireRoundIngestionInput,
): Promise<HireIngestionReservationDecision> {
  const reservationToken = randomUUID()
  const now = input.now ?? new Date()
  const leaseExpiresAt = new Date(
    now.getTime() + HIRE_INGESTION_RESERVATION_LEASE_MS,
  )
  const path = reservationPath(input.stream)
  const runtimeSessionId = new mongoose.Types.ObjectId(input.runtimeSessionId)
  const roundScope = {
    _id: input.roundId,
    workspaceId: input.workspaceId,
    applicationId: input.applicationId,
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const session = await mongoose.startSession()
    let decision: HireIngestionReservationDecision | 'retry' = 'retry'
    try {
      try {
        await session.withTransaction(async () => {
          const runtimeFilter = input.allowUnboundRuntimeSession
            ? {
                $or: [
                  { runtimeSessionId: { $exists: false } },
                  { runtimeSessionId },
                ],
              }
            : { runtimeSessionId }
          const claim = await HireRound.updateOne(
            {
              ...roundScope,
              $and: [
                runtimeFilter,
                {
                  $or: [
                    { [`${path}.revision`]: { $exists: false } },
                    {
                      [`${path}.status`]: 'processed',
                      $or: [
                        { [`${path}.attempt`]: { $lt: input.attempt } },
                        {
                          [`${path}.attempt`]: input.attempt,
                          [`${path}.revision`]: { $lt: input.revision },
                        },
                      ],
                    },
                    {
                      [`${path}.status`]: 'reserved',
                      [`${path}.runtimeSessionId`]: runtimeSessionId,
                      [`${path}.attempt`]: input.attempt,
                      [`${path}.revision`]: input.revision,
                      [`${path}.eventId`]: input.eventId,
                      [`${path}.digest`]: input.digest,
                      [`${path}.leaseExpiresAt`]: { $lte: now },
                    },
                  ],
                },
              ],
            },
            {
              $set: {
                [path]: {
                  runtimeSessionId,
                  attempt: input.attempt,
                  revision: input.revision,
                  eventId: input.eventId,
                  digest: input.digest,
                  status: 'reserved',
                  reservationToken,
                  leaseExpiresAt,
                },
              },
            },
            { session },
          )
          if (claim.matchedCount === 1) {
            const prior = await input.persistReservation(session)
            if (prior) throw new RollbackReservation(prior)
            decision = { outcome: 'acquired', reservationToken }
            return
          }

          const round = await HireRound.findOne(roundScope)
            .select('runtimeSessionId ingestionReservations')
            .session(session)
            .lean()
          if (!round) {
            decision = {
              outcome: 'conflict',
              reason: 'The ingestion round changed before reservation',
            }
            return
          }
          if (
            round.runtimeSessionId &&
            !sameId(round.runtimeSessionId, input.runtimeSessionId)
          ) {
            decision = {
              outcome: 'conflict',
              reason: 'The round is already bound to a different runtime session',
            }
            return
          }
          decision = classifyExistingReservation(
            round.ingestionReservations?.[input.stream],
            input,
          )
        })
      } catch (error) {
        if (error instanceof RollbackReservation) {
          return { outcome: error.outcome }
        }
        // A global event-id or per-round revision uniqueness race aborts the
        // transaction before any head can commit. Re-read it in a fresh
        // transaction so the caller receives duplicate/conflict semantics
        // instead of an opaque duplicate-key failure.
        if (isDuplicateKeyError(error)) decision = 'retry'
        else throw error
      }
    } finally {
      await session.endSession()
    }
    if (decision !== 'retry') return decision
  }
  return {
    outcome: 'conflict',
    reason: 'The ingestion reservation changed too many times',
  }
}

/** Completes the exact owner token and any caller state in one transaction. */
export async function completeHireRoundIngestion(
  input: CompleteHireRoundIngestionInput,
): Promise<void> {
  const path = reservationPath(input.stream)
  const completed = await HireRound.updateOne(
    {
      _id: input.roundId,
      workspaceId: input.workspaceId,
      applicationId: input.applicationId,
      [`${path}.runtimeSessionId`]: input.runtimeSessionId,
      [`${path}.attempt`]: input.attempt,
      [`${path}.revision`]: input.revision,
      [`${path}.eventId`]: input.eventId,
      [`${path}.digest`]: input.digest,
      [`${path}.status`]: 'reserved',
      [`${path}.reservationToken`]: input.reservationToken,
    },
    {
      $set: {
        [`${path}.status`]: 'processed',
        [`${path}.terminalOutcome`]: input.terminalOutcome,
        [`${path}.processedAt`]: new Date(),
        ...input.set,
      },
      $unset: {
        [`${path}.reservationToken`]: 1,
        [`${path}.leaseExpiresAt`]: 1,
        ...input.unset,
      },
    },
    { session: input.session },
  )
  if (completed.matchedCount !== 1) {
    throw new Error('Hire ingestion reservation changed before completion')
  }
}

/** Makes an observed failure immediately reclaimable by the exact event. */
export async function releaseHireRoundIngestion(
  input: ReservationCoordinate & { reservationToken: string },
): Promise<void> {
  const path = reservationPath(input.stream)
  await HireRound.updateOne(
    {
      _id: input.roundId,
      workspaceId: input.workspaceId,
      applicationId: input.applicationId,
      [`${path}.runtimeSessionId`]: input.runtimeSessionId,
      [`${path}.attempt`]: input.attempt,
      [`${path}.revision`]: input.revision,
      [`${path}.eventId`]: input.eventId,
      [`${path}.digest`]: input.digest,
      [`${path}.status`]: 'reserved',
      [`${path}.reservationToken`]: input.reservationToken,
    },
    { $set: { [`${path}.leaseExpiresAt`]: new Date() } },
  ).catch(() => undefined)
}

export const __hireIngestionRevisionReservation = {
  classifyExistingReservation,
}
