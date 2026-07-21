import mongoose, { type ClientSession } from 'mongoose'
import { User } from '@shared/db/models'

const ACTIVE_ACCOUNT_STATES = {
  $or: [
    { accountState: 'active' },
    { accountState: { $exists: false } },
  ],
}

export const JOBS_ACTIVE_ACCOUNT_STATES_FILTER = ACTIVE_ACCOUNT_STATES

const TRANSACTION_OPTIONS = {
  readConcern: { level: 'snapshot' as const },
  writeConcern: { w: 'majority' as const },
  readPreference: 'primary' as const,
}

export class JobsAccountInactiveError extends Error {
  constructor(public readonly userId: string) {
    super('account is missing or being deleted')
    this.name = 'JobsAccountInactiveError'
  }
}

export class JobsAccountTransactionsRequiredError extends Error {
  constructor() {
    super('Jobs account writes require MongoDB replica-set transactions')
    this.name = 'JobsAccountTransactionsRequiredError'
  }
}

function transactionUnsupported(error: unknown): boolean {
  const candidate = error as { code?: number; codeName?: string; message?: string }
  return candidate?.code === 20 ||
    candidate?.codeName === 'IllegalOperation' ||
    /transaction numbers are only allowed/i.test(candidate?.message ?? '')
}

/**
 * Predicate shared by cheap route/provider guards. It is intentionally not
 * the write authority: only withActiveJobsAccountWrite serializes a write
 * against account deletion.
 *
 * `accountState` is absent on legacy and MongoDBAdapter-created users, so a
 * missing field means active. Deletion always writes the explicit `deleting`
 * state before it removes any user-owned row.
 */
export function activeJobsAccountFilter(userId: string): Record<string, unknown> {
  return { _id: userId, ...ACTIVE_ACCOUNT_STATES }
}

export async function isJobsAccountActive(userId: string): Promise<boolean> {
  if (!mongoose.Types.ObjectId.isValid(userId)) return false
  return !!(await User.exists(activeJobsAccountFilter(userId)))
}

/** Resolve several lifecycle predicates in one Mongo snapshot/read. */
export async function activeJobsAccountIds(userIds: string[]): Promise<Set<string>> {
  const validIds = Array.from(new Set(userIds.filter((id) => mongoose.Types.ObjectId.isValid(id))))
  if (validIds.length === 0) return new Set()
  const ids = await User.distinct('_id', {
    _id: { $in: validIds },
    ...ACTIVE_ACCOUNT_STATES,
  })
  return new Set(ids.map((id) => id.toString()))
}

/**
 * Durable A04 write fence.
 *
 * Every user-owned Jobs creator mutates `User.jobsWriteRevision` in the same
 * Mongo transaction as its data write. Account deletion first changes the
 * same User document to `deleting` and increments the same revision. Mongo's
 * document write conflict therefore orders the operations:
 *
 * - writer commits first -> the later deletion sweep removes its data;
 * - deletion commits first -> this active predicate misses and the writer
 *   aborts without a posting pin, application, event, evidence, or ledger.
 */
export async function withActiveJobsAccountWrite<T>(
  userId: string,
  work: (session: ClientSession) => Promise<T> | T,
): Promise<T> {
  if (!mongoose.Types.ObjectId.isValid(userId)) {
    throw new JobsAccountInactiveError(userId)
  }

  const session = await User.db.startSession()
  let result: T | undefined
  let completed = false
  try {
    await session.withTransaction(async () => {
      const fence = await User.updateOne(
        activeJobsAccountFilter(userId),
        { $inc: { jobsWriteRevision: 1 } },
        { session, timestamps: false },
      )
      if ((fence.matchedCount ?? 0) !== 1) {
        throw new JobsAccountInactiveError(userId)
      }
      result = await work(session)
      completed = true
    }, TRANSACTION_OPTIONS)
  } catch (error) {
    if (transactionUnsupported(error)) {
      throw new JobsAccountTransactionsRequiredError()
    }
    throw error
  } finally {
    await session.endSession()
  }

  if (!completed) throw new Error('Jobs account transaction completed without a result')
  return result as T
}
