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

  // Persona
  persona?: string

  status: SessionStatus
  startedAt?: Date
  completedAt?: Date
  durationActualSeconds?: number

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

  userAgent?: string

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

    userAgent: { type: String },
  },
  { timestamps: true }
)

InterviewSessionSchema.index({ userId: 1, createdAt: -1 })
InterviewSessionSchema.index({ organizationId: 1, createdAt: -1 })
InterviewSessionSchema.index({ organizationId: 1, candidateEmail: 1 })
InterviewSessionSchema.index({ status: 1, createdAt: -1 })
InterviewSessionSchema.index({ status: 1, 'config.role': 1, 'config.experience': 1 })
InterviewSessionSchema.index({ userId: 1, status: 1 })

export const InterviewSession: Model<IInterviewSession> =
  mongoose.models.InterviewSession ||
  mongoose.model<IInterviewSession>('InterviewSession', InterviewSessionSchema)
