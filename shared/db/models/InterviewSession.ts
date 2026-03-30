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

  resumeR2Key?: string
  jdR2Key?: string

  templateId?: mongoose.Types.ObjectId
  candidateEmail?: string
  candidateName?: string
  recruiterNotes?: string

  // Sharing
  shareToken?: string
  isPublic?: boolean
  shareExpiresAt?: Date

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
      interviewType: { type: String, default: 'screening' },
      experience: { type: String, enum: ['0-2', '3-6', '7+'], required: true },
      duration: { type: Number, enum: [5, 10, 20], required: true },
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

    parsedJobDescription: { type: Schema.Types.Mixed },
    persona: { type: String },

    resumeR2Key: { type: String },
    jdR2Key: { type: String },

    templateId: { type: Schema.Types.ObjectId, ref: 'InterviewTemplate' },
    candidateEmail: { type: String, lowercase: true },
    candidateName: { type: String },
    recruiterNotes: { type: String },

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
