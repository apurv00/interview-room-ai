import type { HarnessConfig, InterviewDepth, PersonaKind, QualityCheck, StageResult } from '../agent/types'
import type { QaHttpClient } from '../client/httpClient'
import { pickImprovedDrillAnswer } from '../config/personas'
import { avgDimensionScore } from '../config/thresholds'
import { collectUpgradeHints, copyScan } from './interviewRunner'

interface WeakQuestionRow {
  sessionId: string
  questionIndex: number
  question: string
  answer: string
  avgScore: number
  competency?: string
}

export async function runDrillStage(
  client: QaHttpClient,
  harness: HarnessConfig,
  args: {
    sessionId: string
    depth: InterviewDepth
    persona: PersonaKind
  },
): Promise<StageResult> {
  const startedAt = new Date().toISOString()
  const logStart = client.routeLog.length
  const checks: QualityCheck[] = []

  const list = await client.request<{ questions?: WeakQuestionRow[] }>({
    phase: 'drill',
    method: 'GET',
    route: '/api/learn/drill/questions?limit=20',
  })

  checks.push({
    id: 'drill-list',
    label: 'GET /api/learn/drill/questions',
    pass: list.ok,
    severity: 'error',
  })

  const mine = (list.data.questions ?? []).filter((q) => q.sessionId === args.sessionId)

  if (args.persona === 'strong') {
    checks.push({
      id: 'drill-strong-empty-ok',
      label: 'Strong persona may have zero weak questions',
      pass: true,
      detail: `weakForSession=${mine.length}`,
      severity: 'info',
    })
    return finish(startedAt, client, logStart, checks, { skipped: true, weakCount: mine.length })
  }

  if (mine.length === 0) {
    checks.push({
      id: 'drill-weak-present',
      label: 'Weak persona produced ≥1 drill question',
      pass: false,
      detail: 'No weak questions for this session — eval may be too lenient',
      severity: 'error',
    })
    return finish(startedAt, client, logStart, checks, { weakCount: 0 })
  }

  const target = mine[0]
  checks.push({
    id: 'drill-weak-present',
    label: 'Weak question found for session',
    pass: true,
    detail: `Q${target.questionIndex} avg=${target.avgScore}`,
    severity: 'info',
  })

  const ctx = await client.request<Record<string, unknown>>({
    phase: 'drill',
    method: 'GET',
    route: `/api/learn/drill/context/question?sessionId=${target.sessionId}&questionIndex=${target.questionIndex}`,
  })
  checks.push({
    id: 'drill-context',
    label: 'Drill context loaded',
    pass: ctx.ok,
    severity: 'error',
  })
  checks.push(...copyScan(JSON.stringify(ctx.data).slice(0, 4000), 'drill-context'))

  const improved = pickImprovedDrillAnswer(target.answer, args.depth)
  const sse = await client.requestSse({
    phase: 'drill',
    method: 'POST',
    route: '/api/learn/drill/evaluate',
    body: {
      sessionId: target.sessionId,
      questionIndex: target.questionIndex,
      question: target.question,
      originalAnswer: target.answer,
      originalScore: target.avgScore,
      newAnswer: improved,
      competency: target.competency,
    },
    requestSummary: { questionIndex: target.questionIndex },
  })

  checks.push({
    id: 'drill-evaluate',
    label: 'POST /api/learn/drill/evaluate SSE',
    pass: sse.status === 200 && sse.events.length > 0,
    detail: `events=${sse.events.length}`,
    severity: 'error',
  })

  const done = sse.events.find((e) => e.event === 'done' || e.event === 'complete')
  const result = (done?.data ?? sse.events.at(-1)?.data) as Record<string, unknown> | undefined
  const newScore = Number(result?.newScore ?? result?.score ?? result?.overall)
  if (Number.isFinite(newScore)) {
    checks.push({
      id: 'drill-improved',
      label: 'Drill score improved vs original',
      pass: newScore > target.avgScore,
      detail: `${target.avgScore} → ${newScore}`,
      severity: 'warn',
    })
  }

  return finish(startedAt, client, logStart, checks, {
    weakCount: mine.length,
    targetQuestionIndex: target.questionIndex,
    drillEvents: sse.events.length,
  })
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
    stage: 'drill',
    pass: checks.every((c) => c.pass || c.severity === 'info'),
    startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: routes.reduce((s, r) => s + r.durationMs, 0),
    routes,
    checks,
    data,
  }
  if (!stage.pass) stage.notes = collectUpgradeHints(stage, 'drill')
  return stage
}
