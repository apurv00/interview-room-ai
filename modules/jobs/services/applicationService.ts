import { JobApplication, JobPosting } from '@shared/db/models'

/**
 * Application state transitions (PRODUCT_FLOW §2). `apply_clicked` is a
 * MACHINE FACT — recorded the instant the user opens an apply link, never
 * conflated with the user CLAIM `applied` (the return-sheet's job, Wave 4).
 * Everything downstream (save→apply metrics, the confirm nudges, ghost
 * inference) depends on that honesty.
 *
 * Status machine is loose but never regresses here: a click on a row
 * already at `applied`/`interview_scheduled`/... leaves the status alone —
 * clicking an apply link again is not evidence the pipeline moved backward.
 */

/**
 * Atomically claim the right to enqueue ONE ATS run (Codex on #521):
 * concurrent POSTs (double-click, retry) both passed the read-then-write
 * guard and enqueued two model calls. The marker is claimed with a
 * conditional update — only the request that actually flipped it enqueues.
 */
export async function claimAtsRun(
  userId: string,
  jobPostingId: string,
  now = new Date()
): Promise<{ claimed: boolean; claimedAt: Date }> {
  const staleBefore = new Date(now.getTime() - 3 * 60_000)
  const res = await JobApplication.updateOne(
    {
      userId,
      jobPostingId,
      $or: [{ atsRequestedAt: { $exists: false } }, { atsRequestedAt: { $lt: staleBefore } }],
    },
    { $set: { atsRequestedAt: now } }
  )
  // claimedAt travels through the event: a superseded slow run may only
  // clear the marker IT set — never a newer run's (Codex on #521).
  return { claimed: (res?.modifiedCount ?? 0) === 1, claimedAt: now }
}

/** Rollback for a claim whose enqueue failed — the next click must work. */
export async function releaseAtsClaim(userId: string, jobPostingId: string): Promise<void> {
  await JobApplication.updateOne({ userId, jobPostingId }, { $unset: { atsRequestedAt: 1 } }).catch(() => {})
}

export interface ApplyClickResult {
  status: string
  created: boolean
  transitioned: boolean
}

export async function recordApplyClick(
  userId: string,
  jobPostingId: string,
  click: { tier?: string; url?: string },
  now = new Date()
): Promise<ApplyClickResult | null> {
  const posting = await JobPosting.findById(jobPostingId).select('title company locations provenance status').lean()
  if (!posting) return null

  // Clicking Apply references the posting as hard as saving does — pin it
  // (and clear any racing TTL) so the tracker row never dangles (§4.3).
  await JobPosting.updateOne({ _id: jobPostingId }, { $set: { userReferenced: true }, $unset: { purgeAt: 1 } })

  const existing = await JobApplication.findOne({ userId, jobPostingId }).select('status').lean()
  if (existing) {
    if (existing.status !== 'saved') {
      return { status: existing.status, created: false, transitioned: false }
    }
    await JobApplication.updateOne(
      { userId, jobPostingId, status: 'saved' }, // status in the filter: never race-regress a concurrent forward move
      {
        $set: { status: 'apply_clicked', 'jobSnapshot.applyTierAtClick': click.tier, 'jobSnapshot.applyUrlAtClick': click.url },
        $push: { statusHistory: { status: 'apply_clicked', at: now, source: 'system' } },
      }
    )
    return { status: 'apply_clicked', created: false, transitioned: true }
  }

  try {
    await JobApplication.create({
      userId,
      jobPostingId,
      jobSnapshot: {
        title: posting.title,
        company: posting.company,
        location: (posting.locations ?? [])[0] ?? '',
        source: posting.provenance?.[0]?.sourceId ?? 'unknown',
        applyTierAtClick: click.tier,
        applyUrlAtClick: click.url,
      },
      status: 'apply_clicked',
      statusHistory: [{ status: 'apply_clicked', at: now, source: 'system' }],
    })
    return { status: 'apply_clicked', created: true, transitioned: true }
  } catch (err) {
    if ((err as { code?: number })?.code === 11000) {
      // Concurrent create won the unique index — report the surviving row.
      const winner = await JobApplication.findOne({ userId, jobPostingId }).select('status').lean()
      return { status: winner?.status ?? 'apply_clicked', created: false, transitioned: false }
    }
    throw err
  }
}
