#!/usr/bin/env node
/**
 * Rule-based Observer — classify failed (+ 5% pass) activities.
 * Optional LLM upgrade via --llm (Anthropic Haiku, cost-capped).
 *
 * Usage:
 *   node scripts/qa-v3-observe.mjs qa-browser-smoke-1779718960245
 *   node scripts/qa-v3-observe.mjs qa-browser-smoke-1779718960245 --llm
 */
import { observeRun } from '../modules/qa/agents/observer.mjs'
import { llmObserveRun } from '../modules/qa/agents/llmObserver.mjs'
import { loadDotEnvLocal } from '../modules/qa/runner/loadEnv.mjs'

loadDotEnvLocal()

const reportId = process.argv.find((a) => !a.startsWith('-') && a.includes('qa-browser'))
const useLlm = process.argv.includes('--llm')

if (!reportId) {
  console.error('Usage: node scripts/qa-v3-observe.mjs <reportId> [--llm]')
  process.exit(1)
}

if (useLlm) {
  const { summary, outDir, llmCalls } = await llmObserveRun({ reportId })
  console.log(`LLM observed ${summary.observedCount} activities (${llmCalls} API calls)`)
  console.log('By classification:', summary.byClassification)
  if (Object.keys(summary.bySeverity).length) {
    console.log('By severity:', summary.bySeverity)
  }
  console.log(`Output: ${outDir}`)
} else {
  const { summary, outDir } = observeRun(reportId)
  console.log(`Observed ${summary.observedCount}/${summary.totalActivities} activities`)
  console.log('By classification:', summary.byClassification)
  if (Object.keys(summary.bySeverity).length) {
    console.log('By severity:', summary.bySeverity)
  }
  console.log(`Output: ${outDir}`)
  console.log('Tip: add --llm for Anthropic pass on failures/inconclusive (requires ANTHROPIC_API_KEY)')
}
