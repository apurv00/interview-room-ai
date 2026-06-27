import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRunManifest, runOutputDir, saveManifest, loadManifest } from '../orchestrator/runManifest.mjs'
import { writeTelemetryArtifacts } from './telemetry.mjs'
import { computeResumeOffset, mergeMatrixReports } from '../orchestrator/retryPolicy.mjs'
import { bakeStrongAnswersIntoRunner } from './bakeRunnerStrongAnswers.mjs'
import { bakeRosterIntoRunner } from './bakeRosterIntoRunner.mjs'
import { launchQaBrowser } from './browserLaunch.mjs'

const moduleRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

function loadRunnerSource() {
  let source = readFileSync(join(moduleRoot, 'browser', 'qa-matrix-runner.js'), 'utf-8')
  source = bakeRosterIntoRunner(bakeStrongAnswersIntoRunner(source))
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
 * @param {number} [options.duration]
 * @param {string} [options.experience]
 * @param {number} [options.maxCells]
 * @param {number} [options.offset]
 * @param {number} [options.cellRetry]
 * @param {object | null} [options.priorReport]
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
    duration = 10,
    experience = '0-2',
    maxCells = 0,
    offset = 0,
    cellRetry = 1,
    priorReport = null,
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
    resume: {
      offset,
      cellRetry,
      completedCells: priorReport?.runs?.map((r) => r.runId) ?? [],
      quotaAborted: false,
    },
  })

  const externalTelemetry = []
  const playwrightNetwork = []
  const consoleLines = []

  log(`QA v3 Playwright — reportId=${reportId} mode=${mode} questions=${questions} duration=${duration}min experience=${experience}${maxCells ? ` cells=${maxCells}` : ''}${offset ? ` offset=${offset}` : ''}`)
  log(`baseUrl=${baseUrl} harness=${harnessVersion}`)
  log(`Using storageState (OAuth not needed during matrix — cookies only)`)

  const { browser, context } = await launchQaBrowser({ headless, storageStatePath })
  let report = null
  let fatalError = null

  try {
    const page = await context.newPage()
    page.setDefaultTimeout(timeoutMs)
    page.setDefaultNavigationTimeout(120_000)

    page.on('console', (msg) => {
      const text = msg.text()
      consoleLines.push({ level: msg.type(), text, timestamp: Date.now() })
      if (text.startsWith('[QA]')) {
        log(text)
      }
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

    const hashParts = [
      `mode=${encodeURIComponent(mode)}`,
      `questions=${questions}`,
      `duration=${duration}`,
      `experience=${encodeURIComponent(experience)}`,
      'autostart=1',
      `reportId=${encodeURIComponent(reportId)}`,
      `cellRetry=${cellRetry}`,
    ]
    if (maxCells > 0) hashParts.push(`limit=${maxCells}`)
    if (offset > 0) hashParts.push(`offset=${offset}`)
    const hash = hashParts.join('&')
    const landing = `${baseUrl.replace(/\/$/, '')}/#${hash}`
    log(`Navigating ${landing}`)
    await page.goto(landing, { waitUntil: 'networkidle', timeout: 120_000 })

    if (priorReport) {
      await page.evaluate((prior) => {
        window.__QA_PRIOR_REPORT__ = prior
      }, priorReport)
      log(`Resuming from cell offset ${offset} (${priorReport.runs?.length ?? 0} prior runs)`)
    }

    await page.evaluate((src) => {
      const el = document.createElement('script')
      el.textContent = src
      document.documentElement.appendChild(el)
    }, runnerSource)

    log('Harness injected — watch this Chromium window for green QA log output')
    await page.waitForFunction(
      () =>
        document.title === 'QA_MATRIX_RUNNING' ||
        document.title === 'QA_MATRIX_DONE' ||
        document.title === 'QA_MATRIX_ERROR',
      null,
      { timeout: 30_000 },
    )
    log(`Harness booted (title=${await page.title()})`)
    log(`Matrix running — waiting for QA_MATRIX_DONE … (timeout ${Math.round(timeoutMs / 60000)} min)`)

    await page.waitForFunction(
      () => document.title === 'QA_MATRIX_DONE' || document.title === 'QA_MATRIX_ERROR',
      null,
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

    if (priorReport) {
      report = mergeMatrixReports(priorReport, report)
    }

    await context.close()
  } catch (err) {
    fatalError = err
    try {
      writeFileSync(join(outDir, 'playwright-console.json'), JSON.stringify(consoleLines, null, 2), 'utf-8')
      writeFileSync(join(outDir, 'playwright-network.json'), JSON.stringify(playwrightNetwork, null, 2), 'utf-8')
    } catch {
      /* best-effort debug artifacts */
    }
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
    resume: {
      offset: report.runs?.length ?? 0,
      completedCells: report.runs?.map((r) => r.runId) ?? [],
      quotaAborted: report.resume?.quotaAborted ?? false,
      cellRetry,
    },
    error: null,
  })

  log(`Done: ${report.passedRuns}/${report.totalRuns} passed — ${outDir}`)

  return { reportId, outDir, report, telemetry }
}

/**
 * Load partial report + compute resume offset for --resume runs.
 * @param {string} reportId
 */
export function loadResumeState(reportId) {
  const manifest = loadManifest(reportId)
  const reportPath = join(runOutputDir(reportId), 'matrix-report.json')
  let priorReport = null
  if (existsSync(reportPath)) {
    priorReport = JSON.parse(readFileSync(reportPath, 'utf-8'))
  }
  const offset = computeResumeOffset(priorReport, manifest)
  return { manifest, priorReport, offset }
}

/**
 * Verify authenticated session via API before a long run.
 * @param {string} storageStatePath
 * @param {string} baseUrl
 */
export async function verifyAuthSession(storageStatePath, baseUrl) {
  // Auth verify only hits /api/auth/session — no Chrome-specific behavior — so allow the
  // bundled-Chromium fallback for headless/CI containers without system Google Chrome.
  const { browser, context } = await launchQaBrowser({
    headless: true,
    storageStatePath,
    allowChromiumFallback: true,
  })
  try {
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
