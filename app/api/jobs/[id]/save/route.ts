import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@shared/auth/authOptions'
import { connectDB } from '@shared/db/connection'
import mongoose from 'mongoose'
import { JobApplication, JobPosting, ProductEvent } from '@shared/db/models'
import { logger } from '@shared/logger'

export const dynamic = 'force-dynamic'

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
  if (!mongoose.Types.ObjectId.isValid(params.id)) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }
  await connectDB()
  const existing = await JobApplication.findOne({ userId, jobPostingId: params.id }).select('status').lean()
  if (existing) {
    // Ownership, not discovery state, authorizes this idempotent path. A
    // posting may have closed after the user saved/applied; keep its durable
    // tracker context pinned without creating a new closed-posting owner.
    const pin = await JobPosting.updateOne(
      { _id: params.id },
      { $set: { userReferenced: true }, $unset: { purgeAt: 1 } },
    )
    if ((pin?.matchedCount ?? 0) !== 1) {
      return NextResponse.json({ error: 'not found' }, { status: 404 })
    }
    return NextResponse.json({ ok: true, status: existing.status, alreadySaved: true })
  }

  const posting = await JobPosting.findById(params.id).select('title company locations provenance status').lean()
  if (!posting || posting.status !== 'open') return NextResponse.json({ error: 'not found' }, { status: 404 })

  const now = new Date()
  // Retention pin (PRODUCT_FLOW §2: creation sets ingestion's userReferenced
  // pin — the tracker needs a stable posting _id forever). $unset purgeAt in
  // the same write: the delisting sweep can close+stamp between our open-
  // check read and this write, and a pinned row must never carry a TTL
  // (Codex on #517). Runs on the already-saved path too — self-healing.
  const pin = await JobPosting.updateOne(
    { _id: params.id, status: 'open' },
    { $set: { userReferenced: true }, $unset: { purgeAt: 1 } },
  )
  if ((pin?.matchedCount ?? 0) !== 1) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }
  try {
    await JobApplication.create({
      userId,
      jobPostingId: params.id,
      jobSnapshot: {
        title: posting.title,
        company: posting.company,
        location: (posting.locations ?? [])[0] ?? '',
        source: posting.provenance?.[0]?.sourceId ?? 'unknown',
      },
      status: 'saved',
      statusHistory: [{ status: 'saved', at: now, source: 'user' }],
    })
  } catch (err) {
    // Unique-index race with a concurrent save = already saved; anything else surfaces.
    if ((err as { code?: number })?.code !== 11000) throw err
  }
  try {
    await ProductEvent.create({ name: 'jobs.job_saved', userId, jobPostingId: params.id, props: {}, ts: now })
  } catch (err) {
    logger.warn({ err }, 'jobs.job_saved telemetry write failed') // telemetry never breaks the flow
  }
  return NextResponse.json({ ok: true, status: 'saved', alreadySaved: false })
}
