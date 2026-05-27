#!/usr/bin/env node
/**
 * Prod GA gate: preflight → ui-smoke → mini-smoke → optional full matrix.
 *
 * Usage:
 *   node scripts/qa-v3-gate.mjs --prod
 *   node scripts/qa-v3-gate.mjs --prod --with-matrix
 *   node scripts/qa-v3-gate.mjs --prod --skip-ui
 */
import { spawnSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadDotEnvLocal } from '../modules/qa/runner/loadEnv.mjs'

loadDotEnvLocal()

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const prod = process.argv.includes('--prod')
const withMatrix = process.argv.includes('--with-matrix')
const skipUi = process.argv.includes('--skip-ui')
const skipMini = process.argv.includes('--skip-mini')

function run(label, args) {
  console.log(`\n=== ${label} ===\n`)
  const r = spawnSync('node', args, {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: process.env,
  })
  if (r.status !== 0) {
    console.error(`\nGATE FAIL at: ${label} (exit ${r.status ?? 1})`)
    process.exit(r.status ?? 1)
  }
}

if (!prod) {
  console.warn('Tip: use --prod for production GA gate against interviewprep.guru')
}

run('Preflight', ['scripts/qa-preflight.mjs', ...(prod ? ['--prod'] : [])])

if (!skipUi) {
  run('UI smoke', ['scripts/qa-v3-ui-smoke.mjs', ...(prod ? ['--prod'] : [])])
}

if (!skipMini) {
  run('Mini-smoke matrix', [
    'scripts/qa-v3-matrix.mjs',
    ...(prod ? ['--prod'] : []),
    '--profile',
    'mini-smoke',
    '--report',
    '--observe',
    '--infra',
  ])
}

if (withMatrix) {
  run('Full 60-cell matrix', [
    'scripts/qa-v3-matrix.mjs',
    ...(prod ? ['--prod'] : []),
    '--profile',
    'full',
    '--report',
    '--observe',
    '--infra',
  ])
}

console.log('\n=== GATE PASS ===\n')
process.exit(0)
