#!/usr/bin/env node
/**
 * Rule-based Observer — classify failed (+ 5% pass) activities.
 *
 * Usage:
 *   node scripts/qa-v3-observe.mjs qa-browser-smoke-1779718960245
 */
import { observeRun } from '../modules/qa/agents/observer.mjs'

const reportId = process.argv.find((a) => !a.startsWith('-') && a.includes('qa-browser'))

if (!reportId) {
  console.error('Usage: node scripts/qa-v3-observe.mjs <reportId>')
  process.exit(1)
}

const { summary, outDir } = observeRun(reportId)
console.log(`Observed ${summary.observedCount}/${summary.totalActivities} activities`)
console.log('By classification:', summary.byClassification)
if (Object.keys(summary.bySeverity).length) {
  console.log('By severity:', summary.bySeverity)
}
console.log(`Output: ${outDir}`)
