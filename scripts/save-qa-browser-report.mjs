#!/usr/bin/env node
/** Parse QA report JSON from stdin or file and write to modules/qa/output/ */
import { mkdirSync, writeFileSync, readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const input = process.argv[2]
  ? readFileSync(process.argv[2], 'utf-8')
  : readFileSync(0, 'utf-8')

const start = input.indexOf('QA_REPORT_START')
const end = input.indexOf('QA_REPORT_END')
let jsonStr = input
if (start >= 0 && end > start) {
  jsonStr = input.slice(start + 'QA_REPORT_START'.length, end).trim()
  const nl = jsonStr.indexOf('\n')
  if (nl >= 0) jsonStr = jsonStr.slice(nl + 1).trim()
}

const report = JSON.parse(jsonStr)
const outDir = join(root, 'modules/qa/output')
mkdirSync(outDir, { recursive: true })
const id = report.reportId || `qa-browser-${Date.now()}`
writeFileSync(join(outDir, `${id}.json`), JSON.stringify(report, null, 2), 'utf-8')
console.log(join(outDir, `${id}.json`))
console.log(`Pass rate: ${(report.passRate * 100).toFixed(1)}% (${report.passedRuns}/${report.totalRuns})`)
