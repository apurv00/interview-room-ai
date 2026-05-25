#!/usr/bin/env node
/** Reassemble QAPART|N|... chunks from browser console JSON dump */
import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const input = process.argv[2]
if (!input) {
  console.error('Usage: node scripts/reassemble-qa-chunks.mjs <console-dump.json>')
  process.exit(1)
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const messages = JSON.parse(readFileSync(input, 'utf-8'))
const parts = new Map()
let endMeta = null

for (const m of messages) {
  const a = m.args?.[0]
  if (typeof a !== 'string' || !a.startsWith('QAPART|')) continue
  const segs = a.split('|')
  const tag = segs[1]
  const payload = segs.slice(2).join('|')
  if (tag === 'END') {
    endMeta = { count: Number(segs[2]), length: Number(segs[3]) }
    continue
  }
  parts.set(Number(tag), payload)
}

if (!endMeta) {
  console.error('Missing QAPART|END marker')
  process.exit(1)
}

const sorted = [...parts.entries()].sort((a, b) => a[0] - b[0])
if (sorted.length !== endMeta.count) {
  console.warn(`Warning: expected ${endMeta.count} parts, got ${sorted.length}`)
}
const jsonStr = sorted.map(([, v]) => v).join('')
if (jsonStr.length !== endMeta.length) {
  console.warn(`Warning: length ${jsonStr.length} vs expected ${endMeta.length}`)
}

const report = JSON.parse(jsonStr)
const outDir = join(root, 'modules/qa/output')
mkdirSync(outDir, { recursive: true })
const path = join(outDir, `${report.reportId}.json`)
writeFileSync(path, JSON.stringify(report, null, 2), 'utf-8')
console.log(path)
console.log(`Pass: ${report.passedRuns}/${report.totalRuns} (${(report.passRate * 100).toFixed(1)}%)`)
console.log(`Eval rows: ${report.evaluationRows?.length ?? 0}`)
console.log(`Runs: ${report.runs?.length ?? 0}`)
