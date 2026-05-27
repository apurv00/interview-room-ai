/**
 * Derive scorecard metrics from a matrix report JSON (v2 legacy or v3 run dir).
 */
import { readFileSync } from 'node:fs'

function pathwayGenerationStatus(run) {
  return (
    run.stages?.pathway?.pathwayGenerationStatus ??
    run.stages?.pathway?.data?.pathwayGenerationStatus ??
    null
  )
}

function pathwayState(run) {
  return run.stages?.pathway?.data?.state ?? 'missing'
}

function analysisStatus(run) {
  const stage = run.stages?.analysis
  if (!stage) return 'missing'
  if (stage.skipped) return stage.reason === '403' ? 'skipped-403' : 'skipped'
  if (stage.timeout) return 'timeout'
  return stage.data?.status ?? (stage.ok ? 'unknown' : 'error')
}

/**
 * @param {object} report - matrix-report.json payload
 */
export function computeRunMetrics(report) {
  const runs = report.runs ?? []
  const evaluationRows = report.evaluationRows ?? []
  const n = runs.length || 1

  const strongRuns = runs.filter((r) => r.matrixKey?.endsWith('/strong'))
  const weakRuns = runs.filter((r) => r.matrixKey?.endsWith('/weak'))

  const pathwayGenSucceeded = runs.filter(
    (s) => pathwayGenerationStatus(s) === 'succeeded' || pathwayGenerationStatus(s) === 'skipped',
  ).length
  const pathwayGenPending = runs.filter(
    (s) => pathwayGenerationStatus(s) === 'pending' || pathwayGenerationStatus(s) === 'running',
  ).length
  const pathwayGenFailed = runs.filter((s) => pathwayGenerationStatus(s) === 'failed').length
  const pathwayGenCaptured = runs.filter((s) => pathwayGenerationStatus(s) != null).length

  const pathwayViewOk = runs.filter((s) => {
    const gen = pathwayGenerationStatus(s)
    if (gen === 'succeeded' || gen === 'skipped') return true
    const st = pathwayState(s)
    return st === 'completed' || st === 'active'
  }).length

  const pathwayPending = runs.filter((s) => pathwayState(s) === 'pending').length

  const feedbackOk = runs.filter((s) => s.stages?.feedback?.pass === true).length
  const analysisCompleted = runs.filter((s) => analysisStatus(s) === 'completed').length
  const analysisFailed = runs.filter((s) => analysisStatus(s) === 'failed').length

  const drillRan = runs.filter((s) => {
    const d = s.stages?.drill
    return d && !d.skipped && d.sseEvents != null
  }).length

  const lowStructure = evaluationRows.filter((r) => Number(r.eval?.structure ?? r.structure ?? 100) < 30).length
  const strongRegarding = evaluationRows.filter(
    (r) => r.persona === 'strong' && String(r.answer ?? r._raw?.answer ?? '').includes('Regarding "'),
  ).length
  const strongEvalRows = evaluationRows.filter((r) => r.persona === 'strong').length

  const analysisDurations = runs
    .map((s) => s.stages?.analysis?.data?.processingDurationMs)
    .filter((v) => v != null)
  const sorted = [...analysisDurations].sort((a, b) => a - b)

  return {
    reportId: report.reportId,
    mode: report.mode ?? 'unknown',
    harnessVersion: report.harnessVersion ?? null,
    totalRuns: n,
    passedRuns: report.passedRuns ?? runs.filter((r) => r.pass).length,
    passRate: report.passRate ?? (report.passedRuns ?? 0) / n,
    strongPass: strongRuns.filter((r) => r.pass).length,
    weakPass: weakRuns.filter((r) => r.pass).length,
    strongTotal: strongRuns.length,
    weakTotal: weakRuns.length,
    feedbackOk,
    feedbackRate: feedbackOk / n,
    analysisCompleted,
    analysisFailed,
    analysisRate: analysisCompleted / n,
    analysisDurationP50: sorted[Math.floor(sorted.length * 0.5)] ?? null,
    pathwayGenSucceeded,
    pathwayGenPending,
    pathwayGenFailed,
    pathwayGenCaptured,
    pathwayGenRate: pathwayGenCaptured ? pathwayGenSucceeded / n : null,
    pathwayViewOk,
    pathwayPending,
    drillRan,
    evalRowCount: evaluationRows.length,
    lowStructureCount: lowStructure,
    lowStructureRate: evaluationRows.length ? lowStructure / evaluationRows.length : 0,
    strongRegardingCount: strongRegarding,
    strongEvalRowCount: strongEvalRows,
  }
}

/**
 * Auto findings from harness metrics (mirrors generate-qa-browser-report.mjs).
 * @param {ReturnType<typeof computeRunMetrics>} metrics
 * @param {object} report
 */
export function computeAutoFindings(metrics, report) {
  const findings = []
  const n = metrics.totalRuns
  const genPending = metrics.pathwayGenCaptured
    ? metrics.pathwayGenPending
    : metrics.pathwayPending
  const genSucceeded = metrics.pathwayGenCaptured
    ? metrics.pathwayGenSucceeded
    : metrics.pathwayViewOk

  if (genPending === n && n > 0 && genSucceeded === 0) {
    findings.push({
      id: 'AUTO-PWY-001',
      severity: 'P0',
      stage: 'pathway',
      title: 'Pathway generation never reached terminal success in harness',
      status: 'confirmed-auto',
      classification: 'product-bug',
      impact: metrics.pathwayGenCaptured
        ? `${genPending}/${n} sessions stuck at pathwayGenerationStatus pending/running after poll window.`
        : `${n}/${n} sessions stuck in view-model state "pending" after poll window.`,
      evidence: metrics.pathwayGenCaptured
        ? [
            `pathwayGenerationStatus succeeded/skipped: ${genSucceeded}/${n}`,
            `pathwayGenerationStatus pending/running: ${genPending}/${n}`,
          ]
        : [`Harness poll: 0/${n} pathway terminal success`, `${metrics.pathwayPending}/${n} pathway state=pending`],
      nextSteps: [
        'Inngest Cloud: verify pathway-regenerate function registered (expect 8 functions)',
        'Mongo: pathwayGenerationStatus, pathwayGenerationStartedAt, attempts',
        'See modules/qa/docs/PATHWAY_P0_TRACE.md',
      ],
      source: 'auto-metrics',
    })
  }

  if (metrics.strongPass === 0 && metrics.strongTotal > 0 && n >= 6) {
    const artifact =
      metrics.strongEvalRowCount > 0 &&
      metrics.strongRegardingCount > metrics.strongEvalRowCount * 0.5
    findings.push({
      id: 'AUTO-HAR-001',
      severity: 'P2',
      stage: 'interview',
      title: artifact
        ? 'Strong persona 0% harness pass — canned-answer artifact'
        : 'Strong persona 0% harness pass — investigate eval or answers',
      status: artifact ? 'harness-artifact' : 'suspected',
      classification: artifact ? 'harness-artifact' : 'inconclusive',
      impact: artifact
        ? 'Do not treat as eval regression; strong answers were pasted off-topic.'
        : 'Strong persona band check failed despite on-topic harness answers.',
      evidence: [
        `0/${metrics.strongTotal} strong runs passed band (expected ≥60 avg)`,
        metrics.strongRegardingCount > 0
          ? `${metrics.strongRegardingCount}/${metrics.strongEvalRowCount} strong answers contain "Regarding …" hook`
          : 'Harness v2+ — strong answers without Regarding hook',
      ],
      nextSteps: artifact
        ? ['Add strongAnswers.byBucket entry', 'Human-rate 5 strong samples before eval bugs']
        : ['Review evaluate-answer prompt calibration'],
      source: 'auto-metrics',
    })
  }

  if (metrics.evalRowCount > 0 && metrics.lowStructureRate > 0.8) {
    findings.push({
      id: 'AUTO-EVL-001',
      severity: 'P1',
      stage: 'interview',
      title: 'Structure dimension clustered below 30 on most evaluations',
      status: 'suspected',
      classification: 'product-bug',
      impact: 'Users may see uniformly low structure scores regardless of answer quality.',
      evidence: [`${metrics.lowStructureCount}/${metrics.evalRowCount} eval rows with structure < 30`],
      nextSteps: ['Review evaluate-answer prompt STAR calibration', 'Compare with human-rated sample'],
      source: 'auto-metrics',
    })
  }

  if (metrics.analysisFailed > 0) {
    findings.push({
      id: 'AUTO-ANL-001',
      severity: 'P1',
      stage: 'analysis',
      title: 'Multimodal analysis pipeline failures',
      status: 'confirmed-auto',
      classification: 'product-bug',
      impact: `${metrics.analysisFailed}/${n} sessions failed analysis.`,
      evidence: [`analysis completed: ${metrics.analysisCompleted}/${n}`],
      nextSteps: ['Check /api/analysis logs', 'Verify Inngest analysis-job function'],
      source: 'auto-metrics',
    })
  }

  if (metrics.feedbackOk < n) {
    findings.push({
      id: 'AUTO-FBK-001',
      severity: 'P0',
      stage: 'feedback',
      title: 'Feedback generation did not return overall_score',
      status: 'confirmed-auto',
      classification: 'product-bug',
      impact: `${n - metrics.feedbackOk}/${n} sessions missing feedback score.`,
      evidence: [`feedback ok: ${metrics.feedbackOk}/${n}`],
      nextSteps: ['Check /api/generate-feedback logs', 'Verify Redis idempotency lock'],
      source: 'auto-metrics',
    })
  }

  void report
  return findings
}

/**
 * @param {string} reportPath - path to matrix-report.json or legacy output json
 */
export function loadMatrixReport(reportPath) {
  return JSON.parse(readFileSync(reportPath, 'utf-8'))
}
