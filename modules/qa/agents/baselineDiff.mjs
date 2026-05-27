import { readFileSync, existsSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { computeRunMetrics } from './runMetrics.mjs'
import { runOutputDir } from '../orchestrator/runManifest.mjs'

const qaRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const outputRoot = join(qaRoot, 'output')

export const DEFAULT_BASELINE_ID = 'qa-browser-full-1779529900005'

/**
 * Resolve matrix report path for a report id.
 * @param {string} reportId
 */
export function resolveReportJsonPath(reportId) {
  const runPath = join(runOutputDir(reportId), 'matrix-report.json')
  if (existsSync(runPath)) return runPath
  const legacyPath = join(outputRoot, `${reportId}.json`)
  if (existsSync(legacyPath)) return legacyPath
  return null
}

/**
 * @param {string} reportId
 */
export function loadMetricsForReportId(reportId) {
  const path = resolveReportJsonPath(reportId)
  if (!path) throw new Error(`No matrix report found for ${reportId}`)
  const report = JSON.parse(readFileSync(path, 'utf-8'))
  return { report, metrics: computeRunMetrics(report), path }
}

/**
 * @param {ReturnType<typeof computeRunMetrics>} baseline
 * @param {ReturnType<typeof computeRunMetrics>} current
 * @param {object} [opts]
 * @param {string} [opts.baselineId]
 * @param {string} [opts.currentId]
 */
export function diffMetrics(baseline, current, opts = {}) {
  const delta = (a, b) => (a == null || b == null ? null : b - a)
  const deltaPct = (a, b) => (a == null || b == null || a === 0 ? null : ((b - a) / a) * 100)

  const rows = [
    {
      metric: 'harnessPassRate',
      label: 'Harness pass rate',
      baseline: baseline.passRate,
      current: current.passRate,
      delta: delta(baseline.passRate, current.passRate),
      format: 'pct',
    },
    {
      metric: 'pathwayGenRate',
      label: 'Pathway gen succeeded/skipped',
      baseline: baseline.pathwayGenRate ?? baseline.pathwayViewOk / baseline.totalRuns,
      current: current.pathwayGenRate ?? current.pathwayViewOk / current.totalRuns,
      delta: delta(
        baseline.pathwayGenRate ?? baseline.pathwayViewOk / baseline.totalRuns,
        current.pathwayGenRate ?? current.pathwayViewOk / current.totalRuns,
      ),
      format: 'pct',
    },
    {
      metric: 'feedbackRate',
      label: 'Feedback returned score',
      baseline: baseline.feedbackRate,
      current: current.feedbackRate,
      delta: delta(baseline.feedbackRate, current.feedbackRate),
      format: 'pct',
    },
    {
      metric: 'analysisRate',
      label: 'Analysis completed',
      baseline: baseline.analysisRate,
      current: current.analysisRate,
      delta: delta(baseline.analysisRate, current.analysisRate),
      format: 'pct',
    },
    {
      metric: 'strongPass',
      label: 'Strong persona harness pass',
      baseline: baseline.strongPass,
      current: current.strongPass,
      delta: delta(baseline.strongPass, current.strongPass),
      format: 'count',
      baselineN: baseline.strongTotal,
      currentN: current.strongTotal,
    },
    {
      metric: 'analysisDurationP50',
      label: 'Analysis duration p50 (ms)',
      baseline: baseline.analysisDurationP50,
      current: current.analysisDurationP50,
      delta: delta(baseline.analysisDurationP50, current.analysisDurationP50),
      format: 'ms',
    },
  ]

  const improved = []
  const regressed = []
  for (const r of rows) {
    if (r.delta == null) continue
    if (r.metric === 'analysisDurationP50') {
      if (r.delta < -500) improved.push(r)
      if (r.delta > 500) regressed.push(r)
    } else if (r.delta > 0.01) improved.push(r)
    else if (r.delta < -0.01) regressed.push(r)
  }

  return {
    baselineId: opts.baselineId ?? baseline.reportId,
    currentId: opts.currentId ?? current.reportId,
    comparedAt: new Date().toISOString(),
    baselineMode: baseline.mode,
    currentMode: current.mode,
    note:
      baseline.mode !== current.mode
        ? `Baseline mode=${baseline.mode} (${baseline.totalRuns} cells) vs current mode=${current.mode} (${current.totalRuns} cells) — directional only`
        : null,
    rows,
    improved,
    regressed,
    pathwayFixed:
      (baseline.pathwayGenRate ?? 0) < 0.5 &&
      (current.pathwayGenRate ?? current.pathwayViewOk / current.totalRuns) >= 0.95,
  }
}

/**
 * @param {object} diff
 */
export function formatDiffMarkdown(diff) {
  const L = []
  L.push('## Baseline comparison')
  L.push('')
  L.push(`| | |`)
  L.push(`|---|---|`)
  L.push(`| **Baseline** | \`${diff.baselineId}\` (${diff.baselineMode}) |`)
  L.push(`| **Current** | \`${diff.currentId}\` (${diff.currentMode}) |`)
  if (diff.note) L.push(`| **Note** | ${diff.note} |`)
  L.push('')
  L.push('| Metric | Baseline | Current | Δ |')
  L.push('|--------|----------|---------|---|')
  for (const r of diff.rows) {
    const fmt = (v, row) => {
      if (v == null) return '—'
      if (row.format === 'pct') return `${(v * 100).toFixed(1)}%`
      if (row.format === 'ms') return `${Math.round(v)}ms`
      if (row.format === 'count' && row.baselineN != null) {
        return `${v}/${row.baselineN}`
      }
      return String(v)
    }
    const fmtCurrent = (v, row) => {
      if (v == null) return '—'
      if (row.format === 'pct') return `${(v * 100).toFixed(1)}%`
      if (row.format === 'ms') return `${Math.round(v)}ms`
      if (row.format === 'count' && row.currentN != null) {
        return `${v}/${row.currentN}`
      }
      return String(v)
    }
    const d =
      r.delta == null
        ? '—'
        : r.format === 'pct'
          ? `${r.delta >= 0 ? '+' : ''}${(r.delta * 100).toFixed(1)}pp`
          : r.format === 'ms'
            ? `${r.delta >= 0 ? '+' : ''}${Math.round(r.delta)}ms`
            : `${r.delta >= 0 ? '+' : ''}${r.delta}`
    L.push(`| ${r.label} | ${fmt(r.baseline, r)} | ${fmtCurrent(r.current, { ...r, baselineN: r.currentN })} | ${d} |`)
  }
  L.push('')
  if (diff.pathwayFixed) {
    L.push('> **Pathway P0 appears resolved** — current run reached ≥95% pathway terminal success vs baseline stuck at 0%.')
    L.push('')
  }
  if (diff.improved.length) {
    L.push('**Improved:** ' + diff.improved.map((r) => r.label).join(', '))
  }
  if (diff.regressed.length) {
    L.push('**Regressed:** ' + diff.regressed.map((r) => r.label).join(', '))
  }
  return L.join('\n')
}

/**
 * @param {string} currentReportId
 * @param {string} [baselineReportId]
 */
export function runBaselineDiff(currentReportId, baselineReportId = DEFAULT_BASELINE_ID) {
  const { metrics: current } = loadMetricsForReportId(currentReportId)
  const { metrics: baseline } = loadMetricsForReportId(baselineReportId)
  const diff = diffMetrics(baseline, current, {
    baselineId: baselineReportId,
    currentId: currentReportId,
  })
  const outDir = runOutputDir(currentReportId)
  const outPath = join(outDir, 'baseline-diff.json')
  writeFileSync(outPath, JSON.stringify(diff, null, 2), 'utf-8')
  return { diff, outPath, markdown: formatDiffMarkdown(diff) }
}
