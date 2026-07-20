import { inngest } from '@shared/services/inngest'
import { connectDB } from '@shared/db/connection'
import { JobPosting, JobIngestCycle } from '@shared/db/models'
import { logger } from '@shared/logger'
import { checkApplyLink, nextApplyCheckState, isCheckableUrl, MIN_RESTRIKE_MS, type LinkOutcome, type ResolveImpl } from '../services/linkCheckService'
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
// Chunk math vs the route's maxDuration=300 (Codex #543 rounds 2/5/6):
// worst case per URL = 4s DNS preflight + 12s fetch timeout + 0.4s pacing
// ≈ 16.4s. Chunks are packed by URL COUNT (≤15 URL-slots ≈ 246s worst),
// NOT by posting count — so a posting with many apply URLs gets EVERY url
// checked in one step (round 6: always slicing the same first three made
// 4-URL spam permanently uncloseable) while the envelope still holds.
const URL_SLOTS_PER_STEP = 15
const RECHECK_ALIVE_MS = 14 * 24 * 3600 * 1000
const RECHECK_REPORTED_MS = 24 * 3600 * 1000
/** Transient outcomes (timeouts, bot-blocks) re-enter the pool after 48h —
 *  a single flaky response must not permanently exempt a posting from
 *  liveness validation (Codex #543 round 3). Slower than the restrike lane
 *  so bot-blocking ATS hosts are not hammered hourly. */
const RECHECK_UNVERIFIABLE_MS = 48 * 3600 * 1000
const PACING_MS = 400

const PICK_PROJECTION = '_id provenance applyCheck userReferenced'

export async function pickPostingsToCheck(now: Date): Promise<Array<{ _id: unknown; provenance?: Array<{ applyUrl?: string; brokenReportCount?: number }>; applyCheck?: Record<string, unknown>; userReferenced?: boolean }>> {
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
  // Transient results re-enter the pool — a lone timeout must not exempt a
  // row from validation forever (Codex #543 round 3).
  const staleUnverifiable = remaining2 > 0
    ? await JobPosting.find({
        status: 'open',
        'applyCheck.status': 'unverifiable',
        'applyCheck.lastCheckedAt': { $lt: new Date(now.getTime() - RECHECK_UNVERIFIABLE_MS) },
      })
        .select(PICK_PROJECTION)
        .sort({ 'applyCheck.lastCheckedAt': 1 })
        .limit(remaining2)
        .lean()
    : []
  const remaining3 = remaining2 - staleUnverifiable.length
  const stale = remaining3 > 0
    ? await JobPosting.find({
        status: 'open',
        'applyCheck.status': 'alive',
        'applyCheck.lastCheckedAt': { $lt: new Date(now.getTime() - RECHECK_ALIVE_MS) },
      })
        .select(PICK_PROJECTION)
        .sort({ 'applyCheck.lastCheckedAt': 1 })
        .limit(remaining3)
        .lean()
    : []
  const seen = new Set<string>()
  return [...reported, ...restrikes, ...unchecked, ...staleUnverifiable, ...stale].filter((d) => {
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

  // Checkable = non-blocklisted AND passes the URL-shape guard — a stored
  // non-http/malformed string (ingested but never served by feedService's
  // safe-http filter) must not poison an otherwise all-dead outcome
  // (Codex #543 round 3).
  const urlsOf = (doc: (typeof picked)[number]) =>
    Array.from(
      new Set(
        (doc.provenance ?? [])
          .map((p) => p.applyUrl)
          .filter((u): u is string => !!u && !isBlockedApplyUrl(u) && isCheckableUrl(u))
      )
    )
  // Pack chunks by URL-slot budget so EVERY url of a posting is checked in
  // one step (round 6) while the timeout envelope holds.
  const chunks: Array<Array<(typeof picked)[number]>> = []
  let current: Array<(typeof picked)[number]> = []
  let slots = 0
  for (const doc of picked) {
    const n = Math.max(1, urlsOf(doc).length)
    if (current.length > 0 && slots + n > URL_SLOTS_PER_STEP) {
      chunks.push(current)
      current = []
      slots = 0
    }
    current.push(doc)
    slots += n
  }
  if (current.length) chunks.push(current)

  for (let ci = 0; ci < chunks.length; ci++) {
    const chunk = chunks[ci]
    await step.run(`check-${ci}`, async () => {
      for (const doc of chunk) {
        const urls = urlsOf(doc)
        const outcomes: LinkOutcome[] = []
        for (const u of urls) {
          outcomes.push(await checkApplyLink(u, fetchImpl, resolveImpl))
          await new Promise((r) => setTimeout(r, PACING_MS))
        }
        const outcome = postingOutcome(outcomes)
        counters.checked += 1
        counters[outcome] += 1
        const prev = doc.applyCheck as { lastCheckedAt?: Date } | undefined
        const { state, shouldClose } = nextApplyCheckState(prev as never, outcome, new Date())
        const update: Record<string, unknown> = { $set: { applyCheck: state } }
        let closedAt: Date | null = null
        if (shouldClose) {
          closedAt = new Date()
          ;(update.$set as Record<string, unknown>).status = 'closed'
          ;(update.$set as Record<string, unknown>).closedReason = 'dead-apply-link'
          ;(update.$set as Record<string, unknown>).closedAt = closedAt
          // Close without a TTL first. Purge eligibility is stamped only by
          // a second update that observes the current retention pin.
          update.$unset = { purgeAt: 1 }
        }
        // Optimistic token (Codex #543 round 6): if ingestion replaced the
        // apply URL (and cleared applyCheck) between our pick and this
        // write, the evidence below was computed against the OLD link —
        // the filter must miss and the next sweep re-verifies fresh.
        // Status guard keeps a row closed by another path closed.
        const token = prev?.lastCheckedAt
          ? { 'applyCheck.lastCheckedAt': prev.lastCheckedAt }
          : { applyCheck: { $exists: false } }
        const write = await JobPosting.updateOne(
          { _id: doc._id as never, ...token, ...(shouldClose ? { status: 'open' } : {}) } as never,
          update
        )
        if (closedAt && (write?.matchedCount ?? 0) > 0) {
          // Resolve TTL eligibility from the CURRENT retention pin. A
          // concurrent first Save/Apply/Tailor either makes the true branch
          // clear a stale purgeAt or runs after this and clears it itself.
          const closeFilter = {
            _id: doc._id as never,
            status: 'closed',
            closedReason: 'dead-apply-link',
            closedAt,
          }
          await JobPosting.updateOne(
            { ...closeFilter, userReferenced: true } as never,
            { $unset: { purgeAt: 1 } },
          )
          await JobPosting.updateOne(
            { ...closeFilter, userReferenced: { $ne: true } } as never,
            { $set: { purgeAt: new Date(Date.now() + 7 * 24 * 3600 * 1000) } },
          )
          counters.closedNow += 1
        }
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
