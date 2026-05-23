import type {
  HarnessConfig,
  InterviewConfigPayload,
  LiveTranscriptWordPayload,
  PersonaKind,
  QuestionEvaluationRecord,
  QualityCheck,
  RouteCallRecord,
  SimulationStage,
  StageResult,
  TranscriptEntryPayload,
} from '../agent/types'
import type { QaHttpClient } from '../client/httpClient'
import { pickPersonaAnswer, questionQualityHeuristics } from '../config/personas'
import {
  avgDimensionScore,
  BANNED_COPY_PATTERNS,
  effectiveQuestionLimit,
  expectedScoreBand,
} from '../config/thresholds'
import type { InterviewDepth } from '../agent/types'

export interface InterviewRunnerResult {
  sessionId: string
  config: InterviewConfigPayload
  transcript: TranscriptEntryPayload[]
  evaluations: Record<string, unknown>[]
  liveTranscriptWords: LiveTranscriptWordPayload[]
  questions: QuestionEvaluationRecord[]
  routes: RouteCallRecord[]
}

export async function runInterviewStage(
  client: QaHttpClient,
  args: {
    domain: string
    depth: InterviewDepth
    persona: PersonaKind
    harness: HarnessConfig
  },
): Promise<InterviewRunnerResult> {
  const logStart = client.routeLog.length
  const config: InterviewConfigPayload = {
    role: args.domain,
    interviewType: args.depth,
    experience: args.harness.experience,
    duration: args.harness.duration,
    privacyMode: true,
  }

  const createRes = await client.request<{ sessionId?: string; error?: string }>({
    phase: 'interview',
    method: 'POST',
    route: '/api/interviews',
    body: { config },
    requestSummary: { domain: args.domain, depth: args.depth },
  })
  if (!createRes.ok || !createRes.data.sessionId) {
    throw new Error(`Create session failed: ${createRes.status} ${JSON.stringify(createRes.data)}`)
  }
  const sessionId = createRes.data.sessionId

  await client.request({
    phase: 'interview',
    method: 'PATCH',
    route: `/api/interviews/${sessionId}`,
    body: { status: 'in_progress', startedAt: new Date().toISOString() },
  })

  const questionCount = effectiveQuestionLimit(args.harness.duration, args.depth, args.harness.questionLimit)
  const transcript: TranscriptEntryPayload[] = []
  const evaluations: Record<string, unknown>[] = []
  const questions: QuestionEvaluationRecord[] = []
  let t = Date.now()

  for (let questionIndex = 0; questionIndex < questionCount; questionIndex++) {
    const qRoutesStart = client.routeLog.length
    const gq = await client.request<{ question?: string; isFallback?: boolean }>({
      phase: 'interview',
      method: 'POST',
      route: '/api/generate-question',
      questionIndex,
      body: {
        config,
        questionIndex,
        previousQA: transcript,
        sessionId,
        performanceSignal: args.persona === 'strong' ? 'on_track' : 'struggling',
      },
      requestSummary: { questionIndex, domain: args.domain, depth: args.depth },
    })

    const question = gq.data.question ?? ''
    const answer = pickPersonaAnswer(args.depth, args.persona, question)

    transcript.push({
      speaker: 'interviewer',
      text: question,
      timestamp: t,
      questionIndex,
    })
    t += 500
    transcript.push({
      speaker: 'candidate',
      text: answer,
      timestamp: t,
      questionIndex,
    })
    t += 2000

    const ev = await client.request<Record<string, unknown>>({
      phase: 'interview',
      method: 'POST',
      route: '/api/evaluate-answer',
      questionIndex,
      body: {
        config,
        question,
        answer,
        questionIndex,
        sessionId,
      },
      requestSummary: { questionIndex, answerLength: answer.length },
    })

    const evaluation = ev.ok ? ev.data : null
    if (evaluation) evaluations.push(evaluation)

    await client.request({
      phase: 'interview',
      method: 'PATCH',
      route: `/api/interviews/${sessionId}`,
      body: { transcript, evaluations, status: 'in_progress' },
    })

    const qRoutes = client.routeLog.slice(qRoutesStart)
    const checks = buildQuestionChecks({
      question,
      answer,
      evaluation,
      persona: args.persona,
      domain: args.domain,
      depth: args.depth,
      isFallback: Boolean(gq.data.isFallback),
    })

    questions.push({
      questionIndex,
      question,
      answer,
      persona: args.persona,
      evaluation,
      routes: qRoutes,
      checks,
      pass: checks.every((c) => c.pass || c.severity === 'info'),
    })
  }

  const liveTranscriptWords = synthesizeLiveWords(transcript)

  await client.request({
    phase: 'interview',
    method: 'PATCH',
    route: `/api/interviews/${sessionId}`,
    body: {
      transcript,
      evaluations,
      liveTranscriptWords,
      status: 'in_progress',
    },
  })

  return {
    sessionId,
    config,
    transcript,
    evaluations,
    liveTranscriptWords,
    questions,
    routes: client.routeLog.slice(logStart),
  }
}

function buildQuestionChecks(args: {
  question: string
  answer: string
  evaluation: Record<string, unknown> | null
  persona: PersonaKind
  domain: string
  depth: InterviewDepth
  isFallback: boolean
}): QualityCheck[] {
  const checks: QualityCheck[] = []
  checks.push({
    id: 'question-nonempty',
    label: 'Question returned',
    pass: args.question.trim().length > 0,
    severity: 'error',
  })
  if (args.isFallback) {
    checks.push({
      id: 'question-not-fallback',
      label: 'Question not fallback template',
      pass: false,
      detail: 'generate-question returned isFallback',
      severity: 'warn',
    })
  }
  for (const issue of questionQualityHeuristics(args.question, args.domain, args.depth)) {
    checks.push({
      id: `question-heuristic-${issue.slice(0, 24)}`,
      label: issue,
      pass: false,
      severity: 'warn',
    })
  }
  if (args.evaluation) {
    const avg = avgDimensionScore(args.evaluation)
    const band = expectedScoreBand(args.persona)
    checks.push({
      id: 'eval-score-band',
      label: `Avg dimension ${avg} in band ${band.min}-${band.max} for ${args.persona}`,
      pass: avg >= band.min && avg <= band.max,
      detail: `relevance=${args.evaluation.relevance} structure=${args.evaluation.structure}`,
      severity: args.persona === 'strong' ? 'error' : 'warn',
    })
    if (args.evaluation.status === 'failed') {
      checks.push({
        id: 'eval-not-failed',
        label: 'Evaluation status not failed',
        pass: false,
        severity: 'error',
      })
    }
  } else {
    checks.push({
      id: 'eval-present',
      label: 'Evaluation returned',
      pass: false,
      severity: 'error',
    })
  }
  return checks
}

export function synthesizeLiveWords(transcript: TranscriptEntryPayload[]): LiveTranscriptWordPayload[] {
  const words: LiveTranscriptWordPayload[] = []
  let cursor = 0
  const baseTs = transcript[0]?.timestamp ?? Date.now()
  for (const entry of transcript) {
    if (entry.speaker !== 'candidate') continue
    for (const w of entry.text.split(/\s+/).filter(Boolean)) {
      words.push({
        word: w,
        start: cursor,
        end: cursor + 0.25,
        confidence: 0.92,
      })
      cursor += 0.3
    }
    cursor += 0.8
  }
  if (words.length === 0 && transcript.length > 0) {
    words.push({ word: 'hello', start: 0, end: 0.2, confidence: 0.9 })
  }
  void baseTs
  return words
}

export function stageResultFromInterview(
  startedAt: string,
  interview: InterviewRunnerResult,
): StageResult {
  const checks: QualityCheck[] = []
  for (const q of interview.questions) checks.push(...q.checks)
  const pass = interview.questions.every((q) => q.pass)
  return {
    stage: 'interview',
    pass,
    startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: interview.routes.reduce((s, r) => s + r.durationMs, 0),
    routes: interview.routes,
    checks,
    questions: interview.questions,
    data: { sessionId: interview.sessionId, questionCount: interview.questions.length },
  }
}

export function copyScan(text: string, label: string): QualityCheck[] {
  const checks: QualityCheck[] = []
  for (const re of BANNED_COPY_PATTERNS) {
    if (re.test(text)) {
      checks.push({
        id: `copy-${label}-${re.source}`,
        label: `Banned copy in ${label}: ${re.source}`,
        pass: false,
        severity: 'warn',
      })
    }
  }
  return checks
}

export function collectUpgradeHints(stage: StageResult, stageName: SimulationStage): string[] {
  const hints: string[] = []
  for (const c of stage.checks) {
    if (!c.pass && c.severity !== 'info') {
      hints.push(`[${stageName}] ${c.label}${c.detail ? `: ${c.detail}` : ''}`)
    }
  }
  if (stage.questions) {
    for (const q of stage.questions) {
      for (const c of q.checks) {
        if (!c.pass && c.severity !== 'info') {
          hints.push(`[${stageName} Q${q.questionIndex + 1}] ${c.label}`)
        }
      }
      if (q.evaluation && q.routes.some((r) => r.route.includes('evaluate-answer') && r.durationMs > 8000)) {
        hints.push(`[${stageName} Q${q.questionIndex + 1}] evaluate-answer slow (>${8000}ms) — consider model slot tuning`)
      }
    }
  }
  return hints
}
