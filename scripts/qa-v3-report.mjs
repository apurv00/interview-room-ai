#!/usr/bin/env node
/**
 * Full v3 report pipeline: matrix MD/CSV → triage → optional Linear.
 *
 * Usage:
 *   node scripts/qa-v3-report.mjs qa-browser-smoke-1779724948017
 *   node scripts/qa-v3-report.mjs runs/qa-browser-smoke-1779724948017/matrix-report.json
 *   node scripts/qa-v3-report.mjs qa-browser-smoke-1779724948017 --linear
 */
import { existsSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { loadDotEnvLocal } from '../modules/qa/runner/loadEnv.mjs'
import { resolveReportJsonPath } from '../modules/qa/agents/baselineDiff.mjs'
import { triageRun } from '../modules/qa/agents/triage.mjs'
import { syncFindingsToLinear } from '../modules/qa/agents/linearSync.mjs'

loadDotEnvLocal()

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

function arg(name, fallback = null) {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : fallback
}

let input = process.argv.find((a) => !a.startsWith('-') && (a.includes('qa-browser') || a.endsWith('.json')))
const baselineId = arg('--baseline', null)
const linear = process.argv.includes('--linear')
const dryRun = process.argv.includes('--dry-run')

if (!input) {
  console.error('Usage: node scripts/qa-v3-report.mjs <reportId|matrix-report.json> [--baseline id] [--linear]')
  process.exit(1)
}

let reportId = input.includes('qa-browser') ? input.replace(/.*(qa-browser-[^/\\]+).*/, '$1') : basename(input, '.json')
if (input.endsWith('matrix-report.json')) {
  reportId = basename(dirname(input))
}

const reportJson = input.endsWith('.json') ? input : resolveReportJsonPath(reportId)
if (!reportJson || !existsSync(reportJson)) {
  console.error(`Matrix report not found for ${input}`)
  process.exit(1)
}

const useSdk = process.argv.includes('--sdk')
const useNarrative = process.argv.includes('--narrative')

const { summary, triagePath, findingsCsvPath } = await triageRun(reportId, {
  baselineId: baselineId ?? undefined,
  sdk: useSdk,
})

if (useNarrative) {
  const { generateReporterNarrative } = await import('../modules/qa/agents/reporterNarrative.mjs')
  const { outPath } = await generateReporterNarrative(reportId)
  console.log(`Narrative: ${outPath}`)
}

const gen = spawnSync('node', ['scripts/generate-qa-browser-report.mjs', reportJson], {
  cwd: root,
  stdio: 'inherit',
  shell: process.platform === 'win32',
})
if (gen.status !== 0) process.exit(gen.status ?? 1)

console.log(`\nTriage: ${summary.activeP0Count} active P0, ${summary.findings.length} total findings`)
console.log(triagePath)
console.log(findingsCsvPath)

if (linear) {
  const sync = await syncFindingsToLinear({
    findings: summary.findings,
    reportId,
    dryRun,
  })
  if (sync.skipped) console.warn(`Linear: ${sync.reason}`)
  else console.log(`Linear: processed ${sync.synced} finding(s)`)
}

process.exit(summary.activeP0Count > 0 ? 2 : 0)
