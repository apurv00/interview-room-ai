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
  probeQuestion?: string | null
  probingRationale?: string | null
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
}

// ─── Pushback ───────────────────────────────────────────────────────────────

export type PushbackTone = 'curious' | 'probing' | 'encouraging'

export interface Pushback {
  line: string
  targetDimension: string
  tone: PushbackTone
}

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
  needsFollowUp: boolean
  followUpQuestion?: string | null
  flags: string[]
  probeDecision?: ProbeDecision | null
  pushback?: Pushback | null
}

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
