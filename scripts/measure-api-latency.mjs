#!/usr/bin/env node
/**
 * Measure p50 / p95 / p99 / max latency of the two hot-path Claude APIs —
 * `/api/generate-question` and `/api/evaluate-answer` — from the
 * `usagerecords` collection in production MongoDB.
 *
 * Why: the interview pipeline audit (2026-04-20) flagged the possibility
 * of adding AbortController timeouts to these client-side fetches. Before
 * picking a timeout number we need real p99 data. The INTERVIEW_FLOW.md
 * doc declares a budget of ≤1500ms p95. If the production p99 is already
 * within or near budget, the 30s stalls we're seeing are NOT from Claude
 * being slow — the root cause is elsewhere (client freeze, Vercel cold
 * start, network, etc.) and a client-side timeout would be camouflage.
 *
 * Run:
 *   MONGODB_URI=mongodb+srv://... node scripts/measure-api-latency.mjs
 *
 * Optional args:
 *   --days N      — lookback window (default 7)
 *   --limit N     — max records to pull per type (default 10000)
 *
 * Reads `.env.local` if present. Prints a plain-text table. No DB mutations.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { MongoClient } from 'mongodb'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

function loadEnvLocal() {
  const p = path.join(__dirname, '..', '.env.local')
  if (!fs.existsSync(p)) return
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '')
  }
}
loadEnvLocal()

const MONGODB_URI = process.env.MONGODB_URI
if (!MONGODB_URI) {
  console.error('MONGODB_URI not set (try adding it to .env.local or exporting it)')
  process.exit(1)
}

// Args
const args = process.argv.slice(2)
function argInt(name, dflt) {
  const i = args.indexOf(name)
  if (i === -1) return dflt
  const v = parseInt(args[i + 1], 10)
  return Number.isFinite(v) ? v : dflt
}
const LOOKBACK_DAYS = argInt('--days', 7)
const PER_TYPE_LIMIT = argInt('--limit', 10000)

const since = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000)

function percentile(sorted, p) {
  // Nearest-rank method: smallest value such that at least p% of data is
  // ≤ it. For n=100 and p=99 this returns sorted[98] (the 99th value),
  // NOT sorted[99] (the max). The previous `Math.floor((p/100)*n)` form
  // was off-by-one high: it mapped p=99,n=100 → idx 99 = max, which
  // inflated every reported percentile by one rank and could push the
  // decision-guide thresholds (p99 < 2000ms / 2000-5000 / > 5000ms)
  // the wrong side of a boundary. Clamp both ends for 0/100 edge cases.
  if (sorted.length === 0) return 0
  const n = sorted.length
  const idx = Math.max(0, Math.min(n - 1, Math.ceil((p / 100) * n) - 1))
  return sorted[idx]
}

function fmt(ms) {
  if (ms == null || Number.isNaN(ms)) return '—'
  return `${ms.toFixed(0)}ms`
}

function summarize(label, durations) {
  const sorted = [...durations].sort((a, b) => a - b)
  const n = sorted.length
  if (n === 0) return { label, n, p50: null, p95: null, p99: null, max: null, mean: null }
  const mean = sorted.reduce((a, b) => a + b, 0) / n
  return {
    label,
    n,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted[n - 1],
    mean,
  }
}

async function main() {
  console.log(`Measuring last ${LOOKBACK_DAYS}d (since ${since.toISOString()})`)
  console.log(`Per-type limit: ${PER_TYPE_LIMIT}`)
  console.log()

  const client = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 8000 })
  try {
    await client.connect()
    const db = client.db()
    const col = db.collection('usagerecords')

    const types = ['api_call_question', 'api_call_evaluate']
    const results = []

    for (const type of types) {
      const docs = await col
        .find(
          { type, createdAt: { $gte: since } },
          { projection: { durationMs: 1, success: 1, modelUsed: 1 } }
        )
        .sort({ createdAt: -1 })
        .limit(PER_TYPE_LIMIT)
        .toArray()

      const successDocs = docs.filter((d) => d.success)
      const failDocs = docs.filter((d) => !d.success)

      // Keep latency arrays filtered to durationMs > 0 so percentile math
      // isn't skewed by same-millisecond / missing timings. Count-oriented
      // fields below (successCount / failCount / successRate) must be
      // derived from the raw `success` flag on docs, NOT from these arrays
      // — durationMs can legitimately be 0 (UsageRecord schema default,
      // same-millisecond timing) and excluding those under-reports the
      // success rate.
      const all = docs.map((d) => d.durationMs).filter((x) => typeof x === 'number' && x > 0)
      const ok = successDocs.map((d) => d.durationMs).filter((x) => typeof x === 'number' && x > 0)
      const fail = failDocs.map((d) => d.durationMs).filter((x) => typeof x === 'number' && x > 0)

      const byModel = {}
      for (const d of docs) {
        if (d.success && typeof d.durationMs === 'number') {
          byModel[d.modelUsed] = byModel[d.modelUsed] || []
          byModel[d.modelUsed].push(d.durationMs)
        }
      }

      results.push({
        type,
        total: docs.length,
        successCount: successDocs.length,
        failCount: failDocs.length,
        successRate: docs.length ? (successDocs.length / docs.length) * 100 : 0,
        overall: summarize('all', all),
        successOnly: summarize('success', ok),
        failOnly: summarize('fail', fail),
        byModel: Object.entries(byModel).map(([m, arr]) => summarize(m, arr)),
      })
    }

    // Print
    for (const r of results) {
      console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`)
      console.log(`${r.type}`)
      console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`)
      console.log(`  samples:      ${r.total}   (${r.successCount} ok · ${r.failCount} fail · ${r.successRate.toFixed(2)}% success)`)
      console.log()
      const rows = [
        ['(all calls)', r.overall],
        ['success only', r.successOnly],
        ['fail only', r.failOnly],
      ]
      console.log(`  ${'series'.padEnd(16)}  ${'n'.padStart(6)}  ${'p50'.padStart(8)}  ${'p95'.padStart(8)}  ${'p99'.padStart(8)}  ${'max'.padStart(8)}  ${'mean'.padStart(8)}`)
      for (const [label, s] of rows) {
        console.log(
          `  ${label.padEnd(16)}  ${String(s.n).padStart(6)}  ${fmt(s.p50).padStart(8)}  ${fmt(s.p95).padStart(8)}  ${fmt(s.p99).padStart(8)}  ${fmt(s.max).padStart(8)}  ${fmt(s.mean).padStart(8)}`
        )
      }
      if (r.byModel.length > 1) {
        console.log()
        console.log(`  by model (success only):`)
        for (const s of r.byModel) {
          console.log(
            `    ${s.label.padEnd(30)}  n=${String(s.n).padStart(5)}  p50=${fmt(s.p50)}  p95=${fmt(s.p95)}  p99=${fmt(s.p99)}  max=${fmt(s.max)}`
          )
        }
      }
    }

    console.log()
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`)
    console.log(`Decision guide (from INTERVIEW_FLOW.md §5: budget = 1500ms p95):`)
    console.log(`  p99 <  2000ms : no timeout needed — 30s stall root cause is NOT here`)
    console.log(`  p99 2000-5000ms : marginal; investigate tail before adding timeout`)
    console.log(`  p99 > 5000ms : timeout clearly useful; set timeout at ~2x p99`)
    console.log(`  success < 99% : investigate error path before anything else`)
    console.log()
  } finally {
    await client.close()
  }
}

main().catch((err) => {
  console.error('Measurement failed:', err)
  process.exit(1)
})
