#!/usr/bin/env node
/** Assemble QA report from sessionStorage chunk files and save to modules/qa/output/ */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const chunkDir = join(root, 'modules/qa/browser/chunks')
const outDir = join(root, 'modules/qa/output')

if (!existsSync(chunkDir)) {
  console.error('No chunk dir:', chunkDir)
  process.exit(1)
}

const files = readdirSync(chunkDir)
  .filter((f) => f.endsWith('.txt'))
  .sort()

if (files.length === 0) {
  console.error('No chunk files found')
  process.exit(1)
}

const jsonStr = files.map((f) => readFileSync(join(chunkDir, f), 'utf-8')).join('')
const report = JSON.parse(jsonStr)
mkdirSync(outDir, { recursive: true })
const path = join(outDir, `${report.reportId}.json`)
writeFileSync(path, JSON.stringify(report, null, 2), 'utf-8')
console.log(path)
console.log(`Chunks: ${files.length}, JSON bytes: ${jsonStr.length}`)
console.log(`Pass rate: ${(report.passRate * 100).toFixed(1)}% (${report.passedRuns}/${report.totalRuns})`)
console.log(`Eval rows: ${report.evaluationRows?.length ?? 0}`)
