import type { HarnessConfig, QualityCheck, StageResult } from '../agent/types'
import type { QaHttpClient } from '../client/httpClient'
import { copyScan, collectUpgradeHints } from './interviewRunner'

export async function runPathwayStage(
  client: QaHttpClient,
  harness: HarnessConfig,
  sessionId: string,
): Promise<StageResult> {
  const startedAt = new Date().toISOString()
  const logStart = client.routeLog.length
  const checks: QualityCheck[] = []

  await pollPathwayGeneration(client, sessionId, harness)

  const pathway = await client.request<Record<string, unknown>>({
    phase: 'pathway',
    method: 'GET',
    route: `/api/learn/pathway?fromFeedback=${sessionId}`,
    requestSummary: { fromFeedback: sessionId },
  })

  if (!pathway.ok) {
    checks.push({
      id: 'pathway-fetch',
      label: 'GET /api/learn/pathway',
      pass: false,
      detail: String(pathway.status),
      severity: 'error',
    })
    return finish(startedAt, client, logStart, checks, {})
  }

  const sess = await client.request<Record<string, unknown>>({
    phase: 'pathway',
    method: 'GET',
    route: `/api/interviews/${sessionId}?excludeTranscript=true`,
  })
  const genStatus = sess.data.pathwayGenerationStatus
  checks.push({
    id: 'pathway-gen-status',
    label: 'pathwayGenerationStatus completed',
    pass: genStatus === 'completed' || genStatus === undefined,
    detail: String(genStatus),
    severity: genStatus === 'failed' ? 'error' : 'warn',
  })

  const planText = JSON.stringify(pathway.data).slice(0, 12000)
  checks.push({
    id: 'pathway-plan-body',
    label: 'Pathway plan payload non-empty',
    pass: planText.length > 50,
    severity: 'error',
  })
  checks.push(...copyScan(planText, 'pathway'))

  const tasks =
    (pathway.data.plan as Record<string, unknown> | undefined)?.practiceTasks ??
    (pathway.data as { practiceTasks?: unknown }).practiceTasks
  if (Array.isArray(tasks)) {
    checks.push({
      id: 'pathway-tasks',
      label: 'Practice tasks array present',
      pass: tasks.length > 0,
      detail: `count=${tasks.length}`,
      severity: 'warn',
    })
  }

  return finish(startedAt, client, logStart, checks, {
    pathwayGenerationStatus: genStatus,
    hasPlan: planText.length > 50,
  })
}

async function pollPathwayGeneration(
  client: QaHttpClient,
  sessionId: string,
  harness: HarnessConfig,
): Promise<void> {
  const deadline = Date.now() + harness.pathwayTimeoutMs
  while (Date.now() < deadline) {
    const sess = await client.request<Record<string, unknown>>({
      phase: 'pathway',
      method: 'GET',
      route: `/api/interviews/${sessionId}?excludeTranscript=true`,
    })
    const st = sess.data.pathwayGenerationStatus
    if (st === 'completed' || st === 'failed' || st === undefined) return
    await sleep(harness.pollIntervalMs)
  }
}

function finish(
  startedAt: string,
  client: QaHttpClient,
  logStart: number,
  checks: QualityCheck[],
  data: Record<string, unknown>,
): StageResult {
  const routes = client.routeLog.slice(logStart)
  const stage: StageResult = {
    stage: 'pathway',
    pass: checks.every((c) => c.pass || c.severity === 'info'),
    startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: routes.reduce((s, r) => s + r.durationMs, 0),
    routes,
    checks,
    data,
  }
  if (!stage.pass) stage.notes = collectUpgradeHints(stage, 'pathway')
  return stage
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
