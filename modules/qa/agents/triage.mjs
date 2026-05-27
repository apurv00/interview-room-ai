/**
 * Phase 3.4 — merge Observer + Infra + assertions + manual findings.
 */
import { readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runOutputDir } from '../orchestrator/runManifest.mjs'
import { computeRunMetrics, computeAutoFindings, loadMatrixReport } from './runMetrics.mjs'
import { resolveReportJsonPath } from './baselineDiff.mjs'
import { exportFindingsCsv } from './findingsExporter.mjs'
import { runBaselineDiff, DEFAULT_BASELINE_ID } from './baselineDiff.mjs'

const qaRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

function loadManualFindings() {
  const path = join(qaRoot, 'config', 'reportFindings.json')
  if (!existsSync(path)) return []
  return JSON.parse(readFileSync(path, 'utf-8')).findings ?? []
}

function loadObservations(reportId) {
  const dir = join(runOutputDir(reportId), 'observations')
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json') && f !== 'summary.json')
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf-8')))
}

function loadInfraReport(reportId) {
  const path = join(runOutputDir(reportId), 'infra-report.json')
  if (!existsSync(path)) return null
  return JSON.parse(readFileSync(path, 'utf-8'))
}

function loadTelemetrySummary(reportId) {
  const path = join(runOutputDir(reportId), 'telemetry-summary.json')
  if (!existsSync(path)) return null
  return JSON.parse(readFileSync(path, 'utf-8'))
}

function observationToFinding(obs, reportId) {
  if (obs.classification === 'none' || obs.classification === 'audit-pass') return null
  const id = `AUTO-OBS-${obs.activityId.replace(/[/\\:]/g, '__').slice(0, 48)}`
  return {
    id,
    severity: obs.severity === 'none' ? 'P2' : obs.severity,
    stage: obs.stage ?? 'unknown',
    title: obs.summary ?? `Observer: ${obs.activityId}`,
    status: obs.classification === 'harness-artifact' ? 'harness-artifact' : 'confirmed-auto',
    classification: obs.classification,
    impact: obs.summary,
    evidence: obs.evidence ?? [],
    nextSteps: obs.suggestedNextSteps ?? [],
    activityLinks: [`runs/${reportId}/observations/${obs.activityId.replace(/[/\\:]/g, '__')}.json`],
    source: 'observer',
  }
}

function infraToFindings(infra, reportId) {
  if (!infra?.checks) return []
  return infra.checks
    .filter((c) => !c.ok && c.severity !== 'none')
    .map((c) => ({
      id: `AUTO-INFRA-${c.id}`,
      severity: c.severity === 'none' ? 'P1' : c.severity,
      stage: 'infra',
      title: c.message,
      status: 'confirmed-auto',
      classification: 'infra',
      impact: c.message,
      evidence: [JSON.stringify(c.detail ?? {})],
      nextSteps: c.detail?.hint ? [c.detail.hint] : ['See infra-report.json'],
      activityLinks: [`runs/${reportId}/infra-report.json`],
      source: 'infra-verifier',
    }))
}

function telemetryToFindings(summary, reportId) {
  if (!summary || summary.fail === 0) return []
  return [
    {
      id: 'AUTO-TEL-001',
      severity: summary.fail > 0 && summary.pass / summary.total < 0.9 ? 'P1' : 'P2',
      stage: 'telemetry',
      title: `${summary.fail}/${summary.total} activity assertions failed`,
      status: 'confirmed-auto',
      classification: 'inconclusive',
      impact: 'Deterministic harness assertions failed on one or more API steps.',
      evidence: Object.entries(summary.byStage ?? {}).map(
        ([stage, v]) => `${stage}: ${v.fail}/${v.total} fail`,
      ),
      nextSteps: ['Inspect activities/ under run dir', 'Run qa:v3:observe for classification'],
      activityLinks: [`runs/${reportId}/telemetry-summary.json`],
      source: 'telemetry',
    },
  ]
}

/**
 * @param {object[]} findings
 */
function dedupeFindings(findings) {
  const byId = new Map()
  for (const f of findings) {
    const existing = byId.get(f.id)
    if (!existing) {
      byId.set(f.id, f)
      continue
    }
    byId.set(f.id, {
      ...existing,
      evidence: [...new Set([...(existing.evidence ?? []), ...(f.evidence ?? [])])],
      nextSteps: [...new Set([...(existing.nextSteps ?? []), ...(f.nextSteps ?? [])])],
      activityLinks: [...new Set([...(existing.activityLinks ?? []), ...(f.activityLinks ?? [])])],
      sources: [...new Set([...(existing.sources ?? [existing.source]), f.source].filter(Boolean))],
    })
  }
  return [...byId.values()]
}

/**
 * Auto-resolve pathway P0 when metrics show health.
 * @param {object[]} findings
 * @param {ReturnType<typeof computeRunMetrics>} metrics
 */
function applyResolutionRules(findings, metrics) {
  const pathwayRate =
    metrics.pathwayGenRate ?? (metrics.pathwayViewOk / Math.max(metrics.totalRuns, 1))
  return findings.map((f) => {
    if (
      (f.id === 'P0-001' || f.id === 'AUTO-PWY-001') &&
      pathwayRate >= 0.95 &&
      metrics.pathwayGenPending === 0
    ) {
      return {
        ...f,
        status: 'resolved',
        evidence: [
          ...(f.evidence ?? []),
          `Current run: pathway terminal success ${Math.round(pathwayRate * 100)}% (${metrics.pathwayGenSucceeded}/${metrics.totalRuns})`,
        ],
      }
    }
    return f
  })
}

/**
 * @param {string} reportId
 * @param {object} [opts]
 * @param {string} [opts.baselineId]
 * @param {boolean} [opts.skipDiff]
 * @param {boolean} [opts.sdk] — run one SDK triage call and merge into summary
 * @param {(msg: string) => void} [opts.log]
 */
export async function triageRun(reportId, opts = {}) {
  const reportPath = resolveReportJsonPath(reportId)
  if (!reportPath) throw new Error(`No matrix report for ${reportId}`)

  const report = loadMatrixReport(reportPath)
  const metrics = computeRunMetrics(report)
  const outDir = runOutputDir(reportId)
  mkdirSync(outDir, { recursive: true })

  const manual = loadManualFindings()
  const auto = computeAutoFindings(metrics, report)
  const obs = loadObservations(reportId).map((o) => observationToFinding(o, reportId)).filter(Boolean)
  const infra = infraToFindings(loadInfraReport(reportId), reportId)
  const tel = telemetryToFindings(loadTelemetrySummary(reportId), reportId)

  let findings = applyResolutionRules(
    dedupeFindings([...manual, ...auto, ...obs, ...infra, ...tel]),
    metrics,
  )

  const activeP0 = findings.filter((f) => f.severity === 'P0' && f.status !== 'resolved' && f.status !== 'wont-fix')
  const byClassification = {}
  const bySeverity = {}
  for (const f of findings) {
    const c = f.classification ?? f.status ?? 'unknown'
    byClassification[c] = (byClassification[c] ?? 0) + 1
    bySeverity[f.severity] = (bySeverity[f.severity] ?? 0) + 1
  }

  let baselineDiff = null
  let baselineDiffPath = null
  const baselineId = opts.baselineId ?? DEFAULT_BASELINE_ID
  if (!opts.skipDiff) {
    try {
      const diffResult = runBaselineDiff(reportId, baselineId)
      baselineDiff = diffResult.diff
      baselineDiffPath = diffResult.outPath
    } catch (err) {
      baselineDiff = { error: String(err.message || err) }
    }
  }

  let summary = {
    reportId,
    triagedAt: new Date().toISOString(),
    metrics,
    findings,
    activeP0Count: activeP0.length,
    activeP0Ids: activeP0.map((f) => f.id),
    byClassification,
    bySeverity,
    recommendations: buildRecommendations(findings, metrics, activeP0),
    baselineId: baselineDiff?.baselineId ?? baselineId,
    baselineDiffPath,
  }

  if (opts.sdk) {
    try {
      const { sdkTriageRun, mergeSdkTriage } = await import('./sdkTriage.mjs')
      const { sdkTriage } = await sdkTriageRun(reportId, summary, opts.log ?? console.log)
      summary = mergeSdkTriage(summary, sdkTriage)
    } catch (err) {
      summary.sdkTriageError = err instanceof Error ? err.message : String(err)
      ;(opts.log ?? console.warn)(`SDK triage skipped: ${summary.sdkTriageError}`)
    }
  }

  const triagePath = join(outDir, 'triage-summary.json')
  writeFileSync(triagePath, JSON.stringify(summary, null, 2), 'utf-8')

  const outputRoot = join(qaRoot, 'output')
  mkdirSync(outputRoot, { recursive: true })
  const mdReportId = report.reportId ?? reportId
  const findingsCsvPath = exportFindingsCsv(findings, join(outputRoot, `${mdReportId}-findings.csv`))
  exportFindingsCsv(findings, join(outDir, 'findings.csv'))

  return { summary, triagePath, findingsCsvPath, baselineDiff, outDir }
}

function buildRecommendations(findings, metrics, activeP0) {
  const recs = []
  if (activeP0.length) {
    recs.push({ action: 'block-release', reason: `${activeP0.length} active P0 finding(s): ${activeP0.map((f) => f.id).join(', ')}` })
  } else if (metrics.pathwayGenRate >= 0.95) {
    recs.push({ action: 'ship-ok-pathway', reason: 'Pathway generation healthy on this run' })
  }
  const har = findings.find((f) => f.id === 'AUTO-HAR-001' && f.status === 'harness-artifact')
  if (har) {
    recs.push({ action: 'ignore-for-product', reason: 'AUTO-HAR-001 is harness calibration — do not file eval bugs' })
  }
  if (metrics.mode === 'smoke' && metrics.totalRuns < 60) {
    recs.push({ action: 'run-full-matrix', reason: 'Smoke sample — run qa:v3:matrix:prod for 60-cell validation' })
  }
  return recs
}
