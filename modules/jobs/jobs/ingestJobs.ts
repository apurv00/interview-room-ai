import { inngest } from '@shared/services/inngest'
import { connectDB } from '@shared/db/connection'
import {
  JOB_SOURCE_CONTROL_META_ID,
  JobPosting,
  JobSourceConfig,
  JobSourceControlMeta,
  JobSourceOperationAudit,
  JobIngestCursor,
  JobIngestCycle,
  JobsVerdictConfig,
} from '@shared/db/models'
import { redis } from '@shared/redis'
import { logger } from '@shared/logger'
import { jsearchAdapter } from '../adapters/jsearchAdapter'
import { apnaAdapter } from '../adapters/apnaAdapter'
import { unstopAdapter } from '../adapters/unstopAdapter'
import { atsBoardAdapter } from '../adapters/atsBoardAdapter'
import {
  JOB_SOURCE_CATALOG,
  effectiveSourceRequestBudget,
  jobSourceDefinition,
  sourceCatalogIdentityMatches,
  sourceCredentialStatus,
  sourcePolicyHash,
} from '../config/sourceCatalog'
import type { FetchTarget, JobSourceAdapter, NormalizedJob } from '../adapters/types'
import {
  ingestBatch,
  makeRedisRepostCounter,
  snapshotRepostCounts,
  type IngestCounters,
} from '../services/ingestPipeline'
import {
  assertSourceProbeAuthority,
  assertSourceSyncAuthority,
  assertSourceTransactionsReady,
  assertSourceValidationAuthority,
  completeSourceValidation,
  controlRevisionFilter,
  controlRevisionOf,
  operationalRevisionFilter,
  operationalRevisionOf,
  SourceAuthorityChangedError,
  SourceTransactionsRequiredError,
  withSourceWriteFence,
} from '../services/sourceControl'
import {
  assertSourceWorkerReadiness,
  SourceOperationError,
} from '../services/sourceOperations'
import {
  makeSourceQuotaGuard,
  readSourceRunQuotaUsage,
  type SourceRequestRejection,
} from '../services/sourceQuota'

/**
 * Ingestion background jobs (INGESTION §4.4; pathwayJob/analysisJob shape:
 * pure handlers split from Inngest wrappers, ids-only events, step.run
 * checkpoints sized to the Vercel Hobby 60s budget).
 *
 * jobsIngestSchedulerJob (cron :15) — flag-gated dispatcher: finds enabled
 * sources whose cadence is due and emits one `jobs/source.sync` event each.
 * Catalog bootstrap is an explicit, audited CMS operation; this scheduler
 * never invents or mutates source configuration.
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

async function markSourceOperationTerminal(
  operationId: string | undefined,
  action: 'run-now' | 'validate',
  outcome: 'succeeded' | 'failed',
  errorCode?: string,
): Promise<void> {
  if (!operationId) return
  await JobSourceOperationAudit.updateOne(
    { operationId, action, outcome: { $exists: false } },
    {
      $set: {
        outcome,
        completedAt: new Date(),
        ...(outcome === 'failed' ? { errorCode: errorCode ?? `${action}-failed` } : {}),
      },
    },
  )
}
/** Keep external Redis work and posting mutations well below Mongo's normal
 * transaction lifetime. Large SmartRecruiters boards can return 1,000 rows. */
const SOURCE_WRITE_BATCH_SIZE = 25
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
  /** Local request rail stopped the run before networking. Partial work is
   * finalized for telemetry but never used to degrade provider health. */
  requestStopReason?: SourceRequestRejection
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

function accumulateCounters(into: IngestCounters, from: IngestCounters): void {
  into.processed += from.processed
  into.newCount += from.newCount
  into.merged += from.merged
  into.refreshed += from.refreshed
  into.fuzzyMerged += from.fuzzyMerged
  into.saltedInserts += from.saltedInserts
  into.storeErrors += from.storeErrors
  for (const [key, value] of Object.entries(from.drops)) into.drops[key] = (into.drops[key] ?? 0) + value
  for (const [key, value] of Object.entries(from.flagged)) into.flagged[key] = (into.flagged[key] ?? 0) + value
}

function accumulate(into: ChunkOutcome, from: ChunkOutcome): void {
  into.fetched += from.fetched
  into.driftNulls += from.driftNulls
  into.attempts += from.attempts
  into.httpErrors += from.httpErrors
  into.saw429 = into.saw429 || from.saw429
  into.requestStopReason ??= from.requestStopReason
  into.seenSourceKeys.push(...from.seenSourceKeys)
  Object.assign(into.newestByBucket, from.newestByBucket)
  Object.assign(into.feedContinuation, from.feedContinuation)
  into.incompleteBuckets.push(...from.incompleteBuckets)
  accumulateCounters(into.counters, from.counters)
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
  controlRevision: number,
  operationalRevision: number,
  target: FetchTarget,
  outcome: ChunkOutcome,
  beforeBudgetedRequest: () => Promise<void | { allowed: false; reason: SourceRequestRejection }>,
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
    // Cheap pre-fetch stop. The transaction fence around persistence is the
    // atomic authority check; this read minimizes post-revocation requests.
    await assertSourceSyncAuthority(sourceId, controlRevision, operationalRevision)
    const res = await adapter.fetch(t, {
      beforePhysicalRequest: async () => {
        await assertSourceSyncAuthority(sourceId, controlRevision, operationalRevision)
        const decision = await beforeBudgetedRequest()
        if (!decision) outcome.attempts++
        return decision
      },
    })
    if (res.authorityChanged) throw new SourceAuthorityChangedError(sourceId, controlRevision, operationalRevision)
    if (res.requestRejected) {
      outcome.requestStopReason = res.requestRejected === 'quota-exhausted'
        ? 'quota-exhausted'
        : 'quota-unavailable'
      return
    }
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
    // Bound transactions: SmartRecruiters can return 1,000 rows and repost
    // classification performs external Redis work. Each small persistence
    // unit has its own config-row fence. Revoke between units closes earlier
    // commits and prevents every later unit from starting.
    const counters = emptyCounters()
    const registerRepost = makeRedisRepostCounter(redis)
    for (let offset = 0; offset < normalized.length; offset += SOURCE_WRITE_BATCH_SIZE) {
      const batch = normalized.slice(offset, offset + SOURCE_WRITE_BATCH_SIZE)
      const repostCounts = await snapshotRepostCounts(batch, registerRepost)
      const persisted = await withSourceWriteFence(
        sourceId,
        controlRevision,
        operationalRevision,
        (session) => ingestBatch(batch, sourceId, {
          repostCounts,
          initVerdictPending,
          session,
        }),
        { insertedPostings: (result) => result.newCount },
      )
      accumulateCounters(counters, persisted)
    }
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
      // No silent caps (Codex on #559 round 3): a BUCKET that fills all
      // MAX_PAGES_PER_BUCKET pages with fresh rows has more backlog than one run
      // fetches, and — unlike a feed — a bucket has no continuation, so the
      // freshness cursor advances and pages beyond the cap are not revisited
      // (JSearch's date_posted is a RELATIVE window, so a feed-style page-resume
      // can't pin a stable query across runs). Collapsing 6 metros into one ':in'
      // bucket (#23) makes this reachable for a very-high-volume domain-day; the
      // measured supply (~≤24/domain/day vs the 40-row cap, DECISIONS #17) keeps
      // it below the cap in steady state, and the rename's cold-fill backlog is
      // already in-corpus from the pre-#23 metro harvest — so no actual supply
      // loss is expected. This warn makes any REAL cap-exit visible so ops can
      // raise the cap or build bucket continuation (DECISIONS #23 follow-up).
      if (capExit && t.kind === 'bucket') {
        logger.warn({ sourceId, bucket: cursorKey, pagesFetched }, 'jobs ingest: bucket cap-exit — deep backlog beyond MAX_PAGES_PER_BUCKET dropped this run')
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

export async function runIngestSchedulerHandler(
  step: StepRunner,
): Promise<{ dispatched: number } | { skipped: true; reason: 'bootstrap-required' }> {
  // No feature flag (founder ruling 2026-07-13): the ONLY ingestion switch
  // is data — JobSourceConfig.enabled, seeded false. No enabled sources =
  // this dispatches nothing and costs nothing.
  await connectDB()

  const sourceControl = await step.run('find-due-sources', async () => {
    const [sources, meta] = await Promise.all([
      JobSourceConfig.find({}).lean(),
      JobSourceControlMeta.findOne({ _id: JOB_SOURCE_CONTROL_META_ID }).lean(),
    ])
    // Permanent history is unbounded; read exactly one indexed head per
    // enabled catalog source so scheduler cost cannot grow with audit age.
    const enabledSources = sources.filter((source) => source.enabled)
    const operationRows = await Promise.all(enabledSources.map(async (source) => ({
      sourceId: source.sourceId,
      operation: await JobSourceOperationAudit.findOne(
        { sourceId: source.sourceId },
        null,
        { sort: { occurredAt: -1, _id: -1 } },
      ).lean(),
    })))
    const latestOperationBySource = new Map(
      operationRows.map((row) => [row.sourceId, row.operation]),
    )
    const configuredIds = new Set(sources.map((source) => source.sourceId))
    const catalogReady = sources.length === JOB_SOURCE_CATALOG.length &&
      JOB_SOURCE_CATALOG.every((definition) => configuredIds.has(definition.sourceId)) &&
      sources.every((source) => sourceCatalogIdentityMatches(source) &&
        Number.isSafeInteger(source.operationalRevision) && source.operationalRevision >= 0 &&
        sourcePolicyHash(source) !== null)
    const metaReady = !!meta && meta.sourceLineageVersion === 1 &&
      Number.isSafeInteger(meta.controlWriteSeq) && Number.isSafeInteger(meta.ingestWriteSeq) &&
      Number.isSafeInteger(meta.retainedPostings)
    const enabledRowsAudited = enabledSources.every((source) => {
      const operation = latestOperationBySource.get(source.sourceId)
      return operation?.to?.enabled === true &&
        operation.to.controlRevision === controlRevisionOf(source) &&
        operation.to.operationalRevision === operationalRevisionOf(source) &&
        operation.to.policyHash === sourcePolicyHash(source)
    })
    if (!catalogReady || !metaReady || !enabledRowsAudited) {
      logger.warn(
        { catalogReady, metaReady, enabledRowsAudited },
        'jobs ingest scheduler blocked: bootstrap-required',
      )
      return { ready: false as const, due: [] }
    }
    const now = Date.now()
    return { ready: true as const, due: sources
      .filter((source) => source.enabled && ['active', 'degraded'].includes(source.health))
      .filter((s) => !s.lastSyncAt || now - new Date(s.lastSyncAt).getTime() >= s.cadenceMinutes * 60_000)
      .map((s) => ({
        sourceId: s.sourceId,
        controlRevision: controlRevisionOf(s),
        operationalRevision: operationalRevisionOf(s),
      })) }
  })
  if (!sourceControl.ready) return { skipped: true, reason: 'bootstrap-required' }
  const due = sourceControl.due

  let dispatched = 0
  for (const { sourceId, controlRevision, operationalRevision } of due) {
    await step.run(`dispatch-${sourceId}`, async () => {
      await inngest.send({ name: 'jobs/source.sync', data: { sourceId, controlRevision, operationalRevision } })
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
  event: { id?: string; data: { sourceId: string; controlRevision?: number; operationalRevision?: number; operationId?: string } },
  step: StepRunner,
  opts: SyncHandlerOpts = {}
): Promise<{ skipped: true; reason: string } | { cycleWritten: true; counters: IngestCounters }> {
  const delayMs = opts.interRequestDelayMs ?? 300
  const { sourceId, operationId } = event.data
  const skip = async (reason: string, errorCode: string) => {
    await markSourceOperationTerminal(operationId, 'run-now', 'failed', errorCode)
    return { skipped: true as const, reason }
  }
  await connectDB()
  const config = await JobSourceConfig.findOne({ sourceId }).lean()
  if (!config || !config.enabled) return skip('source disabled', 'source-disabled-before-run')
  if (!['active', 'degraded'].includes(config.health)) return skip(`health ${config.health}`, 'source-health-ineligible')
  const definition = jobSourceDefinition(sourceId)
  if (!definition || !sourceCatalogIdentityMatches(config)) {
    return skip('source catalog identity unavailable', 'source-catalog-identity-unavailable')
  }
  const configRevision = controlRevisionOf(config)
  const configOperationalRevision = operationalRevisionOf(config)
  const requestedRevision = event.data.controlRevision
  // Rolling-deploy compatibility is limited to epoch zero. Once any control
  // action increments the source, old queued events without an epoch fail
  // closed forever.
  if (requestedRevision !== undefined && (!Number.isInteger(requestedRevision) || requestedRevision < 0)) {
    return skip('invalid source revision', 'invalid-source-revision')
  }
  const controlRevision = requestedRevision ?? (configRevision === 0 ? 0 : -1)
  if (controlRevision !== configRevision) return skip('stale source revision', 'stale-source-revision')
  const requestedOperationalRevision = event.data.operationalRevision
  if (requestedOperationalRevision !== undefined && (!Number.isInteger(requestedOperationalRevision) || requestedOperationalRevision < 0)) {
    return skip('invalid operational revision', 'invalid-operational-revision')
  }
  const operationalRevision = requestedOperationalRevision ?? (configOperationalRevision === 0 ? 0 : -1)
  if (operationalRevision !== configOperationalRevision) return skip('stale operational revision', 'stale-operational-revision')
  const adapter = resolveAdapter(sourceId, config.kind)
  if (!adapter) return skip(`no adapter for ${sourceId}`, 'source-adapter-unavailable')
  const requestBudget = effectiveSourceRequestBudget(config)
  if (!requestBudget) return skip('request budget unavailable', 'request-budget-unavailable')
  // Inngest always supplies event.id. The deterministic fallback is only for
  // epoch-zero rolling-deploy events/tests and is deliberately over-strict:
  // all such legacy deliveries share one cap instead of bypassing it.
  const runId = event.id ?? event.data.operationId ??
    `legacy:${sourceId}:${controlRevision}:${operationalRevision}`
  const quota = makeSourceQuotaGuard(redis, sourceId, runId, requestBudget)
  await assertSourceWorkerReadiness(config)

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
    { sourceId: config.sourceId, enabled: config.enabled, slug: definition.slug, atsKind: definition.atsKind, displayName: definition.displayName },
    cursors.map((c) => ({ bucket: c.bucket, newestPostedAt: c.newestPostedAt, lastPage: c.lastPage }))
  )
  // Buckets whose last window ended on a failed page (#528 P1): their rows
  // are partially stored, so "already known" cannot mean "window exhausted"
  // — the known-rate cutoff is disabled for them until a full clean pass.
  const distrust = new Set(cursors.filter((c) => c.windowIncomplete).map((c) => c.bucket))
  // First run for a bucket with NO cursor yet must ALSO distrust the known-rate
  // cutoff (Codex on #559): when a bucket id is new to an EXISTING corpus — the
  // #23 metro→country rename ('backend:pune'… → 'backend:in') is the live case,
  // where the DB already holds the old metro rows — page 1 of the country query
  // is mostly already-known, trips the ≥60% cutoff, stops before the deep pages
  // the #23 depth-recovery relies on, and writes a cursor that freezes the
  // shallow coverage. No cursor ⇒ "known" is not evidence of window exhaustion;
  // on a genuinely empty corpus this is a no-op (nothing is known, so the cutoff
  // cannot fire), so it only ever helps.
  const haveCursor = new Set(cursors.map((c) => c.bucket))

  const total: ChunkOutcome = { counters: emptyCounters(), seenSourceKeys: [], fetched: 0, driftNulls: 0, attempts: 0, httpErrors: 0, saw429: false, newestByBucket: {}, incompleteBuckets: [], feedContinuation: {} }
  try {
  // Fail before paid provider calls when the deployed Mongo topology cannot
  // honor A02 transactions. This also re-checks authority at run start.
  await assertSourceTransactionsReady(sourceId, controlRevision, operationalRevision)
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
        // A BUCKET target with no persisted cursor is on its first run (#559).
        // Gated to bucket kind (Codex on #559 round 2): a paged feed reuses
        // distrustKey from cursorBucket, so an unstop feed whose cursor is lost
        // while postings remain would otherwise skip the cutoff, drain to
        // MAX_PAGES_PER_FEED, and write a cap-exit continuation that keeps
        // paginating deep on later runs. Feeds already own their first-run drain
        // via the full-page + continuation logic; the #23 rename is bucket-only.
        const isFirstRunForBucket = target.kind === 'bucket' && !!distrustKey && !haveCursor.has(distrustKey)
        const distrustKnown = (!!distrustKey && distrust.has(distrustKey)) || isContinuation || isFirstRunForBucket
        await processTarget(
          adapter,
          sourceId,
          controlRevision,
          operationalRevision,
          target,
          o,
          quota.beforeRequest,
          delayMs,
          initVerdictPending,
          distrustKnown,
        )
        if (o.requestStopReason) break
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
      if (ops.length) {
        await withSourceWriteFence(sourceId, controlRevision, operationalRevision, (session) =>
          JobIngestCursor.bulkWrite(ops, { session })
        )
      }
      return o
    })
    accumulate(total, outcome)
    if (total.requestStopReason) break
  }

  const durableQuotaSpent = await step.run(
    'read-run-quota',
    () => readSourceRunQuotaUsage(redis, sourceId, runId),
  )
  await step.run('finalize', () => withSourceWriteFence(sourceId, controlRevision, operationalRevision, async (session) => {
    // Cursors: re-assert the accumulated high-water marks and incompleteness
    // flags (monotonic $max / idempotent $set — a no-op where the per-chunk
    // checkpoints already landed).
    const ops = cursorCheckpointOps(sourceId, total.newestByBucket, total.incompleteBuckets, total.feedContinuation)
    if (ops.length) await JobIngestCursor.bulkWrite(ops, { session })

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
    if (total.requestStopReason) newHealth = config.health as 'active' | 'degraded'
    else if (driftRate > 0.5) newHealth = 'quarantined'
    else if (total.saw429 || allFailed || driftRate > 0.2 || total.counters.storeErrors > 0) newHealth = 'degraded'
    else newHealth = 'active'
    await JobSourceConfig.updateOne(
      {
        sourceId,
        enabled: true,
        health: { $in: ['active', 'degraded'] },
        ...controlRevisionFilter(controlRevision),
        $and: [operationalRevisionFilter(operationalRevision)],
      },
      {
        $set: {
          lastSyncAt: new Date(),
          health: newHealth,
          ...(!total.requestStopReason && newHealth === 'active' ? { lastHealthyProbeAt: new Date() } : {}),
        },
      },
      { session }
    )

    // Board delisting closure (§4.3 'board-poll-miss'; Codex on #513, P2):
    // ATS rows carry no expiry date — a posting the board stops listing
    // must close after TWO consecutive clean-sync misses. 'Clean' means
    // FULLY clean: no fetch errors, no normalize drift, no store failures —
    // a drifted run has an incomplete seen-set and would count still-listed
    // postings as misses (Codex round-3). Only closes postings owned SOLELY
    // by this board (another source may still legitimately list it).
    const cleanRun = !total.requestStopReason && total.httpErrors === 0 && total.driftNulls === 0 &&
      total.counters.storeErrors === 0 && targets.length > 0
    if (config.kind === 'ats-board' && cleanRun) {
      const seen = total.seenSourceKeys
      if (seen.length) {
        await JobPosting.updateMany(
          { status: 'open', 'provenance.sourceKey': { $in: seen }, boardPollMisses: { $gt: 0 } },
          { $set: { boardPollMisses: 0 } },
          { session }
        )
      }
      const stale = await JobPosting.find({
        status: 'open',
        'provenance.sourceId': sourceId,
        ...(seen.length ? { 'provenance.sourceKey': { $nin: seen } } : {}),
      }, null, { session }).limit(1000)
      const lifecycleOps = stale.flatMap((doc) => {
        if (!doc.provenance.every((entry) => entry.sourceId === sourceId)) return []
        const misses = (doc.boardPollMisses ?? 0) + 1
        const closedAt = misses >= 2 ? new Date() : null
        // One lifecycle-CAS operation per row eliminates the former three
        // sequential writes. Ownership changes conflict on updatedAt: pin
        // first makes this miss; close first is healed by the monotonic pin.
        const update = closedAt
          ? doc.userReferenced
            ? {
                $set: { boardPollMisses: misses, status: 'closed' as const, closedReason: 'board-poll-miss' as const, closedAt },
                $unset: { purgeAt: 1 as const },
              }
            : {
                $set: {
                  boardPollMisses: misses,
                  status: 'closed' as const,
                  closedReason: 'board-poll-miss' as const,
                  closedAt,
                  purgeAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
                },
              }
          : { $set: { boardPollMisses: misses } }
        return [{
          updateOne: {
            filter: { _id: doc._id, status: 'open' as const, updatedAt: doc.updatedAt },
            update,
          },
        }]
      })
      if (lifecycleOps.length) await JobPosting.bulkWrite(lifecycleOps, { session })
    }

    await JobIngestCycle.create([{
      kind: 'sync',
      sourceId,
      ...(operationId ? { operationId } : {}),
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
      // Durable run usage survives Inngest worker/step retries. The memoized
      // per-chunk claim total is the fail-closed fallback if Redis becomes
      // unavailable only after all provider calls completed.
      quotaSpent: durableQuotaSpent ?? total.attempts,
      ...(total.requestStopReason ? { requestStopReason: total.requestStopReason } : {}),
      healthTransitions: newHealth !== config.health ? [`${config.health}->${newHealth}`] : [],
    }], { session })
    return true
  }))
  } catch (error) {
    if (error instanceof SourceAuthorityChangedError) {
      return skip('source authority changed during sync', 'source-authority-changed')
    }
    if (error instanceof SourceTransactionsRequiredError) {
      logger.error({ error, sourceId, controlRevision }, 'jobs source sync blocked: Mongo transactions unavailable')
    }
    throw error
  }

  await step.run('complete-run-now-operation', () => markSourceOperationTerminal(
    operationId,
    'run-now',
    total.requestStopReason ? 'failed' : 'succeeded',
    total.requestStopReason,
  ))

  return { cycleWritten: true, counters: total.counters }
}

export interface SourceValidationEvent {
  id?: string
  data: {
    sourceId: string
    controlRevision: number
    operationalRevision: number
    operationId?: string
  }
}

/** One bounded, quota-metered provider observation while the source is
 * paused. Validation records evidence only; it never changes lifecycle or
 * provider health. Enable remains a separate audited CAS operation. */
export async function runSourceValidationHandler(
  event: SourceValidationEvent,
  step: StepRunner,
): Promise<{ validated: true; status: 'healthy' | 'failed'; usablePostings: number } | { skipped: true; reason: string }> {
  await connectDB()
  const { sourceId, controlRevision, operationalRevision } = event.data
  const operationId = event.data.operationId
  const skip = async (reason: string, errorCode: string) => {
    await markSourceOperationTerminal(operationId, 'validate', 'failed', errorCode)
    return { skipped: true as const, reason }
  }
  if (
    !Number.isInteger(controlRevision) || controlRevision < 0 ||
    !Number.isInteger(operationalRevision) || operationalRevision < 0
  ) return skip('invalid source revisions', 'invalid-source-revisions')

  const config = await JobSourceConfig.findOne({ sourceId }).lean()
  if (!config || config.enabled || config.health === 'revoked') {
    return skip('source is not paused and validation-eligible', 'source-validation-ineligible')
  }
  if (
    controlRevisionOf(config) !== controlRevision ||
    operationalRevisionOf(config) !== operationalRevision
  ) return skip('stale source revisions', 'stale-source-revisions')

  const definition = jobSourceDefinition(sourceId)
  const adapter = resolveAdapter(sourceId, config.kind)
  if (!definition || !sourceCatalogIdentityMatches(config) || !adapter) {
    return skip('source adapter unavailable', 'source-adapter-unavailable')
  }
  if (!operationId) return { skipped: true, reason: 'validation operation identity unavailable' }
  const runId = event.id ?? operationId
  const requestBudget = effectiveSourceRequestBudget(config)
  if (!requestBudget) return skip('request budget unavailable', 'request-budget-unavailable')
  const quota = makeSourceQuotaGuard(redis, sourceId, runId, requestBudget)
  await assertSourceWorkerReadiness(config)

  const observation = await step.run('probe-source', async () => {
    try {
      await assertSourceValidationAuthority(sourceId, controlRevision, operationalRevision)
    } catch (error) {
      if (error instanceof SourceAuthorityChangedError) return { authorityChanged: true as const }
      throw error
    }
    const configuredCredential = sourceCredentialStatus(definition)
    if (configuredCredential === 'missing') {
      return {
        authorityChanged: false as const,
        status: 'failed' as const,
        credentialStatus: 'missing' as const,
        usablePostings: 0,
        requestAttempts: 0,
        errorCode: 'credential-missing',
      }
    }
    const targets = adapter.buildTargets(
      {
        sourceId: config.sourceId,
        enabled: true,
        slug: definition.slug,
        atsKind: definition.atsKind,
        displayName: definition.displayName,
      },
      [],
    )
    if (!targets.length) {
      return {
        authorityChanged: false as const,
        status: 'failed' as const,
        credentialStatus: configuredCredential,
        usablePostings: 0,
        requestAttempts: 0,
        errorCode: 'validation-target-unavailable',
      }
    }
    let physicalClaims = 0
    const res = await adapter.fetch(targets[0], {
      beforePhysicalRequest: async () => {
        await assertSourceValidationAuthority(sourceId, controlRevision, operationalRevision)
        const decision = await quota.beforeRequest()
        if (!decision) physicalClaims++
        return decision
      },
    })
    if (res.authorityChanged) return { authorityChanged: true as const }
    const credentialStatus = res.status === 401 || res.status === 403
      ? 'rejected' as const
      : configuredCredential
    let usablePostings = 0
    for (const raw of res.raw) {
      try {
        if (adapter.normalize(raw, targets[0])) usablePostings++
      } catch {
        // A provider-shaped row that crashes normalization is unusable probe
        // evidence and must not make validation healthy.
      }
    }
    const status = res.ok && !res.bodyError && usablePostings > 0 ? 'healthy' as const : 'failed' as const
    const errorCode = status === 'healthy'
      ? undefined
      : res.requestRejected ??
        (credentialStatus === 'rejected' ? 'credential-rejected' : null) ??
        (!res.ok ? `provider-status-${res.status}` : 'no-usable-postings')
    return {
      authorityChanged: false as const,
      status,
      credentialStatus,
      usablePostings,
      requestAttempts: await readSourceRunQuotaUsage(redis, sourceId, runId) ?? physicalClaims,
      ...(errorCode ? { errorCode } : {}),
    }
  })
  if (observation.authorityChanged) return skip('source authority changed during validation', 'source-authority-changed')

  return step.run('store-validation', async () => {
    try {
      await assertSourceValidationAuthority(sourceId, controlRevision, operationalRevision)
    } catch (error) {
      if (error instanceof SourceAuthorityChangedError) {
        return skip('source authority changed during validation', 'source-authority-changed')
      }
      throw error
    }
    try {
      await completeSourceValidation(
        sourceId,
        controlRevision,
        operationalRevision,
        operationId,
        {
          status: observation.status,
          credentialStatus: observation.credentialStatus,
          usablePostings: observation.usablePostings,
          requestAttempts: observation.requestAttempts,
          ...(observation.errorCode ? { errorCode: observation.errorCode } : {}),
        },
      )
    } catch (error) {
      if (!(error instanceof SourceAuthorityChangedError)) throw error
      return skip('source authority changed during validation', 'source-authority-changed')
    }
    return { validated: true as const, status: observation.status, usablePostings: observation.usablePostings }
  })
}

/**
 * Weekly board-liveness probe (§4.4): boards die silently (Paytm 404s,
 * CRED is a dead logo). 404/410 quarantines immediately; a quarantined
 * board needs TWO consecutive healthy probes to recover; sub-
 * minIndiaPostings yield 3 weeks running quarantines.
 */
export async function runBoardProbeHandler(
  step: StepRunner,
  runId = 'board-probe:missing-event-id',
): Promise<{ probed: number }> {
  await connectDB()
  const boards = await step.run('load-boards', async () =>
    // 'revoked' is a MANUAL legal block (ruling #9) — the liveness probe
    // must never touch it, or 404→quarantine→2-healthy-probes could
    // silently reactivate a legally-darkened board (Codex on #513).
    JobSourceConfig.find({ enabled: true, kind: 'ats-board', health: { $in: ['active', 'degraded', 'quarantined'] } }).lean()
  )
  let probed = 0
  for (const board of boards) {
    const didProbe = await step.run(`probe-${board.sourceId}`, async () => {
      const adapter = resolveAdapter(board.sourceId, board.kind)
      if (!sourceCatalogIdentityMatches(board) || !adapter) return false
      const controlRevision = controlRevisionOf(board)
      const operationalRevision = operationalRevisionOf(board)
      const definition = jobSourceDefinition(board.sourceId)
      const requestBudget = effectiveSourceRequestBudget(board)
      if (!requestBudget) return false
      const quota = makeSourceQuotaGuard(redis, board.sourceId, runId, requestBudget)
      try {
        await assertSourceWorkerReadiness(board)
        await assertSourceProbeAuthority(board.sourceId, controlRevision, operationalRevision)
      } catch (error) {
        if (error instanceof SourceAuthorityChangedError || error instanceof SourceOperationError) {
          logger.warn({ sourceId: board.sourceId, error }, 'jobs board probe skipped one source readiness blocker')
          return false
        }
        throw error
      }
      const targets = adapter.buildTargets({
        sourceId: board.sourceId,
        enabled: true,
        slug: definition?.slug,
        atsKind: definition?.atsKind,
        displayName: definition?.displayName,
      }, [])
      if (!targets.length) return false
      const res = await adapter.fetch(targets[0], {
        beforePhysicalRequest: async () => {
          await assertSourceProbeAuthority(board.sourceId, controlRevision, operationalRevision)
          return quota.beforeRequest()
        },
      })
      // A revoke during adapter pagination is not a provider failure and
      // must never write health based on the now-unauthorized observation.
      if (res.authorityChanged || res.requestRejected) return false
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
      if (Object.keys(update).length) {
        await JobSourceConfig.updateOne(
          {
            sourceId: board.sourceId,
            enabled: board.enabled,
            health: board.health,
            ...controlRevisionFilter(controlRevision),
            $and: [operationalRevisionFilter(operationalRevision)],
          },
          { $set: update }
        )
      }
      return true
    })
    if (didProbe) probed++
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
  async ({ event, step }) => runBoardProbeHandler(step as StepRunner, event.id)
)

export const jobsSourceValidateJob = inngest.createFunction(
  {
    id: 'jobs-source-validate',
    name: 'Jobs: validate paused source',
    retries: 2,
    concurrency: [{ limit: 2 }, { limit: 1, key: 'event.data.sourceId' }],
    onFailure: async ({ event }) => {
      const original = (event?.data as { event?: { data?: { operationId?: string } } })?.event?.data
      try {
        await connectDB()
        await markSourceOperationTerminal(original?.operationId, 'validate', 'failed', 'validation-failed-all-retries')
      } catch (error) {
        logger.warn({ error, operationId: original?.operationId }, 'jobs-source-validate onFailure terminal write failed')
      }
    },
    triggers: [{ event: 'jobs/source.validate' }],
  },
  async ({ event, step }) => runSourceValidationHandler(
    event as unknown as SourceValidationEvent,
    step as StepRunner,
  ),
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
      const original = (event?.data as { event?: { data?: { sourceId?: string; operationId?: string } } })?.event?.data
      const sourceId = original?.sourceId
      try {
        await connectDB()
        await JobIngestCycle.create({
          kind: 'sync',
          sourceId,
          ...(original?.operationId ? { operationId: original.operationId } : {}),
          startedAt: new Date(),
          finishedAt: new Date(),
          healthTransitions: ['sync-failed-all-retries'],
        })
        await markSourceOperationTerminal(original?.operationId, 'run-now', 'failed', 'sync-failed-all-retries')
      } catch (err) {
        logger.warn({ err, sourceId }, 'jobs-source-sync onFailure telemetry write failed')
      }
    },
    triggers: [{ event: 'jobs/source.sync' }],
  },
  async ({ event, step }) => runSourceSyncHandler(
    event as unknown as {
      id?: string
      data: { sourceId: string; controlRevision?: number; operationalRevision?: number; operationId?: string }
    },
    step as StepRunner
  )
)
