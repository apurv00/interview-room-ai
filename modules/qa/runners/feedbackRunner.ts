import type { HarnessConfig, QualityCheck, StageResult } from '../agent/types'
import type { QaHttpClient } from '../client/httpClient'
import type { InterviewRunnerResult } from './interviewRunner'
import { collectUpgradeHints, copyScan } from './interviewRunner'

export async function runFeedbackStage(
  client: QaHttpClient,
  harness: HarnessConfig,
  interview: InterviewRunnerResult,
): Promise<StageResult> {
  const startedAt = new Date().toISOString()
  const logStart = client.routeLog.length
  const checks: QualityCheck[] = []

  const body = {
    config: interview.config,
    transcript: interview.transcript,
    evaluations: interview.evaluations,
    speechMetrics: [],
    sessionId: interview.sessionId,
    plannedQuestionCount: interview.questions.length,
    answeredCount: interview.evaluations.length,
    endReason: 'user_ended' as const,
  }

  let feedback: Record<string, unknown> | null = null
  let res = await client.request<Record<string, unknown> & { status?: string }>({
    phase: 'feedback',
    method: 'POST',
    route: '/api/generate-feedback',
    body,
    requestSummary: { sessionId: interview.sessionId, evalCount: interview.evaluations.length },
  })

  if (res.status === 202 || res.data.status === 'in_progress') {
    feedback = await pollFeedbackReady(client, interview.sessionId, harness)
  } else if (res.ok) {
    feedback = res.data
  }

  if (!feedback) {
    checks.push({
      id: 'feedback-present',
      label: 'Feedback generated',
      pass: false,
      severity: 'error',
    })
  } else {
    const score = Number(feedback.overall_score)
    checks.push({
      id: 'feedback-score',
      label: 'overall_score present',
      pass: Number.isFinite(score),
      detail: String(score),
      severity: 'error',
    })
    checks.push({
      id: 'feedback-pass-prob',
      label: 'pass_probability present',
      pass: typeof feedback.pass_probability === 'string',
      severity: 'warn',
    })
    checks.push(...copyScan(JSON.stringify(feedback).slice(0, 8000), 'feedback'))

    await client.request({
      phase: 'feedback',
      method: 'PATCH',
      route: `/api/interviews/${interview.sessionId}`,
      body: {
        status: 'completed',
        transcript: interview.transcript,
        evaluations: interview.evaluations,
        liveTranscriptWords: interview.liveTranscriptWords,
        feedback,
        completedAt: new Date().toISOString(),
        endReason: 'user_ended',
        answeredCount: interview.evaluations.length,
        plannedQuestionCount: interview.questions.length,
      },
    })
  }

  const routes = client.routeLog.slice(logStart)
  const stage: StageResult = {
    stage: 'feedback',
    pass: checks.every((c) => c.pass || c.severity === 'info'),
    startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: routes.reduce((s, r) => s + r.durationMs, 0),
    routes,
    checks,
    data: { overall_score: feedback?.overall_score, pass_probability: feedback?.pass_probability },
  }

  if (!stage.pass) {
    stage.notes = collectUpgradeHints(stage, 'feedback')
  }
  return stage
}

async function pollFeedbackReady(
  client: QaHttpClient,
  sessionId: string,
  harness: HarnessConfig,
): Promise<Record<string, unknown> | null> {
  const deadline = Date.now() + harness.pathwayTimeoutMs
  while (Date.now() < deadline) {
    await sleep(harness.pollIntervalMs)
    const sess = await client.request<Record<string, unknown>>({
      phase: 'feedback',
      method: 'GET',
      route: `/api/interviews/${sessionId}?excludeTranscript=true`,
    })
    const fb = sess.data.feedback as Record<string, unknown> | undefined
    if (fb && fb.overall_score != null) return fb
  }
  return null
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
