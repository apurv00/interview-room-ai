#!/usr/bin/env node
/**
 * Audit domain×depth coverage for the full roster matrix.
 *
 * Phase 6 backfill model:
 *   - Non-general domains → QuestionBank rows in shared/db/data/questionBankBackfill.json
 *   - General domain → flow templates (QuestionBank skips general by design)
 *
 * Usage:
 *   node scripts/audit-domain-coverage.mjs
 *   node scripts/audit-domain-coverage.mjs --strict   # exit 1 on any gap
 */
import { existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { listDomainDepthCombos } from '../modules/qa/orchestrator/rosterMatrix.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const strict = process.argv.includes('--strict')

const flowDir = join(root, 'modules/interview/flow/templates')
const skillsDir = join(root, 'modules/interview/skills')
const backfillPath = join(root, 'shared/db/data/questionBankBackfill.json')

/** @type {{ domain: string, interviewType: string }[]} */
const backfill = JSON.parse(readFileSync(backfillPath, 'utf8'))
const backfillCells = new Map()
for (const row of backfill) {
  const key = `${row.domain}/${row.interviewType}`
  backfillCells.set(key, (backfillCells.get(key) ?? 0) + 1)
}

const combos = listDomainDepthCombos('full')
/** @type {string[]} */
const gaps = []

console.log(`Auditing ${combos.length} domain×depth combos (full roster)...\n`)

for (const { domain, depth } of combos) {
  const key = `${domain}/${depth}`
  const missing = []

  if (depth === 'academics') {
    // Academics is a subject viva sourced from per-domain {domain}-academics.md skill files,
    // NOT the QuestionBank — verify the skill file (with the general-academics.md backstop)
    // instead of a bank row, or every applicable */academics cell reads as a false gap.
    const hasOwn = existsSync(join(skillsDir, `${domain}-academics.md`))
    const hasBackstop = existsSync(join(skillsDir, 'general-academics.md'))
    if (!hasOwn && !hasBackstop) missing.push('skill-file')
  } else if (domain === 'general') {
    const flowFile = join(flowDir, `${domain}-${depth}.ts`)
    if (!existsSync(flowFile)) missing.push('flow-template')
  } else {
    const count = backfillCells.get(key) ?? 0
    if (count === 0) missing.push('question-bank')
    else if (count < 4) missing.push(`question-bank-thin(${count})`)
  }

  const status = missing.length ? 'GAP' : 'OK'
  console.log(`${status.padEnd(4)} ${key}${missing.length ? ' — ' + missing.join(', ') : ''}`)
  if (missing.length) gaps.push(`${key}: ${missing.join(', ')}`)
}

const bankCombos = combos.filter((c) => c.domain !== 'general' && c.depth !== 'academics').length
console.log(`\nSummary: ${combos.length - gaps.length}/${combos.length} combos fully covered`)
console.log(`Question bank cells: ${backfillCells.size} (expected ${bankCombos} non-general non-academics)`)
console.log(`Gaps: ${gaps.length}`)

if (strict && gaps.length) {
  console.error('\nStrict mode: failing due to coverage gaps.')
  process.exit(1)
}

process.exit(0)
