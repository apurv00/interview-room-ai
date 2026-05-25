#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const input = process.argv[2]
if (!input) {
  console.error('Usage: node scripts/extract-qa-console-report.mjs <console-dump.json>')
  process.exit(1)
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const raw = readFileSync(input, 'utf-8')
const messages = JSON.parse(raw)

let jsonStr = null
for (const m of messages) {
  const a = m.args?.[0]
  if (typeof a === 'string' && a.startsWith('{"reportId"')) jsonStr = a
}

if (!jsonStr) {
  console.error('No report JSON found in console dump')
  process.exit(1)
}

const report = JSON.parse(jsonStr)
const outDir = join(root, 'modules/qa/output')
mkdirSync(outDir, { recursive: true })
const path = join(outDir, `${report.reportId}.json`)
writeFileSync(path, JSON.stringify(report, null, 2), 'utf-8')
console.log(path)
console.log(`Pass: ${report.passedRuns}/${report.totalRuns} (${(report.passRate * 100).toFixed(1)}%)`)
console.log(`Eval rows: ${report.evaluationRows?.length ?? 0}`)
