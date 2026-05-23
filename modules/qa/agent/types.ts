/** QA simulation harness types — isolated from product modules. */

export type InterviewDepth =
  | 'behavioral'
  | 'technical'
  | 'case-study'
  | 'system-design'
  | 'coding'

export type PersonaKind = 'strong' | 'weak'

export type SimulationStage =
  | 'interview'
  | 'feedback'
  | 'analysis'
  | 'pathway'
  | 'drill'

export interface MatrixCell {
  domain: string
  depth: InterviewDepth
  applicable: boolean
}

export interface MatrixRun {
  cell: MatrixCell
  persona: PersonaKind
  runId: string
}

export interface RouteCallRecord {
  phase: SimulationStage | 'setup' | 'session'
  method: string
  route: string
  status: number
  durationMs: number
  ok: boolean
  questionIndex?: number
  requestSummary?: Record<string, unknown>
  responseSummary?: Record<string, unknown>
  error?: string
}

export interface QuestionEvaluationRecord {
  questionIndex: number
  question: string
  answer: string
  persona: PersonaKind
  evaluation: Record<string, unknown> | null
  routes: RouteCallRecord[]
  checks: QualityCheck[]
  pass: boolean
}

export interface QualityCheck {
  id: string
  label: string
  pass: boolean
  detail?: string
  severity: 'info' | 'warn' | 'error'
}

export interface StageResult {
  stage: SimulationStage
  pass: boolean
  startedAt: string
  finishedAt: string
  durationMs: number
  routes: RouteCallRecord[]
  checks: QualityCheck[]
  questions?: QuestionEvaluationRecord[]
  notes?: string[]
  data?: Record<string, unknown>
}

export interface SimulationRunResult {
  runId: string
  matrixKey: string
  domain: string
  depth: InterviewDepth
  persona: PersonaKind
  sessionId?: string
  pass: boolean
  startedAt: string
  finishedAt: string
  durationMs: number
  stages: StageResult[]
  allRoutes: RouteCallRecord[]
  upgradeRecommendations: string[]
}

export interface EvaluationAggregateRow {
  matrixKey: string
  domain: string
  depth: InterviewDepth
  persona: PersonaKind
  questionIndex: number
  relevance: number | null
  structure: number | null
  specificity: number | null
  ownership: number | null
  jdAlignment: number | null
  avgDimensions: number | null
  pass: boolean
  evalLatencyMs: number | null
  generateLatencyMs: number | null
  issues: string[]
}

export interface RouteLatencyStat {
  route: string
  count: number
  p50Ms: number
  p95Ms: number
  maxMs: number
  errorCount: number
}

export interface MatrixReport {
  reportId: string
  mode: 'smoke' | 'full' | 'single'
  baseUrl: string
  startedAt: string
  finishedAt: string
  durationMs: number
  totalRuns: number
  passedRuns: number
  failedRuns: number
  passRate: number
  runs: SimulationRunResult[]
  phaseSummary: PhaseSummary[]
  routeFrequency: Record<string, number>
  routeLatency: RouteLatencyStat[]
  evaluationRows: EvaluationAggregateRow[]
  topIssues: string[]
}

export interface PhaseSummary {
  phase: string
  description: string
  runsAttempted: number
  runsPassed: number
  passRate: number
  commonFailures: string[]
}

export interface HarnessConfig {
  baseUrl: string
  sessionCookie: string
  duration: number
  experience: '0-2' | '3-6' | '7+'
  questionLimit?: number
  stages: SimulationStage[]
  concurrency: number
  mode: 'smoke' | 'full' | 'single'
  outputDir: string
  pollIntervalMs: number
  pathwayTimeoutMs: number
  analysisTimeoutMs: number
  judgeEnabled: boolean
}

export interface InterviewConfigPayload {
  role: string
  interviewType: string
  experience: '0-2' | '3-6' | '7+'
  duration: number
  privacyMode?: boolean
}

export interface TranscriptEntryPayload {
  speaker: 'interviewer' | 'candidate'
  text: string
  timestamp: number
  questionIndex?: number
}

export interface LiveTranscriptWordPayload {
  word: string
  start: number
  end: number
  confidence: number
}
