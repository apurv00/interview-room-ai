#!/usr/bin/env node
/**
 * Merge Observer + Infra + telemetry + manual findings → triage-summary.json
 *
 * Usage:
 *   node scripts/qa-v3-triage.mjs qa-browser-smoke-1779724948017
 *   node scripts/qa-v3-triage.mjs qa-browser-smoke-1779724948017 --baseline qa-browser-full-1779529900005
 *   node scripts/qa-v3-triage.mjs qa-browser-smoke-1779724948017 --linear --dry-run
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadDotEnvLocal } from '../modules/qa/runner/loadEnv.mjs'
import { triageRun } from '../modules/qa/agents/triage.mjs'
import { syncFindingsToLinear } from '../modules/qa/agents/linearSync.mjs'
import { runOutputDir } from '../modules/qa/orchestrator/runManifest.mjs'

loadDotEnvLocal()

function arg(name, fallback = null) {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : fallback
}

const reportId = process.argv.find((a) => !a.startsWith('-') && a.includes('qa-browser'))
const baselineId = arg('--baseline', null)
const skipDiff = process.argv.includes('--no-diff')
const linear = process.argv.includes('--linear')
const dryRun = process.argv.includes('--dry-run')
const createAll = process.argv.includes('--create-all')

if (!reportId) {
  console.error('Usage: node scripts/qa-v3-triage.mjs <reportId> [--baseline id] [--linear] [--dry-run]')
  process.exit(1)
}

const useSdk = process.argv.includes('--sdk')

const { summary, triagePath, findingsCsvPath, baselineDiff } = await triageRun(reportId, {
  baselineId: baselineId ?? undefined,
  skipDiff,
  sdk: useSdk,
})

console.log(`Triage: ${summary.findings.length} findings (${summary.activeP0Count} active P0)`)
console.log('By severity:', summary.bySeverity)
console.log('Recommendations:', summary.recommendations.map((r) => r.action).join(', ') || 'none')
console.log(`Wrote ${triagePath}`)
console.log(`Wrote ${findingsCsvPath}`)
if (baselineDiff && !baselineDiff.error) {
  console.log(`Baseline diff vs ${baselineDiff.baselineId}: pathwayFixed=${baselineDiff.pathwayFixed}`)
}

if (linear) {
  const sync = await syncFindingsToLinear({
    findings: summary.findings,
    reportId,
    dryRun,
    createAll,
  })
  if (sync.skipped) {
    console.warn(`Linear sync skipped: ${sync.reason}`)
  } else {
    console.log(`Linear: ${sync.synced} issue(s) processed`)
    for (const r of sync.results ?? []) {
      console.log(`  ${r.action} ${r.findingId} → ${r.linearId ?? r.title ?? ''}`)
    }
  }
  writeFileSync(join(runOutputDir(reportId), 'linear-sync.json'), JSON.stringify(sync, null, 2), 'utf-8')
}

process.exit(summary.activeP0Count > 0 ? 2 : 0)
