#!/usr/bin/env node
/**
 * Jobs supply liquidity probe — Phase 0 build gate for the Jobs feature.
 * Spec: modules/jobs/docs/INGESTION.md §6 (gates G1–G6).
 *
 * Standalone: Node >= 18, zero repo imports, zero deps.
 * The normalization functions and spam rules here are the REFERENCE
 * implementations for the future modules/jobs pipeline (identityResolver /
 * qualityGate) — the probe validates the exact fingerprint the pipeline
 * will mint.
 *
 * DESIGN PRINCIPLE (post-review v2): every gate input is either
 * verified-good, explicitly errored, or explicitly PENDING — nothing
 * silently defaults. Errored/partial buckets count as ZERO usable
 * (conservative: biases toward FAIL); >10% errored invalidates the
 * snapshot for gating; `report` refuses stale-format or unpaired
 * artifacts rather than guessing.
 *
 * Commands:
 *   pilot                       12 buckets via JSearch (needs RAPIDAPI_KEY) — classification sanity check
 *   snapshot [--no-fresher]     all buckets incl. fresher variants (default ON) -> probe-data/snapshot-<ts>.json
 *   fresh <A.json> <B.json>     net-new fingerprints between two snapshots (>=24h apart) -> G2
 *   rot <snapshot.json>         stratified dead-link check -> G4 half, persisted for `report`
 *   india [--sample N]          FREE, no key: apna sitemap JSON-LD + Unstop public API sampling
 *   report                      evaluate gates from the latest saved artifacts (strict pairing)
 *
 * Env: RAPIDAPI_KEY (JSearch commands only).
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const SCHEMA_VERSION = 2
// fileURLToPath, not URL.pathname — the latter yields /C:/... on Windows
// and every artifact read/write breaks (Bugbot on #503).
const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'probe-data')
const UA = 'InterviewPrepGuruProbe/0.2 (+https://interviewprep.guru; supply-liquidity-probe; contact: abhishek.apurv00@gmail.com)'
const JSEARCH_HOST = 'jsearch.p.rapidapi.com'

// ---------------------------------------------------------------------------
// Bucket matrix — 13 measured domains x 6 metros + 12 remote + 10 fresher.
// Fresher variants are ON by default: G1f/G6 exist to measure the majority
// segment, so the default flow must sample them (Codex on #503).
// ---------------------------------------------------------------------------
const DOMAINS = [
  { id: 'backend',      q: 'backend developer' },
  { id: 'frontend',     q: 'frontend developer' },
  { id: 'sdet',         q: 'qa engineer' },
  { id: 'data',         q: 'data analyst' },
  { id: 'devops',       q: 'devops engineer' },
  { id: 'pm',           q: 'product manager' },
  { id: 'marketing',    q: 'digital marketing' },
  { id: 'sales',        q: 'sales executive' },
  { id: 'business',     q: 'business analyst' },
  { id: 'finance',      q: 'financial analyst' },
  { id: 'hr',           q: 'hr recruiter' },
  { id: 'design',       q: 'ui ux designer' },
  { id: 'electrical',   q: 'electrical engineer' },
]
const METROS = ['Bengaluru', 'Delhi NCR', 'Mumbai', 'Hyderabad', 'Pune', 'Chennai']
const REMOTE_DOMAINS = DOMAINS.filter(d => d.id !== 'electrical').map(d => d.id) // 12
const FRESHER_DOMAINS = ['marketing', 'sales', 'electrical', 'data', 'hr']       // measured fresher-heavy

function buildBuckets({ fresher = true } = {}) {
  const buckets = []
  for (const d of DOMAINS) for (const m of METROS)
    buckets.push({ id: `${d.id}:${m.toLowerCase().replace(/ /g, '-')}`, domain: d.id, query: `${d.q} in ${m}` })
  for (const id of REMOTE_DOMAINS) {
    const d = DOMAINS.find(x => x.id === id)
    buckets.push({ id: `${id}:remote`, domain: id, query: `remote ${d.q} india` })
  }
  if (fresher) for (const id of FRESHER_DOMAINS) for (const m of ['Bengaluru', 'Delhi NCR']) {
    const d = DOMAINS.find(x => x.id === id)
    buckets.push({ id: `${id}:fresher:${m.toLowerCase().replace(/ /g, '-')}`, domain: id, fresher: true, query: `${d.q} fresher in ${m}` })
  }
  return buckets
}

// ---------------------------------------------------------------------------
// Normalization — REFERENCE implementation for modules/jobs identityResolver.
// companyKey strips LEGAL suffixes only (never "solutions"/"technologies" —
// half of India's consultancy namespace); titleKey keeps seniority tokens.
// ---------------------------------------------------------------------------
const LEGAL_SUFFIX_RE = /\b(pvt|private|ltd|limited|llp|inc|incorporated|corp|corporation)\b\.?/g
const TITLE_STOPWORDS = new Set(['the', 'a', 'an', 'and', 'or', 'for', 'of', 'in', 'at', 'to', 'with'])
const METRO_ALIASES = {
  gurgaon: 'delhi-ncr', gurugram: 'delhi-ncr', noida: 'delhi-ncr', 'greater noida': 'delhi-ncr',
  'new delhi': 'delhi-ncr', delhi: 'delhi-ncr', 'delhi ncr': 'delhi-ncr', ncr: 'delhi-ncr',
  ghaziabad: 'delhi-ncr', faridabad: 'delhi-ncr',
  bangalore: 'bengaluru', bengaluru: 'bengaluru', 'bangalore urban': 'bengaluru',
  mumbai: 'mumbai', 'navi mumbai': 'mumbai', thane: 'mumbai',
  hyderabad: 'hyderabad', secunderabad: 'hyderabad',
  pune: 'pune', chennai: 'chennai',
}

export function companyKey(name = '') {
  return name.toLowerCase().replace(LEGAL_SUFFIX_RE, '').replace(/[^\p{L}\p{N} ]/gu, ' ').replace(/\s+/g, ' ').trim()
}
export function titleKey(title = '') {
  const stripped = title.replace(/\(.*?\)|\[.*?\]/g, ' ').toLowerCase()
  return stripped.split(/[^\p{L}\p{N}+#]+/u).filter(t => t && !TITLE_STOPWORDS.has(t)).sort().join(' ')
}
export function locationKey(city = '', isRemote = false) {
  if (isRemote) return 'remote-in'
  // Collapse separator spelling ("Delhi-NCR" / "Delhi NCR" / "delhi_ncr")
  // BEFORE alias lookup — source-dependent spelling must not mint distinct
  // fingerprints for the same metro (Codex on #503).
  const c = city.toLowerCase().replace(/[-_/]+/g, ' ').replace(/\s+/g, ' ').trim()
  return METRO_ALIASES[c] || (c ? c.replace(/ /g, '-') : 'unknown')
}
export function fingerprint(company, title, city, isRemote) {
  return crypto.createHash('sha256').update(`${companyKey(company)}|${titleKey(title)}|${locationKey(city, isRemote)}`).digest('hex').slice(0, 24)
}

// ---------------------------------------------------------------------------
// Quality gate — REFERENCE implementation for modules/jobs qualityGate.
// ---------------------------------------------------------------------------
const APPLY_DOMAIN_BLOCKLIST = ['bit.ly', 'forms.gle', 'wa.me', 'api.whatsapp.com', 't.me', 'tinyurl.com']
const CONSULTANCY_RE = /\b(consultanc\w*|consultants?|staffing|manpower|placements?|recruitment\s+(services|agency|firm)|hr\s+(services|solutions)|talent\s+(acquisition|solutions)\s+(llp|pvt|private))\b/i
const FEE_FRAUD_RE = /\b(registration|security)\s+(fee|deposit|amount)\b|\bpay(ment)?\s+(for|before)\s+(training|joining)\b|\brefundable\s+deposit\b/i
// INGESTION.md §4.5 contact-spam: phone/WhatsApp solicitation in the body
// AND no apply link above redirect tier — a call-the-HR harvesting pattern.
const CONTACT_SPAM_RE = /(\bcall\b|\bwhats\s?app\b)[\s\S]{0,60}?(\+91[\s-]?)?\b[6-9]\d{9}\b|(\+91[\s-]?)?\b[6-9]\d{9}\b[\s\S]{0,60}?(\bcall\b|\bwhats\s?app\b)/i

function hostOf(u) { try { return new URL(u).hostname.toLowerCase() } catch { return '' } }
// Exact host or registrable-suffix match ONLY — substring includes() matched
// 'recruit.meesho.com'.includes('t.me') and hard-dropped legitimate employers.
function hostMatches(host, entry) { return host === entry || host.endsWith('.' + entry) }
// A blocklisted host is never an apply path, ANYWHERE — not for contact-spam
// exemption, not for tier ranking, not for usable/G4, not for rot sampling.
// classifyApplyUrl falls unknown hosts through to 'employer', so every tier
// consumer must filter through this first (Bugbot on #503).
export function isBlockedApplyUrl(u) { return APPLY_DOMAIN_BLOCKLIST.some(b => hostMatches(hostOf(u), b)) }

export function classifyJob({ title = '', company = '', description = '', applyUrls = [], validThrough = null }) {
  const drops = [], flags = []
  const t = title.trim()
  if (!company.trim()) drops.push('no-company')
  if (/\bwalk[\s-]?in\b/i.test(t)) drops.push('title-walkin')
  if (/(\+91[\s-]?)?\b[6-9]\d{9}\b/.test(t)) drops.push('title-phone')
  if (t.split('/').length > 3) drops.push('title-multirole')
  if (/\b\d+\s*openings?\b/i.test(t)) drops.push('title-openings')
  const letters = t.replace(/[^a-zA-Z]/g, '')
  if (letters.length > 10 && letters.replace(/[^A-Z]/g, '').length / letters.length > 0.7) drops.push('title-caps')
  if (FEE_FRAUD_RE.test(description)) drops.push('fee-fraud')
  const hasNonRedirectApply = applyUrls.some(u => !isBlockedApplyUrl(u) && classifyApplyUrl(u) !== 'aggregator-redirect')
  if (CONTACT_SPAM_RE.test(description) && !hasNonRedirectApply) drops.push('contact-spam')
  if (applyUrls.length && applyUrls.every(isBlockedApplyUrl)) drops.push('blocklist-apply-domain')
  if (validThrough && new Date(validThrough).getTime() < Date.now()) drops.push('valid-through-expired')

  if (CONSULTANCY_RE.test(company)) flags.push('staffing')
  if (/\bconfidential\b/i.test(company)) flags.push('confidential')
  const jdLen = description.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().length
  if (jdLen < 400) flags.push('short-jd')
  return { drops, flags, jdLen }
}

// ---------------------------------------------------------------------------
// Apply-tier ladder (INGESTION.md §4.2)
// ---------------------------------------------------------------------------
const ATS_HOSTS = ['greenhouse.io', 'lever.co', 'smartrecruiters.com', 'ashbyhq.com', 'workable.com', 'bamboohr.com', 'jobvite.com', 'icims.com', 'myworkdayjobs.com']
const AGG_DEEP_HOSTS = ['naukri.com', 'linkedin.com', 'indeed.com', 'shine.com', 'foundit.in', 'monsterindia.com', 'timesjobs.com', 'glassdoor.com', 'glassdoor.co.in']
const FUNNEL_HOSTS = ['apna.co', 'unstop.com', 'internshala.com', 'cutshort.io', 'instahyre.com']
export function classifyApplyUrl(url) {
  const h = hostOf(url)
  if (!h) return 'aggregator-redirect'
  if (ATS_HOSTS.some(a => hostMatches(h, a))) return 'direct-ats'
  if (AGG_DEEP_HOSTS.some(a => hostMatches(h, a))) return 'aggregator-deep'
  if (FUNNEL_HOSTS.some(a => hostMatches(h, a))) return 'platform-funnel'
  if (h.includes('google.') || h === 'g.co') return 'aggregator-redirect'
  return 'employer'
}
const TIER_RANK = { 'direct-ats': 0, employer: 1, 'aggregator-deep': 2, 'platform-funnel': 3, 'aggregator-redirect': 4 }
function bestTier(urls) { return urls.map(classifyApplyUrl).sort((a, b) => TIER_RANK[a] - TIER_RANK[b])[0] || null }
/** Tier of the best NON-BLOCKLISTED apply URL — the only tier gate math may use. */
export function bestUsableTier(urls) { return bestTier(urls.filter(u => !isBlockedApplyUrl(u))) }

// ---------------------------------------------------------------------------
// HTTP — body is consumed INSIDE the abort window (a stalled body previously
// escaped the timeout entirely), and every physical attempt is countable.
// Retries: 5xx/network only, never 4xx (a 429 retry just burns quota).
// ---------------------------------------------------------------------------
const sleep = ms => new Promise(r => setTimeout(r, ms))
async function request(url, { headers = {}, timeoutMs = 15000, retries = 1, onAttempt = null, wantJson = false } = {}) {
  for (let attempt = 0; ; attempt++) {
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), timeoutMs)
    try {
      if (onAttempt) onAttempt()
      const res = await fetch(url, { headers: { 'user-agent': UA, ...headers }, signal: ctl.signal, redirect: 'follow' })
      if (res.status >= 500 && attempt < retries) { clearTimeout(timer); await sleep(1500); continue }
      // Read the body while the abort timer is still armed.
      const text = await res.text()
      clearTimeout(timer)
      if (!wantJson) return { status: res.status, ok: res.ok, text }
      let json = null
      try { json = JSON.parse(text) } catch { /* bad body — caller decides */ }
      return { status: res.status, ok: res.ok, json }
    } catch (err) {
      clearTimeout(timer)
      if (attempt < retries) { await sleep(1500); continue }
      throw err
    }
  }
}
const getText = (url, opts = {}) => request(url, { ...opts, wantJson: false })
const getJson = (url, opts = {}) => request(url, { ...opts, wantJson: true })

let jsearchQuota = 0 // counts PHYSICAL attempts, including retries and failures
async function jsearch(query, { datePosted = 'week', page = 1 } = {}) {
  const key = process.env.RAPIDAPI_KEY
  if (!key) { console.error('RAPIDAPI_KEY not set — JSearch commands need a JSearch subscription key from https://rapidapi.com/letscrape-6bRBa3QguO5/api/jsearch'); process.exit(2) }
  const u = new URL(`https://${JSEARCH_HOST}/search`)
  u.searchParams.set('query', query)
  u.searchParams.set('page', String(page))
  u.searchParams.set('num_pages', '1')
  u.searchParams.set('date_posted', datePosted)
  u.searchParams.set('country', 'in')
  const res = await getJson(u, { headers: { 'x-rapidapi-key': key, 'x-rapidapi-host': JSEARCH_HOST }, retries: 1, timeoutMs: 30000, onAttempt: () => { jsearchQuota++ } })
  if (!res.ok) return { ok: false, status: res.status, jobs: [] }
  // HTTP 200 with an unparseable or error-shaped body is an ERROR, not
  // zero supply (RapidAPI can 200 an error envelope).
  const body = res.json
  if (!body || (body.status && body.status !== 'OK') || !Array.isArray(body.data)) return { ok: false, status: res.status, jobs: [], bodyError: true }
  return { ok: true, status: res.status, jobs: body.data }
}

export function normalizeJSearchJob(j) {
  const applyOptions = (j.apply_options || []).map(o => ({ url: o.apply_link, publisher: o.publisher, isDirect: !!o.is_direct }))
  if (j.job_apply_link && !applyOptions.some(o => o.url === j.job_apply_link)) applyOptions.push({ url: j.job_apply_link, publisher: j.job_publisher, isDirect: !!j.job_apply_is_direct })
  return {
    title: j.job_title || '', company: j.employer_name || '',
    city: j.job_city || j.job_state || '', isRemote: !!j.job_is_remote,
    description: j.job_description || '', postedAt: j.job_posted_at_datetime_utc || null,
    // Expiration must reach the quality gate — dropping it let expired
    // postings count as usable supply (Codex on #503).
    validThrough: j.job_offer_expiration_datetime_utc || null,
    viaSite: (j.job_publisher || '').toLowerCase(), applyOptions,
  }
}

// ---------------------------------------------------------------------------
// Bucket runner
// ---------------------------------------------------------------------------
const MAX_PAGES_PER_BUCKET = 3 // INGESTION.md §4.4 hard cap
async function fetchBucketJobs(bucket) {
  const all = []
  let status = 0, pages = 0, partialStatus = null, lastPageFull = false
  for (let page = 1; page <= MAX_PAGES_PER_BUCKET; page++) {
    const res = await jsearch(bucket.query, { page })
    status = res.status
    if (!res.ok) {
      // Non-OK on page 1 = errored bucket. Non-OK on page >=2 = PARTIAL
      // bucket — it must not masquerade as a small-but-valid sample.
      if (page === 1) return { ok: false, status: res.bodyError ? `bad-body-${res.status}` : res.status, jobs: [], pages, capped: false }
      partialStatus = res.bodyError ? `bad-body-${res.status}` : res.status
      break
    }
    pages++
    all.push(...res.jobs)
    lastPageFull = res.jobs.length >= 10
    if (!lastPageFull) break // short page = result set exhausted
    if (page < MAX_PAGES_PER_BUCKET) await sleep(1100)
  }
  return { ok: true, status, jobs: all, pages, partialStatus, capped: pages === MAX_PAGES_PER_BUCKET && lastPageFull }
}

async function runBucket(bucket) {
  const fetched = await fetchBucketJobs(bucket)
  const rows = fetched.jobs.map(normalizeJSearchJob)
  const stats = {
    bucket: bucket.id, domain: bucket.domain, fresher: !!bucket.fresher,
    httpStatus: fetched.status, pages: fetched.pages, capped: !!fetched.capped,
    raw: rows.length, uniqueNonDropped: 0, usable: 0, fullJd: 0,
    dropped: {}, flagged: {}, byTierAll: {}, byTierUsable: {}, viaSites: {},
    fingerprints: [], dupWithinBucket: 0, sampleApplyUrls: [],
  }
  if (!fetched.ok) { stats.error = `http-${fetched.status}`; return stats }
  if (fetched.partialStatus) stats.error = `http-${fetched.partialStatus}-partial`
  // Duplicate handling picks the BEST representative per fingerprint —
  // first-copy-wins let a short-JD/blocked duplicate shadow a usable copy
  // of the same posting (false-FAIL pressure on G1/G3/G4; Codex on #503).
  const groups = new Map()
  for (const r of rows) {
    const urls = r.applyOptions.map(o => o.url).filter(Boolean)
    const { drops, flags, jdLen } = classifyJob({ title: r.title, company: r.company, description: r.description, applyUrls: urls, validThrough: r.validThrough })
    // Gate math (tier, usable, sample links) sees only non-blocklisted URLs;
    // classifyJob above saw the raw list (its blocklist drop needs it).
    const usableUrls = urls.filter(u => !isBlockedApplyUrl(u))
    const cand = { r, urls: usableUrls, drops, flags, jdLen, tier: bestTier(usableUrls), fp: fingerprint(r.company, r.title, r.city, r.isRemote) }
    // INGESTION.md §4.2: confidential-company rows are EXEMPT from
    // fingerprint merging — 'confidential|title|city' would collapse
    // DIFFERENT employers (Codex on #503). Each gets a unique group key
    // and mints no identity fingerprint (identity is unknowable).
    const key = dedupKey(cand, groups.size)
    const existing = groups.get(key)
    if (!existing) { groups.set(key, cand) }
    else { stats.dupWithinBucket++; if (betterRepresentative(cand, existing)) groups.set(key, cand) }
  }
  for (const c of groups.values()) {
    if (c.r.viaSite) stats.viaSites[c.r.viaSite] = (stats.viaSites[c.r.viaSite] || 0) + 1
    if (c.drops.length) { for (const d of c.drops) stats.dropped[d] = (stats.dropped[d] || 0) + 1; continue }
    stats.uniqueNonDropped++
    for (const f of c.flags) stats.flagged[f] = (stats.flagged[f] || 0) + 1
    if (c.jdLen >= 400) stats.fullJd++
    if (c.tier) stats.byTierAll[c.tier] = (stats.byTierAll[c.tier] || 0) + 1
    if (c.jdLen >= 400 && c.urls.length) {
      stats.usable++
      if (c.tier) stats.byTierUsable[c.tier] = (stats.byTierUsable[c.tier] || 0) + 1
      // {fp, postedAt} so `fresh` can distinguish genuinely-new postings
      // from sampling churn. Confidential rows mint NO fingerprint —
      // their identity is unknowable, so they sit out G2/G5 identity math.
      if (!c.flags.includes('confidential')) stats.fingerprints.push({ fp: c.fp, postedAt: c.r.postedAt })
      if (stats.sampleApplyUrls.length < 3) stats.sampleApplyUrls.push([...c.urls].sort((a, b) => TIER_RANK[classifyApplyUrl(a)] - TIER_RANK[classifyApplyUrl(b)])[0])
    }
  }
  return stats
}

/** Dedup group key — confidential rows never merge (spec §4.2). */
export function dedupKey(cand, seq) {
  return cand.flags.includes('confidential') ? `confidential:${seq}` : cand.fp
}

/** Prefer: not-dropped > full-JD > better apply tier > longer JD. */
export function betterRepresentative(a, b) {
  if (!a.drops.length !== !b.drops.length) return !a.drops.length
  if ((a.jdLen >= 400) !== (b.jdLen >= 400)) return a.jdLen >= 400
  const at = a.tier ? TIER_RANK[a.tier] : 9, bt = b.tier ? TIER_RANK[b.tier] : 9
  if (at !== bt) return at < bt
  return a.jdLen > b.jdLen
}

export function isErroredBucket(b) { return !!b.error || (b.httpStatus !== undefined && b.httpStatus !== 200) }

async function cmdSnapshot({ pilot = false, fresher = true } = {}) {
  const buckets = buildBuckets({ fresher: pilot ? false : fresher }).slice(0, pilot ? 12 : undefined)
  console.log(`Running ${buckets.length} buckets against JSearch (date_posted=week, country=in)…`)
  const results = []
  for (const [i, b] of buckets.entries()) {
    let s
    try { s = await runBucket(b) } catch (err) {
      s = { bucket: b.id, domain: b.domain, fresher: !!b.fresher, httpStatus: 0, pages: 0, capped: false, error: String(err?.message || err), raw: 0, uniqueNonDropped: 0, usable: 0, fullJd: 0, dropped: {}, flagged: {}, byTierAll: {}, byTierUsable: {}, viaSites: {}, fingerprints: [], dupWithinBucket: 0, sampleApplyUrls: [] }
    }
    results.push(s)
    const mark = s.error ? ` ERROR=${s.error}` : (s.capped ? ' (capped)' : '')
    console.log(`  [${String(i + 1).padStart(3)}/${buckets.length}] ${b.id.padEnd(28)} raw=${String(s.raw).padStart(3)} usable=${String(s.usable).padStart(3)} fullJD=${s.uniqueNonDropped ? Math.round((s.fullJd / s.uniqueNonDropped) * 100) : 0}%${mark}`)
    await sleep(1100)
  }
  // invalidForGating is computed and PERSISTED before write — external
  // consumers must see it in the artifact, not recompute it.
  const erroredCount = results.filter(isErroredBucket).length
  const out = {
    schemaVersion: SCHEMA_VERSION, ranAt: new Date().toISOString(), kind: pilot ? 'pilot' : 'snapshot',
    quotaUsed: jsearchQuota, erroredCount, invalidForGating: erroredCount / Math.max(results.length, 1) > 0.1,
    buckets: results,
  }
  fs.mkdirSync(DATA_DIR, { recursive: true })
  const file = path.join(DATA_DIR, `${pilot ? 'pilot' : 'snapshot'}-${out.ranAt.replace(/[:.]/g, '-')}.json`)
  fs.writeFileSync(file, JSON.stringify(out, null, 2))
  summarizeSnapshot(out)
  console.log(`\nSaved: ${file}  (JSearch physical requests: ${jsearchQuota})`)
}

// Lower median for even-length arrays — matches the probe's bias-toward-FAIL
// philosophy at gate boundaries (upper-middle was a false-pass bias).
export function median(arr) {
  const s = [...arr].sort((a, b) => a - b)
  if (!s.length) return 0
  return s.length % 2 ? s[(s.length - 1) / 2] : s[s.length / 2 - 1]
}
function pct1(n, d) { return d ? `${((n / d) * 100).toFixed(1)}%` : '—' }

function summarizeSnapshot(snap) {
  if (snap.schemaVersion !== SCHEMA_VERSION) { console.log(`!!! artifact schemaVersion ${snap.schemaVersion || 1} != ${SCHEMA_VERSION} — re-run snapshot with the current probe; gates not evaluated`); return }
  const errored = snap.buckets.filter(isErroredBucket)
  const bs = snap.buckets.filter(b => !b.fresher)
  const fresherBs = snap.buckets.filter(b => b.fresher)
  const capped = snap.buckets.filter(b => b.capped && !isErroredBucket(b))
  if (errored.length) {
    console.log(`\n(${errored.length}/${snap.buckets.length} bucket(s) errored — counted as ZERO usable: ${errored.map(b => `${b.bucket}[${b.error || b.httpStatus}]`).join(', ')})`)
    if (snap.invalidForGating) { console.log('!!! >10% of buckets errored — SNAPSHOT INVALID FOR GATING. Re-run `snapshot` before reading any gate.'); return }
  }
  // "Errored buckets count as zero" applies to EVERY gate rollup — a
  // partial bucket's pre-failure rows must not feed G3/G4/G5 either
  // (Codex on #503: the header claimed zeroing that only `usable` did).
  const valid = bs.filter(b => !isErroredBucket(b))
  const usable = bs.map(b => isErroredBucket(b) ? 0 : b.usable)
  const totalRaw = valid.reduce((a, b) => a + b.raw, 0)
  const totalUnique = valid.reduce((a, b) => a + b.uniqueNonDropped, 0)
  const totalUsable = valid.reduce((a, b) => a + b.usable, 0)
  const totalFullJd = valid.reduce((a, b) => a + b.fullJd, 0)
  const tierUsable = {}, tierAll = {}
  for (const b of valid) {
    for (const [t, n] of Object.entries(b.byTierUsable)) tierUsable[t] = (tierUsable[t] || 0) + n
    for (const [t, n] of Object.entries(b.byTierAll)) tierAll[t] = (tierAll[t] || 0) + n
  }
  const employerPlus = (tierUsable['direct-ats'] || 0) + (tierUsable['employer'] || 0)
  const tierUsableSum = Object.values(tierUsable).reduce((a, b) => a + b, 0)
  const dupTotal = valid.reduce((a, b) => a + b.dupWithinBucket, 0)
  const allFps = valid.flatMap(b => b.fingerprints.map(f => f.fp))
  const crossBucketDup = allFps.length ? ((1 - new Set(allFps).size / allFps.length) * 100).toFixed(1) : '0.0'
  const viaTotals = {}
  for (const b of valid) for (const [v, n] of Object.entries(b.viaSites)) viaTotals[v] = (viaTotals[v] || 0) + n
  const topVia = Object.entries(viaTotals).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([v, n]) => `${v}=${n}`).join(' ')

  console.log('\n=== SNAPSHOT SUMMARY (week window ≈ weekly supply) ===')
  console.log(`buckets: ${bs.length} core (+${fresherBs.length} fresher)   raw: ${totalRaw}   unique-non-dropped: ${totalUnique}   usable: ${totalUsable}   page-capped buckets: ${capped.length}`)
  console.log(`G1  median usable/bucket/week: ${median(usable)}   (gate: >=20)   buckets<20: ${usable.filter(u => u < 20).length}/${usable.length}`)
  if (fresherBs.length) {
    const fOk = fresherBs.filter(b => !isErroredBucket(b))
    console.log(`G1f fresher buckets (${fOk.length}/${fresherBs.length} valid): ${fresherBs.map(b => `${b.bucket}=${isErroredBucket(b) ? 'ERR' : b.usable}`).join(', ')}   (gate: >=10 each)`)
    const g6 = fOk.map(b => `${b.bucket}: ${b.usable}/${b.uniqueNonDropped || 0} post-filter`).join(' · ')
    console.log(`G6  fresher post-filter yield: ${g6 || '—'}   (gate: usable still >=10 after drops)`)
  } else console.log('G1f/G6: PENDING — snapshot has no fresher buckets (run without --no-fresher)')
  console.log(`G3  full-JD rate: ${pct1(totalFullJd, totalUnique)} of unique-non-dropped   (gate: >=70%)   [raw-based secondary: ${pct1(totalFullJd, totalRaw)}]`)
  console.log(`G4  employer-or-better apply share: ${pct1(employerPlus, tierUsableSum)} of USABLE rows   (gate: >=30%)   usable tiers: ${JSON.stringify(tierUsable)}   [all-rows secondary: ${JSON.stringify(tierAll)}]`)
  console.log(`G5  dup — within-bucket: ${pct1(dupTotal, totalRaw)} · cross-bucket: ${crossBucketDup}%   (gate: <35% cross-source; JSearch-internal lower bound)`)
  console.log(`via-site distribution (Naukri-partner datum): ${topVia || 'none recorded'}`)
}

/** Bare artifact filenames resolve inside DATA_DIR — every command that takes
 *  an artifact path must be runnable from the repo root (Bugbot on #503:
 *  rot got this fix, fresh didn't). */
function resolveArtifact(file) {
  if (file && !fs.existsSync(file) && fs.existsSync(path.join(DATA_DIR, file))) return path.join(DATA_DIR, file)
  return file
}
function loadArtifact(file) {
  const raw = fs.readFileSync(resolveArtifact(file), 'utf8')
  let parsed
  try { parsed = JSON.parse(raw) } catch { console.error(`Corrupt artifact: ${file}`); process.exit(1) }
  return parsed
}

function cmdFresh(fileA, fileB) {
  if (!fileA || !fileB) { console.error('usage: fresh <A.json> <B.json>'); process.exit(1) }
  const A = loadArtifact(fileA), B = loadArtifact(fileB)
  for (const [name, s] of [['A', A], ['B', B]]) {
    if (s.schemaVersion !== SCHEMA_VERSION) { console.error(`snapshot ${name} has schemaVersion ${s.schemaVersion || 1} != ${SCHEMA_VERSION} — re-run it`); process.exit(1) }
    if (s.invalidForGating) { console.error(`snapshot ${name} is marked INVALID FOR GATING (${s.erroredCount} errored buckets) — re-run it`); process.exit(1) }
  }
  const rawGapDays = (new Date(B.ranAt) - new Date(A.ranAt)) / 86400000
  if (rawGapDays < 0) { console.error(`arguments reversed: B (${B.ranAt}) predates A (${A.ranAt}) — pass the OLDER snapshot first`); process.exit(1) }
  if (rawGapDays < 1.0) { console.error(`snapshots are ${(rawGapDays * 24).toFixed(1)}h apart — G2 requires >=24h between snapshots; not evaluable`); process.exit(1) }
  const aRan = new Date(A.ranAt).getTime()
  const mapA = new Map(A.buckets.map(b => [b.bucket, b]))
  const perBucket = [], skipped = { errored: 0, capped: 0, unpaired: 0 }
  for (const b of B.buckets) {
    const a = mapA.get(b.bucket)
    if (!a) { skipped.unpaired++; continue }
    if (isErroredBucket(a) || isErroredBucket(b)) { skipped.errored++; continue }
    if (a.capped || b.capped) { skipped.capped++; continue } // sampling churn ≠ freshness
    const aFps = new Set(a.fingerprints.map(f => f.fp))
    // Fresh = absent from A AND (no postedAt claim OR posted after A ran).
    const fresh = b.fingerprints.filter(f => !aFps.has(f.fp) && (!f.postedAt || new Date(f.postedAt).getTime() > aRan)).length
    perBucket.push({ bucket: b.bucket, freshPerWeek: (fresh / rawGapDays) * 7 })
  }
  console.log(`=== G2 FRESHNESS (true gap ${rawGapDays.toFixed(2)}d; ${perBucket.length} comparable buckets; skipped: ${skipped.errored} errored, ${skipped.capped} page-capped, ${skipped.unpaired} unpaired) ===`)
  if (!perBucket.length) { console.log('G2: NOT EVALUABLE — no comparable bucket pairs'); process.exit(1) }
  for (const p of perBucket) console.log(`  ${p.bucket.padEnd(28)} ~${p.freshPerWeek.toFixed(1)}/week`)
  const passing = perBucket.filter(p => p.freshPerWeek >= 10).length // unrounded comparison
  const share = passing / perBucket.length
  console.log(`G2: ${passing}/${perBucket.length} buckets >=10 net-new/week (gate: >=70% of comparable buckets) -> ${share >= 0.7 ? 'PASS' : 'FAIL'} (${(share * 100).toFixed(1)}%)`)
}

/** Breadth-first sampler: round N takes every bucket's Nth link before any
 *  bucket's N+1th; caps at `cap` total. Pure — tested in the suite. */
export function pickRotSample(lists, cap) {
  const picked = [], contributed = new Set()
  for (let round = 0; picked.length < cap; round++) {
    let added = false
    for (const l of lists) {
      if (l.urls[round] && picked.length < cap) { picked.push(l.urls[round]); contributed.add(l.bucket); added = true }
    }
    if (!added) break
  }
  return { picked, contributed }
}

// Dead = 404/410 only. Bot-blocks (403/406/429/999) and timeouts are
// UNVERIFIABLE — excluded from both numerator and denominator. 200 bodies on
// aggregator hosts are sniffed for expiry markers (real rot hides behind 200).
const EXPIRY_MARKERS = /no longer accepting applications|this job (is|has been) (closed|expired)|position (has been )?filled|job (has )?expired|vacancy (is )?closed/i
async function cmdRot(file) {
  if (!file) { console.error('usage: rot <snapshot.json>'); process.exit(1) }
  file = resolveArtifact(file) // basename kept resolvable; loadArtifact also resolves
  const snap = loadArtifact(file)
  if (snap.schemaVersion !== SCHEMA_VERSION) { console.error(`snapshot schemaVersion ${snap.schemaVersion || 1} != ${SCHEMA_VERSION} — re-run snapshot first`); process.exit(1) }
  const lists = snap.buckets.filter(b => !isErroredBucket(b)).map(b => ({ bucket: b.bucket, urls: b.sampleApplyUrls || [] })).filter(l => l.urls.length)
  // Breadth-first over ALL buckets: every bucket's first link is checked
  // before any bucket's second (cap >= bucket count, so stride subsetting
  // and its skipped-domain bias are gone entirely — Codex on #503).
  const { picked, contributed } = pickRotSample(lists, Math.max(40, lists.length))
  console.log(`Checking ${picked.length} apply links from ${contributed.size}/${lists.length} buckets…`)
  let dead = 0, alive = 0, unverifiable = 0, expiredBody = 0
  const byStatus = {}
  for (const u of picked) {
    try {
      const res = await getText(u, { timeoutMs: 12000, retries: 0 })
      byStatus[res.status] = (byStatus[res.status] || 0) + 1
      if (res.status === 404 || res.status === 410) dead++
      else if ([403, 406, 429, 999].includes(res.status) || res.status >= 500) unverifiable++
      else if (res.ok && EXPIRY_MARKERS.test(res.text || '')) { dead++; expiredBody++ }
      else if (res.ok) alive++
      else unverifiable++
    } catch { unverifiable++; byStatus.timeout = (byStatus.timeout || 0) + 1 }
    await sleep(400)
  }
  const verifiable = dead + alive
  const deadPct = verifiable ? +((dead / verifiable) * 100).toFixed(1) : null
  const inconclusive = unverifiable > picked.length / 2
  const result = {
    schemaVersion: SCHEMA_VERSION, ranAt: new Date().toISOString(), snapshotFile: path.basename(file),
    checked: picked.length, bucketsContributing: contributed.size, dead, alive, unverifiable, expiredBody, byStatus,
    deadPct, inconclusive,
  }
  fs.mkdirSync(DATA_DIR, { recursive: true })
  const outFile = path.join(DATA_DIR, `rot-${result.ranAt.replace(/[:.]/g, '-')}.json`)
  fs.writeFileSync(outFile, JSON.stringify(result, null, 2))
  console.log(`G4 dead-link rate: ${deadPct === null ? 'NOT EVALUABLE' : deadPct + '%'} of ${verifiable} verifiable (gate <10%) · unverifiable(bot-block/timeout): ${unverifiable} · expired-via-200-body: ${expiredBody} · statuses: ${JSON.stringify(byStatus)}${inconclusive ? ' — INCONCLUSIVE (unverifiable majority)' : ''}`)
  console.log(`Saved: ${outFile}`)
}

// ---------------------------------------------------------------------------
// FREE India-source sampling — polite (honest UA, ~350ms pacing, robots-
// permitted paths only).
// ---------------------------------------------------------------------------
function extractLocs(xml) { return [...xml.matchAll(/<loc>(.*?)<\/loc>/g)].map(m => m[1].trim()) }
function extractJsonLdJobPosting(html) {
  for (const m of html.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const parsed = JSON.parse(m[1])
      const nodes = Array.isArray(parsed) ? parsed : parsed['@graph'] ? parsed['@graph'] : [parsed]
      const jp = nodes.find(n => n && n['@type'] === 'JobPosting')
      if (jp) return jp
    } catch { /* malformed block — keep scanning */ }
  }
  return null
}

async function sampleApna(sampleN) {
  const out = { source: 'apna', shardCount: 0, corpusTotal: 0, sampled: 0, jsonldHits: 0, descLens: [], expired: 0, consultancy: 0, cities: {}, errors: 0, shardErrors: 0, fingerprints: [] }
  try {
    const idx = (await getText('https://apna.co/api/sitemap-index.xml')).text
    const jobIndex = extractLocs(idx).find(u => /job-listing-sitemap\.xml/.test(u))
    if (!jobIndex) { console.log('apna: job-listing-sitemap.xml not found in index'); return out }
    const shardIdx = (await getText(jobIndex)).text
    const shards = extractLocs(shardIdx).filter(u => /active-job-listings-/.test(u))
    out.shardCount = shards.length
    if (!shards.length) { console.log('apna: no active-job-listings shards found'); return out }
    // Collect per-shard picks, then INTERLEAVE round-robin so no shard is
    // truncated by ordering; top up from longer shards if some are small.
    const perShard = Math.max(1, Math.ceil(sampleN / shards.length))
    const shardPicks = []
    for (const shardUrl of shards) {
      try {
        const xml = (await getText(shardUrl)).text
        const su = extractLocs(xml).filter(u => /apna\.co\/job/.test(u))
        out.corpusTotal += su.length
        const step = Math.max(1, Math.floor(su.length / perShard))
        const picks = []
        for (let i = 0; i < su.length && picks.length < perShard * 2; i += step) picks.push(su[i]) // 2x overcollect for top-up
        shardPicks.push(picks)
      } catch { out.shardErrors++; shardPicks.push([]) }
      await sleep(350)
    }
    const urls = []
    for (let round = 0; urls.length < sampleN; round++) {
      let added = false
      for (const picks of shardPicks) if (picks[round] && urls.length < sampleN) { urls.push(picks[round]); added = true }
      if (!added) break
    }
    console.log(`apna: ${shards.length} shards (${out.shardErrors} failed), ${out.corpusTotal} total job URLs; sampling ${urls.length} interleaved across shards`)
    for (const url of urls) {
      out.sampled++
      try {
        const html = (await getText(url, { timeoutMs: 12000, retries: 0 })).text
        const jp = extractJsonLdJobPosting(html)
        if (!jp) continue
        out.jsonldHits++
        const desc = String(jp.description || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
        out.descLens.push(desc.length)
        if (jp.validThrough && new Date(jp.validThrough).getTime() < Date.now()) out.expired++
        const org = jp.hiringOrganization?.name || ''
        if (CONSULTANCY_RE.test(org)) out.consultancy++
        const cityMatch = url.match(/\/job\/([^/]+)\//)
        if (cityMatch) out.cities[cityMatch[1]] = (out.cities[cityMatch[1]] || 0) + 1
        const jl = Array.isArray(jp.jobLocation) ? jp.jobLocation[0] : jp.jobLocation
        const locality = jl?.address?.addressLocality || (cityMatch ? cityMatch[1] : '')
        if (org && jp.title) out.fingerprints.push(fingerprint(org, String(jp.title), String(locality), false))
      } catch { out.errors++ }
      await sleep(350)
    }
    if (out.jsonldHits > 0 && out.fingerprints.length === 0) console.log('apna WARNING: JSON-LD hits but ZERO fingerprints minted — org/title extraction is broken; cross-source G5 will be PENDING')
  } catch (e) { console.log(`apna: sampling failed — ${e.message}`); out.errors++ }
  return out
}

async function sampleUnstop(pages = 3) {
  const out = { source: 'unstop', sampled: 0, regnOpen: 0, descLens: [], errors: 0, shapeNote: '', fingerprints: [] }
  for (let p = 1; p <= pages; p++) {
    try {
      const res = await getJson(`https://unstop.com/api/public/opportunity/search-result?opportunity=jobs&per_page=15&page=${p}`, { timeoutMs: 15000 })
      if (!res.ok || !res.json) { out.errors++; continue }
      const body = res.json
      const list = body?.data?.data ?? body?.data ?? (Array.isArray(body) ? body : null)
      if (!Array.isArray(list)) { out.shapeNote = `unexpected shape, top-level keys: ${Object.keys(body || {}).join(',')}`; break }
      for (const item of list) {
        out.sampled++
        if (item.regn_open || item.status === 'LIVE') out.regnOpen++ // regn_open is 1/0
        const desc = String(item.details || item.description || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
        if (desc) out.descLens.push(desc.length)
        const org = item.organisation?.name || item.organisation?.title || ''
        const loc0 = Array.isArray(item.locations) && item.locations[0] ? item.locations[0] : null
        const loc = typeof loc0 === 'string' ? loc0 : (loc0?.city || loc0?.name || '')
        if (org && item.title) out.fingerprints.push(fingerprint(org, String(item.title), String(loc), false))
      }
    } catch (e) { out.errors++; out.shapeNote = String(e?.message || e) }
    await sleep(600)
  }
  if (out.sampled > 0 && out.fingerprints.length === 0) console.log('unstop WARNING: items sampled but ZERO fingerprints minted — org/title extraction is broken; cross-source G5 will be PENDING')
  return out
}

function lenStats(lens) {
  if (!lens.length) return 'n/a'
  const s = [...lens].sort((a, b) => a - b)
  const q = f => s[Math.min(s.length - 1, Math.floor(f * s.length))]
  const ge400 = lens.filter(l => l >= 400).length
  return `n=${lens.length} min=${s[0]} p25=${q(0.25)} p50=${q(0.5)} p75=${q(0.75)} max=${s[s.length - 1]} | >=400ch: ${pct1(ge400, lens.length)}`
}

async function cmdIndia(sampleArg) {
  const sampleN = typeof sampleArg === 'boolean' ? NaN : Number(sampleArg)
  if (!Number.isInteger(sampleN) || sampleN <= 0) { console.error(`--sample must be a positive integer (got: ${sampleArg})`); process.exit(1) }
  console.log(`FREE India-source sampling (apna sample=${sampleN}, unstop pages=3) — no API key needed\n`)
  const apna = await sampleApna(sampleN)
  const unstop = await sampleUnstop(3)
  console.log('\n=== APNA (sitemap -> JSON-LD JobPosting) ===')
  console.log(`sampled: ${apna.sampled}  jsonld-hit: ${pct1(apna.jsonldHits, apna.sampled)}  fetch-errors: ${apna.errors}  shard-errors: ${apna.shardErrors}`)
  console.log(`JD length distribution: ${lenStats(apna.descLens)}   <-- ingest floor is >=400ch`)
  console.log(`validThrough EXPIRED (should never be served): ${pct1(apna.expired, apna.jsonldHits)}`)
  console.log(`consultancy-named orgs: ${pct1(apna.consultancy, apna.jsonldHits)}`)
  console.log(`top cities: ${Object.entries(apna.cities).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([c, n]) => `${c}=${n}`).join(' ')}`)
  console.log('\n=== UNSTOP (public JSON API, robots-allowed) ===')
  console.log(`sampled: ${unstop.sampled}  live(regn_open): ${pct1(unstop.regnOpen, unstop.sampled)}  errors: ${unstop.errors}${unstop.shapeNote ? `  note: ${unstop.shapeNote}` : ''}`)
  console.log(`details length distribution: ${lenStats(unstop.descLens)}`)
  if (apna.sampled === 0) { console.log('\nNOT SAVING artifact: apna sampled 0 pages — a degenerate artifact must not shadow a good one as "latest".'); process.exit(1) }
  fs.mkdirSync(DATA_DIR, { recursive: true })
  const file = path.join(DATA_DIR, `india-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: SCHEMA_VERSION, ranAt: new Date().toISOString(), apna, unstop }, null, 2))
  console.log(`\nSaved: ${file}`)
}

function cmdReport() {
  const files = fs.existsSync(DATA_DIR) ? fs.readdirSync(DATA_DIR) : []
  const latest = prefix => files.filter(f => f.startsWith(prefix)).sort().pop()
  const snapFile = latest('snapshot-')
  const indiaFile = latest('india-')
  const rotFile = latest('rot-')
  console.log('=== GATE REPORT (from latest saved artifacts) ===')
  let snap = null
  if (snapFile) {
    snap = loadArtifact(path.join(DATA_DIR, snapFile))
    console.log(`\nJSearch snapshot: ${snapFile}`)
    if (snap.schemaVersion !== SCHEMA_VERSION) { console.log(`!!! snapshot is schemaVersion ${snap.schemaVersion || 1} (current ${SCHEMA_VERSION}) — STALE FORMAT, re-run \`snapshot\`; its gates are not evaluated`); snap = null }
    else {
      summarizeSnapshot(snap)
      // An invalid snapshot must not feed ANY downstream gate section
      // (G5 overlap, rot pairing) — cmdFresh already refuses it; report
      // must be equally strict (Codex on #503).
      if (snap.invalidForGating) { console.log('(downstream gate sections skipped — snapshot is invalid for gating)'); snap = null }
    }
  } else console.log('\nG1/G1f/G3/G4/G5/G6: PENDING — no JSearch snapshot yet (run `snapshot`)')
  if (indiaFile) {
    const india = loadArtifact(path.join(DATA_DIR, indiaFile))
    // Same strictness as snapshots: a stale-format india artifact is NOT
    // evaluated — its rates and fingerprints must not drive the source
    // decision (Codex on #503).
    if (india.schemaVersion !== SCHEMA_VERSION) {
      console.log(`\nIndia sampling: ${indiaFile} — STALE FORMAT (schemaVersion ${india.schemaVersion || 1}, current ${SCHEMA_VERSION}); stats not evaluated — re-run \`india\``)
    } else {
      const { apna, unstop } = india
      console.log(`\nIndia sampling: ${indiaFile}`)
      console.log(`  apna  full-JD(>=400ch): ${pct1(apna.descLens.filter(l => l >= 400).length, apna.descLens.length)}  expired-served: ${pct1(apna.expired, apna.jsonldHits)}  consultancy: ${pct1(apna.consultancy, apna.jsonldHits)}`)
      console.log(`  unstop live rate: ${pct1(unstop.regnOpen, unstop.sampled)}`)
      const indiaFps = [...(apna.fingerprints || []), ...(unstop.fingerprints || [])]
      if (!snap) console.log('  G5 cross-source overlap: PENDING — needs a valid snapshot')
      else if (indiaFps.length === 0) console.log('  G5 cross-source overlap: PENDING — india artifact has no fingerprints (re-run `india` with the current probe)')
      else {
        // Errored buckets are excluded from EVERY gate — the overlap line
      // included their fingerprints while all other rollups zeroed them
      // (Bugbot on #503).
      const snapFps = new Set(snap.buckets.filter(b => !isErroredBucket(b)).flatMap(b => (b.fingerprints || []).map(f => f.fp)))
        const overlap = indiaFps.filter(fp => snapFps.has(fp)).length
        console.log(`  G5 cross-source overlap (india ∩ JSearch): ${overlap}/${indiaFps.length} — LOWER BOUND from a small sample; full cross-source G5 lands with corpus-scale ingestion telemetry`)
      }
    }
  } else console.log('\nIndia sampling: PENDING — run `india`')
  if (rotFile && snapFile && snap) {
    const rot = loadArtifact(path.join(DATA_DIR, rotFile))
    // A rot artifact only speaks for the snapshot its links came from.
    if (rot.snapshotFile !== snapFile) console.log(`\nG4 dead-link half: PENDING — latest rot (${rot.snapshotFile}) does not pair with latest snapshot (${snapFile}); run \`node scripts/jobs-liquidity-probe.mjs rot ${path.join(DATA_DIR, snapFile)}\``)
    else if (rot.inconclusive || rot.deadPct === null) console.log(`\nG4 dead-link half: INCONCLUSIVE — ${rot.unverifiable}/${rot.checked} unverifiable (bot-blocks/timeouts); treat as unresolved`)
    else console.log(`\nG4 dead-link half: ${rot.deadPct}% of ${rot.dead + rot.alive} verifiable (gate <10%) — ${rotFile}`)
  } else console.log('\nG4 dead-link half: PENDING — run `rot <snapshot.json>` against the latest snapshot')
  console.log('\nG2 (freshness): run `snapshot` twice >=24h apart, then `fresh <A> <B>`')
}

// ---------------------------------------------------------------------------
// CLI — guarded so importing the module (fingerprint-parity tests) never
// executes commands or exits the host process.
// ---------------------------------------------------------------------------
export function parseArgs(rest) {
  const flags = {}
  const positional = []
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]
    if (!a.startsWith('--')) { positional.push(a); continue }
    const name = a.slice(2)
    const next = rest[i + 1]
    if (next !== undefined && !next.startsWith('--')) { flags[name] = next; i++ } else flags[name] = true
  }
  return { flags, positional }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  const [, , cmd, ...rest] = process.argv
  const { flags, positional } = parseArgs(rest)
  switch (cmd) {
    case 'pilot': await cmdSnapshot({ pilot: true }); break
    case 'snapshot': await cmdSnapshot({ fresher: !flags['no-fresher'] }); break
    case 'fresh': cmdFresh(positional[0], positional[1]); break
    case 'rot': await cmdRot(positional[0]); break
    case 'india': await cmdIndia(flags.sample === undefined ? 60 : flags.sample); break
    case 'report': cmdReport(); break
    default:
      console.log('usage: node scripts/jobs-liquidity-probe.mjs <pilot|snapshot [--no-fresher]|fresh A B|rot SNAP|india [--sample N]|report>')
      process.exit(1)
  }
}
