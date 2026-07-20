import type { IJobPosting } from '@shared/db/models'

export type JobPostingState = 'live' | 'archived' | 'restricted'

export const NORMAL_ARCHIVE_CLOSED_REASONS = [
  'board-poll-miss',
  'valid-through-expired',
  'aged-out',
  'dead-apply-link',
] as const

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
