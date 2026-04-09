#!/usr/bin/env node

/**
 * Module size budget check.
 *
 * Fails CI when any domain module exceeds its LOC or file-count budget.
 * Run manually: node scripts/check-module-size.mjs
 * Wired into CI via .github/workflows/ci.yml.
 *
 * Budgets are intentionally generous — they're early-warning tripwires,
 * not hard limits. If a module legitimately needs to grow past its budget,
 * update the budget here and add an ADR explaining why.
 */

import { execSync } from 'child_process'
import { readdirSync, statSync } from 'fs'
import { join, extname } from 'path'

const BUDGETS = {
  'modules/interview': { maxLOC: 30_000, maxFiles: 160 },
  'modules/learn':     { maxLOC: 25_000, maxFiles: 80 },
  'modules/resume':    { maxLOC: 20_000, maxFiles: 70 },
  'modules/b2b':       { maxLOC: 5_000,  maxFiles: 20 },
  'modules/cms':       { maxLOC: 5_000,  maxFiles: 20 },
  'shared':            { maxLOC: 25_000, maxFiles: 130 },
}

const TS_EXTENSIONS = new Set(['.ts', '.tsx'])

function countFiles(dir) {
  let count = 0
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '__tests__') continue
        count += countFiles(fullPath)
      } else if (TS_EXTENSIONS.has(extname(entry.name))) {
        count++
      }
    }
  } catch { /* dir doesn't exist */ }
  return count
}

function countLOC(dir) {
  try {
    const output = execSync(
      `find "${dir}" -name '*.ts' -o -name '*.tsx' | grep -v __tests__ | grep -v node_modules | xargs wc -l 2>/dev/null | tail -1`,
      { encoding: 'utf-8' }
    ).trim()
    const match = output.match(/^\s*(\d+)/)
    return match ? parseInt(match[1], 10) : 0
  } catch {
    return 0
  }
}

let failed = false

console.log('Module size budget check')
console.log('========================\n')

for (const [dir, budget] of Object.entries(BUDGETS)) {
  const files = countFiles(dir)
  const loc = countLOC(dir)
  const fileOver = files > budget.maxFiles
  const locOver = loc > budget.maxLOC

  const fileStatus = fileOver ? '❌' : '✓'
  const locStatus = locOver ? '❌' : '✓'

  console.log(`${dir}`)
  console.log(`  ${fileStatus} Files: ${files} / ${budget.maxFiles}`)
  console.log(`  ${locStatus} LOC:   ${loc} / ${budget.maxLOC}`)

  if (fileOver || locOver) {
    failed = true
    if (fileOver) console.log(`  ⚠  File count exceeds budget by ${files - budget.maxFiles}`)
    if (locOver) console.log(`  ⚠  LOC exceeds budget by ${loc - budget.maxLOC}`)
  }
  console.log()
}

if (failed) {
  console.log('FAILED: One or more modules exceed their size budget.')
  console.log('If this growth is intentional, update the budget in scripts/check-module-size.mjs')
  console.log('and add an ADR to docs/adr/ explaining why.')
  process.exit(1)
} else {
  console.log('All modules within budget. ✓')
}
