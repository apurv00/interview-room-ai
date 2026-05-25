#!/usr/bin/env node
/**
 * Bulk-replay pathway/regenerate events to Inngest Cloud for stuck sessions.
 *
 * Use after Inngest Cloud sync when pathwayGenerationStatus is stuck at
 * `pending` with no worker pickup (attempts=0 / no startedAt).
 *
 * Usage:
 *   # Preview targets (no sends)
 *   node scripts/replay-pathway-regenerate.mjs --dry-run
 *
 *   # Replay all pending sessions since QA run date
 *   INNGEST_EVENT_KEY=your-prod-key node scripts/replay-pathway-regenerate.mjs
 *
 *   # Replay from QA sessions CSV only
 *   INNGEST_EVENT_KEY=... node scripts/replay-pathway-regenerate.mjs --csv modules/qa/output/qa-browser-full-1779529900005-sessions.csv
 *
 * Notes:
 *   - Sends to Inngest Cloud (not local dev). Do not set INNGEST_DEV=1.
 *   - Does not call enqueuePathwayRegeneration (CAS blocks re-enqueue on pending).
 *   - Sends events directly; pathwayJob marks running → succeeded.
 */
import fs from 'node:fs'
import path from 'node:path'
import mongoose from 'mongoose'

const root = path.resolve(import.meta.dirname, '..')

function loadEnvLocal() {
  const envPath = path.join(root, '.env.local')
  if (!fs.existsSync(envPath)) return
  const parsed = {}
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
    parsed[key] = val
  }
  for (const [key, val] of Object.entries(parsed)) {
    if (val && !process.env[key]) process.env[key] = val
  }
}

function parseArgs(argv) {
  const opts = {
    dryRun: false,
    csv: null,
    since: '2026-05-23T00:00:00.000Z',
    limit: 0,
    delayMs: 250,
  }
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--dry-run') opts.dryRun = true
    else if (a === '--csv') opts.csv = argv[++i]
    else if (a === '--since') opts.since = argv[++i]
    else if (a === '--limit') opts.limit = parseInt(argv[++i], 10)
    else if (a === '--delay-ms') opts.delayMs = parseInt(argv[++i], 10)
    else if (a === '--help') {
      console.log(`Usage: INNGEST_EVENT_KEY=... node scripts/replay-pathway-regenerate.mjs [options]

Options:
  --dry-run          List targets only, do not send events
  --csv <path>       Restrict to sessionIds listed in QA sessions CSV
  --since <iso>      Only sessions completed on/after this time (default: 2026-05-23)
  --limit <n>        Max events to send (0 = no limit)
  --delay-ms <ms>    Pause between sends (default: 250)
`)
      process.exit(0)
    }
  }
  return opts
}

function readSessionIdsFromCsv(csvPath) {
  const abs = path.isAbsolute(csvPath) ? csvPath : path.join(root, csvPath)
  const lines = fs.readFileSync(abs, 'utf8').split(/\r?\n/).filter(Boolean)
  const header = lines[0].split(',')
  const idx = header.indexOf('sessionId')
  if (idx === -1) throw new Error(`No sessionId column in ${csvPath}`)
  return lines.slice(1).map((line) => line.split(',')[idx]).filter(Boolean)
}

async function fetchTargets(opts) {
  const uri = process.env.MONGODB_URI
  if (!uri) throw new Error('MONGODB_URI is required (set in .env.local)')

  await mongoose.connect(uri, { serverSelectionTimeoutMS: 15000 })
  const col = mongoose.connection.db.collection('interviewsessions')

  const filter = {
    pathwayGenerationStatus: 'pending',
    completedAt: { $gte: new Date(opts.since) },
  }
  if (opts.csv) {
    const ids = readSessionIdsFromCsv(opts.csv)
    filter._id = { $in: ids.map((id) => new mongoose.Types.ObjectId(id)) }
  }

  let cursor = col
    .find(filter, {
      projection: {
        _id: 1,
        userId: 1,
        pathwayGenerationAttempts: 1,
        pathwayGenerationStartedAt: 1,
        completedAt: 1,
      },
    })
    .sort({ completedAt: 1 })

  if (opts.limit > 0) cursor = cursor.limit(opts.limit)

  const docs = await cursor.toArray()
  await mongoose.disconnect()

  return docs.map((d) => ({
    sessionId: d._id.toString(),
    userId: d.userId?.toString(),
    attempts: d.pathwayGenerationAttempts ?? 0,
    startedAt: d.pathwayGenerationStartedAt ?? null,
    completedAt: d.completedAt?.toISOString?.() ?? null,
  }))
}

async function sendEvent(eventKey, payload) {
  const res = await fetch(`https://inn.gs/e/${eventKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30000),
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Inngest send failed HTTP ${res.status}: ${body.slice(0, 200)}`)
  }
  return res.json().catch(() => ({}))
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

loadEnvLocal()
const opts = parseArgs(process.argv)

// Never route replay sends to local dev server
delete process.env.INNGEST_DEV

const eventKey = process.env.INNGEST_EVENT_KEY
if (!opts.dryRun && !eventKey) {
  console.error(
    'INNGEST_EVENT_KEY is required for production replay.\n' +
      'Get it from Inngest Cloud → Manage → Keys, then run:\n' +
      '  $env:INNGEST_EVENT_KEY="your-key"; node scripts/replay-pathway-regenerate.mjs',
  )
  process.exit(1)
}

const targets = await fetchTargets(opts)
const valid = targets.filter((t) => t.userId)
const skipped = targets.length - valid.length

console.log(`Found ${targets.length} pending session(s) to replay (${skipped} skipped — missing userId)`)
if (valid.length === 0) {
  console.log('Nothing to do.')
  process.exit(0)
}

for (const t of valid.slice(0, 10)) {
  console.log(
    `  ${t.sessionId} user=${t.userId} attempts=${t.attempts} startedAt=${t.startedAt ?? 'null'}`,
  )
}
if (valid.length > 10) console.log(`  ... and ${valid.length - 10} more`)

if (opts.dryRun) {
  console.log('\nDry run — no events sent.')
  process.exit(0)
}

console.log(`\nSending ${valid.length} pathway/regenerate event(s) to Inngest Cloud...`)

let sent = 0
let failed = 0
for (const t of valid) {
  try {
    await sendEvent(eventKey, {
      name: 'pathway/regenerate',
      data: { sessionId: t.sessionId, userId: t.userId },
    })
    sent++
    process.stdout.write(`\r  sent ${sent}/${valid.length}`)
    if (opts.delayMs > 0) await sleep(opts.delayMs)
  } catch (err) {
    failed++
    console.error(`\n  FAIL ${t.sessionId}: ${err instanceof Error ? err.message : err}`)
  }
}

console.log(`\nDone: ${sent} sent, ${failed} failed`)
console.log('Monitor runs: Inngest Cloud → Events → pathway/regenerate')
process.exit(failed > 0 ? 1 : 0)
