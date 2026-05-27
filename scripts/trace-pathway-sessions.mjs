#!/usr/bin/env node
/**
 * Trace pathway generation state for QA matrix sessions in Mongo.
 *
 * Usage:
 *   node scripts/trace-pathway-sessions.mjs --report qa-browser-full-1779806117459
 *   node scripts/trace-pathway-sessions.mjs --csv modules/qa/output/qa-browser-full-1779806117459-sessions.csv
 */
import fs from 'node:fs'
import path from 'node:path'
import { MongoClient, ObjectId } from 'mongodb'

const root = path.resolve(import.meta.dirname, '..')

function loadEnvLocal() {
  const envPath = path.join(root, '.env.local')
  if (!fs.existsSync(envPath)) return
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq === -1) continue
    const key = line.slice(0, eq).trim()
    let val = line.slice(eq + 1).trim().replace(/\s+#.*$/, '').trim()
    if (
      (val.startsWith("'") && val.endsWith("'")) ||
      (val.startsWith('"') && val.endsWith('"'))
    ) {
      val = val.slice(1, -1)
    }
    if (val && !process.env[key]) process.env[key] = val
  }
}

function parseCsv(csvPath) {
  const lines = fs.readFileSync(csvPath, 'utf8').trim().split(/\r?\n/).slice(1)
  return lines.map((line) => {
    const p = line.split(',')
    return {
      matrixKey: p[0],
      sessionId: p[4],
      feedbackPass: p[9],
      pathwayGenHarness: p[14],
      enqueueHarness: p[15],
    }
  })
}

function parseArgs() {
  const opts = { csv: null, report: null, prod: true, session: null }
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i]
    if (a === '--csv') opts.csv = process.argv[++i]
    else if (a === '--report') opts.report = process.argv[++i]
    else if (a === '--local') opts.prod = false
    else if (a === '--session') opts.session = process.argv[++i]
  }
  if (opts.report) {
    opts.csv = path.join(
      root,
      'modules/qa/output',
      `${opts.report}-sessions.csv`,
    )
  }
  if (!opts.csv && !opts.session) {
    console.error('Provide --csv, --report, or --session')
    process.exit(1)
  }
  return opts
}

loadEnvLocal()
const opts = parseArgs()
const uri =
  (opts.prod ? process.env.MONGODB_URI_PROD : null) ?? process.env.MONGODB_URI
if (!uri) {
  console.error('Set MONGODB_URI_PROD or MONGODB_URI in .env.local')
  process.exit(1)
}

if (opts.session) {
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 15_000 })
  await client.connect()
  const doc = await client
    .db()
    .collection('interviewsessions')
    .findOne({ _id: new ObjectId(opts.session) })
  console.log(JSON.stringify(doc, null, 2))
  await client.close()
  process.exit(0)
}

const rows = parseCsv(path.isAbsolute(opts.csv) ? opts.csv : path.join(root, opts.csv))
const ids = rows.map((r) => r.sessionId).filter((id) => /^[a-f0-9]{24}$/i.test(id))

const client = new MongoClient(uri, { serverSelectionTimeoutMS: 15_000 })
await client.connect()
const col = client.db().collection('interviewsessions')
const docs = await col
  .find({ _id: { $in: ids.map((id) => new ObjectId(id)) } })
  .project({
    pathwayGenerationStatus: 1,
    pathwayGenerationStartedAt: 1,
    pathwayGenerationCompletedAt: 1,
    pathwayGenerationAttempts: 1,
    pathwayGenerationError: 1,
    pathwayGenerationUseSynthesizedFeedback: 1,
    completedAt: 1,
    'feedback.overall_score': 1,
    status: 1,
    userId: 1,
  })
  .toArray()

const byId = new Map(docs.map((d) => [d._id.toString(), d]))

const buckets = {
  pending0: [],
  pendingAttempts: [],
  running: [],
  succeeded: [],
  failed: [],
  skipped: [],
  nullStatus: [],
  missing: [],
}

for (const r of rows) {
  const d = byId.get(r.sessionId)
  if (!d) {
    buckets.missing.push(r)
    continue
  }
  const st = d.pathwayGenerationStatus ?? null
  const att = d.pathwayGenerationAttempts ?? 0
  const ageMin = d.completedAt
    ? Math.round((Date.now() - new Date(d.completedAt).getTime()) / 60_000)
    : null
  const entry = {
    matrixKey: r.matrixKey,
    sessionId: r.sessionId,
    st,
    att,
    ageMin,
    startedAt: d.pathwayGenerationStartedAt?.toISOString?.() ?? null,
    completedAt: d.pathwayGenerationCompletedAt?.toISOString?.() ?? null,
    error: d.pathwayGenerationError?.slice?.(0, 120) ?? null,
    fbScore: d.feedback?.overall_score ?? null,
    harnessEnqueue: r.enqueueHarness,
    harnessPathway: r.pathwayGenHarness,
    feedbackPass: r.feedbackPass,
  }
  if (st === 'succeeded') buckets.succeeded.push(entry)
  else if (st === 'skipped') buckets.skipped.push(entry)
  else if (st === 'failed') buckets.failed.push(entry)
  else if (st === 'running') buckets.running.push(entry)
  else if (st === 'pending' && att === 0) buckets.pending0.push(entry)
  else if (st === 'pending') buckets.pendingAttempts.push(entry)
  else buckets.nullStatus.push(entry)
}

console.log('=== Pathway trace:', opts.csv, '===')
console.log('Mongo URI:', uri.replace(/\/\/[^@]+@/, '//***@'))
console.log('')
console.log('| Bucket | Count | Diagnosis |')
console.log('|--------|-------|-----------|')
console.log(`| succeeded | ${buckets.succeeded.length} | Job completed |`)
console.log(`| pending, attempts=0 | ${buckets.pending0.length} | **H1: event sent, worker never ran** |`)
console.log(`| pending, attempts>0 | ${buckets.pendingAttempts.length} | Job started but not finished |`)
console.log(`| running | ${buckets.running.length} | Worker mid-flight or hung |`)
console.log(`| failed | ${buckets.failed.length} | Terminal error — check error field |`)
console.log(`| null status | ${buckets.nullStatus.length} | **Never enqueued** (feedback failed or skipped) |`)
console.log(`| missing doc | ${buckets.missing.length} | Session not in DB |`)

if (buckets.pending0.length) {
  console.log('\n--- H1: pending + 0 attempts (stuck enqueue) ---')
  for (const e of buckets.pending0.sort((a, b) => (b.ageMin || 0) - (a.ageMin || 0))) {
    console.log(
      `  ${e.matrixKey.padEnd(42)} ${e.sessionId}  age=${e.ageMin}m  fb=${e.fbScore}  harness=${e.harnessEnqueue}`,
    )
  }
  console.log('\nInngest: filter events `pathway/regenerate` for these sessionIds.')
  console.log('Replay: INNGEST_EVENT_KEY=... node scripts/replay-pathway-regenerate.mjs --csv <this-csv>')
}

if (buckets.nullStatus.length) {
  const byDepth = {}
  for (const e of buckets.nullStatus) {
    const depth = e.matrixKey.split('/')[1] ?? '?'
    byDepth[depth] = (byDepth[depth] || 0) + 1
  }
  console.log('\n--- Never enqueued (null pathwayGenerationStatus) ---')
  console.log('By depth:', byDepth)
  console.log('Sample (first 3):')
  for (const e of buckets.nullStatus.slice(0, 3)) {
    console.log(`  ${e.matrixKey} ${e.sessionId} feedbackPass=${e.feedbackPass}`)
  }
}

if (buckets.failed.length) {
  console.log('\n--- Failed ---')
  for (const e of buckets.failed) {
    console.log(`  ${e.matrixKey} ${e.sessionId} err=${e.error}`)
  }
}

// PathwayPlan linkage for stuck pending sessions
if (buckets.pending0.length) {
  const planCol = client.db().collection('pathwayplans')
  console.log('\n--- PathwayPlan.generatedFromSessionId (stuck sessions) ---')
  for (const e of buckets.pending0) {
    const d = byId.get(e.sessionId)
    const plan = await planCol.findOne(
      { userId: d?.userId },
      {
        projection: { generatedFromSessionId: 1, generatedAt: 1, planType: 1 },
        sort: { generatedAt: -1 },
      },
    )
    const from = plan?.generatedFromSessionId?.toString?.() ?? 'none'
    const match = from === e.sessionId ? 'MATCH' : 'STALE'
    console.log(
      `  ${e.matrixKey}: planFrom=${from.slice(-8)} (${match}) planAt=${plan?.generatedAt?.toISOString?.()?.slice(0, 19) ?? 'n/a'}`,
    )
  }
}

await client.close()
