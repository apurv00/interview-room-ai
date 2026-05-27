import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from '@playwright/test'
import { runOutputDir, saveManifest } from '../orchestrator/runManifest.mjs'

/** Same 6 cells as matrix smoke mode — one persona each for speed */
export const UI_SMOKE_CELLS = [
  { domain: 'pm', depth: 'behavioral', label: 'pm/behavioral' },
  { domain: 'backend', depth: 'technical', label: 'backend/technical' },
  { domain: 'pm', depth: 'case-study', label: 'pm/case-study' },
  { domain: 'backend', depth: 'system-design', label: 'backend/system-design' },
  { domain: 'frontend', depth: 'coding', label: 'frontend/coding' },
  { domain: 'design', depth: 'technical', label: 'design/technical' },
]

/** HOT PATH budget — INTERVIEW_FLOW.md §7.3 */
const TTS_TTFB_BUDGET_MS = 600
/** Prod smoke gate — fail only above this (cold Vercel + cache miss headroom) */
const TTS_TTFB_HARD_FAIL_MS = 3000
const LOBBY_READY_MS = 90_000
const INTERVIEW_HOT_PATH_MS = 180_000

/** Canned intro answer — ≥3 words for Deepgram interrupt gate, STAR-shaped for eval */
const QA_INTRO_ANSWER =
  'Hi Alex, I am a senior engineer with six years of experience building scalable backend systems, leading cross-functional launches, and owning metrics-driven outcomes end to end.'

/**
 * Injected before navigation: mock Deepgram WS so fake mic silence still produces a transcript.
 * @param {string} answer
 */
function deepgramMockInitScript(answer) {
  const RealWS = WebSocket
  const OPEN = 1
  const CONNECTING = 0
  const CLOSED = 3

  function mockDeepgramSocket() {
    let audioSeen = false
    let closed = false
    const ws = {
      readyState: CONNECTING,
      protocol: '',
      extensions: '',
      bufferedAmount: 0,
      binaryType: 'blob',
      onopen: null,
      onclose: null,
      onerror: null,
      onmessage: null,
      close(code, reason) {
        if (closed) return
        closed = true
        ws.readyState = CLOSED
        ws.onclose?.(
          new CloseEvent('close', {
            code: code ?? 1000,
            reason: reason ?? '',
            wasClean: true,
          }),
        )
      },
      send(_data) {
        if (closed || audioSeen) return
        audioSeen = true
        const words = answer.split(/\s+/).filter(Boolean)
        const dgWords = words.map((word, i) => ({
          word,
          start: i * 0.28,
          end: (i + 1) * 0.28,
          confidence: 0.96,
        }))
        setTimeout(() => {
          if (closed) return
          ws.onmessage?.({
            data: JSON.stringify({
              type: 'Results',
              is_final: true,
              speech_final: true,
              channel: {
                alternatives: [{ transcript: answer, words: dgWords }],
              },
            }),
          })
          setTimeout(() => {
            if (closed) return
            ws.onmessage?.({ data: JSON.stringify({ type: 'UtteranceEnd' }) })
          }, 80)
        }, 1200)
      },
      addEventListener(type, fn) {
        if (type === 'open') ws.onopen = fn
        else if (type === 'close') ws.onclose = fn
        else if (type === 'error') ws.onerror = fn
        else if (type === 'message') ws.onmessage = fn
      },
      removeEventListener() {},
      dispatchEvent() {
        return true
      },
    }

    setTimeout(() => {
      if (closed) return
      ws.readyState = OPEN
      ws.onopen?.(new Event('open'))
    }, 80)

    return ws
  }

  // @ts-expect-error — QA shim replaces global constructor
  window.WebSocket = function WebSocketShim(url, protocols) {
    if (String(url).includes('api.deepgram.com/v1/listen')) {
      void protocols
      return mockDeepgramSocket()
    }
    return new RealWS(url, protocols)
  }
  window.WebSocket.prototype = RealWS.prototype
  window.WebSocket.CONNECTING = RealWS.CONNECTING
  window.WebSocket.OPEN = RealWS.OPEN
  window.WebSocket.CLOSING = RealWS.CLOSING
  window.WebSocket.CLOSED = RealWS.CLOSED
}

/**
 * Browser-reported TTFB from Playwright request timing (ms).
 * @param {import('@playwright/test').Response} response
 */
function ttfbFromResponse(response) {
  const timing = response.request().timing()
  if (timing.responseStart >= 0 && timing.requestStart >= 0) {
    return Math.round(timing.responseStart - timing.requestStart)
  }
  return null
}

/**
 * @param {object} options
 * @param {string} options.baseUrl
 * @param {string} options.storageStatePath
 * @param {string} options.reportId
 * @param {string} [options.userId]
 * @param {boolean} [options.headless]
 * @param {(msg: string) => void} [options.log]
 */
export async function runPlaywrightUiSmoke(options) {
  const {
    baseUrl,
    storageStatePath,
    reportId,
    userId = null,
    headless = false,
    log = console.log,
  } = options

  const outDir = runOutputDir(reportId)
  mkdirSync(outDir, { recursive: true })
  saveManifest(reportId, {
    reportId,
    mode: 'ui-smoke',
    questions: 0,
    baseUrl,
    status: 'running',
    startedAt: new Date().toISOString(),
  })

  const base = baseUrl.replace(/\/$/, '')
  const results = []

  const browser = await chromium.launch({
    headless,
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
  })

  try {
    const context = await browser.newContext({
      storageState: storageStatePath,
      permissions: ['microphone', 'camera'],
    })

    await context.addInitScript(deepgramMockInitScript, QA_INTRO_ANSWER)

    for (const cell of UI_SMOKE_CELLS) {
      log(`UI smoke: ${cell.label}`)
      const page = await context.newPage()
      page.setDefaultTimeout(INTERVIEW_HOT_PATH_MS)

      const metrics = {
        cell: cell.label,
        pass: false,
        lobbyReadyMs: null,
        interviewToTtsMs: null,
        ttsTtfbMs: null,
        ttsCache: null,
        listeningPhaseSeen: false,
        candidateAnswerSeen: false,
        alexFollowUpSeen: false,
        deepgramWs: false,
        interviewUrlReached: false,
        warnings: [],
        errors: [],
      }

      page.on('pageerror', (err) => metrics.errors.push(err.message))

      page.on('websocket', (ws) => {
        const url = ws.url()
        if (/deepgram|api\.deepgram/i.test(url)) {
          metrics.deepgramWs = true
        }
      })

      const config = {
        role: cell.domain,
        interviewType: cell.depth,
        experience: '3-6',
        duration: 10,
        ...(userId ? { _ownerId: userId } : {}),
      }

      await page.goto(`${base}/`, { waitUntil: 'domcontentloaded', timeout: 60_000 })
      await page.evaluate(
        ({ cfg, keys }) => {
          localStorage.removeItem(keys.INTERVIEW_ACTIVE_SESSION)
          localStorage.setItem(keys.INTERVIEW_CONFIG, JSON.stringify(cfg))
        },
        { cfg: config, keys: { INTERVIEW_CONFIG: 'interviewConfig', INTERVIEW_ACTIVE_SESSION: 'interviewActiveSession' } },
      )

      const lobbyT0 = Date.now()
      await page.goto(`${base}/lobby`, { waitUntil: 'networkidle', timeout: 120_000 })

      const joinBtn = page.getByRole('button', { name: /Join Interview Room|Join in Text Mode/i })
      await joinBtn.waitFor({ state: 'visible', timeout: LOBBY_READY_MS })
      metrics.lobbyReadyMs = Date.now() - lobbyT0

      const ttsWait = page.waitForResponse(
        (res) =>
          res.request().method() === 'POST' &&
          res.url().includes('/api/tts/stream') &&
          res.status() < 500,
        { timeout: INTERVIEW_HOT_PATH_MS },
      )

      await joinBtn.click()
      await page.waitForURL(/\/interview/, { timeout: INTERVIEW_HOT_PATH_MS })
      metrics.interviewUrlReached = true
      const interviewT0 = Date.now()

      let ttsResponse = null
      try {
        ttsResponse = await ttsWait
      } catch {
        metrics.errors.push('No /api/tts/stream response within timeout')
      }

      if (ttsResponse) {
        metrics.interviewToTtsMs = Date.now() - interviewT0
        metrics.ttsTtfbMs = ttfbFromResponse(ttsResponse)
        metrics.ttsCache = ttsResponse.headers()['x-tts-cache'] ?? null

        if (metrics.ttsTtfbMs == null) {
          metrics.warnings.push('Could not read Playwright request timing — using wall clock fallback')
          metrics.ttsTtfbMs = metrics.interviewToTtsMs
        }

        if (metrics.ttsTtfbMs > TTS_TTFB_BUDGET_MS) {
          metrics.warnings.push(
            `TTS TTFB ${metrics.ttsTtfbMs}ms exceeds hot-path budget ${TTS_TTFB_BUDGET_MS}ms` +
              (metrics.ttsCache ? ` (cache: ${metrics.ttsCache})` : ''),
          )
        }
        if (metrics.ttsTtfbMs > TTS_TTFB_HARD_FAIL_MS) {
          metrics.errors.push(`TTS TTFB ${metrics.ttsTtfbMs}ms exceeds hard fail ${TTS_TTFB_HARD_FAIL_MS}ms`)
        }
      }

      // Standard flow: intro → Listening → candidate answer → Q1.
      // Coding / system-design: intro → problem TTS → canvas (no intro listen).
      const isCanvasFlow = cell.depth === 'coding' || cell.depth === 'system-design'

      if (isCanvasFlow) {
        try {
          await Promise.race([
            page.waitForResponse(
              (res) =>
                res.request().method() === 'POST' &&
                res.url().includes('/api/tts/stream') &&
                res.status() < 500,
              { timeout: 90_000 },
            ),
            page.getByText(cell.depth === 'coding' ? 'Coding' : 'Designing', { exact: true }).waitFor({
              timeout: 90_000,
            }),
          ])
          metrics.alexFollowUpSeen = true
          metrics.listeningPhaseSeen = true
        } catch {
          metrics.errors.push(`${cell.label}: Alex did not reach problem/canvas phase`)
        }
      } else {
        try {
          await page.getByText('Listening', { exact: true }).waitFor({ timeout: 90_000 })
          metrics.listeningPhaseSeen = true
        } catch {
          metrics.errors.push('Never reached Listening phase after intro')
        }

        try {
          await page.waitForFunction(
            () => {
              const body = document.body.innerText || ''
              return body.includes('senior engineer') || body.includes('six years')
            },
            null,
            { timeout: 45_000 },
          )
          metrics.candidateAnswerSeen = true
        } catch {
          metrics.warnings.push('Simulated candidate answer not visible in transcript UI')
        }

        try {
          await Promise.race([
            page.waitForResponse(
              (res) =>
                res.request().method() === 'POST' &&
                (res.url().includes('/api/generate-question') || res.url().includes('/api/tts/stream')) &&
                res.status() < 500,
              { timeout: 90_000 },
            ),
            page.getByText('Question', { exact: true }).waitFor({ timeout: 90_000 }),
            page.getByText('Processing', { exact: true }).waitFor({ timeout: 90_000 }),
          ])
          metrics.alexFollowUpSeen = true
        } catch {
          metrics.errors.push('Alex did not advance after candidate intro answer (no Q1 TTS / generate-question)')
        }
      }

      // Brief dwell so TTS can start on follow-up before closing this cell.
      await page.waitForTimeout(3000)

      metrics.pass =
        metrics.interviewUrlReached &&
        metrics.listeningPhaseSeen &&
        (isCanvasFlow || metrics.candidateAnswerSeen) &&
        metrics.alexFollowUpSeen &&
        metrics.ttsTtfbMs != null &&
        metrics.ttsTtfbMs <= TTS_TTFB_HARD_FAIL_MS &&
        metrics.errors.length === 0

      log(
        `  ${metrics.pass ? 'PASS' : 'FAIL'} lobby=${metrics.lobbyReadyMs}ms ttfb=${metrics.ttsTtfbMs ?? 'n/a'} listen=${metrics.listeningPhaseSeen} answer=${metrics.candidateAnswerSeen} followUp=${metrics.alexFollowUpSeen} deepgram=${metrics.deepgramWs}` +
          (metrics.warnings.length ? ` warn=${metrics.warnings.length}` : ''),
      )
      results.push(metrics)
      await page.close()
    }

    await context.close()
  } finally {
    await browser.close()
  }

  const passed = results.filter((r) => r.pass).length
  const hotPathBudgetMisses = results.filter(
    (r) => r.ttsTtfbMs != null && r.ttsTtfbMs > TTS_TTFB_BUDGET_MS,
  ).length

  const report = {
    reportId,
    mode: 'ui-smoke',
    totalCells: results.length,
    passedCells: passed,
    passRate: results.length ? passed / results.length : 0,
    ttsBudgetMs: TTS_TTFB_BUDGET_MS,
    ttsHardFailMs: TTS_TTFB_HARD_FAIL_MS,
    hotPathBudgetMisses,
    qaIntroAnswer: QA_INTRO_ANSWER.slice(0, 80) + '…',
    cells: results,
    finishedAt: new Date().toISOString(),
  }

  writeFileSync(join(outDir, 'ui-smoke-report.json'), JSON.stringify(report, null, 2), 'utf-8')
  saveManifest(reportId, {
    status: passed === results.length ? 'completed' : 'failed',
    finishedAt: new Date().toISOString(),
    passedRuns: passed,
    totalRuns: results.length,
  })

  log(`UI smoke done: ${passed}/${results.length} (hot-path budget misses: ${hotPathBudgetMisses}/${results.length}) — ${outDir}`)
  return { reportId, outDir, report }
}
