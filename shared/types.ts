// ─── Interview Configuration ──────────────────────────────────────────────────

// Role is now a dynamic slug from InterviewDomain (backward-compat: 'PM' | 'SWE' etc. still work)
export type Role = string
export type InterviewType = string  // slug from InterviewDepth
export type ExperienceLevel = '0-2' | '3-6' | '7+'
/** Interview duration in minutes (valid range: 5–60) */
export type Duration = number

// Legacy role type for backward compatibility checks
export type LegacyRole = 'PM' | 'SWE' | 'Sales' | 'MBA'

export interface InterviewConfig {
  role: Role
  interviewType?: InterviewType  // defaults to 'screening'
  experience: ExperienceLevel
  duration: Duration
  jobDescription?: string
  resumeText?: string
  jdFileName?: string
  resumeFileName?: string
  persona?: string              // interviewer persona slug
  resumeId?: string             // source resume ID for resume-to-interview flow
  targetCompany?: string        // extracted from JD or entered in lobby
  targetIndustry?: string       // extracted from JD or entered in lobby
  coachMode?: boolean           // active STAR framework coaching during answers
  degraded?: boolean            // true when lobby detected unsupported speech recognition; runtime should fall back to text-only input
  /**
   * Privacy mode — if true, the candidate's camera webm is never uploaded to
   * R2. Only the small audio-only track (needed for Whisper transcription)
   * and the facial-landmark JSON (already client-derived and tiny) are kept.
   * The replay page renders without video but still shows signal timeline
   * and fusion scores. Gated behind `NEXT_PUBLIC_FEATURE_PRIVACY_MODE`.
   */
  privacyMode?: boolean
}

// ─── State Machine ────────────────────────────────────────────────────────────

export type InterviewState =
  | 'INIT'
  | 'LOBBY'
  | 'CALIBRATION'
  | 'INTERVIEW_START'
  | 'ASK_QUESTION'
  | 'LISTENING'
  | 'CODE_EDITING'
  | 'DESIGN_CANVAS'
  | 'PROCESSING'
  | 'COACHING'
  | 'FOLLOW_UP'
  | 'WRAP_UP'
  | 'SCORING'
  | 'FEEDBACK'
  | 'ENDED'

// ─── Coding Interview Types ──────────────────────────────────────────────────

export type CodeLanguage = 'python' | 'javascript' | 'typescript' | 'java' | 'cpp'

export interface CodeSubmission {
  questionIndex: number
  code: string
  language: CodeLanguage
  submittedAt: number
}

// ─── System Design Interview Types ──────────────────────────────────────────

export type DesignComponentType =
  | 'client' | 'cdn' | 'load_balancer' | 'api_gateway'
  | 'web_server' | 'app_server' | 'microservice'
  | 'database' | 'cache' | 'message_queue' | 'storage'
  | 'search' | 'notification' | 'monitoring' | 'custom'

export interface DesignComponent {
  id: string
  type: DesignComponentType
  label: string
  x: number
  y: number
}

export interface DesignConnection {
  id: string
  from: string
  to: string
  label?: string
}

export interface DesignSubmission {
  components: DesignComponent[]
  connections: DesignConnection[]
  questionIndex: number
  submittedAt: number
}

// ─── Performance Signal ─────────────────────────────────────────────────────

export type PerformanceSignal = 'calibrating' | 'struggling' | 'on_track' | 'strong'

// ─── Probing & Threads ──────────────────────────────────────────────────────

export type ProbeType = 'clarify' | 'challenge' | 'expand' | 'quantify'

export interface ProbeDecision {
  shouldProbe: boolean
  probeType?: ProbeType | null
  /** Short target phrase for probe wording construction (e.g. "the outcome of the project") */
  probeTarget?: string | null
  /** P6: True if candidate pivoted away from the question (evasion/topic shift) */
  isPivot?: boolean
}

export interface ThreadEntry {
  role: 'interviewer' | 'candidate'
  text: string
  isProbe: boolean
  probeType?: ProbeType
  probeDepth: number  // 0 = main question, 1+ = probes
}

export interface ThreadSummary {
  topicIndex: number
  topicQuestion: string
  summary: string
  avgScore: number
  probeCount: number
  probeTypes: string[]
  /** Company/employer this thread focused on (best-effort extraction). */
  company?: string
}

// ─── Pushback tone (kept for toneToEmotion mapping in turn-router style) ─────

export type PushbackTone = 'curious' | 'probing' | 'encouraging'

// ─── Avatar ───────────────────────────────────────────────────────────────────

export type AvatarEmotion = 'neutral' | 'friendly' | 'curious' | 'skeptical' | 'impressed'

// ─── Transcript ───────────────────────────────────────────────────────────────

export interface TranscriptEntry {
  speaker: 'interviewer' | 'candidate'
  text: string
  timestamp: number
  questionIndex?: number | null
}

// ─── Evaluation ───────────────────────────────────────────────────────────────

export interface AnswerEvaluation {
  questionIndex: number
  question: string
  answer: string
  relevance: number       // 0–100
  structure: number       // 0–100  (STAR detection)
  specificity: number     // 0–100  (metrics / examples)
  ownership: number       // 0–100
  jdAlignment?: number | null    // 0–100, only present when JD was provided
  /** Dimension with the lowest score — used for coaching tip selection */
  primaryGap?: string
  /** Dimension with the highest score — used for reinforcement */
  primaryStrength?: string
  probeDecision?: ProbeDecision | null
  /** One-sentence factual summary for cross-answer consistency tracking */
  answerSummary?: string
  /** Red-flag strings — populated by offline/post-session evaluator, not live evaluator */
  flags?: string[]
  /**
   * Integrity marker for the scoring attempt (Work Item G.3).
   * - `ok`          : LLM returned a complete, parseable response
   * - `truncated`   : LLM hit max_tokens; partial response parsed
   * - `failed`      : LLM threw / rate-limited / parse failed; dims are
   *                    best-effort fallback values
   *
   * Undefined for legacy rows predating G.3 — treat as `'ok'`.
   * Consumed by generate-feedback aggregation (skip failed, flag
   * truncated in red_flags) and feedback UI rendering.
   */
  status?: 'ok' | 'truncated' | 'failed'
}

// ─── Interrupt context ──────────────────────────────────────────────────────

/** Captured when a candidate interrupts the AI mid-speech. */
export interface InterruptContext {
  /** Full text the AI was speaking when interrupted */
  interruptedUtterance: string
  /** Approximate text already spoken (from TTS chunk tracking) */
  spokenPortion: string
  /** What the candidate said during the interrupt */
  interruptSpeech: string
  /** Interview phase when interrupt occurred */
  phase: InterviewState
  /** Question index at time of interrupt */
  questionIndex: number
}

/** AI's decision on how to handle a candidate interrupt. */
export type InterruptResolution =
  | 'finish_then_address'  // complete current sentence, then respond to interrupt
  | 'abort_and_pivot'      // drop current speech, respond to new context
  | 'acknowledge_defer'    // "good point, we'll come back to that"
  | 'absorbed'             // interrupt was noise/irrelevant, continue

// ─── Speech metrics ───────────────────────────────────────────────────────────

export interface SpeechMetrics {
  wpm: number
  fillerRate: number         // filler words / total words
  pauseScore: number         // 0–100 (higher = better pacing)
  ramblingIndex: number      // 0–1 (higher = rambling)
  totalWords: number
  fillerWordCount: number
  durationMinutes: number
}

// ─── Scoring JSON (as per spec) ───────────────────────────────────────────────

// ─── Engagement signals (AI-estimated from speech patterns) ──────────────────

export interface EngagementSignals {
  score: number                                          // 0–100 overall
  engagement_score: number                               // 0–100
  confidence_trend: 'increasing' | 'stable' | 'declining'
  energy_consistency: number                             // 0–1
  composure_under_pressure: number                       // 0–100
}

// Legacy delivery signals (for backward compat with older sessions)
export interface DeliverySignals {
  score: number
  gaze_ratio: number
  head_stability: number
  affect_variability: number
  confidence_band: 'High' | 'Medium' | 'Low'
}

// ─── JD alignment breakdown ─────────────────────────────────────────────────

export interface JdRequirementMatch {
  requirement: string
  matched: boolean
  evidence?: string
}

export interface FeedbackData {
  overall_score: number
  pass_probability: 'High' | 'Medium' | 'Low'
  confidence_level: 'High' | 'Medium' | 'Low'
  dimensions: {
    answer_quality: {
      score: number
      strengths: string[]
      weaknesses: string[]
    }
    communication: {
      score: number
      wpm: number
      filler_rate: number
      pause_score: number
      rambling_index: number
    }
    engagement_signals: EngagementSignals
    // Legacy: older sessions may still have delivery_signals
    delivery_signals?: DeliverySignals
  }
  jd_match_score?: number                    // 0–100, only when JD was provided
  jd_requirement_breakdown?: JdRequirementMatch[]
  red_flags: string[]
  top_3_improvements: string[]
  /**
   * Signals that the feedback was produced by the server-side fallback
   * path instead of by a successful LLM run. Set to `true` only on the
   * outer-catch path in `/api/generate-feedback` (LLM error, timeout,
   * schema validation failure). The other "low-signal" feedback paths
   * (no-answers, short-form <3 answers) leave this unset because their
   * 0 scores are legitimate — the user genuinely didn't produce scorable
   * content, and the `red_flags` array explains why.
   *
   * UI responsibilities when `degraded === true`:
   *   - Show a clear degraded-mode banner
   *   - Offer a "Retry" affordance (see `handleRetry`)
   *   - Label any numeric values as "approximate" so candidates don't
   *     interpret the synthetic `overall_score` as a real verdict
   *
   * Optional for backwards compatibility — sessions persisted before
   * this field existed will have `degraded === undefined`, which the UI
   * treats as "feedback generated normally" (falsy check). No migration
   * is required.
   */
  degraded?: boolean
  /** FB1: Per-question ideal answer outlines for comparison */
  ideal_answers?: Array<{
    questionIndex: number
    strongAnswer: string
    keyElements: string[]
  }>
  /** FB7: Targeted practice recommendations based on session gaps */
  drill_recommendations?: Array<{
    skillArea: string
    description: string
    practiceQuestions: string[]
  }>
  /**
   * Side-effect scheduling outcomes captured synchronously at response
   * time. Each entry is one of the fire-and-forget post-feedback writes
   * (practiceStats, competency, sessionSummary, weaknessClusters,
   * pathwayPlan, masteryTracking, universalPlanAdvance, persist).
   *
   * `status` resolves to:
   *   - 'scheduled': the side-effect was kicked off. Runtime failures
   *     land in the `post-feedback side effects settled` aggregate log
   *     + per-call `aiLogger.warn`. The response can't be updated
   *     retroactively so these don't re-surface here — use the log
   *     dashboard. Failure does NOT block the response.
   *   - 'skipped': the side-effect was short-circuited at response-
   *     build time. Typically means a feature flag is off (e.g.
   *     `FEATURE_FLAG_PATHWAY_PLANNER=false`) or a precondition is
   *     unmet (e.g. `overall_score` is non-numeric for practiceStats).
   *     The UI / pathway page can surface a targeted message instead
   *     of the generic "complete an interview to generate a plan"
   *     that confused users in prod session
   *     69eb6689c6cbd204bd2b8266.
   *
   * Optional for backwards compat; sessions persisted before this
   * field existed have `sideEffectOutcomes === undefined`.
   */
  sideEffectOutcomes?: Array<{
    name: string
    status: 'scheduled' | 'skipped'
  }>
}

// ─── Stored interview data ────────────────────────────────────────────────────

export interface StoredInterviewData {
  config: InterviewConfig
  transcript: TranscriptEntry[]
  evaluations: AnswerEvaluation[]
  speechMetrics: SpeechMetrics[]
  feedback?: FeedbackData
  threads?: ThreadSummary[]
}

// ─── Pathway & Competency Types (client-facing) ────────────────────────────

export interface CompetencyScore {
  name: string
  score: number
  trend: 'improving' | 'stable' | 'declining'
  confidence: number
}

export interface PathwayData {
  readinessLevel: 'not_ready' | 'developing' | 'approaching' | 'ready' | 'strong'
  readinessScore: number
  topBlockingWeaknesses: Array<{
    competency: string
    currentScore: number
    targetScore: number
    reason: string
  }>
  strengthsToPreserve: string[]
  nextSessionRecommendation: {
    domain: string
    interviewType: string
    focusCompetencies: string[]
    difficulty: string
    reason: string
  }
  practiceTasks: Array<{
    taskId: string
    type: string
    title: string
    description: string
    targetCompetency: string
    difficulty: string
    estimatedMinutes: number
    completed: boolean
  }>
  milestones: Array<{
    name: string
    description: string
    targetScore: number
    currentScore: number
    achieved: boolean
  }>
}

export interface WeaknessData {
  name: string
  description: string
  severity: 'critical' | 'moderate' | 'minor'
  recurrenceCount: number
  linkedCompetencies: string[]
}

// ─── Multimodal Analysis ─────────────────────────────────────────────────────

export type {
  WhisperWord,
  WhisperSegment,
  ProsodySegment,
  FacialFrame,
  FacialSegment,
  TimelineEvent,
  TimelineEventType,
  TimelineSignalSource,
  TimelineSeverity,
  FusionSummary,
  AnalysisStatus,
  MultimodalAnalysisData,
} from './types/multimodal'
