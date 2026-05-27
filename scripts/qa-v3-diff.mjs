#!/usr/bin/env node
/**
 * Baseline diff — compare current run metrics vs a prior report.
 *
 * Usage:
 *   node scripts/qa-v3-diff.mjs qa-browser-smoke-1779724948017
 *   node scripts/qa-v3-diff.mjs qa-browser-smoke-1779724948017 --baseline qa-browser-full-1779529900005
 */
import { writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runBaselineDiff, DEFAULT_BASELINE_ID } from '../modules/qa/agents/baselineDiff.mjs'
import { runOutputDir } from '../modules/qa/orchestrator/runManifest.mjs'

function arg(name, fallback = null) {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : fallback
}

const currentId = process.argv.find((a) => !a.startsWith('-') && a.includes('qa-browser'))
const baselineId = arg('--baseline', DEFAULT_BASELINE_ID)

if (!currentId) {
  console.error('Usage: node scripts/qa-v3-diff.mjs <currentReportId> [--baseline id]')
  process.exit(1)
}

const { diff, outPath, markdown } = runBaselineDiff(currentId, baselineId)
const mdPath = join(runOutputDir(currentId), 'baseline-diff.md')
writeFileSync(mdPath, markdown, 'utf-8')

console.log(markdown)
console.log(`\nWrote ${outPath}`)
console.log(`Wrote ${mdPath}`)
if (diff.pathwayFixed) {
  console.log('\n✅ Pathway P0 appears resolved vs baseline')
}
process.exit(0)
