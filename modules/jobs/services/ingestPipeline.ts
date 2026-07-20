import { gzipSync, gunzipSync } from 'zlib'
import crypto from 'crypto'
import { JobPosting, type IJobPosting } from '@shared/db/models'
import { classifyJob, isBlockedApplyUrl, classifyApplyUrl, normalizeJdBody, displayJdBody, bodyHashOf } from './qualityGate'
import { companyKey, titleKey, titleTokens, locationKey, fingerprintOf, sourceKeyOf, isConfidentialCompany, titleJaccard, FUZZY_MERGE_JACCARD } from './identityResolver'
import type { NormalizedJob } from '../adapters/types'

/**
 * Ingest pipeline — CLASSIFY → IDENTITY → STORE for one batch of normalized
 * postings (INGESTION §4.2/§4.5). Deterministic throughout; the async LLM
 * verdict (ruling #16) attaches AFTER store and never runs here.
 *
 * The §4.2 false-merge guards, verbatim:
 *   #1 never merge same-source/different-externalId OPEN postings — the
 *      fingerprint is salted with the externalId on that collision;
 *   #2 confidential companies mint NO fingerprint and never merge;
 *   #3 provenance eviction (cap 8) preserves source diversity;
 *   #4 merge writes go through findOneAndUpdate on the winner doc — no
 *      delete-then-insert window.
 *
 * Mass-repost (run-level, §4.5): Redis sha1(body) counter over 7 days —
 * >3 distinct companyKeys = hard drop, 2-3 = 'repost' flag. Injected as a
 * dependency and FAIL-OPEN: Redis down must not stall ingestion.
 */

export interface IngestCounters {
  processed: number
  drops: Record<string, number>
  flagged: Record<string, number>
  newCount: number
  merged: number
  refreshed: number
  fuzzyMerged: number
  saltedInserts: number
  /** Rows that failed at the store layer — isolated, never batch-aborting. */
  storeErrors: number
}

export interface RepostCounterDeps {
  /** Returns distinct-company count for the body hash after registering companyKey. Fail-open: null. */
  registerRepost?: (bodyHash: string, companyKeyStr: string) => Promise<number | null>
  /** §4.5: when verdict collection is enabled (JobsVerdictConfig row, read
   *  once per sync), new survivors are stored `llmVerdict: {status:'pending'}`
   *  so the steady-state sweeper runs on the partial index. Disabled = no
   *  init, byte-identical docs. */
  initVerdictPending?: boolean
}

const PROVENANCE_CAP = 8

/** Defensive date parse — Mongoose rejects Invalid Date on Date paths, and
 *  classifyJob deliberately STORES bad-valid-through rows as flagged
 *  (visible, not silently alive) — so a malformed provider date must map to
 *  undefined, never Invalid Date (Codex on #510). */
function validDate(v: string | null | undefined): Date | undefined {
  if (!v) return undefined
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? undefined : d
}

function bump(rec: Record<string, number>, key: string): void {
  rec[key] = (rec[key] ?? 0) + 1
}

function usableApplyUrls(job: NormalizedJob): string[] {
  return job.applyOptions.map((o) => o.url).filter((u) => !isBlockedApplyUrl(u))
}

/** Best-tier apply URL for the snapshot fields (ties keep first-seen order). */
function bestApplyUrl(urls: string[]): string | null {
  if (!urls.length) return null
  return [...urls].sort((a, b) => {
    const rank = (u: string) => ['direct-ats', 'employer', 'aggregator-deep', 'platform-funnel', 'aggregator-redirect'].indexOf(classifyApplyUrl(u))
    return rank(a) - rank(b)
  })[0]
}

/**
 * Provenance eviction preserving source diversity (guard #3): when over cap,
 * evict the stalest entry among sourceIds that have MORE THAN ONE entry
 * first — a rotating aggregator id must not churn out the only entry from
 * another source.
 */
export function evictProvenance<T extends { sourceId: string; lastSeenAt: Date }>(entries: T[], cap = PROVENANCE_CAP): T[] {
  if (entries.length <= cap) return entries
  const sorted = [...entries].sort((a, b) => new Date(a.lastSeenAt).getTime() - new Date(b.lastSeenAt).getTime())
  while (sorted.length > cap) {
    const counts = new Map<string, number>()
    for (const e of sorted) counts.set(e.sourceId, (counts.get(e.sourceId) ?? 0) + 1)
    const victim = sorted.find((e) => (counts.get(e.sourceId) ?? 0) > 1) ?? sorted[0]
    sorted.splice(sorted.indexOf(victim), 1)
  }
  return sorted
}

interface PreparedPosting {
  job: NormalizedJob
  cKey: string
  tKey: string
  tokens: string[]
  locKey: string
  fp: string | null
  sourceKey: string | null
  usableUrls: string[]
  jdLen: number
  flags: string[]
}

function buildInsertDoc(p: PreparedPosting, sourceId: string, now: Date, saltedFp?: string | null, initVerdictPending?: boolean) {
  const jdNorm = normalizeJdBody(p.job.description)
  return {
    companyKey: p.cKey,
    titleKey: p.tKey,
    titleTokens: p.tokens,
    locationKeys: [p.locKey],
    fingerprint: saltedFp ?? p.fp ?? undefined,
    llmVerdict: initVerdictPending ? { status: 'pending' as const, attempts: 0 } : undefined,
    confidentialCompany: isConfidentialCompany(p.job.company),
    title: p.job.title.slice(0, 300),
    company: p.job.company.slice(0, 300),
    locations: p.job.city ? [p.job.city] : [],
    isRemote: p.job.isRemote,
    domain: p.job.domainHint,
    jdCompressed: jdNorm ? gzipSync(Buffer.from(jdNorm)) : undefined,
    // Display twin (founder item 7): block structure preserved for the
    // detail page; NEVER a hash input — jdCompressed stays the canonical
    // collapsed body for bodyHash/verdict/xray.
    jdDisplayCompressed: jdNorm ? gzipSync(Buffer.from(displayJdBody(p.job.description))) : undefined,
    jdLength: p.jdLen,
    provenance: p.job.externalId
      ? [(() => {
          const url = bestApplyUrl(p.usableUrls)
          return {
            sourceId,
            externalId: p.job.externalId,
            sourceKey: sourceKeyOf(sourceId, p.job.externalId),
            // undefined, never '' — Mongoose treats '' as missing for
            // required strings and the field is honest-optional now.
            applyUrl: url ?? undefined,
            applyTier: url ? classifyApplyUrl(url) : undefined,
            viaSite: p.job.viaSite || undefined,
            firstSeenAt: now,
            lastSeenAt: now,
          }
        })()]
      : [],
    flags: {
      staffing: p.flags.includes('staffing'),
      salaryConflict: false,
      shortJd: p.flags.includes('short-jd'),
      repost: p.flags.includes('repost'),
      repostCount: p.flags.includes('repost') ? 2 : 0,
    },
    status: 'open' as const,
    postedAt: validDate(p.job.postedAt),
    validThrough: validDate(p.job.validThrough),
    userReferenced: false,
  }
}

/** Close reasons that fresh source evidence may legitimately reverse.
 *  'llm-verdict' tombstones stay closed on unchanged content (ruling #16
 *  anti-resurrection — reopening is the verdict layer's decision on a body
 *  change), and 'source-revoked' is a legal state no fetch can undo. */
const REOPENABLE_CLOSE_REASONS = new Set(['aged-out', 'board-poll-miss', 'valid-through-expired'])

/** Merge an incoming posting into an existing canonical doc (§4.2 policy). */
export function mergeIntoDoc(doc: IJobPosting, p: PreparedPosting, sourceId: string, now: Date): void {
  // §4.5 'input change re-enqueues': the merge is the ONLY place a stored
  // row's verdict-hash components (JD body, apply URLs) mutate, so it owns
  // invalidating a scored verdict (adversarial review of Wave 2.3 — without
  // this, a scam body merged into a pre-scored clean posting keeps its
  // 'genuine' verdict forever, and §4.3 tombstone re-verdicts are dead).
  let verdictInputsChanged = false
  // Reopen on fresh evidence (Codex on #510): a posting closed for
  // ABSENCE-class reasons that the source is now serving again must return
  // to the open pool — otherwise the refresh saves a hidden doc and the
  // job never re-enters serving until purge deletes it.
  if (doc.status === 'closed' && (!doc.closedReason || REOPENABLE_CLOSE_REASONS.has(doc.closedReason))) {
    doc.status = 'open'
    doc.closedReason = undefined
    doc.closedAt = undefined
    doc.purgeAt = undefined
  }
  // Provenance: refresh same sourceKey, else append (respecting cap+diversity).
  const sk = p.sourceKey
  if (sk) {
    const existing = doc.provenance.find((e) => e.sourceKey === sk)
    if (existing) {
      existing.lastSeenAt = now
      // The source's CURRENT payload is the live truth for its own row
      // (Codex on #510): a row that first arrived url-less — or whose link
      // has since changed — must pick up the apply path the source serves
      // today. Absence in the incoming payload never erases a stored link.
      const url = bestApplyUrl(p.usableUrls)
      if (url && url !== existing.applyUrl) {
        existing.applyUrl = url
        existing.applyTier = classifyApplyUrl(url)
        // Dead-click reports indict a URL, not a rung: the source shipping a
        // NEW url gets a clean slate — count > 0 would keep demoting a link
        // nobody reported (Codex on #522 round-3).
        existing.brokenReportCount = undefined
        verdictInputsChanged = true
        // A REPLACED apply URL is fresh liveness evidence (Codex #543): a
        // dead-apply-link closure was earned by the OLD link — reopen and
        // let the sweep re-verify from scratch. Same-URL refreshes stay
        // closed (spam re-uploads must not resurrect themselves). The
        // strike state clears on OPEN rows too (round 5): a stale strike-1
        // earned by the old URL must never combine with one dead check of
        // the new URL into a close — two strikes always mean two strikes
        // against the CURRENT link.
        doc.applyCheck = undefined
        if (doc.status === 'closed' && doc.closedReason === 'dead-apply-link') {
          doc.status = 'open'
          doc.closedReason = undefined
          doc.closedAt = undefined
          doc.purgeAt = undefined
        }
      }
      if (p.job.viaSite) existing.viaSite = p.job.viaSite
    } else {
      const url = bestApplyUrl(p.usableUrls)
      // A NEW source key contributing a usable URL is the same fresh
      // liveness evidence as a replaced one (Codex #543 round 2:
      // aggregators rotate externalIds — the append path must reopen
      // dead-apply-link closures too, or the fresh live URL is never
      // re-evaluated).
      if (url) {
        // New rung with a usable URL = the posting's link set changed —
        // stale strikes never carry across (round 5).
        doc.applyCheck = undefined
        if (doc.status === 'closed' && doc.closedReason === 'dead-apply-link') {
          doc.status = 'open'
          doc.closedReason = undefined
          doc.closedAt = undefined
          doc.purgeAt = undefined
        }
      }
      doc.provenance.push({
        sourceId,
        externalId: p.job.externalId as string,
        sourceKey: sk,
        applyUrl: url ?? undefined,
        applyTier: url ? classifyApplyUrl(url) : undefined,
        viaSite: p.job.viaSite || undefined,
        firstSeenAt: now,
        lastSeenAt: now,
      })
      doc.provenance = evictProvenance(doc.provenance)
      if (url) verdictInputsChanged = true // new apply host joins the hash input
    }
  }
  // JD: longest normalized body wins.
  if (p.jdLen > (doc.jdLength ?? 0)) {
    const jdNorm = normalizeJdBody(p.job.description)
    doc.jdCompressed = gzipSync(Buffer.from(jdNorm))
    doc.jdDisplayCompressed = gzipSync(Buffer.from(displayJdBody(p.job.description)))
    doc.jdLength = p.jdLen
    verdictInputsChanged = true
  } else if (!doc.jdDisplayCompressed && doc.jdCompressed && p.job.description) {
    // Legacy heal (founder item 7): pre-PR-C rows have no display twin.
    // When the SAME body re-ingests (exact normalized match), write the
    // display artifact WITHOUT touching jdCompressed — no bodyHash,
    // verdict-hash, or xray churn (verdictInputsChanged stays false).
    const jdNorm = normalizeJdBody(p.job.description)
    let existing = ''
    try {
      const buf = doc.jdCompressed as Buffer
      existing = gunzipSync(Buffer.isBuffer(buf) ? buf : Buffer.from((buf as unknown as { buffer: ArrayBufferLike }).buffer as ArrayBuffer)).toString('utf8')
    } catch { /* corrupt gzip — skip the heal */ }
    if (jdNorm && jdNorm === existing) {
      doc.jdDisplayCompressed = gzipSync(Buffer.from(displayJdBody(p.job.description)))
    }
  }
  // postedAt: earliest non-null (aggregators re-stamp reposts).
  const incoming = validDate(p.job.postedAt) ?? null
  if (incoming && (!doc.postedAt || incoming < doc.postedAt)) doc.postedAt = incoming
  // locations: union of location keys (bounded by metro cardinality).
  if (p.locKey && !doc.locationKeys.includes(p.locKey)) doc.locationKeys.push(p.locKey)
  if (p.job.city && !doc.locations.includes(p.job.city)) doc.locations.push(p.job.city)
  // Flags only ever tighten deterministically here (staffing/shortJd recompute
  // is left to the winner's own classify — a merged stub must not unset them).
  // ANY existing verdict state resets — scored verdicts are stale, and an
  // attempts-exhausted pending row would otherwise be skipped forever by
  // both worker (>=MAX) and sweeper ($lt) despite changed content
  // (Codex on #515).
  if (verdictInputsChanged && doc.llmVerdict) {
    doc.llmVerdict.status = 'pending'
    doc.llmVerdict.attempts = 0 // new input = fresh attempt budget
  }
}

const MERGE_SAVE_ATTEMPTS = 2

function isStaleMergeSave(error: unknown): boolean {
  const name = (error as { name?: unknown } | null)?.name
  return name === 'DocumentNotFoundError' || name === 'VersionError'
}

/**
 * Persist a merge against the exact lifecycle/version that was inspected.
 *
 * `mergeIntoDoc` legitimately reopens normal expiry closures. A plain
 * hydrated `save()` could therefore reopen a newer source-revoked or
 * llm-verdict close that landed after the identity lookup. Mongoose's
 * documented `$where` save predicate turns that write into a CAS. On a miss
 * we discard the mutated stale document, re-read, and re-apply policy to the
 * current lifecycle; restricted rows may refresh identity inputs but can
 * never be reopened by this layer.
 */
async function mergeAndSaveWithLifecycleCas(
  initial: IJobPosting,
  prepared: PreparedPosting,
  sourceId: string,
  now: Date,
): Promise<void> {
  let doc = initial
  for (let attempt = 0; attempt < MERGE_SAVE_ATTEMPTS; attempt++) {
    const expectedStatus = doc.status
    const expectedClosedReason = doc.closedReason
    const expectedUpdatedAt = doc.updatedAt
    mergeIntoDoc(doc, prepared, sourceId, now)
    const where: Record<string, unknown> = {
      status: expectedStatus,
      updatedAt: expectedUpdatedAt,
    }
    if (expectedStatus === 'closed') {
      where.closedReason = expectedClosedReason ?? { $exists: false }
    }
    const guardedDoc = doc as IJobPosting & { $where: Record<string, unknown> }
    guardedDoc.$where = where
    try {
      // Explicit acknowledgement is required for Mongoose to surface a
      // zero-match custom `$where` predicate as DocumentNotFoundError.
      await doc.save({ w: 1 })
      return
    } catch (error) {
      if (!isStaleMergeSave(error) || attempt + 1 >= MERGE_SAVE_ATTEMPTS) throw error
      const latest = await JobPosting.findById(doc._id)
      if (!latest) throw error
      doc = latest
    }
  }
}

export async function ingestBatch(
  jobs: NormalizedJob[],
  sourceId: string,
  deps: RepostCounterDeps = {}
): Promise<IngestCounters> {
  const counters: IngestCounters = {
    processed: 0, drops: {}, flagged: {}, newCount: 0, merged: 0, refreshed: 0, fuzzyMerged: 0, saltedInserts: 0, storeErrors: 0,
  }
  const now = new Date()

  for (const job of jobs) {
    counters.processed++
    const urls = job.applyOptions.map((o) => o.url)
    const { drops, flags, jdLen } = classifyJob({
      title: job.title,
      company: job.company,
      description: job.description,
      applyUrls: urls,
      validThrough: job.validThrough,
    })

    // Run-level mass-repost (fail-open on Redis absence/errors).
    const effectiveFlags: string[] = [...flags]
    let massRepost = false
    const bh = bodyHashOf(job.description)
    if (bh && deps.registerRepost) {
      const distinctCompanies = await deps.registerRepost(bh, companyKey(job.company)).catch(() => null)
      if (distinctCompanies !== null) {
        if (distinctCompanies > 3) massRepost = true
        else if (distinctCompanies >= 2) effectiveFlags.push('repost')
      }
    }

    if (drops.length || massRepost) {
      for (const d of drops) bump(counters.drops, d)
      if (massRepost) bump(counters.drops, 'mass-repost')
      continue // hard drops are never stored (§4.5 floor)
    }
    for (const f of effectiveFlags) bump(counters.flagged, f)

    const prepared: PreparedPosting = {
      job,
      cKey: companyKey(job.company),
      tKey: titleKey(job.title),
      tokens: titleTokens(job.title),
      locKey: locationKey(job.city, job.isRemote),
      fp: fingerprintOf(job.company, job.title, job.city, job.isRemote),
      sourceKey: job.externalId ? sourceKeyOf(sourceId, job.externalId) : null,
      usableUrls: usableApplyUrls(job),
      jdLen,
      flags: effectiveFlags,
    }

    // Per-row isolation (Codex on #510): one malformed row must count as a
    // store error and continue — never abort the rest of the batch.
    try {
    // ── Identity ladder ──
    // Tier 1: sourceKey refresh.
    if (prepared.sourceKey) {
      const bySource = await JobPosting.findOne({ 'provenance.sourceKey': prepared.sourceKey })
      if (bySource) {
        await mergeAndSaveWithLifecycleCas(bySource, prepared, sourceId, now)
        counters.refreshed++
        continue
      }
    }

    // Tier 2: canonical fingerprint (absent for confidential — guard #2).
    if (prepared.fp) {
      const byFp = await JobPosting.findOne({ fingerprint: prepared.fp })
      if (byFp) {
        // Guard #1: same source, different externalId, both open ⇒ distinct
        // postings (multiple openings of one role) — salt, insert, never merge.
        const sameSourceDifferentExternal =
          byFp.status === 'open' &&
          !!prepared.job.externalId &&
          byFp.provenance.some((e) => e.sourceId === sourceId && e.externalId !== prepared.job.externalId)
        if (sameSourceDifferentExternal) {
          const salted = fingerprintOf(job.company, job.title, job.city, job.isRemote, prepared.job.externalId as string)
          await JobPosting.create(buildInsertDoc(prepared, sourceId, now, salted, deps.initVerdictPending))
          counters.saltedInserts++
          counters.newCount++
          continue
        }
        await mergeAndSaveWithLifecycleCas(byFp, prepared, sourceId, now)
        counters.merged++
        continue
      }
    }

    // Tier 3: fuzzy — COMPANY-SCOPED only, location overlap, Jaccard ≥ 0.85.
    if (!isConfidentialCompany(job.company)) {
      const candidates = await JobPosting.find({ companyKey: prepared.cKey, status: 'open' }).limit(20)
      const match = candidates.find(
        (c) =>
          c.locationKeys.includes(prepared.locKey) &&
          titleJaccard(c.titleKey, prepared.tKey) >= FUZZY_MERGE_JACCARD &&
          // Guard #1 applies to the fuzzy tier too (Codex on #510): a
          // candidate already carrying this source under a DIFFERENT
          // externalId is a sibling requisition, not the same posting.
          !(prepared.job.externalId && c.provenance.some((e) => e.sourceId === sourceId && e.externalId !== prepared.job.externalId))
      )
      if (match) {
        await mergeAndSaveWithLifecycleCas(match, prepared, sourceId, now)
        counters.fuzzyMerged++
        counters.merged++
        continue
      }
    }

    // Tier 4: insert.
    await JobPosting.create(buildInsertDoc(prepared, sourceId, now, undefined, deps.initVerdictPending))
    counters.newCount++
    } catch {
      counters.storeErrors++
    }
  }

  return counters
}

/**
 * Redis-backed 7d mass-repost counter (§4.5): sha1(body) → set of
 * companyKeys. Returns the distinct-company count AFTER registering.
 * Fail-open (null) on any Redis error — ingestion never stalls on Redis.
 */
export function makeRedisRepostCounter(redis: {
  sadd: (k: string, v: string) => Promise<number>
  expire: (k: string, s: number) => Promise<number>
  scard: (k: string) => Promise<number>
}): NonNullable<RepostCounterDeps['registerRepost']> {
  return async (bodyHash, companyKeyStr) => {
    try {
      const key = `jobs:repost:7d:${bodyHash}`
      const added = await redis.sadd(key, crypto.createHash('sha1').update(companyKeyStr).digest('hex').slice(0, 12))
      if (added === 1) await redis.expire(key, 7 * 24 * 3600)
      return await redis.scard(key)
    } catch {
      return null
    }
  }
}
