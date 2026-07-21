import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@shared/auth/authOptions'
import { connectDB } from '@shared/db/connection'
import mongoose, { type ClientSession } from 'mongoose'
import { JobApplication, JobPosting } from '@shared/db/models'
import { logger } from '@shared/logger'
import { checkJobsRateLimit } from '@jobs/services/rateLimit'
import {
  exactOptionalPostingCondition,
  jobPostingStateOf,
} from '@jobs/services/postingAccess'
import {
  JobsAccountInactiveError,
  withActiveJobsAccountWrite,
} from '@shared/services/jobsAccountFence'
import { recordJobsUserEvent } from '@jobs/services/userEventService'

export const dynamic = 'force-dynamic'

interface SavePostingSnapshot {
  title?: string
  company?: string
  locations?: string[]
  provenance?: unknown[]
  status?: unknown
  closedReason?: unknown
}

type SaveTransactionResult =
  | { ok: false }
  | { ok: true; status: string; alreadySaved: boolean; insertedAt?: Date }

class SaveAuthorityRaceError extends Error {}

function isDuplicateKeyError(error: unknown): boolean {
  return (error as { code?: number })?.code === 11000
}

/** Bind the pin to the exact legal/source snapshot read in this transaction. */
function exactSavePostingAuthorityFilter(
  jobPostingId: string,
  posting: SavePostingSnapshot,
): Record<string, unknown> {
  return {
    _id: jobPostingId,
    status: posting.status,
    closedReason: exactOptionalPostingCondition(posting.closedReason),
    provenance: exactOptionalPostingCondition(posting.provenance),
  }
}

async function runSaveTransaction<T>(
  userId: string,
  work: (session: ClientSession) => Promise<T>,
): Promise<T> {
  return withActiveJobsAccountWrite(userId, work)
}

async function savePostingAttempt(
  userId: string,
  jobPostingId: string,
  now: Date,
): Promise<SaveTransactionResult> {
  return runSaveTransaction(userId, async (session) => {
    const posting = await JobPosting.findById(jobPostingId, undefined, { session })
      .select('title company locations provenance status closedReason')
      .lean()
    if (!posting || jobPostingStateOf(posting) === 'restricted') return { ok: false }

    const existing = await JobApplication.findOne(
      { userId, jobPostingId },
      undefined,
      { session },
    ).select('status').lean()
    // A normal retained archive is durable only for an existing owner. A
    // closed id alone must never manufacture a tracker row.
    if (!existing && jobPostingStateOf(posting) !== 'live') return { ok: false }

    const pin = await JobPosting.updateOne(
      exactSavePostingAuthorityFilter(jobPostingId, posting),
      {
        $set: { userReferenced: true },
        $unset: { purgeAt: 1 },
        $inc: { derivedAuthorityRevision: 1 },
      },
      { session, timestamps: false },
    )
    if ((pin?.matchedCount ?? 0) !== 1) {
      // Re-read once outside this aborted snapshot. A benign provenance
      // refresh can still save; a close/revoke observes the new authority.
      throw new SaveAuthorityRaceError('posting authority changed')
    }

    if (existing) {
      return { ok: true, status: existing.status, alreadySaved: true }
    }

    await JobApplication.create([{
      userId,
      jobPostingId,
      jobSnapshot: {
        title: posting.title,
        company: posting.company,
        location: (posting.locations ?? [])[0] ?? '',
        source: (posting.provenance?.[0] as { sourceId?: string } | undefined)?.sourceId ?? 'unknown',
      },
      status: 'saved',
      statusHistory: [{ status: 'saved', at: now, source: 'user' }],
    }], { session })

    return { ok: true, status: 'saved', alreadySaved: false, insertedAt: now }
  })
}

async function savePosting(
  userId: string,
  jobPostingId: string,
  now: Date,
): Promise<SaveTransactionResult> {
  try {
    return await savePostingAttempt(userId, jobPostingId, now)
  } catch (error) {
    if (!isDuplicateKeyError(error) && !(error instanceof SaveAuthorityRaceError)) throw error
    try {
      return await savePostingAttempt(userId, jobPostingId, now)
    } catch (retryError) {
      if (retryError instanceof SaveAuthorityRaceError) return { ok: false }
      throw retryError
    }
  }
}

/**
 * POST /api/jobs/[id]/save — authed Save (PRODUCT_FLOW §2). Creates the
 * JobApplication row at `saved` (idempotent on the {userId, jobPostingId}
 * unique index — a re-save returns the existing row untouched: saving must
 * never regress a later status). Creation pins the posting as
 * user-referenced for the ingestion GC. Telemetry is server-side here
 * (`jobs.job_saved`), never client keepalive for an authed surface.
 */
export async function POST(_req: Request, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions)
  const userId = (session?.user as { id?: string } | undefined)?.id
  if (!userId) return NextResponse.json({ error: 'sign in to save jobs' }, { status: 401 })
  const rateLimitBlock = await checkJobsRateLimit(userId)
  if (rateLimitBlock) return rateLimitBlock
  if (!mongoose.Types.ObjectId.isValid(params.id)) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }
  await connectDB()
  const now = new Date()
  let result: SaveTransactionResult
  try {
    result = await savePosting(userId, params.id, now)
  } catch (error) {
    if (error instanceof JobsAccountInactiveError) {
      return NextResponse.json(
        { error: 'account unavailable', code: 'ACCOUNT_UNAVAILABLE' },
        { status: 401 },
      )
    }
    throw error
  }
  if (!result.ok) return NextResponse.json({ error: 'not found' }, { status: 404 })

  // Only the transaction that inserted the ownership edge emits Save. An
  // idempotent existing row or duplicate-key loser never double-counts it.
  if (!result.alreadySaved) {
    try {
      await recordJobsUserEvent({ name: 'jobs.job_saved', userId, jobPostingId: params.id, props: {}, ts: result.insertedAt ?? now })
    } catch (err) {
      logger.warn({ err }, 'jobs.job_saved telemetry write failed') // telemetry never breaks the flow
    }
  }
  return NextResponse.json({
    ok: true,
    status: result.status,
    alreadySaved: result.alreadySaved,
  })
}
