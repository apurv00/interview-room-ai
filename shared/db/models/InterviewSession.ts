import mongoose, { Schema, Document, Model } from 'mongoose'
import type {
  InterviewConfig,
  TranscriptEntry,
  AnswerEvaluation,
  SpeechMetrics,
  FeedbackData,
} from '@shared/types'

export type SessionStatus = 'created' | 'in_progress' | 'completed' | 'abandoned'

export interface IInterviewSession extends Document {
  _id: mongoose.Types.ObjectId

  userId: mongoose.Types.ObjectId
  organizationId?: mongoose.Types.ObjectId

  config: InterviewConfig

  // Document context
  jobDescription?: string
  resumeText?: string
  jdFileName?: string
  resumeFileName?: string
  parsedJobDescription?: Record<string, unknown>
  parsedResume?: Record<string, unknown>

  // Persona
  persona?: string

  status: SessionStatus
  startedAt?: Date
  completedAt?: Date
  durationActualSeconds?: number
  interviewLatencyTelemetry?: Record<string, unknown>

  transcript: TranscriptEntry[]
  evaluations: AnswerEvaluation[]
  speechMetrics: SpeechMetrics[]
  feedback?: FeedbackData

  recordingUrl?: string
  recordingSizeBytes?: number
  recordingR2Key?: string

  // Screen recording (coding & system-design interviews) — captures the
  // candidate's work surface (IDE / canvas) alongside the camera track.
  screenRecordingR2Key?: string
  screenRecordingSizeBytes?: number

  // Audio-only recording — uploaded in parallel with the camera webm so
  // Whisper transcription reads a small file (typically 1–2MB for a
  // 6-minute interview) instead of the multi-megabyte video webm. Keeps
  // Groq's 25MB upload limit comfortably out of reach.
  audioRecordingR2Key?: string
  audioRecordingSizeBytes?: number

  resumeR2Key?: string
  jdR2Key?: string

  // Scoring dimensions used for this session (stored at creation from depth config)
  scoringDimensions?: Array<{ name: string; label: string; weight: number }>

  // Coding interview
  codingProblemId?: string
  // Design interview
  designProblemId?: string
  codeSubmissions?: Array<{
    code: string
    language: string
    submittedAt: Date
  }>
  // Coding clarifications: AI answers to candidate questions about a coding problem.
  // Append-only — original problem description and test cases are never mutated.
  codingClarifications?: Array<{
    problemId: string
    question: string
    answer: string
    addedExamples?: Array<{ input: string; output: string; explanation?: string }>
    addedConstraints?: string[]
    createdAt: Date
  }>

  templateId?: mongoose.Types.ObjectId
  candidateEmail?: string
  candidateName?: string
  recruiterNotes?: string

  // Invite verification (B2B)
  inviteTokenHash?: string
  inviteTokenExpiry?: Date

  // Sharing
  shareToken?: string
  isPublic?: boolean
  shareExpiresAt?: Date

  // Consent tracking
  consentedToRecording?: boolean
  consentedToAnalysis?: boolean

  // Privacy mode — candidate opted out of video storage. Camera webm is
  // never uploaded; audio-only webm and facial-landmark JSON still are.
  privacyMode?: boolean

  // Research donation — candidate opted in to contribute this session's
  // signals to the dual-pipeline comparison experiment. Gate for #4.
  researchDonation?: boolean

  // Multimodal analysis
  multimodalAnalysisId?: mongoose.Types.ObjectId
  facialLandmarksR2Key?: string

  // Live transcript captured by Deepgram streaming STT during the
  // interview, with audio-timeline-relative word timestamps. When
  // present, the multimodal analysis pipeline uses these directly
  // and skips the post-interview Whisper call (cost + 25MB limit).
  liveTranscriptWords?: Array<{
    word: string
    start: number
    end: number
    confidence: number
  }>

  userAgent?: string

  // Retake linkage — when a session is a retake of a prior one, `parentSessionId`
  // points to the ROOT of the retake chain (not the immediate parent). This
  // keeps the comparison query trivial: all retakes of the same original share
  // a single parent id. `retakeNumber` starts at 1 for the first retake.
  // Both fields optional — legacy sessions read as undefined and remain valid.
  parentSessionId?: mongoose.Types.ObjectId
  retakeNumber?: number

  // ── Pathway regeneration status ───────────────────────────────────────
  // Tracks the lifecycle of the post-feedback pathway-plan generation
  // (Inngest job: `pathway/regenerate`). Before this field existed, the
  // pathway page inferred "is the plan ready?" by comparing
  // `PathwayPlan.generatedFromSessionId` to the `?fromFeedback=<sessionId>`
  // query param. If the fire-and-forget side-effect chain ever rejected
  // (LLM timeout, schema mismatch, eval failure), the field stayed stale
  // forever and the UI hung on "catching up" with no recovery path.
  //
  // The status field gives the UI an explicit signal — pending/running/
  // succeeded/failed/skipped — so it can show a retry affordance instead
  // of a stuck banner. All fields optional so legacy sessions remain
  // valid; readers treat undefined as "no attempt yet recorded".
  pathwayGenerationStatus?: 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped'
  pathwayGenerationError?: string
  pathwayGenerationStartedAt?: Date
  pathwayGenerationCompletedAt?: Date
  pathwayGenerationAttempts?: number
  /** Set when pathway/regenerate is enqueued from a path that will NOT
   *  persist session.feedback (outer-catch / inner-degraded). The Inngest
   *  job may synthesize planner input from evaluations in-memory only. */
  pathwayGenerationUseSynthesizedFeedback?: boolean

  // ── G.7: session completion shape ─────────────────────────────────────
  // Populated at session-create time (from getQuestionCount(config.duration))
  // and at finishInterview time (from how the session ended). Consumed by
  // G.10 (partial-completion scoring) — feedback generation uses these to
  // apply a completion multiplier, clamp confidence_level on low-data
  // sessions, and surface an explicit red_flag when answeredCount is
  // below the planned count. All fields optional so legacy sessions remain
  // valid; readers treat undefined as "unknown" rather than zero.
  plannedQuestionCount?: number
  answeredCount?: number
  endReason?: 'normal' | 'time_up' | 'user_ended' | 'usage_limit' | 'abandoned'
  /**
   * Per-question flag — true when the candidate's answer to that question
   * was cut off by the interview timer expiring (the 15s LISTENING grace
   * at useInterview.ts:397-403). G.12 will populate this; G.7 just
   * reserves the schema so later writes don't need a migration.
   */
  wasTruncatedByTimer?: boolean[]

  createdAt: Date
  updatedAt: Date
}

const InterviewSessionSchema = new Schema<IInterviewSession>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', index: true },

    config: {
      role: { type: String, required: true },
      interviewType: { type: String, default: 'behavioral' },
      experience: { type: String, enum: ['0-2', '3-6', '7+'], required: true },
      duration: { type: Number, min: 5, max: 60, required: true },
    },

    // Document context (stored separately from config to keep config lightweight)
    jobDescription: { type: String },
    resumeText: { type: String },
    jdFileName: { type: String },
    resumeFileName: { type: String },

    status: {
      type: String,
      enum: ['created', 'in_progress', 'completed', 'abandoned'],
      default: 'created',
      index: true,
    },
    startedAt: { type: Date },
    completedAt: { type: Date },
    durationActualSeconds: { type: Number },
    interviewLatencyTelemetry: { type: Schema.Types.Mixed },

    transcript: { type: Schema.Types.Mixed, default: [] },
    evaluations: { type: Schema.Types.Mixed, default: [] },
    speechMetrics: { type: Schema.Types.Mixed, default: [] },
    feedback: { type: Schema.Types.Mixed },

    recordingUrl: { type: String },
    recordingSizeBytes: { type: Number },
    recordingR2Key: { type: String },

    // Screen recording (coding & system-design)
    screenRecordingR2Key: { type: String },
    screenRecordingSizeBytes: { type: Number },

    // Audio-only recording (used by Whisper to avoid 25MB Groq limit)
    audioRecordingR2Key: { type: String },
    audioRecordingSizeBytes: { type: Number },

    parsedJobDescription: { type: Schema.Types.Mixed },
    parsedResume: { type: Schema.Types.Mixed },
    persona: { type: String },

    resumeR2Key: { type: String },
    jdR2Key: { type: String },

    // Scoring dimensions used for this session
    scoringDimensions: { type: Schema.Types.Mixed },

    // Coding interview
    codingProblemId: { type: String },
    // Design interview
    designProblemId: { type: String },
    codeSubmissions: { type: Schema.Types.Mixed },
    codingClarifications: { type: Schema.Types.Mixed, default: [] },

    templateId: { type: Schema.Types.ObjectId, ref: 'InterviewTemplate' },
    candidateEmail: { type: String, lowercase: true },
    candidateName: { type: String },
    recruiterNotes: { type: String },

    // Invite verification (B2B)
    inviteTokenHash: { type: String },
    inviteTokenExpiry: { type: Date },

    // Consent
    consentedToRecording: { type: Boolean },
    consentedToAnalysis: { type: Boolean },

    // Privacy mode & research donation (per-session opt-in flags)
    privacyMode: { type: Boolean },
    researchDonation: { type: Boolean },

    // Sharing
    shareToken: { type: String, unique: true, sparse: true },
    isPublic: { type: Boolean, default: false },
    shareExpiresAt: { type: Date },

    // Multimodal analysis
    multimodalAnalysisId: { type: Schema.Types.ObjectId, ref: 'MultimodalAnalysis' },
    facialLandmarksR2Key: { type: String },

    // Live transcript with audio-timeline-relative word timestamps
    // (Deepgram-captured during the interview; skips post-hoc Whisper)
    liveTranscriptWords: { type: Schema.Types.Mixed },

    userAgent: { type: String },

    // Retake linkage — see interface comment. Both optional so existing
    // sessions (pre-change) remain valid without a migration.
    parentSessionId: { type: Schema.Types.ObjectId, ref: 'InterviewSession', index: true },
    retakeNumber: { type: Number, min: 1 },

    // G.7: session completion shape. See interface comment.
    plannedQuestionCount: { type: Number, min: 0 },
    answeredCount: { type: Number, min: 0 },
    endReason: {
      type: String,
      enum: ['normal', 'time_up', 'user_ended', 'usage_limit', 'abandoned'],
    },
    wasTruncatedByTimer: { type: [Boolean], default: undefined },

    // Pathway regeneration status — see interface comment for rationale.
    pathwayGenerationStatus: {
      type: String,
      enum: ['pending', 'running', 'succeeded', 'failed', 'skipped'],
    },
    pathwayGenerationError: { type: String, maxlength: 500 },
    pathwayGenerationStartedAt: { type: Date },
    pathwayGenerationCompletedAt: { type: Date },
    pathwayGenerationAttempts: { type: Number, min: 0, default: 0 },
    pathwayGenerationUseSynthesizedFeedback: { type: Boolean, default: false },
  },
  { timestamps: true }
)

InterviewSessionSchema.index({ userId: 1, createdAt: -1 })
InterviewSessionSchema.index({ organizationId: 1, createdAt: -1 })
InterviewSessionSchema.index({ organizationId: 1, candidateEmail: 1 })
InterviewSessionSchema.index({ status: 1, createdAt: -1 })
InterviewSessionSchema.index({ status: 1, 'config.role': 1, 'config.experience': 1 })
InterviewSessionSchema.index({ userId: 1, status: 1 })
// "Most recent completed session for this user" — used by the pathway
// next-action resolver (resolvePathwayNextHref) and /api/learn/pathway.
// Without completedAt in the index those queries filter on {userId,status}
// then sort completedAt in memory; this makes the sort index-backed.
InterviewSessionSchema.index({ userId: 1, status: 1, completedAt: -1 })
// Retake chain lookup — all retakes of a given root session
InterviewSessionSchema.index({ userId: 1, parentSessionId: 1 })

export const InterviewSession: Model<IInterviewSession> =
  mongoose.models.InterviewSession ||
  mongoose.model<IInterviewSession>('InterviewSession', InterviewSessionSchema)
