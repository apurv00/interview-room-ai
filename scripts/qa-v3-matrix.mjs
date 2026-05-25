#!/usr/bin/env node
/**
 * QA Agent v3 — Playwright matrix runner.
 *
 * Usage:
 *   node scripts/qa-v3-matrix.mjs --prod --profile smoke
 *   node scripts/qa-v3-matrix.mjs --prod --mode full --questions 3
 *   node scripts/qa-v3-matrix.mjs --prod --profile full --report
 *   node scripts/qa-v3-matrix.mjs --resume qa-browser-full-1234567890
 */
import { existsSync, readFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { runPlaywrightMatrix, verifyAuthSession } from '../modules/qa/runner/playwrightMatrix.mjs'
import { defaultAuthPath, loadManifest, runOutputDir } from '../modules/qa/orchestrator/runManifest.mjs'
import { ensureQaAuth } from '../modules/qa/runner/automationAuth.mjs'
import { loadDotEnvLocal } from '../modules/qa/runner/loadEnv.mjs'

loadDotEnvLocal()

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const profiles = JSON.parse(readFileSync(join(root, 'modules/qa/config/runProfiles.json'), 'utf-8'))

function arg(name, fallback = null) {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : fallback
}

const prod = process.argv.includes('--prod')
const baseUrl = arg('--url', prod ? 'https://www.interviewprep.guru' : 'http://localhost:3000')
const authPath = arg('--auth', defaultAuthPath(prod))
const profileName = arg('--profile', null)
const profile = profileName ? profiles[profileName] : null
const mode = arg('--mode', profile?.mode ?? 'smoke')
const questions = parseInt(arg('--questions', String(profile?.questions ?? 6)), 10)
const duration = parseInt(arg('--duration', String(profile?.duration ?? 10)), 10)
const maxCells = parseInt(arg('--max-cells', String(profile?.maxCells ?? 0)), 10)
const headless = process.argv.includes('--headless')
const generateReport = process.argv.includes('--report')
const resumeId = arg('--resume', null)

if (resumeId) {
  const manifest = loadManifest(resumeId)
  if (manifest?.status === 'completed') {
    console.log(`Run ${resumeId} already completed (${manifest.passedRuns}/${manifest.totalRuns}).`)
    process.exit(0)
  }
  if (manifest?.status === 'running') {
    console.warn(`Run ${resumeId} was marked running — re-executing full matrix.`)
  }
}

if (!existsSync(authPath)) {
  mkdirSync(dirname(authPath), { recursive: true })
}

try {
  await ensureQaAuth({
    baseUrl,
    authPath,
    verifyAuthSession,
    log: console.log,
  })
} catch (err) {
  console.error(String(err.message || err))
  process.exit(1)
}

const auth = await verifyAuthSession(authPath, baseUrl)
console.log(`Authenticated as ${auth.user?.email ?? auth.user?.name ?? 'user'}`)

const reportId = resumeId ?? `qa-browser-${mode}-${Date.now()}`

try {
  const result = await runPlaywrightMatrix({
    baseUrl,
    storageStatePath: authPath,
    mode,
    questions,
    duration,
    maxCells,
    headless,
    reportId,
  })

  if (generateReport) {
    const reportJson = join(result.outDir, 'matrix-report.json')
    const gen = spawnSync('node', ['scripts/generate-qa-browser-report.mjs', reportJson], {
      cwd: root,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    })
    if (gen.status !== 0) process.exit(gen.status ?? 1)
  }

  const runPost = process.argv.includes('--observe') || process.argv.includes('--infra')
  if (runPost) {
    if (process.argv.includes('--observe')) {
      const obs = spawnSync('node', ['scripts/qa-v3-observe.mjs', result.reportId], {
        cwd: root,
        stdio: 'inherit',
        shell: process.platform === 'win32',
      })
      if (obs.status !== 0) console.warn('Observer exited with errors (non-fatal)')
    }
    if (process.argv.includes('--infra')) {
      const infraArgs = ['scripts/qa-v3-infra.mjs', result.reportId]
      if (prod) infraArgs.push('--prod')
      const infra = spawnSync('node', infraArgs, {
        cwd: root,
        stdio: 'inherit',
        shell: process.platform === 'win32',
      })
      if (infra.status !== 0) console.warn('Infra verifier reported issues')
    }
  }

  console.log(`\nReport ID: ${result.reportId}`)
  console.log(`Output: ${result.outDir}`)
  if (!generateReport) {
    console.log(`Generate report: npm run qa:report:browser -- ${join(result.outDir, 'matrix-report.json')}`)
  }
} catch (err) {
  console.error(String(err.message || err))
  console.error(`Partial artifacts may exist under ${runOutputDir(reportId)}`)
  process.exit(1)
}
