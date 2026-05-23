import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import type {
  EvaluationAggregateRow,
  MatrixReport,
  PhaseSummary,
  RouteLatencyStat,
  SimulationRunResult,
} from '../agent/types'
import { avgDimensionScore } from '../config/thresholds'

const PHASES = [
  { phase: 'Q0', description: 'Scaffold, matrix, auth, dry-run' },
  { phase: 'Q1', description: 'Interview + feedback via HTTP' },
  { phase: 'Q2', description: 'Multimodal analysis poll' },
  { phase: 'Q3', description: 'Pathway regeneration poll' },
  { phase: 'Q4', description: 'Drill weak-list, context, evaluate SSE' },
  { phase: 'Q5', description: 'Full matrix orchestration + reports' },
]

export function buildMatrixReport(args: {
  reportId: string
  mode: MatrixReport['mode']
  baseUrl: string
  startedAt: string
  finishedAt: string
  runs: SimulationRunResult[]
}): MatrixReport {
  const passedRuns = args.runs.filter((r) => r.pass).length
  const routeFrequency: Record<string, number> = {}
  const issueCounts = new Map<string, number>()

  for (const run of args.runs) {
    for (const route of run.allRoutes) {
      const key = `${route.method} ${route.route}`
      routeFrequency[key] = (routeFrequency[key] ?? 0) + 1
    }
    for (const hint of run.upgradeRecommendations) {
      issueCounts.set(hint, (issueCounts.get(hint) ?? 0) + 1)
    }
  }

  const topIssues = [...issueCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 25)
    .map(([k, v]) => `${k} (×${v})`)

  const phaseSummary = buildPhaseSummaries(args.runs)
  const evaluationRows = collectEvaluationRows(args.runs)
  const routeLatency = buildRouteLatencyStats(args.runs)

  return {
    reportId: args.reportId,
    mode: args.mode,
    baseUrl: args.baseUrl,
    startedAt: args.startedAt,
    finishedAt: args.finishedAt,
    durationMs: new Date(args.finishedAt).getTime() - new Date(args.startedAt).getTime(),
    totalRuns: args.runs.length,
    passedRuns,
    failedRuns: args.runs.length - passedRuns,
    passRate: args.runs.length ? passedRuns / args.runs.length : 0,
    runs: args.runs,
    phaseSummary,
    routeFrequency,
    routeLatency,
    evaluationRows,
    topIssues,
  }
}

function numOrNull(v: unknown): number | null {
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

export function collectEvaluationRows(runs: SimulationRunResult[]): EvaluationAggregateRow[] {
  const rows: EvaluationAggregateRow[] = []
  for (const run of runs) {
    const iv = run.stages.find((s) => s.stage === 'interview')
    if (!iv?.questions?.length) continue
    for (const q of iv.questions) {
      const genRoute = q.routes.find((r) => r.route.includes('generate-question'))
      const evalRoute = q.routes.find((r) => r.route.includes('evaluate-answer'))
      rows.push({
        matrixKey: run.matrixKey,
        domain: run.domain,
        depth: run.depth,
        persona: run.persona,
        questionIndex: q.questionIndex,
        relevance: q.evaluation ? numOrNull(q.evaluation.relevance) : null,
        structure: q.evaluation ? numOrNull(q.evaluation.structure) : null,
        specificity: q.evaluation ? numOrNull(q.evaluation.specificity) : null,
        ownership: q.evaluation ? numOrNull(q.evaluation.ownership) : null,
        jdAlignment: q.evaluation ? numOrNull(q.evaluation.jdAlignment) : null,
        avgDimensions: q.evaluation ? avgDimensionScore(q.evaluation) : null,
        pass: q.pass,
        evalLatencyMs: evalRoute?.durationMs ?? null,
        generateLatencyMs: genRoute?.durationMs ?? null,
        issues: q.checks.filter((c) => !c.pass).map((c) => c.label),
      })
    }
  }
  return rows
}

export function buildRouteLatencyStats(runs: SimulationRunResult[]): RouteLatencyStat[] {
  const byRoute = new Map<string, number[]>()
  const errors = new Map<string, number>()

  for (const run of runs) {
    for (const route of run.allRoutes) {
      const key = `${route.method} ${route.route}`
      const list = byRoute.get(key) ?? []
      list.push(route.durationMs)
      byRoute.set(key, list)
      if (!route.ok) errors.set(key, (errors.get(key) ?? 0) + 1)
    }
  }

  return [...byRoute.entries()]
    .map(([route, durations]) => {
      const sorted = [...durations].sort((a, b) => a - b)
      const p50 = sorted[Math.floor(sorted.length * 0.5)] ?? 0
      const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? sorted.at(-1) ?? 0
      return {
        route,
        count: sorted.length,
        p50Ms: p50,
        p95Ms: p95,
        maxMs: sorted.at(-1) ?? 0,
        errorCount: errors.get(route) ?? 0,
      }
    })
    .sort((a, b) => b.count - a.count)
}

function buildPhaseSummaries(runs: SimulationRunResult[]): PhaseSummary[] {
  const stageNames = ['interview', 'feedback', 'analysis', 'pathway', 'drill'] as const
  return stageNames.map((stage, i) => {
    const attempted = runs.filter((r) => r.stages.some((s) => s.stage === stage))
    const passed = attempted.filter((r) => r.stages.find((s) => s.stage === stage)?.pass)
    const failures = new Map<string, number>()
    for (const r of attempted) {
      const st = r.stages.find((s) => s.stage === stage)
      if (!st || st.pass) continue
      for (const c of st.checks.filter((x) => !x.pass)) {
        failures.set(c.label, (failures.get(c.label) ?? 0) + 1)
      }
    }
    return {
      phase: PHASES[i + 1]?.phase ?? `Q${i + 1}`,
      description: PHASES[i + 1]?.description ?? stage,
      runsAttempted: attempted.length,
      runsPassed: passed.length,
      passRate: attempted.length ? passed.length / attempted.length : 0,
      commonFailures: [...failures.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([k, v]) => `${k} (×${v})`),
    }
  })
}

export function writeReports(
  outputDir: string,
  report: MatrixReport,
): { jsonPath: string; mdPath: string; evalCsvPath?: string } {
  mkdirSync(outputDir, { recursive: true })
  const jsonPath = join(outputDir, `${report.reportId}.json`)
  const mdPath = join(outputDir, `${report.reportId}.md`)
  writeFileSync(jsonPath, JSON.stringify(report, null, 2), 'utf-8')
  writeFileSync(mdPath, formatMarkdownReport(report), 'utf-8')

  let evalCsvPath: string | undefined
  if (report.evaluationRows.length > 0) {
    evalCsvPath = join(outputDir, `${report.reportId}-evaluations.csv`)
    writeFileSync(evalCsvPath, formatEvaluationsCsv(report.evaluationRows), 'utf-8')
  }

  return { jsonPath, mdPath, evalCsvPath }
}

export function formatEvaluationsCsv(rows: EvaluationAggregateRow[]): string {
  const header =
    'matrixKey,domain,depth,persona,questionIndex,relevance,structure,specificity,ownership,jdAlignment,avgDimensions,pass,generateLatencyMs,evalLatencyMs,issues'
  const lines = rows.map((r) =>
    [
      r.matrixKey,
      r.domain,
      r.depth,
      r.persona,
      r.questionIndex + 1,
      r.relevance ?? '',
      r.structure ?? '',
      r.specificity ?? '',
      r.ownership ?? '',
      r.jdAlignment ?? '',
      r.avgDimensions ?? '',
      r.pass ? 'PASS' : 'FAIL',
      r.generateLatencyMs ?? '',
      r.evalLatencyMs ?? '',
      `"${r.issues.join('; ').replace(/"/g, '""')}"`,
    ].join(','),
  )
  return [header, ...lines].join('\n')
}

export function formatMarkdownReport(report: MatrixReport): string {
  const lines: string[] = []
  lines.push(`# QA Agent Matrix Report`)
  lines.push('')
  lines.push(`| Field | Value |`)
  lines.push(`|-------|-------|`)
  lines.push(`| Report ID | \`${report.reportId}\` |`)
  lines.push(`| Mode | ${report.mode} |`)
  lines.push(`| Base URL | ${report.baseUrl} |`)
  lines.push(`| Runs | ${report.passedRuns}/${report.totalRuns} passed (${(report.passRate * 100).toFixed(1)}%) |`)
  lines.push(`| Duration | ${(report.durationMs / 1000).toFixed(1)}s |`)
  lines.push('')

  lines.push('## Phase-wise summary')
  lines.push('')
  lines.push('| Phase | Description | Attempted | Passed | Rate | Top failures |')
  lines.push('|-------|-------------|-----------|--------|------|--------------|')
  for (const p of report.phaseSummary) {
    lines.push(
      `| ${p.phase} | ${p.description} | ${p.runsAttempted} | ${p.runsPassed} | ${(p.passRate * 100).toFixed(0)}% | ${p.commonFailures.slice(0, 2).join('; ') || '—'} |`,
    )
  }
  lines.push('')

  lines.push('## Routes touched (frequency)')
  lines.push('')
  for (const [route, count] of Object.entries(report.routeFrequency).sort((a, b) => b[1] - a[1])) {
    lines.push(`- \`${route}\` — ${count}×`)
  }
  lines.push('')

  if (report.routeLatency.length) {
    lines.push('## Route latency (p50 / p95 / max)')
    lines.push('')
    lines.push('| Route | Calls | p50 | p95 | max | Errors |')
    lines.push('|-------|-------|-----|-----|-----|--------|')
    for (const s of report.routeLatency) {
      lines.push(
        `| \`${s.route}\` | ${s.count} | ${s.p50Ms}ms | ${s.p95Ms}ms | ${s.maxMs}ms | ${s.errorCount} |`,
      )
    }
    lines.push('')
  }

  if (report.evaluationRows.length) {
    lines.push('## All per-question evaluations (matrix-wide)')
    lines.push('')
    lines.push(
      '| Run | Q# | Persona | Rel | Str | Spec | Own | JD | Avg | Gen ms | Eval ms | Pass | Issues |',
    )
    lines.push(
      '|-----|----|---------|-----|-----|------|-----|----|-----|--------|---------|------|--------|',
    )
    for (const r of report.evaluationRows) {
      lines.push(
        `| ${r.matrixKey} | ${r.questionIndex + 1} | ${r.persona} | ${r.relevance ?? '—'} | ${r.structure ?? '—'} | ${r.specificity ?? '—'} | ${r.ownership ?? '—'} | ${r.jdAlignment ?? '—'} | ${r.avgDimensions ?? '—'} | ${r.generateLatencyMs ?? '—'} | ${r.evalLatencyMs ?? '—'} | ${r.pass ? '✅' : '❌'} | ${r.issues.join('; ') || '—'} |`,
      )
    }
    lines.push('')
    lines.push(
      `> Full CSV: \`${report.reportId}-evaluations.csv\` (${report.evaluationRows.length} rows)`,
    )
    lines.push('')
  }

  if (report.topIssues.length) {
    lines.push('## Upgrade recommendations (aggregated)')
    lines.push('')
    for (const issue of report.topIssues) {
      lines.push(`- ${issue}`)
    }
    lines.push('')
  }

  lines.push('## Per-run detail')
  lines.push('')
  for (const run of report.runs) {
    lines.push(`### ${run.pass ? '✅' : '❌'} ${run.matrixKey}`)
    lines.push('')
    lines.push(`- Session: \`${run.sessionId ?? 'n/a'}\``)
    lines.push(`- Duration: ${(run.durationMs / 1000).toFixed(1)}s`)
    lines.push('')

    for (const stage of run.stages) {
      lines.push(`#### Stage: ${stage.stage} ${stage.pass ? '✅' : '❌'}`)
      lines.push('')
      lines.push('**Routes:**')
      for (const r of stage.routes) {
        lines.push(
          `- \`${r.method} ${r.route}\` → ${r.status} (${r.durationMs}ms)${r.questionIndex != null ? ` Q${r.questionIndex}` : ''}`,
        )
      }
      if (stage.questions?.length) {
        lines.push('')
        lines.push('**Per-question evaluation:**')
        lines.push('')
        lines.push(
          '| Q | Rel | Str | Spec | Own | JD | Avg | Gen ms | Eval ms | Pass | Question (truncated) | Issues |',
        )
        lines.push(
          '|---|-----|-----|------|-----|----|-----|--------|---------|------|------------------------|--------|',
        )
        for (const q of stage.questions) {
          const ev = q.evaluation
          const avg = ev ? avgDimensionScore(ev) : '—'
          const genMs = q.routes.find((r) => r.route.includes('generate-question'))?.durationMs ?? '—'
          const evalMs = q.routes.find((r) => r.route.includes('evaluate-answer'))?.durationMs ?? '—'
          const issues = q.checks.filter((c) => !c.pass).map((c) => c.label).join('; ') || '—'
          lines.push(
            `| ${q.questionIndex + 1} | ${ev ? numOrNull(ev.relevance) ?? '—' : '—'} | ${ev ? numOrNull(ev.structure) ?? '—' : '—'} | ${ev ? numOrNull(ev.specificity) ?? '—' : '—'} | ${ev ? numOrNull(ev.ownership) ?? '—' : '—'} | ${ev ? numOrNull(ev.jdAlignment) ?? '—' : '—'} | ${avg} | ${genMs} | ${evalMs} | ${q.pass ? '✅' : '❌'} | ${q.question.slice(0, 50).replace(/\|/g, '/')}… | ${issues} |`,
          )
        }
      }
      const failedChecks = stage.checks.filter((c) => !c.pass)
      if (failedChecks.length) {
        lines.push('')
        lines.push('**Failed checks:**')
        for (const c of failedChecks) {
          lines.push(`- ${c.label}${c.detail ? ` — ${c.detail}` : ''}`)
        }
      }
      lines.push('')
    }

    if (run.upgradeRecommendations.length) {
      lines.push('**Run-level upgrades:**')
      for (const u of run.upgradeRecommendations.slice(0, 15)) {
        lines.push(`- ${u}`)
      }
      lines.push('')
    }
  }

  return lines.join('\n')
}

export { PHASES }
