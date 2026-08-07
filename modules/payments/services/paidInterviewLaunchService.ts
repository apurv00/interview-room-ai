import mongoose, {
  type ClientSession,
  type QueryFilter,
} from 'mongoose'
import type { BillingConfigView } from './billingConfigService'
import {
  PaidInterviewUnlock,
  PAID_INTERVIEW_MAX_DURATION_MINUTES,
  type IPaidInterviewUnlock,
} from '../models/PaidInterviewUnlock'
import type { ProviderMode } from '../types/catalog'

const OBJECT_ID_PATTERN = /^[a-f\d]{24}$/i

export type PaidInterviewLaunchErrorCode =
  | 'invalid_request'
  | 'unavailable'
  | 'persistence_conflict'

export class PaidInterviewLaunchError extends Error {
  constructor(
    readonly code: PaidInterviewLaunchErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'PaidInterviewLaunchError'
  }
}

export interface PaidInterviewLaunchInput {
  userId: unknown
  sessionId: unknown
  providerMode: unknown
  durationMinutes: unknown
  now: unknown
}

export interface PaidInterviewLaunchResult {
  unlockId: string
  userId: string
  sessionId: string
  providerMode: ProviderMode
  consumedAt: Date
  reused: boolean
}

interface StoredPaidInterviewLaunchUnlock {
  id: mongoose.Types.ObjectId
  userId: mongoose.Types.ObjectId
  providerMode: ProviderMode
  status: 'consumed'
  maxDurationMinutes: number
  validUntil: Date
  reservedSessionId: mongoose.Types.ObjectId
  consumedSessionId: mongoose.Types.ObjectId
  reservedAt: Date
  consumedAt: Date
}

export interface PaidInterviewLaunchStore {
  findConsumed(input: {
    userId: mongoose.Types.ObjectId
    sessionId: mongoose.Types.ObjectId
    providerMode: ProviderMode
    session: ClientSession
  }): Promise<StoredPaidInterviewLaunchUnlock | null>
  claimAvailable(input: {
    userId: mongoose.Types.ObjectId
    sessionId: mongoose.Types.ObjectId
    providerMode: ProviderMode
    durationMinutes: number
    now: Date
    session: ClientSession
  }): Promise<StoredPaidInterviewLaunchUnlock | null>
}

function failure(
  code: PaidInterviewLaunchErrorCode,
  message: string,
  cause?: unknown,
) {
  return new PaidInterviewLaunchError(
    code,
    message,
    cause === undefined ? undefined : { cause },
  )
}

function exactObjectId(value: unknown, label: string) {
  if (typeof value !== 'string' || !OBJECT_ID_PATTERN.test(value)) {
    throw failure(
      'invalid_request',
      `${label} must be an exact canonical ObjectId`,
    )
  }
  return new mongoose.Types.ObjectId(value)
}

function exactDate(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime())
}

function storedUnlock(
  row: {
    _id: mongoose.Types.ObjectId
    userId: mongoose.Types.ObjectId
    providerMode: ProviderMode
    status: 'consumed'
    maxDurationMinutes: number
    validUntil: Date
    reservedSessionId: mongoose.Types.ObjectId
    consumedSessionId: mongoose.Types.ObjectId
    reservedAt: Date
    consumedAt: Date
  },
): StoredPaidInterviewLaunchUnlock {
  return { id: row._id, ...row }
}

const mongoPaidInterviewLaunchStore: PaidInterviewLaunchStore = {
  async findConsumed(input) {
    const row = await PaidInterviewUnlock.findOne({
      userId: input.userId,
      providerMode: input.providerMode,
      status: 'consumed',
      reservedSessionId: input.sessionId,
      consumedSessionId: input.sessionId,
    })
      .session(input.session)
      .lean<{
        _id: mongoose.Types.ObjectId
        userId: mongoose.Types.ObjectId
        providerMode: ProviderMode
        status: 'consumed'
        maxDurationMinutes: number
        validUntil: Date
        reservedSessionId: mongoose.Types.ObjectId
        consumedSessionId: mongoose.Types.ObjectId
        reservedAt: Date
        consumedAt: Date
      }>()
    return row ? storedUnlock(row) : null
  },

  async claimAvailable(input) {
    const row = await PaidInterviewUnlock.findOneAndUpdate(
      {
        userId: input.userId,
        providerMode: input.providerMode,
        status: { $in: ['available', 'restored'] },
        validUntil: { $gt: input.now },
        maxDurationMinutes: {
          $gte: input.durationMinutes,
        },
      } as QueryFilter<IPaidInterviewUnlock>,
      {
        $set: {
          status: 'consumed',
          reservedSessionId: input.sessionId,
          consumedSessionId: input.sessionId,
          reservedAt: input.now,
          consumedAt: input.now,
        },
        $unset: {
          restoredAt: 1,
          restoreReason: 1,
        },
      },
      {
        new: true,
        runValidators: true,
        sort: { createdAt: 1, _id: 1 },
        session: input.session,
      },
    ).lean<{
      _id: mongoose.Types.ObjectId
      userId: mongoose.Types.ObjectId
      providerMode: ProviderMode
      status: 'consumed'
      maxDurationMinutes: number
      validUntil: Date
      reservedSessionId: mongoose.Types.ObjectId
      consumedSessionId: mongoose.Types.ObjectId
      reservedAt: Date
      consumedAt: Date
    }>()
    return row ? storedUnlock(row) : null
  },
}

function exactConsumedUnlock(
  unlock: StoredPaidInterviewLaunchUnlock,
  expected: {
    userId: mongoose.Types.ObjectId
    sessionId: mongoose.Types.ObjectId
    providerMode: ProviderMode
    durationMinutes: number
  },
): void {
  if (
    !unlock.id ||
    !unlock.userId.equals(expected.userId) ||
    unlock.providerMode !== expected.providerMode ||
    unlock.status !== 'consumed' ||
    unlock.maxDurationMinutes < expected.durationMinutes ||
    unlock.maxDurationMinutes > PAID_INTERVIEW_MAX_DURATION_MINUTES ||
    !exactDate(unlock.validUntil) ||
    !unlock.reservedSessionId.equals(expected.sessionId) ||
    !unlock.consumedSessionId.equals(expected.sessionId) ||
    !exactDate(unlock.reservedAt) ||
    !exactDate(unlock.consumedAt) ||
    unlock.consumedAt.getTime() !== unlock.reservedAt.getTime() ||
    unlock.validUntil <= unlock.reservedAt
  ) {
    throw failure(
      'persistence_conflict',
      'Paid interview unlock consumption is incoherent',
    )
  }
}

/**
 * Maps the current customer billing rollout to the only provider lane from
 * which an interview unlock may be consumed. Turning selling off never
 * invalidates an already-purchased live unlock; QA users remain isolated in
 * the test lane.
 */
export function paidInterviewLaunchProviderMode(
  config: BillingConfigView,
  userId: string,
): ProviderMode {
  return config.sellingMode === 'qa' && config.qaUserIds.includes(userId)
    ? 'test'
    : 'live'
}

/**
 * Atomically records both reservation and consumption for one paid interview
 * inside the transaction that creates its InterviewSession. Replaying the
 * same session is idempotent; a different account or session can never reuse
 * the consumed unlock.
 */
export async function consumePaidInterviewUnlockForLaunchInSession(
  input: PaidInterviewLaunchInput,
  session: ClientSession,
  dependencies: { store?: PaidInterviewLaunchStore } = {},
): Promise<PaidInterviewLaunchResult> {
  if (
    !session ||
    typeof session.inTransaction !== 'function' ||
    session.inTransaction() !== true
  ) {
    throw failure(
      'invalid_request',
      'Paid interview launch requires an active transaction',
    )
  }
  const userId = exactObjectId(input.userId, 'userId')
  const sessionId = exactObjectId(input.sessionId, 'sessionId')
  if (input.providerMode !== 'test' && input.providerMode !== 'live') {
    throw failure('invalid_request', 'providerMode is invalid')
  }
  if (
    !Number.isSafeInteger(input.durationMinutes) ||
    (input.durationMinutes as number) < 5 ||
    (input.durationMinutes as number) > PAID_INTERVIEW_MAX_DURATION_MINUTES
  ) {
    throw failure(
      'invalid_request',
      `Paid interviews must be between 5 and ${PAID_INTERVIEW_MAX_DURATION_MINUTES} minutes`,
    )
  }
  if (!exactDate(input.now)) {
    throw failure('invalid_request', 'Paid interview launch time is invalid')
  }
  const providerMode = input.providerMode
  const durationMinutes = input.durationMinutes as number
  const now = new Date(input.now)
  const store = dependencies.store ?? mongoPaidInterviewLaunchStore

  try {
    const replay = await store.findConsumed({
      userId,
      sessionId,
      providerMode,
      session,
    })
    if (replay) {
      exactConsumedUnlock(replay, {
        userId,
        sessionId,
        providerMode,
        durationMinutes,
      })
      return {
        unlockId: replay.id.toHexString(),
        userId: userId.toHexString(),
        sessionId: sessionId.toHexString(),
        providerMode,
        consumedAt: new Date(replay.consumedAt),
        reused: true,
      }
    }

    const claimed = await store.claimAvailable({
      userId,
      sessionId,
      providerMode,
      durationMinutes,
      now,
      session,
    })
    if (!claimed) {
      throw failure(
        'unavailable',
        'No captured paid interview unlock is available',
      )
    }
    exactConsumedUnlock(claimed, {
      userId,
      sessionId,
      providerMode,
      durationMinutes,
    })
    return {
      unlockId: claimed.id.toHexString(),
      userId: userId.toHexString(),
      sessionId: sessionId.toHexString(),
      providerMode,
      consumedAt: new Date(claimed.consumedAt),
      reused: false,
    }
  } catch (error) {
    if (error instanceof PaidInterviewLaunchError) throw error
    throw failure(
      'persistence_conflict',
      'Paid interview unlock could not be consumed',
      error,
    )
  }
}
