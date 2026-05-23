#!/usr/bin/env npx tsx
/**
 * QA Agent — external black-box interview matrix runner.
 *
 * Does NOT import product modules. Calls public HTTP APIs only.
 *
 * Usage:
 *   QA_SESSION_COOKIE="next-auth.session-token=..." \
 *   QA_BASE_URL=http://localhost:3000 \
 *   npm run qa:matrix -- --smoke
 *
 *   npm run qa:matrix -- --full --concurrency 2 --questions 5
 *
 *   npm run qa:matrix -- --dry-run --full
 */

import { buildRunPlan } from '../modules/qa/config/matrix'
import { parseCliArgs, buildHarnessConfig } from '../modules/qa/cli/parseArgs'
import { verifyAuth } from '../modules/qa/client/httpClient'
import { runMatrixWithConcurrency } from '../modules/qa/agent/orchestrator'
import { buildMatrixReport, writeReports, PHASES, formatMarkdownReport } from '../modules/qa/report/reportBuilder'
import type { InterviewDepth } from '../modules/qa/agent/types'

async function main() {
  const args = parseCliArgs(process.argv.slice(2))

  console.log('QA Agent — Interview Matrix Harness')
  console.log('Phases:', PHASES.map((p) => p.phase).join(' → '))
  console.log('Mode:', args.mode)
  console.log('Stages:', args.stages.join(', '))
  console.log('Base URL:', args.baseUrl)

  const runs = buildRunPlan(args.mode, args.personas, {
    domain: args.domain,
    depth: args.depth as InterviewDepth | undefined,
  })

  console.log(`Planned runs: ${runs.length}`)
  for (const r of runs) {
    console.log(`  - ${r.runId}`)
  }

  if (args.dryRun) {
    console.log('\nDry run complete — no HTTP calls made.')
    process.exit(0)
  }

  const harness = buildHarnessConfig(args)
  const { QaHttpClient } = await import('../modules/qa/client/httpClient')
  const probe = new QaHttpClient({ baseUrl: harness.baseUrl, sessionCookie: harness.sessionCookie })
  const auth = await verifyAuth(probe)
  if (!auth.ok) {
    console.error('Auth failed:', auth.detail)
    process.exit(1)
  }
  console.log('Auth:', auth.detail)

  const startedAt = new Date().toISOString()
  const reportId = `qa-${args.mode}-${startedAt.replace(/[:.]/g, '-')}`

  let done = 0
  const results = await runMatrixWithConcurrency(harness, runs, (d, total, last) => {
    done = d
    const icon = last.pass ? 'PASS' : 'FAIL'
    console.log(`[${d}/${total}] ${icon} ${last.matrixKey} session=${last.sessionId ?? 'n/a'}`)
  })

  const finishedAt = new Date().toISOString()
  const report = buildMatrixReport({
    reportId,
    mode: args.mode,
    baseUrl: harness.baseUrl,
    startedAt,
    finishedAt,
    runs: results,
  })

  const { jsonPath, mdPath, evalCsvPath } = writeReports(harness.outputDir, report)

  console.log('\n' + '='.repeat(60))
  console.log(formatMarkdownReport(report).split('\n').slice(0, 40).join('\n'))
  console.log('...')
  console.log('='.repeat(60))
  console.log(`\nJSON: ${jsonPath}`)
  console.log(`Markdown: ${mdPath}`)
  if (evalCsvPath) console.log(`Evaluations CSV: ${evalCsvPath} (${report.evaluationRows.length} rows)`)
  console.log(`Pass rate: ${(report.passRate * 100).toFixed(1)}% (${report.passedRuns}/${report.totalRuns})`)

  process.exit(report.passRate >= 0.9 ? 0 : 1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
