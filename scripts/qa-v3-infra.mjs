#!/usr/bin/env node
/**
 * Post-run infra verification — Mongo pathway batch + Inngest checklist.
 *
 * Usage:
 *   node scripts/qa-v3-infra.mjs qa-browser-smoke-1779718960245
 *   node scripts/qa-v3-infra.mjs qa-browser-smoke-1779718960245 --prod
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadDotEnvLocal } from '../modules/qa/runner/loadEnv.mjs'
import { verifyRunInfra } from '../modules/qa/agents/infraVerifier.mjs'

loadDotEnvLocal()

const reportId = process.argv.find((a) => !a.startsWith('-') && a.includes('qa-browser'))
const prod = process.argv.includes('--prod')

if (!reportId) {
  console.error('Usage: node scripts/qa-v3-infra.mjs <reportId> [--prod]')
  process.exit(1)
}

const result = await verifyRunInfra({ reportId, prod })
const outPath = join(result.outDir, 'infra-report.json')
writeFileSync(outPath, JSON.stringify(result, null, 2), 'utf-8')

for (const c of result.checks) {
  console.log(`${c.ok ? '✅' : '❌'} ${c.id}: ${c.message}`)
}
console.log(`\nWrote ${outPath}`)
process.exit(result.ok ? 0 : 1)
