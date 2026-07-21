import { JobPosting } from '@shared/db/models'
import {
  isJobsAccountActive,
  JobsAccountInactiveError,
} from '@shared/services/jobsAccountFence'
import {
  resolveApplyOption,
  type ApplyOptionSource,
} from './applyOptionIdentity'

/**
 * Resolve an opaque apply option at the last server-controlled boundary.
 *
 * The browser-projected URL is never treated as authority: every navigation
 * re-reads the live posting and binds the opaque option id to its current,
 * safe canonical provenance. The second account read prevents a deletion
 * that completes during posting resolution from releasing private navigation.
 */
export async function resolveLiveApplyRedirect(
  userId: string,
  postingId: string,
  optionId: string,
): Promise<string | null> {
  if (!(await isJobsAccountActive(userId))) {
    throw new JobsAccountInactiveError(userId)
  }

  const posting = await JobPosting.findOne({
    _id: postingId,
    status: 'open',
  })
    .read('primary')
    .select({ provenance: 1 })
    .lean<{ provenance?: ApplyOptionSource[] }>()

  const option = resolveApplyOption(posting?.provenance, optionId)

  if (!(await isJobsAccountActive(userId))) {
    throw new JobsAccountInactiveError(userId)
  }

  return option?.url ?? null
}
