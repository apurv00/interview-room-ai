import { ProductEvent } from '@shared/db/models'
import {
  JobsAccountInactiveError,
  withActiveJobsAccountWrite,
} from '@shared/services/jobsAccountFence'

export interface JobsUserEventInput {
  name: string
  userId: string
  anonId?: string
  jobPostingId?: string
  applicationId?: string
  sessionId?: string
  props?: Record<string, unknown>
  ts: Date
}

/**
 * Persist user-attributed telemetry only while the account can acquire the
 * same transaction fence used by account deletion. Telemetry callers remain
 * best-effort: `false` means the account was deleted/deleting and no event
 * was written.
 */
export async function recordJobsUserEvent(input: JobsUserEventInput): Promise<boolean> {
  try {
    await withActiveJobsAccountWrite(input.userId, async (session) => {
      await ProductEvent.create([input], { session })
    })
    return true
  } catch (error) {
    if (error instanceof JobsAccountInactiveError) return false
    throw error
  }
}
