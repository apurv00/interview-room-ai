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
// Anchored to the TAIL and iterated — an unanchored strip turned
// 'Corporation Bank' into 'bank', false-merging distinct employers.
const LEGAL_SUFFIX_TAIL_RE = /(\s+(pvt|private|ltd|limited|llp|inc|incorporated|corp|corporation)\.?)+\s*$/
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
  return name.toLowerCase().replace(LEGAL_SUFFIX_TAIL_RE, '').replace(/[^\p{L}\p{N} ]/gu, ' ').replace(/\s+/g, ' ').trim()
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
// whatsapp.com covers api./chat./www. via suffix matching; telegram.me/.org
// beside t.me; docs.google.com is the Google-Forms vector (same as forms.gle).
const APPLY_DOMAIN_BLOCKLIST = ['bit.ly', 'forms.gle', 'docs.google.com', 'wa.me', 'whatsapp.com', 't.me', 'telegram.me', 'telegram.org', 'tinyurl.com']
const CONSULTANCY_RE = /\b(consultanc\w*|consultants?|staffing|manpower|placements?|recruitment\s+(services|agency|firm)|hr\s+(services|solutions)|talent\s+(acquisition|solutions)\s+(llp|pvt|private))\b/i
// §4.5 names TeamLease/Randstad/Quess explicitly — India's largest staffing
// firms match no generic word-shape. One shared predicate keeps the snapshot
// flag and the india consultancy counter in lockstep.
const STAFFING_NAMES_RE = /\b(teamlease|randstad|quess|adecco|kelly\s?services|gi\s?group|persolkelly|ciel\s?hr|innovsource|firstmeridian)\b/i
export function isStaffingOrg(name = '') { return CONSULTANCY_RE.test(name) || STAFFING_NAMES_RE.test(name) }
const FEE_FRAUD_RE = /\b(registration|security)\s+(fee|deposit|amount)\b|\bpay(ment)?\s+(for|before)\s+(training|joining)\b|\brefundable\s+deposit\b/i
// INGESTION.md §4.5 contact-spam: phone/WhatsApp solicitation in the body
// AND no apply link above redirect tier — a call-the-HR harvesting pattern.
// Body-side phone matching allows one internal separator ('98765 43210') —
// call/WhatsApp proximity guards against salary-range false hits. The
// title-phone drop stays contiguous-only: '60000-70000' in a salary-bearing
// title must not hard-drop the row.
const SPACED_PHONE = '(\\+91[\\s-]?)?\\b[6-9]\\d{4}[\\s-]?\\d{5}\\b'
const CONTACT_SPAM_RE = new RegExp(`(\\bcall\\b|\\bwhats\\s?app\\b)[\\s\\S]{0,60}?${SPACED_PHONE}|${SPACED_PHONE}[\\s\\S]{0,60}?(\\bcall\\b|\\bwhats\\s?app\\b)`, 'i')

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
  // Malformed dates must be VISIBLE, not silently alive: NaN passes neither
  // branch, so bad dates get a flag and real expiries get the drop.
  if (validThrough) {
    const vt = new Date(validThrough).getTime()
    if (Number.isNaN(vt)) flags.push('bad-valid-through')
    else if (vt < Date.now()) drops.push('valid-through-expired')
  }

  if (isStaffingOrg(company)) flags.push('staffing')
  if (/\bconfidential\b/i.test(company)) flags.push('confidential')
  const jdLen = description.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().length
  if (jdLen < 400) flags.push('short-jd')
  return { drops, flags, jdLen }
}

// ---------------------------------------------------------------------------
// Apply-tier ladder (INGESTION.md §4.2)
// ---------------------------------------------------------------------------
const GOOGLE_REDIRECT_HOSTS = new Set(['google.com', 'www.google.com', 'google.co.in', 'www.google.co.in', 'g.co', 'www.g.co'])
const ATS_HOSTS = ['greenhouse.io', 'lever.co', 'smartrecruiters.com', 'ashbyhq.com', 'workable.com', 'bamboohr.com', 'jobvite.com', 'icims.com', 'myworkdayjobs.com']
const AGG_DEEP_HOSTS = ['naukri.com', 'linkedin.com', 'indeed.com', 'shine.com', 'foundit.in', 'monsterindia.com', 'timesjobs.com', 'glassdoor.com', 'glassdoor.co.in']
const FUNNEL_HOSTS = ['apna.co', 'unstop.com', 'internshala.com', 'cutshort.io', 'instahyre.com']
export function classifyApplyUrl(url) {
  const h = hostOf(url)
  if (!h) return 'aggregator-redirect'
  if (ATS_HOSTS.some(a => hostMatches(h, a))) return 'direct-ats'
  if (AGG_DEEP_HOSTS.some(a => hostMatches(h, a))) return 'aggregator-deep'
  if (FUNNEL_HOSTS.some(a => hostMatches(h, a))) return 'platform-funnel'
  // EXACT hosts only — substring 'google.' demoted careers.google.com to
  // tier-4; suffix matching would reintroduce that. docs.google.com is
  // handled by the blocklist, not the tier ladder.
  if (GOOGLE_REDIRECT_HOSTS.has(h)) return 'aggregator-redirect'
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
      if (res.status >= 500 && attempt < retries) {
        clearTimeout(timer)
        res.body?.cancel?.().catch(() => {}) // release the connection deterministically
        await sleep(1500); continue
      }
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
    // Retained so multi-req collapses (§4.2 amendment 1) are COUNTED —
    // JSearch job_ids rotate, so the probe reports rather than salts; the
    // pipeline identityResolver MUST salt with refNumber/ordinal for
    // stable-id (ATS) sources. The probe's fp-only merge is a
    // JSearch-specific concession, not the reference merge rule.
    externalId: j.job_id || null,
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

// sha1 of the normalized JD body — the within-run mass-repost key. Tiny
// bodies (<100 chars) hash to noise, so they mint no repost key.
function bodyHashOf(description = '') {
  const norm = description.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 2000)
  return norm.length >= 100 ? crypto.createHash('sha1').update(norm).digest('hex').slice(0, 20) : null
}

async function runBucket(bucket) {
  const fetched = await fetchBucketJobs(bucket)
  const rows = fetched.jobs.map(normalizeJSearchJob)
  const stats = {
    bucket: bucket.id, domain: bucket.domain, fresher: !!bucket.fresher,
    httpStatus: fetched.status, pages: fetched.pages, capped: !!fetched.capped,
    raw: rows.length, uniqueNonDropped: 0, usable: 0, fullJd: 0,
    dropped: {}, flagged: {}, byTierAll: {}, byTierUsable: {}, viaSites: {},
    fingerprints: [], dupWithinBucket: 0, multiReqCollapsed: 0, sampleApplyUrls: [],
  }
  if (!fetched.ok) { stats.error = `http-${fetched.status}`; return { stats, reps: [] } }
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
    else {
      stats.dupWithinBucket++
      if (existing.r.externalId && cand.r.externalId && existing.r.externalId !== cand.r.externalId) stats.multiReqCollapsed = (stats.multiReqCollapsed || 0) + 1
      groups.set(key, foldCandidates(cand, existing))
    }
  }
  const reps = [...groups.values()].map(c => ({ ...c, bodyHash: bodyHashOf(c.r.description), companyKey: companyKey(c.r.company) }))
  return { stats, reps }
}

/** Pure accounting over a bucket's deduped representatives. Runs AFTER the
 *  run-level mass-repost pass so §4.5's 'same body under >3 companyKeys'
 *  hard drop applies before any gate stat is minted (within-run lower bound
 *  of the spec's 7-day Redis rule). repostFlagHashes (2-3 companyKeys) get
 *  the demotion flag instead. Exported for the test suite. */
export function accountBucket(stats, reps, massRepostHashes = new Set(), repostFlagHashes = new Set()) {
  for (const c of reps) {
    if (c.r.viaSite) stats.viaSites[c.r.viaSite] = (stats.viaSites[c.r.viaSite] || 0) + 1
    const drops = (c.bodyHash && massRepostHashes.has(c.bodyHash)) ? [...c.drops, 'mass-repost'] : c.drops
    if (drops.length) { for (const d of drops) stats.dropped[d] = (stats.dropped[d] || 0) + 1; continue }
    stats.uniqueNonDropped++
    const flags = (c.bodyHash && repostFlagHashes.has(c.bodyHash)) ? [...c.flags, 'repost'] : c.flags
    for (const f of flags) stats.flagged[f] = (stats.flagged[f] || 0) + 1
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

/** Run-level mass-repost detection: bodyHash → distinct companyKeys.
 *  >3 keys = §4.5 hard drop; 2-3 keys = 'repost' demotion flag. */
export function detectMassReposts(allReps) {
  const byHash = new Map()
  for (const c of allReps) {
    if (!c.bodyHash) continue
    if (!byHash.has(c.bodyHash)) byHash.set(c.bodyHash, new Set())
    byHash.get(c.bodyHash).add(c.companyKey)
  }
  const drop = new Set(), flag = new Set()
  for (const [h, keys] of byHash) {
    if (keys.size > 3) drop.add(h)
    else if (keys.size > 1) flag.add(h)
  }
  return { drop, flag }
}

/** Dedup group key — confidential rows never merge (spec §4.2). */
export function dedupKey(cand, seq) {
  return cand.flags.includes('confidential') ? `confidential:${seq}` : cand.fp
}

/** §4.2 merge policy at duplicate collapse: the group keeps the UNION of
 *  usable apply URLs (tier = best across the union), the max jdLen, and the
 *  EARLIEST non-null postedAt (aggregators re-stamp reposts — taking the
 *  representative's fresh postedAt inflated G2). betterRepresentative still
 *  decides which row's drops/flags/meta speak for the group. */
export function foldCandidates(a, b) {
  const rep = betterRepresentative(a, b) ? a : b
  const urls = [...new Set([...a.urls, ...b.urls])]
  const posted = [a.r.postedAt, b.r.postedAt].filter(Boolean).sort()[0] || null
  return { ...rep, urls, tier: bestTier(urls), jdLen: Math.max(a.jdLen, b.jdLen), r: { ...rep.r, postedAt: posted } }
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

/** THE single gate-population accessor. Core gates (G1/G3/G4/G5) read core
 *  non-errored buckets; fresher gates (G1f/G6) read fresher non-errored.
 *  No gate consumer may touch snap.buckets directly — population drift
 *  across consumers caused four separate review findings. */
export function gateBuckets(snap, { fresher = false } = {}) {
  return snap.buckets.filter(b => (fresher ? b.fresher : !b.fresher) && !isErroredBucket(b))
}
export function gateFingerprints(snap, opts) {
  return gateBuckets(snap, opts).flatMap(b => (b.fingerprints || []).map(f => f.fp))
}

async function cmdSnapshot({ pilot = false, fresher = true } = {}) {
  const buckets = buildBuckets({ fresher: pilot ? false : fresher }).slice(0, pilot ? 12 : undefined)
  console.log(`Running ${buckets.length} buckets against JSearch (date_posted=week, country=in)…`)
  const collected = []
  for (const [i, b] of buckets.entries()) {
    let c
    try { c = await runBucket(b) } catch (err) {
      c = { stats: { bucket: b.id, domain: b.domain, fresher: !!b.fresher, httpStatus: 0, pages: 0, capped: false, error: String(err?.message || err), raw: 0, uniqueNonDropped: 0, usable: 0, fullJd: 0, dropped: {}, flagged: {}, byTierAll: {}, byTierUsable: {}, viaSites: {}, fingerprints: [], dupWithinBucket: 0, multiReqCollapsed: 0, sampleApplyUrls: [] }, reps: [] }
    }
    collected.push(c)
    console.log(`  [${String(i + 1).padStart(3)}/${buckets.length}] ${b.id.padEnd(28)} fetched=${String(c.stats.raw).padStart(3)}${c.stats.error ? ` ERROR=${c.stats.error}` : (c.stats.capped ? ' (capped)' : '')}`)
    await sleep(1100)
  }
  // Run-level pass BEFORE accounting: §4.5 mass-repost (same body under >3
  // companyKeys) applies across the whole snapshot; per-bucket gate stats
  // are minted only after it (within-run lower bound of the 7d Redis rule).
  const { drop: massDrop, flag: repostFlag } = detectMassReposts(collected.flatMap(c => c.reps))
  const results = collected.map(c => accountBucket(c.stats, c.reps, massDrop, repostFlag))
  if (massDrop.size) console.log(`(mass-repost: ${massDrop.size} JD bodies span >3 companies — rows hard-dropped per §4.5; ${repostFlag.size} more bodies flagged 'repost')`)
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
  // partial bucket's pre-failure rows must not feed G3/G4/G5 either.
  // All rollups route through the single gateBuckets accessor; the
  // fresher population feeds G1f/G6 ONLY (core gates are labeled so).
  const valid = gateBuckets(snap)
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
  const allFps = gateFingerprints(snap)
  const crossBucketDup = allFps.length ? ((1 - new Set(allFps).size / allFps.length) * 100).toFixed(1) : '0.0'
  const viaTotals = {}
  for (const b of valid) for (const [v, n] of Object.entries(b.viaSites)) viaTotals[v] = (viaTotals[v] || 0) + n
  const topVia = Object.entries(viaTotals).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([v, n]) => `${v}=${n}`).join(' ')

  if (snap.kind === 'pilot') console.log('\nPILOT — classification sanity check only; gate thresholds are NOT evaluable from 12 buckets.')
  console.log('\n=== SNAPSHOT SUMMARY (week window ≈ weekly supply; core buckets only — fresher measured under G1f/G6) ===')
  const multiReq = valid.reduce((a, b) => a + (b.multiReqCollapsed || 0), 0)
  console.log(`buckets: ${bs.length} core (+${fresherBs.length} fresher)   raw: ${totalRaw}   unique-non-dropped: ${totalUnique}   usable: ${totalUsable}   page-capped: ${capped.length}   multi-req collapsed: ${multiReq} (same employer/title/city, distinct source ids — G1 reads conservative; §4.2 amendment-1 salting is a pipeline requirement)`)
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
/** kind: 'snapshot' | 'india' — shape-validated so a wrong-kind or missing
 *  artifact gets the same clean refusal every other invalid input gets. */
function loadArtifact(file, kind = 'snapshot') {
  const p = resolveArtifact(file)
  if (!p || !fs.existsSync(p)) { console.error(`Artifact not found: ${file} (looked in cwd and ${DATA_DIR})`); process.exit(1) }
  let parsed
  try { parsed = JSON.parse(fs.readFileSync(p, 'utf8')) } catch { console.error(`Corrupt artifact: ${p}`); process.exit(1) }
  if (kind === 'snapshot' && !Array.isArray(parsed.buckets)) { console.error(`${p} is not a snapshot artifact (no buckets array)`); process.exit(1) }
  if (kind === 'india' && !parsed.apna) { console.error(`${p} is not an india artifact (no apna section)`); process.exit(1) }
  if (kind === 'rot' && typeof parsed.checked !== 'number') { console.error(`${p} is not a rot artifact`); process.exit(1) }
  if (kind === 'fresh' && typeof parsed.comparable !== 'number') { console.error(`${p} is not a fresh artifact`); process.exit(1) }
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
  // The search window is 7 days: beyond it, B cannot see everything posted
  // since A, and 'net-new' silently undercounts (false-FAIL on G2).
  if (rawGapDays > 7) { console.error(`snapshots are ${rawGapDays.toFixed(1)}d apart — beyond the 7-day search window B cannot see all postings since A; G2 not evaluable, re-run snapshots closer together`); process.exit(1) }
  const aRan = new Date(A.ranAt).getTime()
  const coreA = gateBuckets(A), coreB = gateBuckets(B)
  const mapA = new Map(coreA.map(b => [b.bucket, b]))
  const bNames = new Set(coreB.map(b => b.bucket))
  const perBucket = [], skipped = { errored: 0, capped: 0, unpaired: 0 }
  skipped.errored = (A.buckets.length - coreA.length - A.buckets.filter(x => x.fresher).length) + (B.buckets.length - coreB.length - B.buckets.filter(x => x.fresher).length)
  skipped.unpaired += coreA.filter(a => !bNames.has(a.bucket)).length // A-only buckets are skips too
  for (const b of coreB) {
    const a = mapA.get(b.bucket)
    if (!a) { skipped.unpaired++; continue }
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
  const verdict = share >= 0.7 ? 'PASS' : 'FAIL'
  console.log(`G2: ${passing}/${perBucket.length} buckets >=10 net-new/week (gate: >=70% of comparable buckets) -> ${verdict} (${(share * 100).toFixed(1)}%)`)
  // Persist — report's saved gate verdict must be able to consume G2
  // instead of eternally instructing the operator to run fresh again.
  const result = {
    schemaVersion: SCHEMA_VERSION, ranAt: new Date().toISOString(),
    fileA: path.basename(resolveArtifact(fileA)), fileB: path.basename(resolveArtifact(fileB)),
    gapDays: +rawGapDays.toFixed(2), comparable: perBucket.length, passing,
    sharePct: +(share * 100).toFixed(1), verdict, skipped,
  }
  fs.mkdirSync(DATA_DIR, { recursive: true })
  const outFile = path.join(DATA_DIR, `fresh-${result.ranAt.replace(/[:.]/g, '-')}.json`)
  fs.writeFileSync(outFile, JSON.stringify(result, null, 2))
  console.log(`Saved: ${outFile}`)
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
  // Same refusal as fresh — G4's dead-link half must not be computed from a
  // snapshot every sibling command rejects.
  if (snap.invalidForGating) { console.error(`snapshot is marked INVALID FOR GATING (${snap.erroredCount} errored buckets) — re-run snapshot first`); process.exit(1) }
  const lists = gateBuckets(snap).map(b => ({ bucket: b.bucket, urls: b.sampleApplyUrls || [] })).filter(l => l.urls.length)
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
export function extractJsonLdJobPosting(html) {
  for (const m of html.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const parsed = JSON.parse(m[1])
      const nodes = Array.isArray(parsed) ? parsed : parsed['@graph'] ? parsed['@graph'] : [parsed]
      // @type may legally be an array ('["JobPosting","Thing"]')
      const jp = nodes.find(n => n && [].concat(n['@type'] ?? []).includes('JobPosting'))
      if (jp) return jp
    } catch { /* malformed block — keep scanning */ }
  }
  return null
}

// §6/§2 fresher measurement: the india sources ARE the fresher supply plan,
// so the sampler must report fresher-domain-matched × full-JD × post-spam —
// the exact numbers the segment verdict hinges on. Patterns seed from the
// same domains the bucket matrix uses.
export const FRESHER_DOMAIN_PATTERNS = {
  marketing: /market/i,
  sales: /\b(sales|business development|telecall|telesales|field sales)\b/i,
  electrical: /electric/i,
  data: /\b(data entry|data analyst|analyst|mis)\b/i,
  hr: /\b(hr|recruiter|recruitment|talent acquisition)\b/i,
}
export function matchFresherDomain(text = '') {
  for (const [d, re] of Object.entries(FRESHER_DOMAIN_PATTERNS)) if (re.test(text)) return d
  return null
}
function emptyFresherTally() {
  return Object.fromEntries(Object.keys(FRESHER_DOMAIN_PATTERNS).map(d => [d, { matched: 0, fullJd: 0, postSpam: 0 }]))
}

async function sampleApna(sampleN) {
  const out = { source: 'apna', shardCount: 0, corpusTotal: 0, sampled: 0, jsonldHits: 0, descLens: [], expired: 0, consultancy: 0, cities: {}, errors: 0, shardErrors: 0, fingerprints: [], fresherDomains: emptyFresherTally() }
  try {
    // Every fetch layer checks HTTP status — a WAF/5xx failure is an ERROR,
    // never silently counted as 'no JSON-LD' quality data.
    const idxRes = await getText('https://apna.co/api/sitemap-index.xml')
    if (!idxRes.ok) { console.log(`apna: sitemap index HTTP ${idxRes.status} — source errored`); out.errors++; return out }
    const jobIndex = extractLocs(idxRes.text).find(u => /job-listing-sitemap\.xml/.test(u))
    if (!jobIndex) { console.log('apna: job-listing-sitemap.xml not found in index'); return out }
    const shardIdxRes = await getText(jobIndex)
    if (!shardIdxRes.ok) { console.log(`apna: shard index HTTP ${shardIdxRes.status} — source errored`); out.errors++; return out }
    const shards = extractLocs(shardIdxRes.text).filter(u => /active-job-listings-/.test(u))
    out.shardCount = shards.length
    if (!shards.length) { console.log('apna: no active-job-listings shards found'); return out }
    // Collect per-shard picks, then INTERLEAVE round-robin so no shard is
    // truncated by ordering; top up from longer shards if some are small.
    const perShard = Math.max(1, Math.ceil(sampleN / shards.length))
    const shardPicks = []
    for (const shardUrl of shards) {
      try {
        const shardRes = await getText(shardUrl)
        if (!shardRes.ok) { out.shardErrors++; shardPicks.push([]); await sleep(350); continue }
        const su = extractLocs(shardRes.text).filter(u => /apna\.co\/job/.test(u))
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
        const detailRes = await getText(url, { timeoutMs: 12000, retries: 0 })
        if (!detailRes.ok) { out.errors++; await sleep(350); continue }
        const jp = extractJsonLdJobPosting(detailRes.text)
        if (!jp) continue
        out.jsonldHits++
        const title = typeof jp.title === 'string' ? jp.title : ''
        const org = typeof jp.hiringOrganization?.name === 'string' ? jp.hiringOrganization.name : ''
        const desc = String(jp.description || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
        out.descLens.push(desc.length)
        const expired = jp.validThrough && new Date(jp.validThrough).getTime() < Date.now()
        if (expired) out.expired++
        if (isStaffingOrg(org)) out.consultancy++ // same predicate as the snapshot flag — no drift
        const cityMatch = url.match(/\/job\/([^/]+)\//)
        if (cityMatch) out.cities[cityMatch[1]] = (out.cities[cityMatch[1]] || 0) + 1
        // §2 fresher measurement: matched × full-JD × ingest-usable yield.
        // postSpam counts only rows that would actually enter the corpus:
        // not expired, full-JD, and clearing every hard drop. The platform
        // detail page IS the apply path (tier platform-funnel) — passing []
        // made contact-spam false-fire on legitimate platform listings
        // whose JD mentions a recruiter phone (Codex on #503).
        const fd = matchFresherDomain(`${title} ${url}`)
        if (fd) {
          const t = out.fresherDomains[fd]
          t.matched++
          if (desc.length >= 400) t.fullJd++
          const { drops } = classifyJob({ title, company: org, description: jp.description || '', applyUrls: [url], validThrough: jp.validThrough || null })
          if (!drops.length && !expired && desc.length >= 400) t.postSpam++
        }
        // FULL fingerprint parity with the ingestable corpus: no
        // confidential, no expired, AND full-JD (>=400ch) — G5 overlap must
        // compare only postings ingestion would actually store.
        const jl = Array.isArray(jp.jobLocation) ? jp.jobLocation[0] : jp.jobLocation
        const locality = jl?.address?.addressLocality || (cityMatch ? cityMatch[1] : '')
        const isRemote = [].concat(jp.jobLocationType ?? []).includes('TELECOMMUTE')
        if (org && title && !expired && desc.length >= 400 && !/\bconfidential\b/i.test(org)) out.fingerprints.push(fingerprint(org, title, String(locality), isRemote))
      } catch { out.errors++ }
      await sleep(350)
    }
    if (out.jsonldHits > 0 && out.fingerprints.length === 0) console.log('apna WARNING: JSON-LD hits but ZERO fingerprints minted — org/title extraction is broken; cross-source G5 will be PENDING')
  } catch (e) { console.log(`apna: sampling failed — ${e.message}`); out.errors++ }
  return out
}

async function sampleUnstop(pages = 5) {
  const out = { source: 'unstop', sampled: 0, regnOpen: 0, descLens: [], errors: 0, itemErrors: 0, shapeNote: '', fingerprints: [], fresherDomains: emptyFresherTally() }
  for (let p = 1; p <= pages; p++) {
    try {
      const res = await getJson(`https://unstop.com/api/public/opportunity/search-result?opportunity=jobs&per_page=15&page=${p}`, { timeoutMs: 15000 })
      if (!res.ok || !res.json) { out.errors++; continue }
      const body = res.json
      const list = body?.data?.data ?? body?.data ?? (Array.isArray(body) ? body : null)
      // A changed envelope is an ERROR, not a note — otherwise a gate-grade
      // artifact can save with zero/partial unstop coverage and no invalidity.
      if (!Array.isArray(list)) { out.errors++; out.shapeNote = `unexpected shape, top-level keys: ${Object.keys(body || {}).join(',')}`; break }
      for (const item of list) {
        // Per-item isolation: one malformed item must not discard its page.
        try {
          out.sampled++
          const live = !!(item.regn_open || item.status === 'LIVE') // regn_open is 1/0
          if (live) out.regnOpen++
          const title = typeof item.title === 'string' ? item.title : ''
          const rawOrg = item.organisation?.name ?? item.organisation?.title
          const org = typeof rawOrg === 'string' ? rawOrg : ''
          const desc = String(item.details || item.description || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
          if (desc) out.descLens.push(desc.length)
          // §2 fresher measurement: matched × full-JD × post-spam per domain
          // The Unstop listing page is the apply path (platform-funnel) —
          // [] would false-fire contact-spam on legitimate listings.
          const pageUrl = typeof item.public_url === 'string' && item.public_url.startsWith('http') ? item.public_url : 'https://unstop.com/jobs'
          const fd = matchFresherDomain(title)
          if (fd) {
            const t = out.fresherDomains[fd]
            t.matched++
            if (desc.length >= 400) t.fullJd++
            const { drops } = classifyJob({ title, company: org, description: item.details || '', applyUrls: [pageUrl] })
            // Ingest-usable only: live + full-JD + clears every hard drop —
            // closed or stub rows must not make fresher supply look viable.
            if (!drops.length && live && desc.length >= 400) t.postSpam++
          }
          const loc0 = Array.isArray(item.locations) && item.locations[0] ? item.locations[0] : null
          const loc = typeof loc0 === 'string' ? loc0 : (loc0?.city || loc0?.name || '')
          const isRemote = /remote|work from home/i.test(`${String(loc)} ${title}`)
          // Fingerprint parity with the snapshot population: live,
          // non-confidential rows only.
          if (org && title && live && desc.length >= 400 && !/\bconfidential\b/i.test(org)) out.fingerprints.push(fingerprint(org, title, String(loc), isRemote))
        } catch { out.itemErrors++ }
      }
    } catch (e) { out.errors++; out.shapeNote = String(e?.message || e) }
    await sleep(600)
  }
  if (out.sampled > 0 && out.fingerprints.length === 0) console.log('unstop WARNING: items sampled but ZERO fingerprints minted — org/title extraction is broken; cross-source G5 will be PENDING')
  return out
}

export function lenStats(lens) {
  if (!lens.length) return 'n/a'
  const s = [...lens].sort((a, b) => a - b)
  const q = f => s[Math.min(s.length - 1, Math.floor(f * s.length))]
  const ge400 = lens.filter(l => l >= 400).length
  // p50 uses the shared lower-median — one bias-toward-FAIL convention
  // across every gate-adjacent number.
  return `n=${lens.length} min=${s[0]} p25=${q(0.25)} p50=${median(s)} p75=${q(0.75)} max=${s[s.length - 1]} | >=400ch: ${pct1(ge400, lens.length)}`
}

function printFresherTally(label, tally) {
  const line = Object.entries(tally).map(([d, t]) => `${d}: ${t.matched} matched / ${t.fullJd} full-JD / ${t.postSpam} ingest-usable`).join(' · ')
  console.log(`${label} fresher-domain measurement (§2): ${line}`)
}

async function cmdIndia(sampleArg) {
  const sampleN = typeof sampleArg === 'boolean' ? NaN : Number(sampleArg)
  if (!Number.isInteger(sampleN) || sampleN <= 0) { console.error(`--sample must be a positive integer (got: ${sampleArg})`); process.exit(1) }
  if (sampleN < 100) console.log(`NOTE: sub-spec sample (${sampleN} < 100 detail pages, INGESTION.md §6) — fine for a smoke run, not for the gate decision.`)
  console.log(`FREE India-source sampling (apna sample=${sampleN}, unstop pages=5) — no API key needed\n`)
  const apna = await sampleApna(sampleN)
  const unstop = await sampleUnstop(5)
  console.log('\n=== APNA (sitemap -> JSON-LD JobPosting) ===')
  console.log(`sampled: ${apna.sampled}  jsonld-hit: ${pct1(apna.jsonldHits, apna.sampled)}  fetch-errors: ${apna.errors}  shard-errors: ${apna.shardErrors}`)
  console.log(`JD length distribution: ${lenStats(apna.descLens)}   <-- ingest floor is >=400ch`)
  console.log(`validThrough EXPIRED (should never be served): ${pct1(apna.expired, apna.jsonldHits)}`)
  console.log(`consultancy/staffing orgs: ${pct1(apna.consultancy, apna.jsonldHits)}`)
  console.log(`top cities: ${Object.entries(apna.cities).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([c, n]) => `${c}=${n}`).join(' ')}`)
  printFresherTally('apna', apna.fresherDomains)
  console.log('\n=== UNSTOP (public JSON API, robots-allowed) ===')
  console.log(`sampled: ${unstop.sampled}  live(regn_open): ${pct1(unstop.regnOpen, unstop.sampled)}  errors: ${unstop.errors}/${unstop.itemErrors} (page/item)${unstop.shapeNote ? `  note: ${unstop.shapeNote}` : ''}`)
  console.log(`details length distribution: ${lenStats(unstop.descLens)}`)
  printFresherTally('unstop', unstop.fresherDomains)
  if (apna.sampled === 0) { console.log('\nNOT SAVING artifact: apna sampled 0 pages — a degenerate artifact must not shadow a good one as "latest".'); process.exit(1) }
  // Same invalid-for-gating discipline as snapshots — and shard loss is
  // judged against SHARD COUNT, not detail-sample size: 3 of 4 failed
  // shards with one shard filling the sample is a biased slice, not a 6%
  // error rate (Codex on #503).
  const apnaShardLoss = apna.shardCount ? apna.shardErrors / apna.shardCount : 0
  const apnaDetailErr = apna.errors / Math.max(apna.sampled, 1)
  const unstopPageErr = unstop.errors / 5
  // HTTP-200 pages with no JobPosting JSON-LD are schema drift, not benign
  // skips — historical hit rate is 91-100%, so a sample below 70% means the
  // markup or selector broke and the surviving rates are a biased slice.
  const apnaJsonLdRate = apna.sampled ? apna.jsonldHits / apna.sampled : 0
  const invalidForGating = apnaShardLoss >= 0.25 || apnaDetailErr > 0.1 || (apna.sampled > 0 && apnaJsonLdRate < 0.7) || unstopPageErr >= 0.4 || (unstop.sampled === 0 && unstop.errors > 0) || !!unstop.shapeNote
  if (invalidForGating) console.log(`\n!!! india sampling errored beyond gate tolerance (shard loss ${(apnaShardLoss * 100).toFixed(0)}%, detail errors ${(apnaDetailErr * 100).toFixed(1)}%, JSON-LD hit rate ${(apnaJsonLdRate * 100).toFixed(1)}%, unstop page errors ${unstop.errors}/5) — artifact marked INVALID FOR GATING; re-run \`india\`.`)
  fs.mkdirSync(DATA_DIR, { recursive: true })
  const file = path.join(DATA_DIR, `india-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
  // subSpecSample records what was ACTUALLY sampled, not what was requested —
  // a thin corpus can under-fill a --sample 100 request.
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: SCHEMA_VERSION, ranAt: new Date().toISOString(), sampleN, actualSampled: apna.sampled, subSpecSample: apna.sampled < 100, invalidForGating, apna, unstop }, null, 2))
  console.log(`\nSaved: ${file}`)
}

/** §6 verdict engine — PASS / PARTIAL(scoped to passing domains) / FAIL
 *  (<50% of core buckets pass G1+G3) / NOT-EVALUABLE. Pure over a snapshot;
 *  G2 (fresh), dead-links (rot) and the india fresher measurement are
 *  reported alongside, not folded in silently. Exported for tests. */
export function computeVerdict(snap) {
  // Errored core buckets COUNT AS ZERO here, exactly as in the summary —
  // the median and pass-share denominators use ALL core buckets, so a few
  // 429'd buckets under the 10% invalid threshold can only drag the
  // verdict down, never inflate it (Codex on #503). Row-based rates
  // (G3/G4) read valid buckets — errored ones contribute no rows anyway.
  const coreAll = snap.buckets.filter(b => !b.fresher)
  const core = gateBuckets(snap)
  if (!coreAll.length) return { verdict: 'NOT-EVALUABLE', reasons: ['no core buckets'], gates: {}, passingDomains: [] }
  const usableOf = b => isErroredBucket(b) ? 0 : b.usable
  const byDomain = {}
  for (const b of coreAll) (byDomain[b.domain] ||= []).push(b)
  const domainMedians = Object.fromEntries(Object.entries(byDomain).map(([d, bs]) => [d, median(bs.map(usableOf))]))
  // A PARTIAL verdict's launch scope must meet the QUALITY gates at domain
  // level too — a domain with volume but poor full-JD or apply fidelity
  // must not appear "safe to launch" (Codex on #503).
  const domainQuality = {}
  for (const [d, bs] of Object.entries(byDomain)) {
    const validBs = bs.filter(b => !isErroredBucket(b))
    const unique = validBs.reduce((a, b) => a + b.uniqueNonDropped, 0)
    const fullJd = validBs.reduce((a, b) => a + b.fullJd, 0)
    const tu = {}
    for (const b of validBs) for (const [t, n] of Object.entries(b.byTierUsable)) tu[t] = (tu[t] || 0) + n
    const us = Object.values(tu).reduce((a, b) => a + b, 0)
    domainQuality[d] = {
      fullJdRate: unique ? fullJd / unique : 0,
      employerShare: us ? ((tu['direct-ats'] || 0) + (tu['employer'] || 0)) / us : 0,
    }
  }
  const passingDomains = Object.entries(domainMedians)
    .filter(([d, m]) => m >= 20 && domainQuality[d].fullJdRate >= 0.7 && domainQuality[d].employerShare >= 0.3)
    .map(([d]) => d)
  const g1Median = median(coreAll.map(usableOf))
  const totalUnique = core.reduce((a, b) => a + b.uniqueNonDropped, 0)
  const totalFullJd = core.reduce((a, b) => a + b.fullJd, 0)
  const g3 = totalUnique ? totalFullJd / totalUnique : 0
  // spec: any priority bucket under 50% full-JD gets flagged individually
  const lowFullJdBuckets = core.filter(b => b.uniqueNonDropped >= 5 && b.fullJd / b.uniqueNonDropped < 0.5).map(b => b.bucket)
  const tierUsable = {}
  for (const b of core) for (const [t, n] of Object.entries(b.byTierUsable)) tierUsable[t] = (tierUsable[t] || 0) + n
  const usableSum = Object.values(tierUsable).reduce((a, b) => a + b, 0)
  const g4 = usableSum ? ((tierUsable['direct-ats'] || 0) + (tierUsable['employer'] || 0)) / usableSum : 0
  // An errored bucket cannot pass G1+G3 — it sits in the denominator.
  const bucketPass = coreAll.filter(b => !isErroredBucket(b) && b.usable >= 20 && (b.uniqueNonDropped ? b.fullJd / b.uniqueNonDropped : 0) >= 0.5).length
  const passShare = bucketPass / coreAll.length
  // fresher aggregated per domain across metros (top-5 fresher-domain rule);
  // errored fresher buckets likewise contribute zero.
  const fresherByDomain = {}
  for (const b of snap.buckets.filter(x => x.fresher)) fresherByDomain[b.domain] = (fresherByDomain[b.domain] || 0) + usableOf(b)
  const fresherPass = Object.entries(fresherByDomain).filter(([, u]) => u >= 10).map(([d]) => d)
  const gates = { g1Median, g3Pct: +(g3 * 100).toFixed(1), g4Pct: +(g4 * 100).toFixed(1), passSharePct: +(passShare * 100).toFixed(1), domainMedians, domainQuality, lowFullJdBuckets, fresherByDomain, fresherPass }
  const reasons = []
  let verdict
  if (passShare < 0.5) { verdict = 'FAIL'; reasons.push(`only ${gates.passSharePct}% of core buckets pass G1+G3 — below the <50% rule`) }
  else if (g1Median >= 20 && g3 >= 0.7 && g4 >= 0.3) { verdict = 'PASS'; reasons.push('G1/G3/G4 pass on the JSearch corpus') }
  else {
    verdict = 'PARTIAL'
    reasons.push(`launch scoped to passing domains: ${passingDomains.join(', ') || '(none)'}`)
    if (g1Median < 20) reasons.push(`G1 median ${g1Median} < 20`)
    if (g3 < 0.7) reasons.push(`G3 ${gates.g3Pct}% < 70%`)
    if (g4 < 0.3) reasons.push(`G4 ${gates.g4Pct}% < 30%`)
  }
  reasons.push('G2 (fresh), dead-links (rot) and the india fresher measurement are separate inputs — read them in this report before acting')
  return { verdict, reasons, gates, passingDomains }
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
  // Gate-grade selection: walk india artifacts newest-first and use the
  // first that is current-format, valid, AND full-spec — a later smoke run
  // (--sample 20) must never shadow a gate-grade artifact (Codex on #503).
  let indiaValid = null
  const indiaFiles = files.filter(f => f.startsWith('india-')).sort().reverse()
  let indiaPick = null, indiaSkipped = []
  for (const f of indiaFiles) {
    const art = loadArtifact(path.join(DATA_DIR, f), 'india')
    if (art.schemaVersion !== SCHEMA_VERSION) { indiaSkipped.push(`${f} (stale format)`); continue }
    if (art.invalidForGating) { indiaSkipped.push(`${f} (invalid for gating)`); continue }
    // Positive proof of spec-size required — and judged on what was ACTUALLY
    // sampled, never on what was requested (a thin corpus can under-fill).
    if (!(art.apna?.sampled >= 100)) { indiaSkipped.push(`${f} (actual apna sample ${art.apna?.sampled ?? 'unrecorded'} < 100)`); continue }
    indiaPick = { file: f, art }; break
  }
  if (indiaSkipped.length) console.log(`\n(india artifacts skipped for gating: ${indiaSkipped.join(' · ')})`)
  if (indiaPick) {
    {
      const india = indiaPick.art
      const indiaFileName = indiaPick.file
      indiaValid = india
      const { apna, unstop } = india
      console.log(`\nIndia sampling: ${indiaFileName}`)
      console.log(`  apna  full-JD(>=400ch): ${pct1(apna.descLens.filter(l => l >= 400).length, apna.descLens.length)}  expired-served: ${pct1(apna.expired, apna.jsonldHits)}  consultancy/staffing: ${pct1(apna.consultancy, apna.jsonldHits)}`)
      console.log(`  unstop live rate: ${pct1(unstop.regnOpen, unstop.sampled)}`)
      if (apna.fresherDomains) { printFresherTally('  apna', apna.fresherDomains); printFresherTally('  unstop', unstop.fresherDomains) }
      const indiaFps = [...(apna.fingerprints || []), ...(unstop.fingerprints || [])]
      if (!snap) console.log('  G5 cross-source overlap: PENDING — needs a valid snapshot')
      else if (indiaFps.length === 0) console.log('  G5 cross-source overlap: PENDING — india artifact has no fingerprints (re-run `india` with the current probe)')
      else {
        const snapFps = new Set(gateFingerprints(snap))
        const overlap = indiaFps.filter(fp => snapFps.has(fp)).length
        console.log(`  G5 cross-source overlap (india ∩ JSearch): ${overlap}/${indiaFps.length} — LOWER BOUND from a small sample; full cross-source G5 lands with corpus-scale ingestion telemetry`)
      }
    }
  } else console.log('\nIndia sampling: PENDING — run `india`')
  if (rotFile && snapFile && snap) {
    const rot = loadArtifact(path.join(DATA_DIR, rotFile), 'rot')
    // A rot artifact only speaks for the snapshot its links came from.
    if (rot.snapshotFile !== snapFile) console.log(`\nG4 dead-link half: PENDING — latest rot (${rot.snapshotFile}) does not pair with latest snapshot (${snapFile}); run \`node scripts/jobs-liquidity-probe.mjs rot ${path.join(DATA_DIR, snapFile)}\``)
    else if (rot.inconclusive || rot.deadPct === null) console.log(`\nG4 dead-link half: INCONCLUSIVE — ${rot.unverifiable}/${rot.checked} unverifiable (bot-blocks/timeouts); treat as unresolved`)
    else console.log(`\nG4 dead-link half: ${rot.deadPct}% of ${rot.dead + rot.alive} verifiable (gate <10%) — ${rotFile}`)
  } else if (snap) console.log(`\nG4 dead-link half: PENDING — run \`node scripts/jobs-liquidity-probe.mjs rot ${path.join(DATA_DIR, snapFile)}\``)
  else console.log('\nG4 dead-link half: PENDING — needs a valid snapshot first')
  // G2 reads the persisted fresh artifact, paired to the latest snapshot
  // (a fresh result whose B side isn't this snapshot is stale).
  const freshFile = latest('fresh-')
  if (freshFile && snap) {
    const fr = loadArtifact(path.join(DATA_DIR, freshFile), 'fresh')
    if (fr.schemaVersion !== SCHEMA_VERSION) console.log('\nG2 (freshness): PENDING — fresh artifact is stale-format; re-run `fresh`')
    else if (fr.fileB !== snapFile) console.log(`\nG2 (freshness): PENDING — latest fresh result (B=${fr.fileB}) does not pair with the latest snapshot (${snapFile}); re-run \`fresh\``)
    else console.log(`\nG2 (freshness): ${fr.verdict} — ${fr.passing}/${fr.comparable} comparable buckets >=10 net-new/week (${fr.sharePct}%, gap ${fr.gapDays}d) — ${freshFile}`)
  } else console.log('\nG2 (freshness): PENDING — run `snapshot` twice >=24h apart (<=7d), then `fresh <A> <B>`')
  if (snap && snap.kind !== 'pilot') {
    const v = computeVerdict(snap)
    console.log(`\n=== §6 VERDICT (JSearch corpus): ${v.verdict} ===`)
    for (const r of v.reasons) console.log(`  • ${r}`)
    console.log(`  per-domain medians: ${Object.entries(v.gates.domainMedians).map(([d, m]) => `${d}=${m}`).join(' ')}`)
    if (v.gates.lowFullJdBuckets?.length) console.log(`  <50% full-JD buckets flagged: ${v.gates.lowFullJdBuckets.join(', ')}`)
    console.log(`  JSearch fresher buckets (supplementary): ${Object.entries(v.gates.fresherByDomain).map(([d, u]) => `${d}=${u}`).join(' ') || 'none'} — the fresher SEGMENT verdict reads the india measurement above${indiaValid ? '' : ' (PENDING)'}`)
  }
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
    case 'india': await cmdIndia(flags.sample === undefined ? 100 : flags.sample); break
    case 'report': cmdReport(); break
    default:
      console.log('usage: node scripts/jobs-liquidity-probe.mjs <pilot|snapshot [--no-fresher]|fresh A B|rot SNAP|india [--sample N]|report>')
      process.exit(1)
  }
}
