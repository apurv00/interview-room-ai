import { inngest } from '@shared/services/inngest'
import { connectDB } from '@shared/db/connection'
import { JobPosting, JobIngestCycle } from '@shared/db/models'
import { logger } from '@shared/logger'
import { checkApplyLink, nextApplyCheckState, MIN_RESTRIKE_MS, type LinkOutcome, type ResolveImpl } from '../services/linkCheckService'
import { isBlockedApplyUrl } from '../services/qualityGate'

/**
 * Hourly apply-link liveness sweep (founder directive 2026-07-16, ruling
 * #22): machine-checks apply URLs so dead-link spam dies without a human,
 * on ANY host — the scalable layer above the observed-abuse blocklist.
 *
 * Pick order per run (cap 150):
 *  1. crowd-reported rungs (brokenReportCount ≥ 1) not checked in 24h —
 *     user reports become machine-verified closures instead of waiting
 *     on the 35-day ghost;
 *  2. dead rows whose restrike window (20h) has elapsed — the strike-1
 *     row MUST come back for its second strike or nothing ever closes
 *     (Codex #543 P1);
 *  3. never-checked open rows, oldest first;
 *  4. alive rows stale by 14+ days.
 * Posting-level outcome: dead ONLY if EVERY (non-blocklisted, checkable)
 * apply URL is dead — one alive rung keeps the posting alive. Closing
 * requires TWO dead sweeps ≥20h apart (linkCheckService policy).
 */

interface StepRunner {
  run: <T>(name: string, fn: () => Promise<T> | T) => Promise<T>
}

const RUN_CAP = 150
// Chunk math vs the route's maxDuration=300 (Codex #543 round 2): worst
// case per URL = 12s timeout + 0.4s pacing; per posting ≤ MAX_URLS × 12.4s
// ≈ 37s; per chunk ≤ 5 × 37s ≈ 186s — checkpointed well inside the
// envelope even when every host times out.
const CHUNK = 5
const MAX_URLS_PER_POSTING = 3
const RECHECK_ALIVE_MS = 14 * 24 * 3600 * 1000
const RECHECK_REPORTED_MS = 24 * 3600 * 1000
const PACING_MS = 400

const PICK_PROJECTION = '_id provenance applyCheck'

export async function pickPostingsToCheck(now: Date): Promise<Array<{ _id: unknown; provenance?: Array<{ applyUrl?: string; brokenReportCount?: number }>; applyCheck?: Record<string, unknown> }>> {
  const reported = await JobPosting.find({
    status: 'open',
    'provenance.brokenReportCount': { $gte: 1 },
    $or: [{ 'applyCheck.lastCheckedAt': { $exists: false } }, { 'applyCheck.lastCheckedAt': { $lt: new Date(now.getTime() - RECHECK_REPORTED_MS) } }],
  })
    .select(PICK_PROJECTION)
    .sort({ updatedAt: 1 })
    .limit(RUN_CAP)
    .lean()
  // Strike-1 rows come back the moment their restrike window elapses —
  // without this bucket the picker never revisits 'dead' rows and no
  // posting can ever reach its second strike (Codex #543 P1).
  const remaining0 = RUN_CAP - reported.length
  const restrikes = remaining0 > 0
    ? await JobPosting.find({
        status: 'open',
        'applyCheck.status': 'dead',
        'applyCheck.lastDeadAt': { $lt: new Date(now.getTime() - MIN_RESTRIKE_MS) },
      })
        .select(PICK_PROJECTION)
        .sort({ 'applyCheck.lastDeadAt': 1 })
        .limit(remaining0)
        .lean()
    : []
  const remaining1 = RUN_CAP - reported.length - restrikes.length
  const unchecked = remaining1 > 0
    ? await JobPosting.find({ status: 'open', applyCheck: { $exists: false } })
        .select(PICK_PROJECTION)
        .sort({ createdAt: 1 })
        .limit(remaining1)
        .lean()
    : []
  const remaining2 = RUN_CAP - reported.length - restrikes.length - unchecked.length
  const stale = remaining2 > 0
    ? await JobPosting.find({
        status: 'open',
        'applyCheck.status': 'alive',
        'applyCheck.lastCheckedAt': { $lt: new Date(now.getTime() - RECHECK_ALIVE_MS) },
      })
        .select(PICK_PROJECTION)
        .sort({ 'applyCheck.lastCheckedAt': 1 })
        .limit(remaining2)
        .lean()
    : []
  const seen = new Set<string>()
  return [...reported, ...restrikes, ...unchecked, ...stale].filter((d) => {
    const id = String(d._id)
    if (seen.has(id)) return false
    seen.add(id)
    return true
  }) as never
}

/** Posting-level outcome from per-URL outcomes: one alive rung = alive;
 *  all checkable rungs dead = dead; otherwise unverifiable. Blocklisted
 *  URLs are skipped — they are never served as apply paths anyway. */
export function postingOutcome(outcomes: LinkOutcome[]): LinkOutcome {
  if (outcomes.length === 0) return 'unverifiable'
  if (outcomes.some((o) => o === 'alive')) return 'alive'
  if (outcomes.every((o) => o === 'dead')) return 'dead'
  return 'unverifiable'
}

export async function runLinkCheckHandler(
  step: StepRunner,
  fetchImpl: typeof fetch = fetch,
  now = new Date(),
  resolveImpl?: ResolveImpl
): Promise<{ checked: number; closed: number }> {
  await connectDB()
  const picked = await step.run('pick', () => pickPostingsToCheck(now))
  const counters = { checked: 0, dead: 0, alive: 0, unverifiable: 0, closedNow: 0 }

  for (let i = 0; i < picked.length; i += CHUNK) {
    const chunk = picked.slice(i, i + CHUNK)
    await step.run(`check-${i / CHUNK}`, async () => {
      for (const doc of chunk) {
        const allUrls = Array.from(
          new Set(
            (doc.provenance ?? [])
              .map((p) => p.applyUrl)
              .filter((u): u is string => !!u && !isBlockedApplyUrl(u))
          )
        )
        const urls = allUrls.slice(0, MAX_URLS_PER_POSTING)
        const outcomes: LinkOutcome[] = []
        for (const u of urls) {
          outcomes.push(await checkApplyLink(u, fetchImpl, resolveImpl))
          await new Promise((r) => setTimeout(r, PACING_MS))
        }
        // Truncation honesty: 'dead' may only be judged when EVERY url was
        // actually checked — an unchecked rung could be the live one.
        let outcome = postingOutcome(outcomes)
        if (outcome === 'dead' && allUrls.length > urls.length) outcome = 'unverifiable'
        counters.checked += 1
        counters[outcome] += 1
        const { state, shouldClose } = nextApplyCheckState(doc.applyCheck as never, outcome, new Date())
        const update: Record<string, unknown> = { $set: { applyCheck: state } }
        if (shouldClose) {
          ;(update.$set as Record<string, unknown>).status = 'closed'
          ;(update.$set as Record<string, unknown>).closedReason = 'dead-apply-link'
          ;(update.$set as Record<string, unknown>).closedAt = new Date()
          counters.closedNow += 1
        }
        // Status-guarded: a posting closed by another sweep mid-run keeps
        // its original closedReason.
        await JobPosting.updateOne({ _id: doc._id as never, ...(shouldClose ? { status: 'open' } : {}) }, update)
      }
      return chunk.length
    })
  }

  await step.run('telemetry', async () => {
    await JobIngestCycle.create({
      kind: 'link-check',
      sourceId: 'link-check',
      startedAt: now,
      finishedAt: new Date(),
      linkCheck: {
        checked: counters.checked,
        dead: counters.dead,
        alive: counters.alive,
        unverifiable: counters.unverifiable,
        closedNow: counters.closedNow,
      },
    })
  })
  logger.info({ ...counters }, 'link-check sweep complete')
  return { checked: counters.checked, closed: counters.closedNow }
}

export const jobsLinkCheckJob = inngest.createFunction(
  // :40 offsets the hourly ingest scheduler (:15) and verdict sweeper (:45).
  { id: 'jobs-link-check', name: 'Jobs: apply-link liveness sweep', retries: 1, triggers: [{ cron: '40 * * * *' }] },
  async ({ step }) => runLinkCheckHandler(step as StepRunner)
)
