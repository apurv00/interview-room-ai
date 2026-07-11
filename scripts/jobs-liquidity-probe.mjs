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
 * Commands:
 *   pilot                       12 buckets via JSearch (needs RAPIDAPI_KEY) — classification sanity check
 *   snapshot [--fresher]        all 90 buckets (+10 fresher variants) -> probe-data/snapshot-<ts>.json
 *   fresh <A.json> <B.json>     net-new fingerprints between two snapshots (>=24h apart) -> G2
 *   rot <snapshot.json>         sample apply links, measure dead-link rate -> G4
 *   india [--sample N]          FREE, no key: apna sitemap JSON-LD + Unstop public API sampling
 *   report                      evaluate gates from the latest saved artifacts
 *
 * Env: RAPIDAPI_KEY (JSearch commands only).
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const DATA_DIR = path.join(path.dirname(new URL(import.meta.url).pathname), 'probe-data')
const UA = 'InterviewPrepGuruProbe/0.1 (+https://interviewprep.guru; supply-liquidity-probe; contact: abhishek.apurv00@gmail.com)'
const JSEARCH_HOST = 'jsearch.p.rapidapi.com'

// ---------------------------------------------------------------------------
// Bucket matrix — 13 measured domains x 6 metros + 12 remote = 90 buckets.
// Domains reflect the measured audience mix (India-heavy, majority non-SWE).
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

function buildBuckets({ fresher = false } = {}) {
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
  'new delhi': 'delhi-ncr', delhi: 'delhi-ncr', ghaziabad: 'delhi-ncr', faridabad: 'delhi-ncr',
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
  const c = city.toLowerCase().trim()
  return METRO_ALIASES[c] || c || 'unknown'
}
export function fingerprint(company, title, city, isRemote) {
  return crypto.createHash('sha256').update(`${companyKey(company)}|${titleKey(title)}|${locationKey(city, isRemote)}`).digest('hex').slice(0, 24)
}

// ---------------------------------------------------------------------------
// Quality gate — REFERENCE implementation for modules/jobs qualityGate.
// Hard drops never enter the corpus; flags are stored demotions.
// ---------------------------------------------------------------------------
const APPLY_DOMAIN_BLOCKLIST = ['bit.ly', 'forms.gle', 'wa.me', 'api.whatsapp.com', 't.me', 'tinyurl.com']
const CONSULTANCY_RE = /\b(consultanc\w*|consultants?|staffing|manpower|placements?|recruitment\s+(services|agency|firm)|hr\s+(services|solutions)|talent\s+(acquisition|solutions)\s+(llp|pvt|private))\b/i
const FEE_FRAUD_RE = /\b(registration|security)\s+(fee|deposit|amount)\b|\bpay(ment)?\s+(for|before)\s+(training|joining)\b|\brefundable\s+deposit\b/i

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
  if (applyUrls.length && applyUrls.every(u => APPLY_DOMAIN_BLOCKLIST.some(b => safeHost(u).includes(b)))) drops.push('blocklist-apply-domain')
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
function safeHost(u) { try { return new URL(u).hostname.toLowerCase() } catch { return '' } }
export function classifyApplyUrl(url) {
  const h = safeHost(url)
  if (!h) return 'aggregator-redirect'
  if (ATS_HOSTS.some(a => h.endsWith(a))) return 'direct-ats'
  if (AGG_DEEP_HOSTS.some(a => h.endsWith(a))) return 'aggregator-deep'
  if (FUNNEL_HOSTS.some(a => h.endsWith(a))) return 'platform-funnel'
  if (h.includes('google.') || h.includes('g.co')) return 'aggregator-redirect'
  return 'employer'
}
const TIER_RANK = { 'direct-ats': 0, employer: 1, 'aggregator-deep': 2, 'platform-funnel': 3, 'aggregator-redirect': 4 }
function bestTier(urls) { return urls.map(classifyApplyUrl).sort((a, b) => TIER_RANK[a] - TIER_RANK[b])[0] || null }

// ---------------------------------------------------------------------------
// HTTP helpers — polite: honest UA, delays, one retry on 5xx/network only.
// ---------------------------------------------------------------------------
const sleep = ms => new Promise(r => setTimeout(r, ms))
async function get(url, { headers = {}, timeoutMs = 15000, retries = 1 } = {}) {
  for (let attempt = 0; ; attempt++) {
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), timeoutMs)
    try {
      const res = await fetch(url, { headers: { 'user-agent': UA, ...headers }, signal: ctl.signal, redirect: 'follow' })
      clearTimeout(timer)
      if (res.status >= 500 && attempt < retries) { await sleep(1500); continue }
      return res
    } catch (err) {
      clearTimeout(timer)
      if (attempt < retries) { await sleep(1500); continue }
      throw err
    }
  }
}

let jsearchQuota = 0
async function jsearch(query, { datePosted = 'week', page = 1 } = {}) {
  const key = process.env.RAPIDAPI_KEY
  if (!key) { console.error('RAPIDAPI_KEY not set — JSearch commands need a JSearch (Pro) subscription key from https://rapidapi.com/letscrape-6bRBa3QguO5/api/jsearch'); process.exit(2) }
  const u = new URL(`https://${JSEARCH_HOST}/search`)
  u.searchParams.set('query', query)
  u.searchParams.set('page', String(page))
  u.searchParams.set('num_pages', '1')
  u.searchParams.set('date_posted', datePosted)
  u.searchParams.set('country', 'in')
  jsearchQuota++
  const res = await get(u, { headers: { 'x-rapidapi-key': key, 'x-rapidapi-host': JSEARCH_HOST }, retries: 1, timeoutMs: 30000 })
  if (!res.ok) return { ok: false, status: res.status, jobs: [] }
  const body = await res.json().catch(() => ({}))
  return { ok: true, status: res.status, jobs: Array.isArray(body.data) ? body.data : [] }
}

function normalizeJSearchJob(j) {
  const applyOptions = (j.apply_options || []).map(o => ({ url: o.apply_link, publisher: o.publisher, isDirect: !!o.is_direct }))
  if (j.job_apply_link && !applyOptions.some(o => o.url === j.job_apply_link)) applyOptions.push({ url: j.job_apply_link, publisher: j.job_publisher, isDirect: !!j.job_apply_is_direct })
  return {
    title: j.job_title || '', company: j.employer_name || '',
    city: j.job_city || j.job_state || '', isRemote: !!j.job_is_remote,
    description: j.job_description || '', postedAt: j.job_posted_at_datetime_utc || null,
    viaSite: (j.job_publisher || '').toLowerCase(), applyOptions,
  }
}

// ---------------------------------------------------------------------------
// Bucket runner + snapshot
// ---------------------------------------------------------------------------
// Codex P1 on #503: one page (~10 results) caps every bucket below G1's
// median>=20 threshold — the gate could false-FAIL on adequate supply.
// Fetch up to the spec's 3-page/bucket/day cap (INGESTION.md §4.4), stopping
// early when a short page signals the result set is exhausted. num_pages
// stays 1 per request so quota accounting is exact (billing per num_pages
// is unverified).
const MAX_PAGES_PER_BUCKET = 3
async function fetchBucketJobs(bucket) {
  const all = []
  let ok = false, status = 0
  for (let page = 1; page <= MAX_PAGES_PER_BUCKET; page++) {
    const res = await jsearch(bucket.query, { page })
    status = res.status
    if (!res.ok) break
    ok = true
    all.push(...res.jobs)
    if (res.jobs.length < 10) break // short page = no further pages
    if (page < MAX_PAGES_PER_BUCKET) await sleep(1100)
  }
  return { ok, status, jobs: all }
}

async function runBucket(bucket) {
  const { ok, status, jobs } = await fetchBucketJobs(bucket)
  const rows = jobs.map(normalizeJSearchJob)
  const seen = new Set()
  const stats = { bucket: bucket.id, domain: bucket.domain, fresher: !!bucket.fresher, httpStatus: status, raw: rows.length, usable: 0, fullJd: 0, dropped: {}, flagged: {}, byTier: {}, viaSites: {}, fingerprints: [], dupWithinBucket: 0, sampleApplyUrls: [] }
  if (!ok) return stats
  for (const r of rows) {
    const urls = r.applyOptions.map(o => o.url).filter(Boolean)
    const { drops, flags, jdLen } = classifyJob({ title: r.title, company: r.company, description: r.description, applyUrls: urls })
    const fp = fingerprint(r.company, r.title, r.city, r.isRemote)
    if (seen.has(fp)) { stats.dupWithinBucket++; continue }
    seen.add(fp)
    if (r.viaSite) stats.viaSites[r.viaSite] = (stats.viaSites[r.viaSite] || 0) + 1
    if (drops.length) { for (const d of drops) stats.dropped[d] = (stats.dropped[d] || 0) + 1; continue }
    for (const f of flags) stats.flagged[f] = (stats.flagged[f] || 0) + 1
    if (jdLen >= 400) stats.fullJd++
    const tier = bestTier(urls)
    if (tier) stats.byTier[tier] = (stats.byTier[tier] || 0) + 1
    if (jdLen >= 400 && urls.length) {
      stats.usable++
      stats.fingerprints.push(fp)
      if (stats.sampleApplyUrls.length < 3) stats.sampleApplyUrls.push(urls.sort((a, b) => TIER_RANK[classifyApplyUrl(a)] - TIER_RANK[classifyApplyUrl(b)])[0])
    }
  }
  return stats
}

async function cmdSnapshot({ pilot = false, fresher = false } = {}) {
  const buckets = buildBuckets({ fresher }).slice(0, pilot ? 12 : undefined)
  console.log(`Running ${buckets.length} buckets against JSearch (date_posted=week, country=in)…`)
  const results = []
  for (const [i, b] of buckets.entries()) {
    // A single slow/failed bucket must never kill the whole snapshot run.
    let s
    try {
      s = await runBucket(b)
    } catch (err) {
      s = { bucket: b.id, domain: b.domain, fresher: !!b.fresher, httpStatus: 0, error: String(err?.message || err), raw: 0, usable: 0, fullJd: 0, dropped: {}, flagged: {}, byTier: {}, viaSites: {}, fingerprints: [], dupWithinBucket: 0, sampleApplyUrls: [] }
    }
    results.push(s)
    console.log(`  [${String(i + 1).padStart(3)}/${buckets.length}] ${b.id.padEnd(28)} raw=${String(s.raw).padStart(3)} usable=${String(s.usable).padStart(3)} fullJD=${s.raw ? Math.round((s.fullJd / s.raw) * 100) : 0}% tiers=${JSON.stringify(s.byTier)}`)
    await sleep(1100) // polite pacing; also keeps quota burn observable
  }
  const out = { ranAt: new Date().toISOString(), kind: pilot ? 'pilot' : 'snapshot', quotaUsed: jsearchQuota, buckets: results }
  fs.mkdirSync(DATA_DIR, { recursive: true })
  const file = path.join(DATA_DIR, `${pilot ? 'pilot' : 'snapshot'}-${out.ranAt.replace(/[:.]/g, '-')}.json`)
  fs.writeFileSync(file, JSON.stringify(out, null, 2))
  summarizeSnapshot(out)
  console.log(`\nSaved: ${file}  (JSearch requests used: ${jsearchQuota})`)
}

function median(arr) { const s = [...arr].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0 }
function pct(n, d) { return d ? `${Math.round((n / d) * 100)}%` : '—' }

function summarizeSnapshot(snap) {
  const errored = snap.buckets.filter(b => b.error)
  const bs = snap.buckets.filter(b => !b.fresher && !b.error)
  const fresherBs = snap.buckets.filter(b => b.fresher && !b.error)
  if (errored.length) console.log(`\n(${errored.length} bucket(s) errored and are excluded from gates: ${errored.map(b => b.bucket).join(', ')})`)
  const usable = bs.map(b => b.usable)
  const totalRaw = bs.reduce((a, b) => a + b.raw, 0)
  const totalUsable = bs.reduce((a, b) => a + b.usable, 0)
  const totalFullJd = bs.reduce((a, b) => a + b.fullJd, 0)
  const tierTotals = {}
  for (const b of bs) for (const [t, n] of Object.entries(b.byTier)) tierTotals[t] = (tierTotals[t] || 0) + n
  const employerPlus = (tierTotals['direct-ats'] || 0) + (tierTotals['employer'] || 0)
  const tierSum = Object.values(tierTotals).reduce((a, b) => a + b, 0)
  const dupTotal = bs.reduce((a, b) => a + b.dupWithinBucket, 0)
  // Codex P2 on #503 (2nd round): G5 is a CROSS-SOURCE gate. Within-bucket
  // dups alone under-count the canonical merge burden — also measure
  // fingerprints recurring across buckets; full cross-source overlap is
  // reported by `report` (india fingerprints ∩ snapshot) and stays a
  // lower bound until all sources are sampled at scale.
  const allFps = bs.flatMap(b => b.fingerprints)
  const crossBucketDup = allFps.length ? Math.round((1 - new Set(allFps).size / allFps.length) * 100) : 0
  const viaNaukri = bs.reduce((a, b) => a + (b.viaSites['naukri'] || b.viaSites['naukri.com'] || 0), 0)
  console.log('\n=== SNAPSHOT SUMMARY (week window ≈ weekly supply) ===')
  console.log(`buckets: ${bs.length}   raw jobs: ${totalRaw}   usable: ${totalUsable}`)
  console.log(`G1  median usable/bucket/week: ${median(usable)}   (gate: >=20)   buckets<20: ${usable.filter(u => u < 20).length}/${usable.length}`)
  if (fresherBs.length) console.log(`G1f fresher buckets usable: ${fresherBs.map(b => `${b.bucket}=${b.usable}`).join(', ')}   (gate: >=10 each)`)
  console.log(`G3  full-JD rate (raw): ${pct(totalFullJd, totalRaw)}   (gate: >=70%)`)
  console.log(`G4  employer-or-better apply share: ${pct(employerPlus, tierSum)}   (gate: >=30%)   tiers: ${JSON.stringify(tierTotals)}`)
  console.log(`G5  dup — within-bucket: ${pct(dupTotal, totalRaw)} · cross-bucket: ${crossBucketDup}%   (gate: <35% cross-source; JSearch-internal lower bound — see report for cross-source overlap)`)
  console.log(`viaSite=naukri share (Naukri-partner datum): ${pct(viaNaukri, totalRaw)}`)
}

function cmdFresh(fileA, fileB) {
  const A = JSON.parse(fs.readFileSync(fileA, 'utf8')), B = JSON.parse(fs.readFileSync(fileB, 'utf8'))
  const dayGap = Math.max((new Date(B.ranAt) - new Date(A.ranAt)) / 86400000, 0.5)
  const mapA = Object.fromEntries(A.buckets.map(b => [b.bucket, new Set(b.fingerprints)]))
  const perBucket = []
  for (const b of B.buckets) {
    if (!mapA[b.bucket]) continue
    const fresh = b.fingerprints.filter(fp => !mapA[b.bucket].has(fp)).length
    perBucket.push({ bucket: b.bucket, freshPerWeek: Math.round((fresh / dayGap) * 7) })
  }
  const passing = perBucket.filter(p => p.freshPerWeek >= 10).length
  console.log(`=== G2 FRESHNESS (gap ${dayGap.toFixed(1)}d, ${perBucket.length} comparable buckets) ===`)
  for (const p of perBucket) console.log(`  ${p.bucket.padEnd(28)} ~${p.freshPerWeek}/week`)
  console.log(`G2: ${passing}/${perBucket.length} buckets >=10 net-new/week (gate: >=70% of buckets) -> ${passing / perBucket.length >= 0.7 ? 'PASS' : 'FAIL'}`)
}

async function cmdRot(file) {
  const snap = JSON.parse(fs.readFileSync(file, 'utf8'))
  // Codex P2 on #503 (2nd round): a prefix slice covers only the first ~14
  // buckets in fixed order. Stratify round-robin — one link per bucket per
  // round — so every domain (incl. remote buckets) contributes to the
  // dead-link rate.
  const lists = snap.buckets.map(b => b.sampleApplyUrls || []).filter(l => l.length)
  const urls = []
  for (let round = 0; urls.length < 40; round++) {
    let added = false
    for (const list of lists) {
      if (list[round]) { urls.push(list[round]); added = true; if (urls.length >= 40) break }
    }
    if (!added) break
  }
  console.log(`Checking ${urls.length} apply links stratified across ${lists.length} buckets…`)
  let dead = 0
  for (const u of urls) {
    try { const res = await get(u, { timeoutMs: 12000, retries: 0 }); if (res.status >= 400) dead++ } catch { dead++ }
    await sleep(400)
  }
  console.log(`G4 dead-link rate: ${pct(dead, urls.length)} (gate: <10%)`)
}

// ---------------------------------------------------------------------------
// FREE India-source sampling: apna sitemap JSON-LD + Unstop public API.
// Polite: honest UA, ~350ms delay between detail fetches, robots-permitted paths only.
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
  const out = { source: 'apna', sampled: 0, jsonldHits: 0, descLens: [], expired: 0, consultancy: 0, cities: {}, errors: 0, fingerprints: [] }
  try {
    // Sitemap is two levels deep: index -> job-listing-sitemap.xml -> active-job-listings-N.xml -> job URLs
    const idx = await (await get('https://apna.co/api/sitemap-index.xml')).text()
    const jobIndex = extractLocs(idx).find(u => /job-listing-sitemap\.xml/.test(u))
    if (!jobIndex) { console.log('apna: job-listing-sitemap.xml not found in index'); return out }
    const shardIdx = await (await get(jobIndex)).text()
    const shards = extractLocs(shardIdx).filter(u => /active-job-listings-/.test(u))
    out.shardCount = shards.length
    if (!shards.length) { console.log('apna: no active-job-listings shards found'); return out }
    // Codex P2 on #503: sample across ALL active shards, not just shard[0] —
    // shards may be ordered by date/id/geography, so a single-shard sample
    // can misrepresent JD-length/consultancy/expiry rates for the corpus.
    const perShard = Math.max(1, Math.ceil(sampleN / shards.length))
    const urls = []
    let corpusTotal = 0
    for (const shardUrl of shards) {
      const shardXml = await (await get(shardUrl)).text()
      const shardUrls = extractLocs(shardXml).filter(u => /apna\.co\/job/.test(u))
      corpusTotal += shardUrls.length
      const step = Math.max(1, Math.floor(shardUrls.length / perShard))
      for (let i = 0, taken = 0; i < shardUrls.length && taken < perShard; i += step, taken++) urls.push(shardUrls[i])
    }
    console.log(`apna: ${shards.length} active shards, ${corpusTotal} total job URLs; sampling ${Math.min(sampleN, urls.length)} spread across all shards`)
    for (let i = 0; i < urls.length && out.sampled < sampleN; i++) {
      out.sampled++
      try {
        const html = await (await get(urls[i], { timeoutMs: 12000, retries: 0 })).text()
        const jp = extractJsonLdJobPosting(html)
        if (!jp) continue
        out.jsonldHits++
        const desc = String(jp.description || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
        out.descLens.push(desc.length)
        if (jp.validThrough && new Date(jp.validThrough).getTime() < Date.now()) out.expired++
        const org = jp.hiringOrganization?.name || ''
        if (CONSULTANCY_RE.test(org)) out.consultancy++
        const cityMatch = urls[i].match(/\/job\/([^/]+)\//)
        if (cityMatch) out.cities[cityMatch[1]] = (out.cities[cityMatch[1]] || 0) + 1
        // Cross-source G5: same canonical fingerprint the pipeline will mint
        const jl = Array.isArray(jp.jobLocation) ? jp.jobLocation[0] : jp.jobLocation
        const locality = jl?.address?.addressLocality || (cityMatch ? cityMatch[1] : '')
        if (org && jp.title) out.fingerprints.push(fingerprint(org, String(jp.title), String(locality), false))
      } catch { out.errors++ }
      await sleep(350)
    }
  } catch (e) { console.log(`apna: sampling failed — ${e.message}`); out.errors++ }
  return out
}

async function sampleUnstop(pages = 3) {
  const out = { source: 'unstop', sampled: 0, regnOpen: 0, descLens: [], errors: 0, shapeNote: '', fingerprints: [] }
  for (let p = 1; p <= pages; p++) {
    try {
      const res = await get(`https://unstop.com/api/public/opportunity/search-result?opportunity=jobs&per_page=15&page=${p}`, { timeoutMs: 15000 })
      if (!res.ok) { out.errors++; continue }
      const body = await res.json().catch(() => null)
      const list = body?.data?.data ?? body?.data ?? (Array.isArray(body) ? body : null)
      if (!Array.isArray(list)) { out.shapeNote = `unexpected shape, top-level keys: ${Object.keys(body || {}).join(',')}`; break }
      for (const item of list) {
        out.sampled++
        if (item.regn_open || item.status === 'LIVE') out.regnOpen++ // regn_open is 1/0, not boolean
        const desc = String(item.details || item.description || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
        if (desc) out.descLens.push(desc.length)
        const org = item.organisation?.name || item.organisation?.title || ''
        const loc0 = Array.isArray(item.locations) && item.locations[0] ? item.locations[0] : null
        const loc = typeof loc0 === 'string' ? loc0 : (loc0?.city || loc0?.name || '')
        if (org && item.title) out.fingerprints.push(fingerprint(org, String(item.title), String(loc), false))
      }
    } catch (e) { out.errors++; out.shapeNote = e.message }
    await sleep(600)
  }
  return out
}

function lenStats(lens) {
  if (!lens.length) return 'n/a'
  const s = [...lens].sort((a, b) => a - b)
  const q = f => s[Math.min(s.length - 1, Math.floor(f * s.length))]
  const ge400 = lens.filter(l => l >= 400).length
  return `n=${lens.length} min=${s[0]} p25=${q(0.25)} p50=${q(0.5)} p75=${q(0.75)} max=${s[s.length - 1]} | >=400ch: ${pct(ge400, lens.length)}`
}

async function cmdIndia(sampleN) {
  console.log(`FREE India-source sampling (apna sample=${sampleN}, unstop pages=3) — no API key needed\n`)
  const apna = await sampleApna(sampleN)
  const unstop = await sampleUnstop(3)
  console.log('\n=== APNA (sitemap -> JSON-LD JobPosting) ===')
  console.log(`sampled: ${apna.sampled}  jsonld-hit: ${pct(apna.jsonldHits, apna.sampled)}  fetch-errors: ${apna.errors}`)
  console.log(`JD length distribution: ${lenStats(apna.descLens)}   <-- G3 input; ingest floor is >=400ch`)
  console.log(`validThrough EXPIRED (should never be served): ${pct(apna.expired, apna.jsonldHits)}`)
  console.log(`consultancy-named orgs: ${pct(apna.consultancy, apna.jsonldHits)}`)
  console.log(`top cities: ${Object.entries(apna.cities).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([c, n]) => `${c}=${n}`).join(' ')}`)
  console.log('\n=== UNSTOP (public JSON API, robots-allowed) ===')
  console.log(`sampled: ${unstop.sampled}  regn_open: ${pct(unstop.regnOpen, unstop.sampled)}  errors: ${unstop.errors} ${unstop.shapeNote ? ` note: ${unstop.shapeNote}` : ''}`)
  console.log(`details length distribution: ${lenStats(unstop.descLens)}`)
  fs.mkdirSync(DATA_DIR, { recursive: true })
  const file = path.join(DATA_DIR, `india-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
  fs.writeFileSync(file, JSON.stringify({ ranAt: new Date().toISOString(), apna, unstop }, null, 2))
  console.log(`\nSaved: ${file}`)
}

function cmdReport() {
  const files = fs.existsSync(DATA_DIR) ? fs.readdirSync(DATA_DIR) : []
  const latest = prefix => files.filter(f => f.startsWith(prefix)).sort().pop()
  const snapFile = latest('snapshot-')
  const indiaFile = latest('india-')
  console.log('=== GATE REPORT (from latest saved artifacts) ===')
  let snap = null
  if (snapFile) { snap = JSON.parse(fs.readFileSync(path.join(DATA_DIR, snapFile), 'utf8')); console.log(`\nJSearch snapshot: ${snapFile}`); summarizeSnapshot(snap) }
  else console.log('\nG1/G3/G4/G5: PENDING — no JSearch snapshot yet (needs RAPIDAPI_KEY; run `snapshot`)')
  if (indiaFile) {
    const { apna, unstop } = JSON.parse(fs.readFileSync(path.join(DATA_DIR, indiaFile), 'utf8'))
    console.log(`\nIndia sampling: ${indiaFile}`)
    console.log(`  apna  full-JD(>=400ch) rate: ${pct(apna.descLens.filter(l => l >= 400).length, apna.descLens.length)}  expired-served: ${pct(apna.expired, apna.jsonldHits)}  consultancy: ${pct(apna.consultancy, apna.jsonldHits)}`)
    console.log(`  unstop regn_open rate: ${pct(unstop.regnOpen, unstop.sampled)}`)
    if (snap) {
      const snapFps = new Set(snap.buckets.flatMap(b => b.fingerprints || []))
      const indiaFps = [...(apna.fingerprints || []), ...(unstop.fingerprints || [])]
      const overlap = indiaFps.filter(fp => snapFps.has(fp)).length
      console.log(`  G5 cross-source overlap (india sample ∩ JSearch snapshot): ${overlap}/${indiaFps.length} — LOWER BOUND from a small sample; combine with the cross-bucket rate above; full cross-source G5 lands with corpus-scale ingestion telemetry`)
    }
  } else console.log('\nIndia sampling: PENDING — run `india`')
  console.log('\nG2 (freshness): run `snapshot` twice >=24h apart, then `fresh <A> <B>`')
}

// ---------------------------------------------------------------------------
const [, , cmd, ...rest] = process.argv
const flag = (name, dflt) => { const i = rest.indexOf(`--${name}`); return i >= 0 ? (rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[i + 1] : true) : dflt }
switch (cmd) {
  case 'pilot': await cmdSnapshot({ pilot: true }); break
  case 'snapshot': await cmdSnapshot({ fresher: !!flag('fresher', false) }); break
  case 'fresh': cmdFresh(rest[0], rest[1]); break
  case 'rot': await cmdRot(rest[0]); break
  case 'india': await cmdIndia(Number(flag('sample', 60))); break
  case 'report': cmdReport(); break
  default:
    console.log('usage: node scripts/jobs-liquidity-probe.mjs <pilot|snapshot [--fresher]|fresh A B|rot SNAP|india [--sample N]|report>')
    process.exit(1)
}
