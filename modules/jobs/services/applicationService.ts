import { gunzipSync } from 'zlib'
import { JobApplication, JobPosting, InterviewSession } from '@shared/db/models'
import { xrayHashOf } from './xrayService'

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

/**
 * Tailored-version persist (§2, Wave 4.5): latest-wins on the application
 * row — NEVER counted against the 3-resume cap (savedResumes is a doc-size
 * bound; the application absorbs per-job volume). Tailoring without a row
 * implicitly saves the job (strongest save signal); jdHash binds the
 * version to the JD it was tailored against.
 */
export async function saveTailoredVersion(
  userId: string,
  jobPostingId: string,
  payload: { tailoredText: string; sourceResumeId?: string; matchScore?: number; addedKeywords: string[]; missingKeywords: string[] },
  now = new Date()
): Promise<{ ok: boolean }> {
  const posting = await JobPosting.findById(jobPostingId).select('title company locations provenance status jdCompressed').lean()
  if (!posting) return { ok: false }
  let jdHash = ''
  try {
    const buf = posting.jdCompressed as Buffer | undefined
    const jd = buf?.length ? gunzipSync(Buffer.isBuffer(buf) ? buf : Buffer.from((buf as { buffer: ArrayBufferLike }).buffer as ArrayBuffer)).toString('utf8') : ''
    if (jd) jdHash = xrayHashOf(jd)
  } catch { /* no jd → empty hash */ }

  // '' would fail the schema's string validation on create (Mongoose treats
  // empty as missing) — paste/upload-sourced tailors simply have no source
  // resume (Codex P1 on #526).
  const tailoredVersion = { ...payload, sourceResumeId: payload.sourceResumeId || undefined, jdHash, createdAt: now }
  const res = await JobApplication.updateOne({ userId, jobPostingId }, { $set: { tailoredVersion } })
  if ((res?.matchedCount ?? 0) > 0) return { ok: true }

  // No row yet: implicit save (mirrors the save route's create + pin).
  await JobPosting.updateOne({ _id: jobPostingId }, { $set: { userReferenced: true }, $unset: { purgeAt: 1 } })
  try {
    await JobApplication.create({
      userId,
      jobPostingId,
      jobSnapshot: {
        title: posting.title,
        company: posting.company,
        location: (posting.locations ?? [])[0] ?? '',
        source: posting.provenance?.[0]?.sourceId ?? 'unknown',
      },
      status: 'saved',
      statusHistory: [{ status: 'saved', at: now, source: 'user' }],
      tailoredVersion,
    })
  } catch (err) {
    if ((err as { code?: number })?.code === 11000) {
      await JobApplication.updateOne({ userId, jobPostingId }, { $set: { tailoredVersion } })
    } else {
      throw err
    }
  }
  return { ok: true }
}

/** Statuses a USER may set (loose machine: forward jumps and backward
 *  corrections both allowed; ghosted/rejected recoverable). apply_clicked
 *  is the MACHINE fact and is never user-settable. */
export const USER_SETTABLE_STATUSES = ['saved', 'applied', 'interview_scheduled', 'offer', 'rejected', 'ghosted', 'withdrawn'] as const
export type UserSettableStatus = (typeof USER_SETTABLE_STATUSES)[number]

export async function transitionStatus(
  userId: string,
  jobPostingId: string,
  to: UserSettableStatus,
  now = new Date()
): Promise<{ ok: boolean; status?: string; from?: string }> {
  if (!(USER_SETTABLE_STATUSES as readonly string[]).includes(to)) return { ok: false }
  // findOneAndUpdate returns the PRE-update doc — the event vocabulary
  // promises jobs.status_changed{from,to,source}, and in a loose machine
  // `from` is what distinguishes a forward move from a correction
  // (Codex on #522).
  const prev = await JobApplication.findOneAndUpdate(
    { userId, jobPostingId },
    {
      $set: { status: to, ...(to === 'applied' ? { appliedAt: now } : {}) },
      $push: { statusHistory: { status: to, at: now, source: 'user' } },
    },
    { new: false }
  )
  return prev ? { ok: true, status: to, from: prev.status } : { ok: false }
}

/**
 * Broken-link report (§4b): recorded on the application AND counted on the
 * posting's provenance entry — one user's dead click demotes that rung for
 * everyone (heals, never hides; the ladder sort sinks rungs with reports).
 */
export async function reportBrokenLink(
  userId: string,
  jobPostingId: string,
  url: string,
  now = new Date()
): Promise<{ ok: boolean }> {
  // The demotion predicate is a RECORDED DEAD CLICK, not mere row existence
  // (Codex on #522 rounds 2+4): a saved-only row (no click ever) must not
  // unlock posting-level demotion — the application must carry the machine
  // fact (statusHistory contains apply_clicked) before its report counts.
  // URL equality is deliberately NOT required: the snapshot stores only the
  // FIRST click's URL, and reports against alternate rungs are legitimate.
  const app = await JobApplication.updateOne(
    { userId, jobPostingId, 'statusHistory.status': 'apply_clicked' },
    { $push: { brokenLinkReports: { url: url.slice(0, 2000), reportedAt: now } } }
  )
  if ((app?.matchedCount ?? 0) === 0) return { ok: false }
  // arrayFilters, not positional $: the merge appends provenance by
  // sourceKey, so ONE dead URL can sit in several rungs — the positional
  // operator updated only the first, leaving a clean twin ranked ahead of
  // the failover (Codex on #522 round-3).
  await JobPosting.updateOne(
    { _id: jobPostingId, 'provenance.applyUrl': url },
    { $inc: { 'provenance.$[elem].brokenReportCount': 1 } },
    { arrayFilters: [{ 'elem.applyUrl': url }] }
  )
  return { ok: true }
}

/**
 * Evidence push (Wave 4.3, PRODUCT_FLOW §1 Stage 4): a jobs-attributed
 * session that reached SCORED feedback lands in
 * JobApplication.practiceSessionIds — the tracker/detail evidence ticker
 * (n/3) reads that array. Idempotent ($addToSet — feedback retries and
 * cache reloads must not double-count). Called fire-and-forget from the
 * generate-feedback route's side-effect rail; never throws into it.
 * Sessions refused scoring (short-form guard) deliberately do NOT count —
 * the ticker sells readiness evidence, not attendance.
 */
export async function recordPracticeEvidence(
  userId: string,
  sessionId: string
): Promise<{ recorded: boolean; evidenceCount?: number }> {
  const session = await InterviewSession.findById(sessionId).select('attribution userId').lean()
  const attr = session?.attribution as { source?: string; jobId?: string; applicationId?: string } | undefined
  if (!session || String(session.userId) !== String(userId) || attr?.source !== 'jobs' || !attr.jobId) {
    return { recorded: false }
  }
  const filter = attr.applicationId
    ? { _id: attr.applicationId, userId } // userId guard: never attach to another user's row
    : { userId, jobPostingId: attr.jobId }
  const app = await JobApplication.findOneAndUpdate(
    filter,
    { $addToSet: { practiceSessionIds: session._id } },
    { new: true }
  )
    .select('practiceSessionIds')
    .lean()
  if (!app) return { recorded: false } // practiced without saving and no click row — nothing to attach to
  return { recorded: true, evidenceCount: Math.min(3, app.practiceSessionIds?.length ?? 0) }
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
