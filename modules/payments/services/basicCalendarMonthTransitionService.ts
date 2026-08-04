import mongoose, { type ClientSession } from 'mongoose'
import { User } from '@shared/db/models/User'
import {
  CONSUMER_CATALOG_V1,
  CURRENT_PLAN_VOCABULARY_VERSION,
} from '@shared/services/planConfig'
import {
  PR8_BASIC_CALENDAR_MONTH_TRANSITION_READY,
} from '@shared/services/pr8InterviewRollout'
import {
  basicCalendarMonthPeriod,
  type EntitlementPeriod,
} from './periodKeyService'
import {
  findAndCommitUserEntitlementProjectionUpdateInSession,
} from './entitlementService'

const OBJECT_ID_PATTERN = /^[0-9a-f]{24}$/
const BASIC_PERIOD_KEY_PATTERN =
  /^basic:([1-9][0-9]{3})-(0[1-9]|1[0-2])$/
const BASIC_INTERVIEW_LIMIT =
  CONSUMER_CATALOG_V1.plans.free.interview.includedPerPeriod

/**
 * This transition remains unreachable from production until its transaction
 * caller and replay evidence are approved. Tests may opt in explicitly.
 */
export { PR8_BASIC_CALENDAR_MONTH_TRANSITION_READY }

export const BASIC_CALENDAR_MONTH_TRANSITION_ERROR_CODES = [
  'not_ready',
  'invalid_input',
  'invalid_transaction_context',
  'authority_conflict',
  'persistence_conflict',
] as const
export type BasicCalendarMonthTransitionErrorCode =
  (typeof BASIC_CALENDAR_MONTH_TRANSITION_ERROR_CODES)[number]

export class BasicCalendarMonthTransitionError extends Error {
  constructor(
    readonly code: BasicCalendarMonthTransitionErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'BasicCalendarMonthTransitionError'
  }
}

export interface BasicCalendarMonthProjectionRow {
  _id: mongoose.Types.ObjectId
  plan?: unknown
  planVocabularyVersion?: unknown
  planExpiresAt?: unknown
  entitlementSource?: unknown
  usagePeriodKey?: unknown
  interviewsUsed?: unknown
  interviewLimit?: unknown
  usageResetAt?: unknown
  entitlementVersion?: unknown
  buyerState?: unknown
}

export interface BasicCalendarMonthTransitionCasInput {
  userId: mongoose.Types.ObjectId
  previousPeriodKey: string
  previousUsageResetAt: Date
  previousInterviewsUsed: number
  previousInterviewLimit: number
  previousEntitlementVersion: number
  nextPeriod: EntitlementPeriod
}

export interface BasicCalendarMonthTransitionPersistence {
  loadProjection(
    userId: mongoose.Types.ObjectId,
    session: ClientSession,
  ): Promise<BasicCalendarMonthProjectionRow | null>
  compareAndSwapPeriod(
    input: BasicCalendarMonthTransitionCasInput,
    session: ClientSession,
  ): Promise<BasicCalendarMonthProjectionRow | null>
}

export interface BasicCalendarMonthTransitionContext {
  session: ClientSession
  claimedUserId: mongoose.Types.ObjectId
  /**
   * The caller must set this only after the authority loader proved, inside
   * this same transaction, that no current paid cycle can own the period.
   */
  noActivePaidCycleConfirmed: true
}

export interface BasicCalendarMonthTransitionDependencies {
  now?: () => Date
  persistence?: BasicCalendarMonthTransitionPersistence
  allowWhenReadinessDisabledForTests?: boolean
}

export interface BasicCalendarMonthTransitionResult {
  disposition: 'replayed' | 'advanced'
  userId: string
  usagePeriodKey: string
  interviewsUsed: number
  interviewLimit: number
  usageResetAt: Date
  entitlementVersion: number
}

export interface BasicCalendarMonthReadProjection {
  transitionRequired: boolean
  userId: string
  usagePeriodKey: string
  interviewsUsed: number
  interviewLimit: number
  usageResetAt: Date
  entitlementVersion: number
}

function failure(
  code: BasicCalendarMonthTransitionErrorCode,
  message: string,
): BasicCalendarMonthTransitionError {
  return new BasicCalendarMonthTransitionError(code, message)
}

function validDate(value: unknown): value is Date {
  return (
    value instanceof Date &&
    Number.isFinite(value.getTime())
  )
}

function sameDate(value: unknown, expected: Date): boolean {
  return (
    validDate(value) &&
    value.getTime() === expected.getTime()
  )
}

function safeCounter(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0
  )
}

function exactUserId(value: unknown): mongoose.Types.ObjectId {
  if (
    typeof value !== 'string' ||
    !OBJECT_ID_PATTERN.test(value)
  ) {
    throw failure(
      'invalid_input',
      'Basic transition userId must be a canonical ObjectId',
    )
  }
  return new mongoose.Types.ObjectId(value)
}

function observedNow(provider?: () => Date): Date {
  const value = provider ? provider() : new Date()
  if (!validDate(value)) {
    throw failure(
      'invalid_input',
      'Basic transition clock returned an invalid date',
    )
  }
  return new Date(value)
}

function assertReady(
  dependencies: BasicCalendarMonthTransitionDependencies,
): void {
  const testOverride =
    process.env.NODE_ENV === 'test' &&
    dependencies.allowWhenReadinessDisabledForTests === true
  if (!PR8_BASIC_CALENDAR_MONTH_TRANSITION_READY && !testOverride) {
    throw failure(
      'not_ready',
      'Basic calendar-month transition is not ready',
    )
  }
}

function assertTransactionContext(
  context: BasicCalendarMonthTransitionContext,
  userId: mongoose.Types.ObjectId,
): void {
  let activeTransaction = false
  try {
    activeTransaction = Boolean(
      context.session &&
      typeof context.session.inTransaction === 'function' &&
      context.session.inTransaction(),
    )
  } catch {
    activeTransaction = false
  }
  if (
    !(context.claimedUserId instanceof mongoose.Types.ObjectId) ||
    !context.claimedUserId.equals(userId) ||
    context.noActivePaidCycleConfirmed !== true ||
    !activeTransaction
  ) {
    throw failure(
      'invalid_transaction_context',
      'Basic transition requires the caller active claimed transaction',
    )
  }
}

function exactStoredBasicPeriod(value: unknown): EntitlementPeriod | null {
  if (typeof value !== 'string') return null
  const match = BASIC_PERIOD_KEY_PATTERN.exec(value)
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  try {
    const probe = new Date(Date.UTC(year, month - 1, 15, 12))
    const period = basicCalendarMonthPeriod(probe)
    return period.key === value ? period : null
  } catch {
    return null
  }
}

function exactProjection(
  row: BasicCalendarMonthProjectionRow,
  userId: mongoose.Types.ObjectId,
): {
  period: EntitlementPeriod
  interviewsUsed: number
  entitlementVersion: number
} {
  const period = exactStoredBasicPeriod(row.usagePeriodKey)
  if (
    !(row._id instanceof mongoose.Types.ObjectId) ||
    !row._id.equals(userId) ||
    row.plan !== 'free' ||
    row.planVocabularyVersion !==
      CURRENT_PLAN_VOCABULARY_VERSION ||
    row.entitlementSource !== 'free' ||
    row.planExpiresAt !== undefined ||
    row.buyerState === 'deletion_pending' ||
    !period ||
    !sameDate(row.usageResetAt, period.end) ||
    !safeCounter(row.interviewsUsed) ||
    row.interviewLimit !== BASIC_INTERVIEW_LIMIT ||
    row.interviewsUsed > BASIC_INTERVIEW_LIMIT ||
    !safeCounter(row.entitlementVersion) ||
    row.entitlementVersion < 1
  ) {
    throw failure(
      'authority_conflict',
      'Stored Basic entitlement projection requires review',
    )
  }
  return {
    period,
    interviewsUsed: row.interviewsUsed,
    entitlementVersion: row.entitlementVersion,
  }
}

export function buildBasicCalendarMonthTransitionCas(
  input: BasicCalendarMonthTransitionCasInput,
) {
  return {
    filter: {
      _id: input.userId,
      plan: 'free' as const,
      planVocabularyVersion:
        CURRENT_PLAN_VOCABULARY_VERSION,
      planExpiresAt: { $exists: false as const },
      entitlementSource: 'free' as const,
      usagePeriodKey: input.previousPeriodKey,
      interviewsUsed: input.previousInterviewsUsed,
      interviewLimit: input.previousInterviewLimit,
      usageResetAt: input.previousUsageResetAt,
      entitlementVersion: input.previousEntitlementVersion,
      buyerState: { $ne: 'deletion_pending' as const },
    },
    update: {
      $set: {
        usagePeriodKey: input.nextPeriod.key,
        interviewsUsed: 0,
        interviewLimit: BASIC_INTERVIEW_LIMIT,
        usageResetAt: input.nextPeriod.end,
      },
      $inc: {
        entitlementVersion: 1,
      },
    },
  }
}

const mongoPersistence: BasicCalendarMonthTransitionPersistence = {
  async loadProjection(userId, session) {
    return User.findOne({
      _id: userId,
      buyerState: { $ne: 'deletion_pending' },
    })
      .select(
        'plan planVocabularyVersion planExpiresAt entitlementSource ' +
          'usagePeriodKey interviewsUsed interviewLimit usageResetAt ' +
          'entitlementVersion buyerState',
      )
      .session(session)
      .lean<BasicCalendarMonthProjectionRow>()
  },

  async compareAndSwapPeriod(input, session) {
    const mutation = buildBasicCalendarMonthTransitionCas(input)
    return findAndCommitUserEntitlementProjectionUpdateInSession(
      'basic_period_transition',
      mutation.filter,
      mutation.update,
      session,
    )
      .select(
        'plan planVocabularyVersion planExpiresAt entitlementSource ' +
          'usagePeriodKey interviewsUsed interviewLimit usageResetAt ' +
          'entitlementVersion buyerState',
      )
      .lean<BasicCalendarMonthProjectionRow>()
  },
}

function result(
  disposition: BasicCalendarMonthTransitionResult['disposition'],
  userId: mongoose.Types.ObjectId,
  row: BasicCalendarMonthProjectionRow,
): BasicCalendarMonthTransitionResult {
  return {
    disposition,
    userId: userId.toHexString(),
    usagePeriodKey: row.usagePeriodKey as string,
    interviewsUsed: row.interviewsUsed as number,
    interviewLimit: row.interviewLimit as number,
    usageResetAt: new Date(row.usageResetAt as Date),
    entitlementVersion: row.entitlementVersion as number,
  }
}

/**
 * Computes the exact current Basic authority without mutating it. Preflight
 * uses this projection so a dormant user's stale, canonical month is shown as
 * the same allowance that atomic session creation will CAS into place.
 */
export function projectBasicCalendarMonthEntitlementReadOnly(input: {
  userId: unknown
  row: BasicCalendarMonthProjectionRow
  now: Date
}): BasicCalendarMonthReadProjection {
  const userId = exactUserId(input.userId)
  if (!validDate(input.now)) {
    throw failure(
      'invalid_input',
      'Basic transition clock returned an invalid date',
    )
  }
  const currentPeriod = basicCalendarMonthPeriod(input.now)
  const exact = exactProjection(input.row, userId)
  if (exact.period.key === currentPeriod.key) {
    return {
      transitionRequired: false,
      userId: userId.toHexString(),
      usagePeriodKey: currentPeriod.key,
      interviewsUsed: exact.interviewsUsed,
      interviewLimit: BASIC_INTERVIEW_LIMIT,
      usageResetAt: new Date(currentPeriod.end),
      entitlementVersion: exact.entitlementVersion,
    }
  }
  if (
    exact.period.end > currentPeriod.start ||
    exact.entitlementVersion >= Number.MAX_SAFE_INTEGER
  ) {
    throw failure(
      'authority_conflict',
      'Basic entitlement period cannot advance safely',
    )
  }
  return {
    transitionRequired: true,
    userId: userId.toHexString(),
    usagePeriodKey: currentPeriod.key,
    interviewsUsed: 0,
    interviewLimit: BASIC_INTERVIEW_LIMIT,
    usageResetAt: new Date(currentPeriod.end),
    entitlementVersion: exact.entitlementVersion + 1,
  }
}

/**
 * In-session primitive only. The caller owns the transaction, must have
 * claimed this exact User row through the deletion fence, and must have ruled
 * out current paid-cycle authority in the same transaction before calling.
 */
export async function transitionBasicCalendarMonthEntitlementInSession(
  input: { userId: unknown },
  context: BasicCalendarMonthTransitionContext,
  dependencies: BasicCalendarMonthTransitionDependencies = {},
): Promise<BasicCalendarMonthTransitionResult> {
  assertReady(dependencies)
  const userId = exactUserId(input.userId)
  assertTransactionContext(context, userId)
  const now = observedNow(dependencies.now)
  const currentPeriod = basicCalendarMonthPeriod(now)
  const persistence = dependencies.persistence ?? mongoPersistence
  const current = await persistence.loadProjection(
    userId,
    context.session,
  )
  if (!current) {
    throw failure(
      'authority_conflict',
      'Basic entitlement projection is unavailable',
    )
  }
  const readProjection =
    projectBasicCalendarMonthEntitlementReadOnly({
      userId: userId.toHexString(),
      row: current,
      now,
    })
  if (!readProjection.transitionRequired) {
    return result('replayed', userId, current)
  }
  const exact = exactProjection(current, userId)

  const updated = await persistence.compareAndSwapPeriod(
    {
      userId,
      previousPeriodKey: exact.period.key,
      previousUsageResetAt: exact.period.end,
      previousInterviewsUsed: exact.interviewsUsed,
      previousInterviewLimit: BASIC_INTERVIEW_LIMIT,
      previousEntitlementVersion: exact.entitlementVersion,
      nextPeriod: currentPeriod,
    },
    context.session,
  )
  if (!updated) {
    throw failure(
      'persistence_conflict',
      'Basic entitlement projection changed concurrently',
    )
  }
  const advanced = exactProjection(updated, userId)
  if (
    advanced.period.key !== currentPeriod.key ||
    advanced.interviewsUsed !== 0 ||
    advanced.entitlementVersion !==
      readProjection.entitlementVersion
  ) {
    throw failure(
      'persistence_conflict',
      'Basic entitlement transition returned a mismatched projection',
    )
  }
  return result('advanced', userId, updated)
}
