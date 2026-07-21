import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@shared/auth/authOptions'
import { connectDB } from '@shared/db/connection'
import mongoose, { type ClientSession } from 'mongoose'
import { JobApplication, JobPosting, ProductEvent } from '@shared/db/models'
import { logger } from '@shared/logger'
import { checkJobsRateLimit } from '@jobs/services/rateLimit'
import { jobPostingStateOf } from '@jobs/services/postingAccess'

export const dynamic = 'force-dynamic'

const SAVE_TRANSACTION_OPTIONS = {
  readConcern: { level: 'snapshot' as const },
  writeConcern: { w: 'majority' as const },
}

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
    closedReason: posting.closedReason === undefined
      ? { $exists: false }
      : posting.closedReason,
    provenance: posting.provenance === undefined
      ? { $exists: false }
      : posting.provenance,
  }
}

async function runSaveTransaction<T>(
  work: (session: ClientSession) => Promise<T>,
): Promise<T> {
  const session = await JobApplication.db.startSession()
  let result: T | undefined
  let completed = false
  try {
    await session.withTransaction(async () => {
      result = await work(session)
      completed = true
    }, SAVE_TRANSACTION_OPTIONS)
  } finally {
    await session.endSession()
  }
  if (!completed) throw new Error('save transaction completed without a result')
  return result as T
}

async function savePostingAttempt(
  userId: string,
  jobPostingId: string,
  now: Date,
): Promise<SaveTransactionResult> {
  return runSaveTransaction(async (session) => {
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
      { $set: { userReferenced: true }, $unset: { purgeAt: 1 } },
      { session },
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
  const result = await savePosting(userId, params.id, now)
  if (!result.ok) return NextResponse.json({ error: 'not found' }, { status: 404 })

  // Only the transaction that inserted the ownership edge emits Save. An
  // idempotent existing row or duplicate-key loser never double-counts it.
  if (!result.alreadySaved) {
    try {
      await ProductEvent.create({ name: 'jobs.job_saved', userId, jobPostingId: params.id, props: {}, ts: result.insertedAt ?? now })
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
