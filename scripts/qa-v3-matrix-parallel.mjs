#!/usr/bin/env node
/**
 * Run matrix cells in parallel browser workers (~3× faster wall time).
 *
 * Usage:
 *   node scripts/qa-v3-matrix-parallel.mjs --prod --profile full --shards 3
 *   node scripts/qa-v3-matrix-parallel.mjs --prod --mode full --shards 3 --report --observe --infra
 */
import { spawn } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { planShards } from '../modules/qa/orchestrator/matrixPlan.mjs'
import { mergeShardReports } from '../modules/qa/orchestrator/mergeShards.mjs'
import { saveManifest, runOutputDir } from '../modules/qa/orchestrator/runManifest.mjs'
import { loadDotEnvLocal } from '../modules/qa/runner/loadEnv.mjs'

loadDotEnvLocal()

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

function arg(name, fallback = null) {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : fallback
}

const prod = process.argv.includes('--prod')
const profileName = arg('--profile', 'full')
const mode = arg('--mode', profileName === 'full' ? 'full' : profileName === 'smoke' ? 'smoke' : 'full')
const shards = parseInt(arg('--shards', '3'), 10)
const parentReportId = arg('--report-id', `qa-browser-${mode}-${Date.now()}`)

const forwardArgs = []
if (prod) forwardArgs.push('--prod')
if (profileName) forwardArgs.push('--profile', profileName)
if (arg('--mode', null)) forwardArgs.push('--mode', mode)
if (arg('--questions', null)) forwardArgs.push('--questions', arg('--questions'))
if (arg('--duration', null)) forwardArgs.push('--duration', arg('--duration'))
if (arg('--experience', null)) forwardArgs.push('--experience', arg('--experience'))
if (process.argv.includes('--headless')) forwardArgs.push('--headless')
if (process.argv.includes('--llm')) forwardArgs.push('--llm')

const { total, plan } = planShards({ mode, shards })
console.log(`Parallel matrix: ${plan.length} workers, ${total} cells total`)
for (const s of plan) {
  console.log(`  shard ${s.shard}: offset=${s.offset} limit=${s.limit} (${s.count} cells)`)
}

saveManifest(parentReportId, {
  reportId: parentReportId,
  mode,
  status: 'running',
  parallel: { shards: plan.length, shardIds: plan.map((s) => `${parentReportId}--s${s.shard}`) },
  startedAt: new Date().toISOString(),
})

/**
 * @param {string[]} args
 */
function runChild(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', args, {
      cwd: root,
      stdio: 'inherit',
      shell: process.platform === 'win32',
      env: process.env,
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve(code)
      else reject(new Error(`Worker exited ${code}`))
    })
  })
}

const shardIds = []
const failures = []

await Promise.all(
  plan.map(async (s) => {
    const shardReportId = `${parentReportId}--s${s.shard}`
    shardIds.push(shardReportId)
    const args = [
      'scripts/qa-v3-matrix.mjs',
      ...forwardArgs,
      '--report-id',
      shardReportId,
      '--offset',
      String(s.offset),
      '--limit',
      String(s.limit),
    ]
    console.log(`\n>>> Starting shard ${s.shard}: ${shardReportId}\n`)
    try {
      await runChild(args)
    } catch (err) {
      failures.push({ shard: s.shard, shardReportId, error: String(err.message || err) })
    }
  }),
)

if (failures.length) {
  console.error('\nShard failures:', failures)
  console.error('Merge skipped — fix failed shards or re-run with --resume on shard ids')
  process.exit(1)
}

console.log('\n>>> Merging shard reports...\n')
const { outDir, report } = mergeShardReports(parentReportId, shardIds)
console.log(`Merged: ${report.passedRuns}/${report.totalRuns} passed → ${outDir}`)

saveManifest(parentReportId, {
  status: 'completed',
  finishedAt: new Date().toISOString(),
  passedRuns: report.passedRuns,
  totalRuns: report.totalRuns,
  parallel: { shards: shardIds, merged: true },
})

const postArgs = ['scripts/qa-v3-matrix.mjs', '--post-only', parentReportId]
if (prod) postArgs.push('--prod')
if (process.argv.includes('--observe')) postArgs.push('--observe')
if (process.argv.includes('--infra')) postArgs.push('--infra')
if (process.argv.includes('--report')) {
  postArgs.push('--report', '--triage', '--quality', '--strict-triage')
} else {
  if (process.argv.includes('--triage')) postArgs.push('--triage')
  if (process.argv.includes('--quality')) postArgs.push('--quality')
  if (process.argv.includes('--strict-triage')) postArgs.push('--strict-triage')
}
if (process.argv.includes('--llm')) postArgs.push('--llm')
const baseline = arg('--baseline', null)
if (baseline) postArgs.push('--baseline', baseline)

if (postArgs.length > 3) {
  const post = spawnSync('node', postArgs, {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })
  if (post.status !== 0 && post.status !== 2) process.exit(post.status ?? 1)
}

console.log(`\nReport ID: ${parentReportId}`)
console.log(`Output: ${runOutputDir(parentReportId)}`)
