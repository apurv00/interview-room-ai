import type { HarnessConfig, QualityCheck, StageResult } from '../agent/types'
import type { QaHttpClient } from '../client/httpClient'
import { copyScan } from './interviewRunner'
import { collectUpgradeHints } from './interviewRunner'

export async function runAnalysisStage(
  client: QaHttpClient,
  harness: HarnessConfig,
  sessionId: string,
): Promise<StageResult> {
  const startedAt = new Date().toISOString()
  const logStart = client.routeLog.length
  const checks: QualityCheck[] = []

  const start = await client.request<{ status?: string; jobId?: string; error?: string }>({
    phase: 'analysis',
    method: 'POST',
    route: '/api/analysis/start',
    body: { sessionId },
    requestSummary: { sessionId },
  })

  if (start.status === 403) {
    checks.push({
      id: 'analysis-flag',
      label: 'Multimodal analysis enabled on target',
      pass: false,
      detail: start.data.error ?? '403 — feature flag off',
      severity: 'warn',
    })
    return finishStage(startedAt, client, logStart, checks, { skipped: true })
  }

  if (!start.ok && start.status !== 200) {
    checks.push({
      id: 'analysis-start',
      label: 'analysis/start succeeded',
      pass: false,
      detail: JSON.stringify(start.data),
      severity: 'error',
    })
    return finishStage(startedAt, client, logStart, checks, {})
  }

  const analysis = await pollAnalysis(client, sessionId, harness)
  if (!analysis) {
    checks.push({
      id: 'analysis-complete',
      label: 'Analysis reached completed status',
      pass: false,
      severity: 'error',
    })
    return finishStage(startedAt, client, logStart, checks, {})
  }

  checks.push({
    id: 'analysis-status',
    label: 'status completed',
    pass: analysis.status === 'completed',
    detail: String(analysis.status),
    severity: 'error',
  })

  const tips = JSON.stringify(analysis.fusionSummary ?? analysis.timeline ?? '')
  checks.push({
    id: 'analysis-content',
    label: 'Fusion/timeline content present',
    pass: tips.length > 20,
    severity: 'warn',
  })
  checks.push(...copyScan(tips, 'analysis'))

  return finishStage(startedAt, client, logStart, checks, {
    status: analysis.status,
    processingDurationMs: analysis.processingDurationMs,
  })
}

async function pollAnalysis(
  client: QaHttpClient,
  sessionId: string,
  harness: HarnessConfig,
): Promise<Record<string, unknown> | null> {
  const deadline = Date.now() + harness.analysisTimeoutMs
  while (Date.now() < deadline) {
    await sleep(harness.pollIntervalMs)
    const res = await client.request<Record<string, unknown>>({
      phase: 'analysis',
      method: 'GET',
      route: `/api/analysis/${sessionId}`,
    })
    if (res.status === 404) continue
    const status = res.data.status
    if (status === 'completed' || status === 'failed') return res.data
  }
  return null
}

function finishStage(
  startedAt: string,
  client: QaHttpClient,
  logStart: number,
  checks: QualityCheck[],
  data: Record<string, unknown>,
): StageResult {
  const routes = client.routeLog.slice(logStart)
  const stage: StageResult = {
    stage: 'analysis',
    pass: checks.every((c) => c.pass || c.severity === 'info'),
    startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: routes.reduce((s, r) => s + r.durationMs, 0),
    routes,
    checks,
    data,
  }
  if (!stage.pass) stage.notes = collectUpgradeHints(stage, 'analysis')
  return stage
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
