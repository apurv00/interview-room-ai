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
import { runPlaywrightMatrix, verifyAuthSession, loadResumeState } from '../modules/qa/runner/playwrightMatrix.mjs'
import { defaultAuthPath, runOutputDir } from '../modules/qa/orchestrator/runManifest.mjs'
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
const postOnlyId = arg('--post-only', null)

if (postOnlyId) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const result = { reportId: postOnlyId, outDir: runOutputDir(postOnlyId) }
  if (process.argv.includes('--observe')) {
    const obsArgs = ['scripts/qa-v3-observe.mjs', postOnlyId]
    if (process.argv.includes('--llm')) obsArgs.push('--llm')
    spawnSync('node', obsArgs, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' })
  }
  if (process.argv.includes('--infra')) {
    const infraArgs = ['scripts/qa-v3-infra.mjs', postOnlyId]
    if (prod) infraArgs.push('--prod')
    spawnSync('node', infraArgs, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' })
  }
  if (process.argv.includes('--report') || process.argv.includes('--triage')) {
    const postArgs = ['scripts/qa-v3-triage.mjs', postOnlyId]
    const baseline = arg('--baseline', null)
    if (baseline) postArgs.push('--baseline', baseline)
    spawnSync('node', postArgs, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' })
  }
  if (process.argv.includes('--report')) {
    const reportJson = join(result.outDir, 'matrix-report.json')
    spawnSync('node', ['scripts/generate-qa-browser-report.mjs', reportJson], {
      cwd: root,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    })
  }
  process.exit(0)
}

const baseUrl = arg('--url', prod ? 'https://www.interviewprep.guru' : 'http://localhost:3000')
const authPath = arg('--auth', defaultAuthPath(prod))
const profileName = arg('--profile', null)
const profile = profileName ? profiles[profileName] : null
const mode = arg('--mode', profile?.mode ?? 'smoke')
const questions = parseInt(arg('--questions', String(profile?.questions ?? 6)), 10)
const duration = parseInt(arg('--duration', String(profile?.duration ?? 10)), 10)
const maxCells = parseInt(arg('--limit', arg('--max-cells', String(profile?.maxCells ?? 0))), 10)
const explicitOffset = arg('--offset', null)
const headless = process.argv.includes('--headless')
const generateReport = process.argv.includes('--report')
const cellRetry = parseInt(arg('--cell-retry', '1'), 10)
const resumeId = arg('--resume', null)

let resumeOffset = 0
let priorReport = null
if (resumeId) {
  const resume = loadResumeState(resumeId)
  priorReport = resume.priorReport
  resumeOffset = resume.offset
  const manifest = resume.manifest
  if (manifest?.status === 'completed' && !manifest?.resume?.quotaAborted) {
    console.log(`Run ${resumeId} already completed (${manifest.passedRuns}/${manifest.totalRuns}).`)
    process.exit(0)
  }
  if (manifest?.status === 'running') {
    console.warn(`Run ${resumeId} was marked running — resuming from cell offset ${resumeOffset}.`)
  }
  if (resumeOffset > 0) {
    console.log(`Resume: ${resumeOffset} cells already in matrix-report.json`)
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

const reportId = arg('--report-id', resumeId ?? `qa-browser-${mode}-${Date.now()}`)
const cellOffset = explicitOffset != null ? parseInt(explicitOffset, 10) : resumeOffset

try {
  const result = await runPlaywrightMatrix({
    baseUrl,
    storageStatePath: authPath,
    mode,
    questions,
    duration,
    maxCells,
    offset: cellOffset,
    cellRetry,
    priorReport,
    headless,
    reportId,
  })

  const runPost = process.argv.includes('--observe') || process.argv.includes('--infra')
  if (runPost) {
    if (process.argv.includes('--observe')) {
      const obsArgs = ['scripts/qa-v3-observe.mjs', result.reportId]
      if (process.argv.includes('--llm')) obsArgs.push('--llm')
      const obs = spawnSync('node', obsArgs, {
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

  if (generateReport || process.argv.includes('--triage')) {
    const postArgs = ['scripts/qa-v3-triage.mjs', result.reportId]
    const baseline = arg('--baseline', null)
    if (baseline) postArgs.push('--baseline', baseline)
    if (process.argv.includes('--linear')) postArgs.push('--linear')
    const triage = spawnSync('node', postArgs, {
      cwd: root,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    })
    if (triage.status === 2) console.warn('Triage: active P0 findings remain')
    else if (triage.status !== 0 && triage.status != null) console.warn('Triage exited with errors')
  }

  if (generateReport) {
    const reportJson = join(result.outDir, 'matrix-report.json')
    const gen = spawnSync('node', ['scripts/generate-qa-browser-report.mjs', reportJson], {
      cwd: root,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    })
    if (gen.status !== 0) process.exit(gen.status ?? 1)
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
