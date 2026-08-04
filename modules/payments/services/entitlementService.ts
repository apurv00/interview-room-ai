import type {
  ClientSession,
  QueryFilter,
  UpdateQuery,
} from 'mongoose'
import { connectDB } from '@shared/db/connection'
import { User, type IUser } from '@shared/db/models/User'
import type { PersonalPlanKey } from '@shared/services/planConfig'
import { basicCalendarMonthPeriod } from './periodKeyService'

export type EntitlementSource = 'free' | 'subscription' | 'admin_grant'

export interface EntitlementProjection {
  plan: PersonalPlanKey
  entitlementSource: EntitlementSource
  planExpiresAt?: Date
  usagePeriodKey: string
  interviewsUsed: number
  interviewLimit: number
  premiumResumesUsed: number
  premiumResumeLimit: number
  usageResetAt: Date
  freeBasicResumeId?: string
  entitlementVersion: number
}

export interface EntitlementProjectionRead extends EntitlementProjection {
  initialized: boolean
}

interface LeanEntitlementProjectionRow {
  plan?: string
  entitlementSource?: EntitlementSource
  planExpiresAt?: Date
  usagePeriodKey?: string
  interviewsUsed?: number
  interviewLimit?: number
  premiumResumesUsed?: number
  premiumResumeLimit?: number
  usageResetAt?: Date
  freeBasicResumeId?: string
  entitlementVersion?: number
}

export async function readEntitlementProjection(
  userId: string,
  now = new Date(),
): Promise<EntitlementProjectionRead | null> {
  await connectDB()
  const user = await User.findById(userId)
    .select([
      'plan',
      'entitlementSource',
      'planExpiresAt',
      'usagePeriodKey',
      'interviewsUsed',
      'interviewLimit',
      'premiumResumesUsed',
      'premiumResumeLimit',
      'usageResetAt',
      'freeBasicResumeId',
      'entitlementVersion',
    ].join(' '))
    .lean<LeanEntitlementProjectionRow>()
  if (!user) return null

  const basicPeriod = basicCalendarMonthPeriod(now)
  const initialized = typeof user.entitlementVersion === 'number'
  const plan = user.plan === 'plus' || user.plan === 'pro'
    ? user.plan
    : 'free'

  return {
    initialized,
    plan,
    entitlementSource: user.entitlementSource ?? 'free',
    planExpiresAt: user.planExpiresAt,
    usagePeriodKey: user.usagePeriodKey ?? basicPeriod.key,
    interviewsUsed: user.interviewsUsed ?? 0,
    // An uninitialized row is compatibility-only. No v2 gate consumes this
    // while enforcement is off.
    interviewLimit: user.interviewLimit ?? 1,
    premiumResumesUsed: user.premiumResumesUsed ?? 0,
    premiumResumeLimit: user.premiumResumeLimit ?? 0,
    usageResetAt: user.usageResetAt ?? basicPeriod.end,
    freeBasicResumeId: user.freeBasicResumeId,
    entitlementVersion: user.entitlementVersion ?? 0,
  }
}

export const USER_ENTITLEMENT_PROJECTION_PATHS = [
  'plan',
  'planVocabularyVersion',
  'planExpiresAt',
  'monthlyInterviewsUsed',
  'monthlyInterviewLimit',
  'entitlementSource',
  'usagePeriodKey',
  'interviewsUsed',
  'interviewLimit',
  'premiumResumesUsed',
  'premiumResumeLimit',
  'usageResetAt',
  'freeBasicResumeId',
  'entitlementVersion',
  'entitlementAuthority',
] as const

export type UserEntitlementProjectionMutationKind =
  | 'subscription_cycle'
  | 'subscription_basic_fallback'
  | 'basic_period_transition'
  | 'admin_authority'
  | 'interview_reservation'
  | 'interview_restoration'
  | 'resume_entitlement'
  | 'account_deletion_reset'
  | 'exact_reconciliation'

type UserUpdateFilter = QueryFilter<IUser>
type UserUpdateDocument = UpdateQuery<IUser>

export class EntitlementProjectionWriteBoundaryError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EntitlementProjectionWriteBoundaryError'
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function assertActiveCallerSession(session: ClientSession): void {
  const active = typeof session?.inTransaction === 'function'
    ? session.inTransaction()
    : process.env.NODE_ENV === 'test'
  if (!active) {
    throw new EntitlementProjectionWriteBoundaryError(
      'Entitlement projection writes require an active caller transaction',
    )
  }
}

function buyerDeletionFence(filter: Record<string, unknown>): boolean {
  const buyerState = filter.buyerState
  if (typeof buyerState === 'string') {
    return buyerState !== 'deletion_pending'
  }
  const condition = record(buyerState)
  return (
    condition.$ne === 'deletion_pending' ||
    condition.$exists === false
  )
}

function exactEntitlementVersionPredicate(
  value: unknown,
  allowMissing: boolean,
): number | 'missing' | null {
  if (
    Number.isSafeInteger(value) &&
    Number(value) >= 0 &&
    Number(value) < Number.MAX_SAFE_INTEGER
  ) {
    return Number(value)
  }
  const condition = record(value)
  return (
    allowMissing &&
    Object.keys(condition).length === 1 &&
    condition.$exists === false
  )
    ? 'missing'
    : null
}

function assertProjectionMutation(
  kind: UserEntitlementProjectionMutationKind,
  filterValue: UserUpdateFilter,
  updateValue: UserUpdateDocument,
  session: ClientSession,
): void {
  assertActiveCallerSession(session)
  const filter = record(filterValue)
  const update = record(updateValue)
  const touched = ['$set', '$unset', '$inc', '$setOnInsert']
    .flatMap((operator) => Object.keys(record(update[operator])))
    .map((path) => path.split('.')[0])
  if (!touched.some((path) =>
    path !== 'entitlementVersion' &&
    (USER_ENTITLEMENT_PROJECTION_PATHS as readonly string[])
      .includes(path))) {
    throw new EntitlementProjectionWriteBoundaryError(
      'Mutation does not touch the entitlement projection',
    )
  }
  const expectedVersion = exactEntitlementVersionPredicate(
    filter.entitlementVersion,
    kind === 'account_deletion_reset',
  )
  if (expectedVersion === null) {
    throw new EntitlementProjectionWriteBoundaryError(
      'Entitlement projection writes require an exact version predicate',
    )
  }
  if (kind === 'account_deletion_reset') {
    const next = record(update.$set).entitlementVersion
    const requiredNext =
      expectedVersion === 'missing' ? 1 : expectedVersion + 1
    if (
      !Number.isSafeInteger(next) ||
      Number(next) !== requiredNext
    ) {
      throw new EntitlementProjectionWriteBoundaryError(
        'Deletion reset requires an explicit next entitlement version',
      )
    }
  } else if (record(update.$inc).entitlementVersion !== 1) {
    throw new EntitlementProjectionWriteBoundaryError(
      'Entitlement projection writes must increment the version by one',
    )
  }
  if (
    kind !== 'account_deletion_reset' &&
    !buyerDeletionFence(filter)
  ) {
    throw new EntitlementProjectionWriteBoundaryError(
      'Entitlement projection writes require a deletion fence',
    )
  }
}

export function commitUserEntitlementProjectionUpdateInSession(
  kind: UserEntitlementProjectionMutationKind,
  filter: UserUpdateFilter,
  update: UserUpdateDocument,
  session: ClientSession,
) {
  assertProjectionMutation(kind, filter, update, session)
  return User.updateOne(
    filter,
    update,
    { session, runValidators: true },
  )
}

export function findAndCommitUserEntitlementProjectionUpdateInSession(
  kind: UserEntitlementProjectionMutationKind,
  filter: UserUpdateFilter,
  update: UserUpdateDocument,
  session: ClientSession,
) {
  assertProjectionMutation(kind, filter, update, session)
  return User.findOneAndUpdate(
    filter,
    update,
    { session, runValidators: true, new: true },
  )
}
