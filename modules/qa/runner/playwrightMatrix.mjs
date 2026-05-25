import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'
import { createRunManifest, runOutputDir, saveManifest } from '../orchestrator/runManifest.mjs'
import { writeTelemetryArtifacts } from './telemetry.mjs'

const moduleRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

function loadRunnerSource() {
  let source = readFileSync(join(moduleRoot, 'browser', 'qa-matrix-runner.js'), 'utf-8')
  // Playwright sets hash via goto URL
  source = source.replace(/^location\.hash=[^\r\n]+\r?\n/, '')
  return source
}

function readHarnessVersion(source) {
  const m = source.match(/HARNESS_VERSION = '([^']+)'/)
  return m?.[1] ?? 'unknown'
}

/**
 * @param {object} options
 * @param {string} options.baseUrl
 * @param {string} options.storageStatePath
 * @param {string} [options.mode]
 * @param {number} [options.questions]
 * @param {boolean} [options.headless]
 * @param {number} [options.timeoutMs]
 * @param {string} [options.reportId]
 * @param {(msg: string) => void} [options.log]
 */
export async function runPlaywrightMatrix(options) {
  const {
    baseUrl,
    storageStatePath,
    mode = 'smoke',
    questions = 3,
    headless = false,
    timeoutMs = 4 * 60 * 60 * 1000,
    reportId = `qa-browser-${mode}-${Date.now()}`,
    log = console.log,
  } = options

  const runnerSource = loadRunnerSource()
  const harnessVersion = readHarnessVersion(runnerSource)
  const outDir = runOutputDir(reportId)
  mkdirSync(outDir, { recursive: true })

  saveManifest(reportId, {
    reportId,
    mode,
    questions,
    baseUrl,
    harnessVersion,
    status: 'running',
    startedAt: new Date().toISOString(),
  })

  const externalTelemetry = []
  const playwrightNetwork = []
  const consoleLines = []

  log(`QA v3 Playwright — reportId=${reportId} mode=${mode} questions=${questions}`)
  log(`baseUrl=${baseUrl} harness=${harnessVersion}`)
  log(`Using storageState (OAuth not needed during matrix — cookies only)`)

  const browser = await chromium.launch({ headless })
  let report = null
  let fatalError = null

  try {
    const context = await browser.newContext({ storageState: storageStatePath })
    const page = await context.newPage()

    page.on('console', (msg) => {
      const text = msg.text()
      consoleLines.push({ level: msg.type(), text, timestamp: Date.now() })
      if (text.startsWith('QA_TELEMETRY ')) {
        try {
          externalTelemetry.push(JSON.parse(text.slice('QA_TELEMETRY '.length)))
        } catch {
          /* ignore malformed */
        }
      }
    })

    page.on('pageerror', (err) => {
      consoleLines.push({ level: 'pageerror', text: err.message, timestamp: Date.now() })
    })

    page.on('response', (response) => {
      const url = response.url()
      if (!url.includes('/api/')) return
      playwrightNetwork.push({
        url,
        status: response.status(),
        method: response.request().method(),
        timestamp: Date.now(),
      })
    })

    const hash = `mode=${encodeURIComponent(mode)}&questions=${questions}&autostart=1`
    const landing = `${baseUrl.replace(/\/$/, '')}/#${hash}`
    log(`Navigating ${landing}`)
    await page.goto(landing, { waitUntil: 'domcontentloaded', timeout: 120_000 })

    await page.evaluate((src) => {
      const el = document.createElement('script')
      el.textContent = src
      document.documentElement.appendChild(el)
    }, runnerSource)

    log('Matrix running — waiting for QA_MATRIX_DONE …')

    await page.waitForFunction(
      () => document.title === 'QA_MATRIX_DONE' || document.title === 'QA_MATRIX_ERROR',
      { timeout: timeoutMs },
    )

    const title = await page.title()
    if (title === 'QA_MATRIX_ERROR') {
      const errText = await page.evaluate(() => {
        const el = document.getElementById('qa-log')
        return el?.textContent?.slice(-500) ?? 'unknown matrix error'
      })
      throw new Error(`Matrix runner error: ${errText}`)
    }

    report = await page.evaluate(() => window.__QA_REPORT__ ?? null)
    if (!report) {
      throw new Error('Matrix completed but window.__QA_REPORT__ is missing')
    }

    await context.close()
  } catch (err) {
    fatalError = err
    saveManifest(reportId, {
      status: 'failed',
      finishedAt: new Date().toISOString(),
      error: String(err.message || err),
    })
    throw err
  } finally {
    await browser.close()
  }

  const telemetry = report.telemetry?.length ? report.telemetry : externalTelemetry

  writeFileSync(join(outDir, 'matrix-report.json'), JSON.stringify(report, null, 2), 'utf-8')
  writeFileSync(join(outDir, 'playwright-console.json'), JSON.stringify(consoleLines, null, 2), 'utf-8')
  writeFileSync(join(outDir, 'playwright-network.json'), JSON.stringify(playwrightNetwork, null, 2), 'utf-8')

  if (telemetry.length) {
    writeTelemetryArtifacts(outDir, telemetry)
  }

  saveManifest(reportId, {
    status: 'completed',
    finishedAt: new Date().toISOString(),
    passedRuns: report.passedRuns,
    totalRuns: report.totalRuns,
    harnessVersion: report.harnessVersion ?? harnessVersion,
    error: null,
  })

  log(`Done: ${report.passedRuns}/${report.totalRuns} passed — ${outDir}`)

  return { reportId, outDir, report, telemetry }
}

/**
 * Verify authenticated session via API before a long run.
 * @param {string} storageStatePath
 * @param {string} baseUrl
 */
export async function verifyAuthSession(storageStatePath, baseUrl) {
  const browser = await chromium.launch({ headless: true })
  try {
    const context = await browser.newContext({ storageState: storageStatePath })
    const page = await context.newPage()
    const res = await page.goto(`${baseUrl.replace(/\/$/, '')}/api/auth/session`, { timeout: 30_000 })
    const status = res?.status() ?? 0
    const body = await res?.json().catch(() => ({}))
    await context.close()
    return { ok: status === 200 && !!body?.user, status, user: body?.user ?? null }
  } finally {
    await browser.close()
  }
}
