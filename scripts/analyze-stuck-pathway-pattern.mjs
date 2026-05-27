#!/usr/bin/env node
/**
 * Compare stuck-pathway sessions vs succeeded across telemetry signals.
 * Read-only analysis of artifacts from a finished QA matrix run.
 */
import fs from 'node:fs'
import path from 'node:path'

const reportId = process.argv[2] || 'qa-browser-full-1779806117459'
const root = path.resolve(import.meta.dirname, '..')
const runDir = path.join(root, 'modules/qa/output/runs', reportId)
const telemetryPath = path.join(runDir, 'telemetry.jsonl')
const csvPath = path.join(root, 'modules/qa/output', `${reportId}-sessions.csv`)

const STUCK = new Set([
  '6a15b5b73cedd7b2ecf012d6',
  '6a15b6b63ac36ceb75315a40',
  '6a15b71a3ac36ceb75315b57',
  '6a15b80e3cedd7b2ecf0159b',
  '6a15bef43ac36ceb75315fec',
  '6a15c0043ac36ceb75316233',
])

const csvLines = fs.readFileSync(csvPath, 'utf8').trim().split(/\r?\n/)
const header = csvLines[0].split(',')
const colIdx = (n) => header.indexOf(n)
const iSession = colIdx('sessionId')
const iMatrix = colIdx('matrixKey')

const sessions = []
for (const line of csvLines.slice(1)) {
  const cols = line.split(',')
  sessions.push({
    sessionId: cols[iSession],
    matrixKey: cols[iMatrix],
    depth: cols[iMatrix].split('/')[1],
  })
}

// Build per-shard chronological list of generate-feedback calls
const feedbackRowsByShard = new Map() // shard -> array of {sessionId, matrixKey, durationMs, epoch, completedAtEpoch}
const rl = fs.readFileSync(telemetryPath, 'utf8').split(/\r?\n/)
for (const line of rl) {
  if (!line) continue
  const rec = JSON.parse(line)
  if (rec.step !== 'generate-feedback') continue
  if (!rec.sessionId) continue
  if (rec.network?.[0]?.status !== 200) continue // exclude the coding/sysdes 400s
  const shard = (rec.runId || '').split('--').pop()
  const completedAtEpoch = new Date(rec.timestamp).getTime()
  const list = feedbackRowsByShard.get(shard) || []
  list.push({
    sessionId: rec.sessionId,
    matrixKey: rec.matrixKey,
    durationMs: rec.durationMs,
    completedAtEpoch,
    stuck: STUCK.has(rec.sessionId),
  })
  feedbackRowsByShard.set(shard, list)
}
for (const list of feedbackRowsByShard.values()) {
  list.sort((a, b) => a.completedAtEpoch - b.completedAtEpoch)
}

// For each session, compute gap to NEXT feedback completion on same shard.
const enriched = []
for (const [shard, list] of feedbackRowsByShard.entries()) {
  for (let i = 0; i < list.length; i++) {
    const cur = list[i]
    const next = list[i + 1]
    const gapToNextMs = next ? next.completedAtEpoch - cur.completedAtEpoch : null
    enriched.push({
      shard,
      sessionId: cur.sessionId,
      matrixKey: cur.matrixKey,
      durationMs: cur.durationMs,
      completedAt: new Date(cur.completedAtEpoch).toISOString().slice(11, 19),
      gapToNextMs,
      stuck: cur.stuck,
      isLastOnShard: !next,
    })
  }
}

// Distribution of gapToNext for stuck vs succeeded
function quantile(arr, q) {
  if (!arr.length) return null
  const s = arr.slice().sort((a, b) => a - b)
  const pos = (s.length - 1) * q
  const base = Math.floor(pos)
  const rest = pos - base
  return s[base + 1] !== undefined ? s[base] + rest * (s[base + 1] - s[base]) : s[base]
}

const stuckGaps = enriched.filter((e) => e.stuck && e.gapToNextMs != null).map((e) => e.gapToNextMs)
const succeededGaps = enriched.filter((e) => !e.stuck && e.gapToNextMs != null).map((e) => e.gapToNextMs)
const stuckLastOnShard = enriched.filter((e) => e.stuck && e.isLastOnShard).length
const succeededLastOnShard = enriched.filter((e) => !e.stuck && e.isLastOnShard).length

console.log('=== Gap from feedback completion to NEXT feedback completion on same shard ===')
console.log(`Stuck     (n=${stuckGaps.length}): min=${Math.min(...stuckGaps)}ms  p50=${Math.round(quantile(stuckGaps, 0.5))}ms  p90=${Math.round(quantile(stuckGaps, 0.9))}ms  max=${Math.max(...stuckGaps)}ms`)
console.log(`Succeeded (n=${succeededGaps.length}): min=${Math.min(...succeededGaps)}ms  p50=${Math.round(quantile(succeededGaps, 0.5))}ms  p90=${Math.round(quantile(succeededGaps, 0.9))}ms  max=${Math.max(...succeededGaps)}ms`)
console.log(`Stuck "last on shard": ${stuckLastOnShard}/6   Succeeded "last on shard": ${succeededLastOnShard}/${enriched.filter((e)=>!e.stuck).length}`)
console.log('')

console.log('=== Per-stuck session detail ===')
for (const e of enriched.filter((e) => e.stuck).sort((a, b) => a.completedAt.localeCompare(b.completedAt))) {
  const gap = e.gapToNextMs == null ? 'LAST-ON-SHARD' : `${e.gapToNextMs}ms`
  console.log(`  ${e.completedAt}  shard=${e.shard}  ${e.matrixKey.padEnd(40)}  fbDur=${e.durationMs}ms  gapToNextFeedback=${gap}`)
}
console.log('')

// Print the full per-shard sequence with stuck flagged
console.log('=== Full per-shard feedback sequence (stuck flagged with ⚠) ===')
for (const [shard, list] of feedbackRowsByShard.entries()) {
  console.log(`-- ${shard} (${list.length} feedback calls)`)
  for (let i = 0; i < list.length; i++) {
    const r = list[i]
    const next = list[i + 1]
    const gap = next ? `→${next.completedAtEpoch - r.completedAtEpoch}ms` : '→END'
    const t = new Date(r.completedAtEpoch).toISOString().slice(11, 19)
    const flag = r.stuck ? '⚠ STUCK   ' : '  ok      '
    console.log(`  [${String(i+1).padStart(2)}] ${flag} ${t}  ${r.matrixKey.padEnd(42)}  fbDur=${String(r.durationMs).padStart(5)}ms  ${gap}`)
  }
}
