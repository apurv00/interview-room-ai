#!/usr/bin/env node
/**
 * Phase 3.5 — UI smoke (lobby → interview room, TTS stream TTFB, Deepgram WS).
 *
 * Usage:
 *   node scripts/qa-v3-ui-smoke.mjs --prod
 *   node scripts/qa-v3-ui-smoke.mjs --prod --headless
 */
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runPlaywrightUiSmoke } from '../modules/qa/runner/playwrightUiSmoke.mjs'
import { verifyAuthSession } from '../modules/qa/runner/playwrightMatrix.mjs'
import { defaultAuthPath } from '../modules/qa/orchestrator/runManifest.mjs'
import { ensureQaAuth } from '../modules/qa/runner/automationAuth.mjs'
import { loadDotEnvLocal } from '../modules/qa/runner/loadEnv.mjs'

loadDotEnvLocal()

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

function arg(name, fallback = null) {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : fallback
}

const prod = process.argv.includes('--prod')
const baseUrl = arg('--url', prod ? 'https://www.interviewprep.guru' : 'http://localhost:3000')
const authPath = arg('--auth', defaultAuthPath(prod))
const headless = process.argv.includes('--headless')
const reportId = arg('--report-id', `qa-ui-smoke-${Date.now()}`)

if (!existsSync(authPath)) {
  mkdirSync(dirname(authPath), { recursive: true })
}

await ensureQaAuth({
  baseUrl,
  authPath,
  verifyAuthSession,
  log: console.log,
})

const auth = await verifyAuthSession(authPath, baseUrl)
if (!auth.ok) {
  console.error('Auth session invalid')
  process.exit(1)
}

console.log(`Authenticated as ${auth.user?.email ?? auth.user?.name ?? 'user'}`)

const result = await runPlaywrightUiSmoke({
  baseUrl,
  storageStatePath: authPath,
  reportId,
  userId: auth.user?.id ?? null,
  headless,
})

console.log(`\nReport ID: ${result.reportId}`)
console.log(`Output: ${result.outDir}`)
process.exit(result.report.passRate === 1 ? 0 : 1)
