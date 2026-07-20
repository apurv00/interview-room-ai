import { inngest } from '@shared/services/inngest'
import { connectDB } from '@shared/db/connection'
import { JobPosting, JobSourceConfig, JobIngestCursor, JobIngestCycle, JobsVerdictConfig, JobApplication } from '@shared/db/models'
import { redis } from '@shared/redis'
import { logger } from '@shared/logger'
import { jsearchAdapter } from '../adapters/jsearchAdapter'
import { apnaAdapter } from '../adapters/apnaAdapter'
import { unstopAdapter } from '../adapters/unstopAdapter'
import { atsBoardAdapter } from '../adapters/atsBoardAdapter'
import { BOARD_REGISTRY } from '../config/boardRegistry'
import type { FetchTarget, JobSourceAdapter, NormalizedJob } from '../adapters/types'
import { ingestBatch, makeRedisRepostCounter, type IngestCounters } from '../services/ingestPipeline'

/**
 * Ingestion background jobs (INGESTION §4.4; pathwayJob/analysisJob shape:
 * pure handlers split from Inngest wrappers, ids-only events, step.run
 * checkpoints sized to the Vercel Hobby 60s budget).
 *
 * jobsIngestSchedulerJob (cron :15) — flag-gated dispatcher: finds enabled
 * sources whose cadence is due and emits one `jobs/source.sync` event each.
 * Auto-seeds a DISABLED jsearch JobSourceConfig row on first run so ops is
 * one flip away, never surprised by silent ingestion.
 *
 * jobsSourceSyncJob (event, concurrency limit 2 — the Atlas shared-tier
 * rule; NOTE: first use of Inngest `concurrency` in this repo) — one
 * bucket per step.run: the worst case (4 full pages × 15s adapter
 * timeout + spacing) is ~61s, well inside the real per-step budget
 * (maxDuration=300s at app/api/inngest/route.ts — the earlier "Vercel
 * Hobby 60s" sizing predated the plan check and is stale). BUCKETS_PER_CHUNK
 * stays 1 (Codex on #511 — 5-bucket chunks could run 450s and Inngest would
 * retry the uncheckpointed chunk, re-burning billed quota).
 * Normalizes (drift COUNTED and health-relevant), runs the deterministic
 * pipeline, updates freshness cursors, writes one JobIngestCycle row.
 */

const ADAPTERS: Record<string, JobSourceAdapter> = {
  jsearch: jsearchAdapter,
  apna: apnaAdapter,
  unstop: unstopAdapter,
}

/** Adapter resolution: aggregator ids map directly; every ats-board config
 *  row (gh:, lever:, sr:, ashby: prefixes) rides the unified board adapter. */
export function resolveAdapter(sourceId: string, kind?: string): JobSourceAdapter | null {
  if (ADAPTERS[sourceId]) return ADAPTERS[sourceId]
  if (kind === 'ats-board' || /^(gh|lever|sr|ashby):/.test(sourceId)) return atsBoardAdapter
  return null
}

const BUCKETS_PER_CHUNK = 1
// Raised 3→4 with the country-only harvest cut (DECISIONS #23): a country query
// carries far more fresh supply than a single metro slice did, so the known-rate
// cutoff paginates it deeper — the extra page recovers coverage the dropped metro
// breadth used to provide. Worst case 4×15s ≈ 61s, inside the 300s step budget.
// Tune from live JobIngestCycle.quotaSpent once the first country-only cycle lands.
const MAX_PAGES_PER_BUCKET = 4
/** Feed sources (unstop) paginate deeper per run: their whole corpus sits
 *  behind one paged list, and the known-rate cutoff stops early once the
 *  run reaches already-ingested rows (Codex #536). */
const MAX_PAGES_PER_FEED = 12
const FULL_PAGE_SIZE = 10
const KNOWN_RATE_PAGINATION_CUTOFF = 0.6

interface StepRunner {
  run: <T>(name: string, fn: () => Promise<T> | T) => Promise<T>
}

export interface ChunkOutcome {
  counters: IngestCounters
  /** sourceKeys observed this run — the board delisting sweep's seen-set. */
  seenSourceKeys: string[]
  fetched: number
  driftNulls: number
  attempts: number
  httpErrors: number
  saw429: boolean
  newestByBucket: Record<string, string>
  /** Feed continuation: cursorKey → next-run start offset (0 = reset).
   *  Cap-exits persist the reached page; exhaustion exits reset. */
  feedContinuation: Record<string, number>
  /** Buckets whose pagination ended on a failed page — their cursor must
   *  not advance AND the next run must distrust the known-rate cutoff for
   *  them (Codex #528 P1). */
  incompleteBuckets: string[]
}

function emptyCounters(): IngestCounters {
  return { processed: 0, drops: {}, flagged: {}, newCount: 0, merged: 0, refreshed: 0, fuzzyMerged: 0, saltedInserts: 0, storeErrors: 0 }
}

function accumulate(into: ChunkOutcome, from: ChunkOutcome): void {
  into.fetched += from.fetched
  into.driftNulls += from.driftNulls
  into.attempts += from.attempts
  into.httpErrors += from.httpErrors
  into.saw429 = into.saw429 || from.saw429
  into.seenSourceKeys.push(...from.seenSourceKeys)
  Object.assign(into.newestByBucket, from.newestByBucket)
  Object.assign(into.feedContinuation, from.feedContinuation)
  into.incompleteBuckets.push(...from.incompleteBuckets)
  const c = into.counters
  const f = from.counters
  c.processed += f.processed
  c.newCount += f.newCount
  c.merged += f.merged
  c.refreshed += f.refreshed
  c.fuzzyMerged += f.fuzzyMerged
  c.saltedInserts += f.saltedInserts
  c.storeErrors += f.storeErrors
  for (const [k, v] of Object.entries(f.drops)) c.drops[k] = (c.drops[k] ?? 0) + v
  for (const [k, v] of Object.entries(f.flagged)) c.flagged[k] = (c.flagged[k] ?? 0) + v
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Fetch one bucket (with §4.4 pagination policy) and ingest its rows.
 *  `sourceId` is the CONFIG row's id (gh:phonepe, lever:meesho, jsearch) —
 *  never the adapter's constant id: the unified board adapter serves many
 *  companies, and a shared prefix would collide sourceKeys across boards
 *  whose providers reuse posting ids (Codex on #513, P1). */
async function processTarget(
  adapter: JobSourceAdapter,
  sourceId: string,
  target: FetchTarget,
  outcome: ChunkOutcome,
  delayMs = 300,
  initVerdictPending = false,
  distrustKnown = false
): Promise<void> {
  // Honor the target's own starting page (Codex #536 — the continuation
  // offset buildTargets resumes from was being stomped by this local
  // counter). Buckets always start at 1; the cap bounds the COUNT of
  // pages fetched this run, never the absolute page number.
  const startPage = (target.kind === 'bucket' || target.kind === 'feed') && typeof target.page === 'number' && target.page > 0 ? target.page : 1
  let page = startPage
  // Cursor mark accumulates LOCALLY and commits to the outcome only on a
  // clean exit (Codex on #528): a bucket whose later page fails must not
  // advance its cursor — page 1 already ingested fine, but the narrowed
  // window on the next run would permanently skip the failed pages' rows.
  // An unadvanced cursor just re-fetches the same window; the merge layer
  // makes that idempotent. Completeness beats quota.
  let newestSeen: string | undefined
  for (;;) {
    const t: FetchTarget =
      target.kind === 'bucket' || target.kind === 'feed' ? { ...target, page } : target
    const res = await adapter.fetch(t)
    outcome.attempts += res.attempts
    if (!res.ok) {
      outcome.httpErrors++
      if (res.status === 429) outcome.saw429 = true
      // Durable incompleteness (Codex #528 P1): rows already stored from
      // this partial window would satisfy the known-rate cutoff on the
      // retry run BEFORE the failed page is ever refetched — flag the
      // bucket so the next run distrusts the cutoff and paginates through.
      if (t.kind === 'bucket') outcome.incompleteBuckets.push(t.bucketId)
      else if ('cursorBucket' in t && t.cursorBucket) outcome.incompleteBuckets.push(t.cursorBucket)
      return
    }
    outcome.fetched += res.raw.length

    const normalized: NormalizedJob[] = []
    for (const raw of res.raw) {
      const n = adapter.normalize(raw, t)
      if (n === null) outcome.driftNulls++
      else normalized.push(n)
    }
    const counters = await ingestBatch(normalized, sourceId, {
      registerRepost: makeRedisRepostCounter(redis),
      initVerdictPending,
    })
    accumulate(outcome, {
      counters, seenSourceKeys: [], fetched: 0, driftNulls: 0, attempts: 0, httpErrors: 0, saw429: false, newestByBucket: {}, incompleteBuckets: [], feedContinuation: {},
    })
    for (const n of normalized) {
      if (n.externalId) outcome.seenSourceKeys.push(`${sourceId}:${n.externalId}`)
    }

    // Freshness cursor input: newest PARSEABLE postedAt for this bucket.
    // A non-parseable provider date must never reach the cursor write —
    // new Date('garbage') = Invalid Date fails Mongoose casting in
    // finalize AFTER rows are ingested, and the step then retries forever
    // on the same bad value (Codex on #511). Compare numerically: mixed
    // date formats make string comparison meaningless.
    const cursorKey = t.kind === 'bucket' ? t.bucketId : 'cursorBucket' in t ? t.cursorBucket : undefined
    if (cursorKey) {
      if (res.watermark) {
        // Adapter-owned watermark (Codex #536): apna filters candidates by
        // sitemap lastmod, so the cursor MUST be in lastmod units —
        // postedAt (datePosted) lags lastmod on updated postings, and a
        // postedAt cursor keeps the same fetched prefix > cursor forever,
        // starving later entries.
        const ts = new Date(res.watermark).getTime()
        if (!Number.isNaN(ts) && (!newestSeen || ts > new Date(newestSeen).getTime())) newestSeen = res.watermark
      } else {
        for (const n of normalized) {
          if (!n.postedAt) continue
          const ts = new Date(n.postedAt).getTime()
          if (Number.isNaN(ts)) continue
          if (!newestSeen || ts > new Date(newestSeen).getTime()) newestSeen = n.postedAt
        }
      }
    }

    // Pagination policy (§4.4): continue only while pages come back full
    // AND most rows are new to us — a page we mostly already know means
    // the freshness window is exhausted.
    const knownRate = counters.processed > 0 ? (counters.merged + counters.refreshed) / counters.processed : 1
    const paginable = t.kind === 'bucket' || t.kind === 'feed'
    const pageSize = t.kind === 'feed' ? t.perPage : FULL_PAGE_SIZE
    const maxPages = t.kind === 'feed' ? MAX_PAGES_PER_FEED : MAX_PAGES_PER_BUCKET
    const pageFull = (res.rawPageSize ?? res.raw.length) >= pageSize
    // distrustKnown (Codex #528 P1): after an incomplete window, "already
    // known" is evidence of the PARTIAL run's stores, not of exhaustion —
    // the cutoff is disabled until one full clean pass rebuilds trust.
    // The cutoff is evidence of reaching KNOWN ground — a page with zero
    // processed rows (all policy-filtered, e.g. every registration closed)
    // is no such evidence and must keep paging (Codex #536).
    const cutoffHit = !distrustKnown && counters.processed > 0 && knownRate >= KNOWN_RATE_PAGINATION_CUTOFF
    const pagesFetched = page - startPage + 1
    const capExit = paginable && pageFull && !cutoffHit && pagesFetched >= maxPages
    if (!paginable || !pageFull || cutoffHit || pagesFetched >= maxPages) {
      // Feed continuation (Codex #536): a cap-exit is NOT exhaustion —
      // persist the reached page so the next run resumes at page+1;
      // exhaustion exits (non-full / cutoff) reset the offset to 0.
      if (t.kind === 'feed' && cursorKey) {
        outcome.feedContinuation[cursorKey] = capExit ? page : 0
      }
      // Clean exit: every page this window owed us was fetched — the
      // cursor may now advance (bucket targets key on bucketId; sitemap/
      // feed targets on their explicit cursorBucket).
      if (cursorKey && newestSeen) outcome.newestByBucket[cursorKey] = newestSeen
      return
    }
    page++
    if (delayMs) await sleep(delayMs)
  }
}

/** Monotonic cursor upserts (Codex on #511): $max means a reordered page or
 *  an older overlapping run finalizing late can never move a cursor
 *  backwards — that would widen future windows and re-fetch stale pages on
 *  billed quota. Shared by the per-chunk checkpoint and finalize. */
function cursorCheckpointOps(
  sourceId: string,
  newestByBucket: ChunkOutcome['newestByBucket'],
  incompleteBuckets: ChunkOutcome['incompleteBuckets'] = [],
  feedContinuation: ChunkOutcome['feedContinuation'] = {}
) {
  return [
    // Feed continuation offsets (Codex #536): cap-exit persists the
    // reached page; exhaustion resets to 0.
    ...Object.entries(feedContinuation).map(([bucket, lastPage]) => ({
      updateOne: {
        filter: { sourceId, bucket },
        update: { $set: { lastPage, lastRunAt: new Date() } },
        upsert: true,
      },
    })),
    // Completed buckets advance and clear the incompleteness flag — one
    // full clean pass rebuilds trust in the known-rate cutoff.
    ...Object.entries(newestByBucket).map(([bucket, newest]) => ({
      updateOne: {
        filter: { sourceId, bucket },
        update: { $max: { newestPostedAt: new Date(newest) }, $set: { lastRunAt: new Date(), windowIncomplete: false } },
        upsert: true,
      },
    })),
    // Failed-page buckets never advance; the durable flag makes the next
    // run distrust "already known" until the window completes (#528 P1).
    ...incompleteBuckets.map((bucket) => ({
      updateOne: {
        filter: { sourceId, bucket },
        update: { $set: { lastRunAt: new Date(), windowIncomplete: true } },
        upsert: true,
      },
    })),
  ]
}

// ── Pure handlers (unit-testable with a step mock) ──────────────────────────

export async function runIngestSchedulerHandler(step: StepRunner): Promise<{ dispatched: number } | { skipped: true }> {
  // No feature flag (founder ruling 2026-07-13): the ONLY ingestion switch
  // is data — JobSourceConfig.enabled, seeded false. No enabled sources =
  // this dispatches nothing and costs nothing.
  await connectDB()

  // Seed the jsearch config DISABLED on first contact — ops flips `enabled`
  // deliberately; the scheduler never invents an active source.
  await step.run('seed-configs', async () => {
    await JobSourceConfig.updateOne(
      { sourceId: 'jsearch' },
      { $setOnInsert: { sourceId: 'jsearch', kind: 'aggregator-api', enabled: false, health: 'active', cadenceMinutes: 1440 } },
      { upsert: true }
    )
    // India-native sources (§6 items 5/6): seeded DISABLED — the founder's
    // ToS read (legal layer 2) gates the enable, per DECISIONS #9.
    await JobSourceConfig.updateOne(
      { sourceId: 'apna' },
      { $setOnInsert: { sourceId: 'apna', kind: 'sitemap-jsonld', enabled: false, health: 'active', cadenceMinutes: 1440 } },
      { upsert: true }
    )
    await JobSourceConfig.updateOne(
      { sourceId: 'unstop' },
      { $setOnInsert: { sourceId: 'unstop', kind: 'public-api', enabled: false, health: 'active', cadenceMinutes: 1440 } },
      { upsert: true }
    )
    // ATS boards (§1 build-now): seeded DISABLED, 6h cadence per §4.4.
    for (const b of BOARD_REGISTRY) {
      await JobSourceConfig.updateOne(
        { sourceId: b.sourceId },
        { $setOnInsert: { sourceId: b.sourceId, kind: 'ats-board', atsKind: b.atsKind, slug: b.slug, minIndiaPostings: b.minIndiaPostings, displayName: b.displayName, enabled: false, health: 'active', cadenceMinutes: 360 } },
        { upsert: true }
      )
      // Backfill displayName ONLY where absent (rows seeded before the field
      // existed) — never overwrite a set value: config rows are ops-owned
      // data, and an unconditional $set would revert any ops correction on
      // the next hourly tick (adversarial review of Codex #513 round-5).
      await JobSourceConfig.updateOne(
        { sourceId: b.sourceId, displayName: { $in: [null, ''] } },
        { $set: { displayName: b.displayName } }
      )
    }
    return true
  })

  const due = await step.run('find-due-sources', async () => {
    const sources = await JobSourceConfig.find({
      enabled: true,
      health: { $in: ['active', 'degraded'] },
    }).lean()
    const now = Date.now()
    return sources
      .filter((s) => !s.lastSyncAt || now - new Date(s.lastSyncAt).getTime() >= s.cadenceMinutes * 60_000)
      .map((s) => s.sourceId)
  })

  let dispatched = 0
  for (const sourceId of due) {
    await step.run(`dispatch-${sourceId}`, async () => {
      await inngest.send({ name: 'jobs/source.sync', data: { sourceId } })
      return true
    })
    dispatched++
  }
  return { dispatched }
}

export interface SyncHandlerOpts {
  /** Inter-request politeness spacing; tests pass 0. */
  interRequestDelayMs?: number
}

export async function runSourceSyncHandler(
  event: { data: { sourceId: string } },
  step: StepRunner,
  opts: SyncHandlerOpts = {}
): Promise<{ skipped: true; reason: string } | { cycleWritten: true; counters: IngestCounters }> {
  const delayMs = opts.interRequestDelayMs ?? 300
  const { sourceId } = event.data
  await connectDB()
  const config = await JobSourceConfig.findOne({ sourceId }).lean()
  if (!config || !config.enabled) return { skipped: true, reason: 'source disabled' }
  if (!['active', 'degraded'].includes(config.health)) return { skipped: true, reason: `health ${config.health}` }
  const adapter = resolveAdapter(sourceId, config.kind)
  if (!adapter) return { skipped: true, reason: `no adapter for ${sourceId}` }

  const startedAt = new Date()
  // §4.5: read the verdict switch ONCE per sync — new survivors get
  // llmVerdict:{status:'pending'} for the sweeper's partial index. A
  // mid-sync CMS flip applies from the next sync, not mid-run.
  const verdictCfg = await JobsVerdictConfig.getConfig()
  // Opted-out sources (ToS lever) never even mint pending rows — a pinned
  // pending row the worker refuses to evaluate would starve the oldest-first
  // sweep for every other source (adversarial review of Wave 2.3).
  const initVerdictPending = verdictCfg.collectionEnabled && !config.llmVerdictOptOut
  const cursors = await JobIngestCursor.find({ sourceId }).lean()
  const targets = adapter.buildTargets(
    { sourceId: config.sourceId, enabled: config.enabled, slug: config.slug, atsKind: config.atsKind, displayName: config.displayName },
    cursors.map((c) => ({ bucket: c.bucket, newestPostedAt: c.newestPostedAt, lastPage: c.lastPage }))
  )
  // Buckets whose last window ended on a failed page (#528 P1): their rows
  // are partially stored, so "already known" cannot mean "window exhausted"
  // — the known-rate cutoff is disabled for them until a full clean pass.
  const distrust = new Set(cursors.filter((c) => c.windowIncomplete).map((c) => c.bucket))

  const total: ChunkOutcome = { counters: emptyCounters(), seenSourceKeys: [], fetched: 0, driftNulls: 0, attempts: 0, httpErrors: 0, saw429: false, newestByBucket: {}, incompleteBuckets: [], feedContinuation: {} }
  for (let i = 0; i < targets.length; i += BUCKETS_PER_CHUNK) {
    const chunk = targets.slice(i, i + BUCKETS_PER_CHUNK)
    const outcome = await step.run(`fetch-chunk-${Math.floor(i / BUCKETS_PER_CHUNK)}`, async () => {
      const o: ChunkOutcome = { counters: emptyCounters(), seenSourceKeys: [], fetched: 0, driftNulls: 0, attempts: 0, httpErrors: 0, saw429: false, newestByBucket: {}, incompleteBuckets: [], feedContinuation: {} }
      for (const target of chunk) {
        const distrustKey = target.kind === 'bucket' ? target.bucketId : 'cursorBucket' in target ? target.cursorBucket : undefined
        // Continuation runs (feed resuming past page 1) also distrust the
        // cutoff (Codex #536): on a newest-first feed, front-insertions
        // shift the backlog deeper, so a resumed page may land on
        // already-known rows — the cutoff would reset the drain before it
        // reaches the shifted backlog. Cap + non-full-page remain the
        // exits; known pages are merge-idempotent.
        const isContinuation = target.kind === 'feed' && target.page > 1
        const distrustKnown = (!!distrustKey && distrust.has(distrustKey)) || isContinuation
        await processTarget(adapter, sourceId, target, o, delayMs, initVerdictPending, distrustKnown)
        if (delayMs) await sleep(delayMs)
      }
      // Durable checkpoint (prod first-fill incident, 2026-07-15): a
      // full-corpus run can outlive the platform's invocation ceiling, and
      // with cursors persisted only in finalize every retry re-fetched all
      // buckets from scratch on billed quota. $max is monotonic, so
      // checkpointing per chunk is replay-safe, and buildTargets re-reads
      // cursors on each resume — a bucket completed ONCE keeps its narrowed
      // window across run deaths and hourly re-dispatches.
      const ops = cursorCheckpointOps(sourceId, o.newestByBucket, o.incompleteBuckets, o.feedContinuation)
      if (ops.length) await JobIngestCursor.bulkWrite(ops)
      return o
    })
    accumulate(total, outcome)
  }

  await step.run('finalize', async () => {
    // Cursors: re-assert the accumulated high-water marks and incompleteness
    // flags (monotonic $max / idempotent $set — a no-op where the per-chunk
    // checkpoints already landed).
    const ops = cursorCheckpointOps(sourceId, total.newestByBucket, total.incompleteBuckets, total.feedContinuation)
    if (ops.length) await JobIngestCursor.bulkWrite(ops)

    // Health (§4.4 thresholds): drift >50% = QUARANTINED (provider schema is
    // gone — dark the source for ops; the scheduler stops dispatching it,
    // so a fully-broken provider stops burning billed quota — Codex on
    // #511); drift >20%, any 429, or all-failed = degraded (still runs,
    // visibly sick); a clean run on a degraded source recovers it.
    // Quarantine recovery is deliberate: ops re-activation (weekly board
    // probe automation lands in 2.2).
    const allFailed = targets.length > 0 && total.httpErrors >= targets.length
    const driftRate = total.fetched > 0 ? total.driftNulls / total.fetched : 0
    // Store errors are OUR failures (validation/index regressions), not the
    // provider's — a run that fetched valid rows but could not store them
    // must never read healthy (Codex on #511, post-merge follow-up).
    let newHealth: 'active' | 'degraded' | 'quarantined'
    if (driftRate > 0.5) newHealth = 'quarantined'
    else if (total.saw429 || allFailed || driftRate > 0.2 || total.counters.storeErrors > 0) newHealth = 'degraded'
    else newHealth = 'active'
    await JobSourceConfig.updateOne(
      { sourceId },
      { $set: { lastSyncAt: new Date(), health: newHealth, ...(newHealth === 'active' ? { lastHealthyProbeAt: new Date() } : {}) } }
    )

    // Board delisting closure (§4.3 'board-poll-miss'; Codex on #513, P2):
    // ATS rows carry no expiry date — a posting the board stops listing
    // must close after TWO consecutive clean-sync misses. 'Clean' means
    // FULLY clean: no fetch errors, no normalize drift, no store failures —
    // a drifted run has an incomplete seen-set and would count still-listed
    // postings as misses (Codex round-3). Only closes postings owned SOLELY
    // by this board (another source may still legitimately list it).
    const cleanRun = total.httpErrors === 0 && total.driftNulls === 0 && total.counters.storeErrors === 0 && targets.length > 0
    if (config.kind === 'ats-board' && cleanRun) {
      const seen = total.seenSourceKeys
      if (seen.length) {
        await JobPosting.updateMany(
          { status: 'open', 'provenance.sourceKey': { $in: seen }, boardPollMisses: { $gt: 0 } },
          { $set: { boardPollMisses: 0 } }
        )
      }
      const stale = await JobPosting.find({
        status: 'open',
        'provenance.sourceId': sourceId,
        ...(seen.length ? { 'provenance.sourceKey': { $nin: seen } } : {}),
      }).limit(1000)
      for (const doc of stale) {
        if (!doc.provenance.every((e) => e.sourceId === sourceId)) continue
        const misses = (doc.boardPollMisses ?? 0) + 1
        doc.boardPollMisses = misses
        if (misses >= 2) {
          doc.status = 'closed'
          doc.closedReason = 'board-poll-miss'
          doc.closedAt = new Date()
          // userReferenced rows (saved/tracked) close but NEVER purge — the
          // tracker keeps a stable _id forever (§4.3). The pin is RE-DERIVED
          // here, not trusted (PRODUCT_FLOW §2: scan JobApplication existence
          // during GC — immune to cascade drift): account deletion removes
          // JobApplication rows without touching pins, and clearing pins at
          // delete time would be refcount-unsafe (other users may reference
          // the same posting). Orphaned pins clear + purge normally
          // (Codex on #517 round-3).
          let pinned = !!doc.userReferenced
          if (pinned && !(await JobApplication.exists({ jobPostingId: doc._id }))) {
            doc.userReferenced = false
            pinned = false
          }
          if (!pinned) doc.purgeAt = new Date(Date.now() + 7 * 24 * 3600 * 1000)
        }
        await doc.save()
      }
    }

    await JobIngestCycle.create({
      kind: 'sync',
      sourceId,
      startedAt,
      finishedAt: new Date(),
      fetched: total.fetched,
      normalized: total.counters.processed,
      driftNulls: total.driftNulls,
      drops: total.counters.drops,
      flagged: total.counters.flagged,
      newCount: total.counters.newCount,
      merged: total.counters.merged,
      refreshed: total.counters.refreshed,
      storeErrors: total.counters.storeErrors,
      quotaSpent: total.attempts,
      healthTransitions: newHealth !== config.health ? [`${config.health}->${newHealth}`] : [],
    })
    return true
  })

  return { cycleWritten: true, counters: total.counters }
}

/**
 * Weekly board-liveness probe (§4.4): boards die silently (Paytm 404s,
 * CRED is a dead logo). 404/410 quarantines immediately; a quarantined
 * board needs TWO consecutive healthy probes to recover; sub-
 * minIndiaPostings yield 3 weeks running quarantines.
 */
export async function runBoardProbeHandler(step: StepRunner): Promise<{ probed: number }> {
  await connectDB()
  const boards = await step.run('load-boards', async () =>
    // 'revoked' is a MANUAL legal block (ruling #9) — the liveness probe
    // must never touch it, or 404→quarantine→2-healthy-probes could
    // silently reactivate a legally-darkened board (Codex on #513).
    JobSourceConfig.find({ kind: 'ats-board', health: { $in: ['active', 'degraded', 'quarantined'] } }).lean()
  )
  let probed = 0
  for (const board of boards) {
    await step.run(`probe-${board.sourceId}`, async () => {
      const adapter = resolveAdapter(board.sourceId, board.kind)
      if (!adapter) return false
      const targets = adapter.buildTargets({ sourceId: board.sourceId, enabled: true, slug: board.slug, atsKind: board.atsKind, displayName: board.displayName }, [])
      if (!targets.length) return false
      const res = await adapter.fetch(targets[0])
      const update: Record<string, unknown> = {}
      if (!res.ok && (res.status === 404 || res.status === 410)) {
        // The board itself is gone — quarantine immediately.
        Object.assign(update, { health: 'quarantined', healthyProbeStreak: 0 })
      } else if (res.ok) {
        // Supply = rows that NORMALIZE, not raw rows: a board quarantined
        // for >50% schema drift keeps returning rows, and counting raw
        // would probe-recover it into an immediate re-quarantine flap
        // (Codex on #513 round-4). Drifted rows are not usable supply.
        const indiaCount = res.raw.filter((r) => adapter.normalize(r, targets[0]) !== null).length
        const under = board.minIndiaPostings != null && indiaCount < board.minIndiaPostings
        const emptyStreak = under ? (board.emptyStreak ?? 0) + 1 : 0
        Object.assign(update, { emptyStreak })
        // 'Two consecutive healthy probes' means CONSECUTIVE — an
        // under-supply week resets the recovery streak (Codex on #513).
        if (under) Object.assign(update, { healthyProbeStreak: 0 })
        if (under && emptyStreak >= 3) {
          Object.assign(update, { health: 'quarantined', healthyProbeStreak: 0 })
        } else if (board.health === 'quarantined' && !under && indiaCount > 0) {
          const streak = (board.healthyProbeStreak ?? 0) + 1
          Object.assign(update, streak >= 2
            ? { health: 'active', healthyProbeStreak: 0, lastHealthyProbeAt: new Date() }
            : { healthyProbeStreak: streak })
        } else if (!under) {
          Object.assign(update, { lastHealthyProbeAt: new Date() })
        }
      }
      // Transient non-404 failures leave health to the sync job's judgment.
      if (Object.keys(update).length) await JobSourceConfig.updateOne({ sourceId: board.sourceId }, { $set: update })
      return true
    })
    probed++
  }
  return { probed }
}

// ── Inngest wrappers ─────────────────────────────────────────────────────────

export const jobsIngestSchedulerJob = inngest.createFunction(
  { id: 'jobs-ingest-scheduler', name: 'Jobs: ingest scheduler', retries: 1, triggers: [{ cron: '15 * * * *' }] },
  async ({ step }) => runIngestSchedulerHandler(step as StepRunner)
)

export const jobsBoardProbeJob = inngest.createFunction(
  { id: 'jobs-board-probe', name: 'Jobs: weekly board liveness probe', retries: 1, triggers: [{ cron: '30 6 * * 1' }] },
  async ({ step }) => runBoardProbeHandler(step as StepRunner)
)

export const jobsSourceSyncJob = inngest.createFunction(
  {
    id: 'jobs-source-sync',
    name: 'Jobs: source sync',
    retries: 2,
    // First use of Inngest concurrency in this repo (flagged in the plan):
    // global limit 2 = the Atlas shared-tier rule (ruling #11); the
    // per-sourceId key makes each source a SINGLETON — a slow run crossing
    // the next cron tick (or an admin double-kick) queues instead of
    // racing cursor/health writes and double-burning billed quota
    // (Codex on #511). The queued run is then cheap: fresh cursors make it
    // mostly known-rows and pagination stops at page 1.
    concurrency: [
      { limit: 2 },
      { limit: 1, key: 'event.data.sourceId' },
    ],
    onFailure: async ({ event }) => {
      const sourceId = (event?.data as { event?: { data?: { sourceId?: string } } })?.event?.data?.sourceId
      try {
        await connectDB()
        await JobIngestCycle.create({ kind: 'sync', sourceId, startedAt: new Date(), finishedAt: new Date(), healthTransitions: ['sync-failed-all-retries'] })
      } catch (err) {
        logger.warn({ err, sourceId }, 'jobs-source-sync onFailure telemetry write failed')
      }
    },
    triggers: [{ event: 'jobs/source.sync' }],
  },
  async ({ event, step }) => runSourceSyncHandler(event as unknown as { data: { sourceId: string } }, step as StepRunner)
)
