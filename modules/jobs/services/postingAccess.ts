import type { IJobPosting } from '@shared/db/models'

export type JobPostingState = 'live' | 'archived' | 'restricted'

export const NORMAL_ARCHIVE_CLOSED_REASONS = [
  'board-poll-miss',
  'valid-through-expired',
  'aged-out',
  'dead-apply-link',
] as const

/**
 * Match an optional posting field exactly in a Mongo authority guard.
 * Mongo's plain `null` equality also matches a missing field, so an explicit
 * null needs an existence predicate to remain a true compare-and-swap token.
 */
type ExactOptionalPostingCondition<T> =
  | Exclude<T, null | undefined>
  | { $exists: false }
  | { $eq: null; $exists: true }

export function exactOptionalPostingCondition<T>(
  value: T,
): ExactOptionalPostingCondition<T> {
  if (value === undefined) return { $exists: false }
  if (value === null) return { $eq: null, $exists: true }
  return value as Exclude<T, null | undefined>
}

/**
 * Server-authoritative lifecycle policy for retained postings.
 *
 * Normal expiry/delisting keeps the candidate's owned preparation context.
 * Safety/legal closures fail closed: tracker history may remain, but the JD
 * and new JD-derived actions must not be served. Unknown legacy reasons are
 * restricted because the server cannot prove why the posting was removed.
 */
export function jobPostingStateOf(
  posting: Pick<IJobPosting, 'status' | 'closedReason'>,
): JobPostingState {
  if (posting.status === 'open') return 'live'
  if (NORMAL_ARCHIVE_CLOSED_REASONS.some((reason) => reason === posting.closedReason)) return 'archived'
  return 'restricted'
}
