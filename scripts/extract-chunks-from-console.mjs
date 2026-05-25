#!/usr/bin/env node
/** Extract QA_CH|N|payload lines from browser console dump into chunk files. */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const chunkDir = join(root, 'modules/qa/browser/chunks')
const input = process.argv[2]
if (!input) {
  console.error('Usage: node scripts/extract-chunks-from-console.mjs <console-dump.json>')
  process.exit(1)
}

mkdirSync(chunkDir, { recursive: true })
const messages = JSON.parse(readFileSync(input, 'utf-8'))
let count = 0
for (const m of messages) {
  const a = m.args?.[0]
  if (typeof a !== 'string') continue
  const match = a.match(/^QA_CH\|(\d+)\|([\s\S]*)$/)
  if (!match) continue
  const idx = Number(match[1])
  const payload = match[2]
  const path = join(chunkDir, `${String(idx).padStart(4, '0')}.txt`)
  if (!existsSync(path)) {
    writeFileSync(path, payload, 'utf-8')
    count++
  }
}
const existing = readdirSync(chunkDir).filter((f) => f.endsWith('.txt')).length
console.log(`New chunks saved: ${count}, total on disk: ${existing}`)
