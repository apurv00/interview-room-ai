import mongoose, { Schema, Document, Model } from 'mongoose'
import type {
  AnalysisStatus,
  WhisperSegment,
  ProsodySegment,
  FacialSegment,
  TimelineEvent,
  FusionSummary,
} from '@shared/types/multimodal'

export interface IMultimodalAnalysis extends Document {
  _id: mongoose.Types.ObjectId

  sessionId: mongoose.Types.ObjectId
  userId: mongoose.Types.ObjectId
  status: AnalysisStatus

  // Whisper output
  whisperTranscript?: WhisperSegment[]

  // Derived audio features
  prosodySegments?: ProsodySegment[]

  // Facial pipeline output
  facialFramesR2Key?: string
  facialSegments?: FacialSegment[]

  // Fusion output
  timeline?: TimelineEvent[]
  fusionSummary?: FusionSummary

  // Cost tracking
  whisperCostUsd?: number
  claudeCostUsd?: number
  totalCostUsd?: number
  processingDurationMs?: number

  // Coach notes (per-moment rewrite suggestions)
  coachNotes?: Array<{
    momentSec: number
    questionIndex: number
    originalText: string
    suggestion: string
    rewriteExample: string
    dimension: string
  }>

  error?: string
  completedAt?: Date

  createdAt: Date
  updatedAt: Date
}

const MultimodalAnalysisSchema = new Schema<IMultimodalAnalysis>(
  {
    sessionId: {
      type: Schema.Types.ObjectId,
      ref: 'InterviewSession',
      required: true,
      unique: true,
      index: true,
    },
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    status: {
      type: String,
      enum: ['pending', 'processing', 'completed', 'failed'],
      default: 'pending',
      index: true,
    },

    // Whisper output
    whisperTranscript: { type: Schema.Types.Mixed },

    // Derived audio features
    prosodySegments: { type: Schema.Types.Mixed },

    // Facial pipeline output
    facialFramesR2Key: { type: String },
    facialSegments: { type: Schema.Types.Mixed },

    // Fusion output
    timeline: { type: Schema.Types.Mixed },
    fusionSummary: { type: Schema.Types.Mixed },

    // Cost tracking
    whisperCostUsd: { type: Number },
    claudeCostUsd: { type: Number },
    totalCostUsd: { type: Number },
    processingDurationMs: { type: Number },

    // Coach notes
    coachNotes: [{
      momentSec: { type: Number, required: true },
      questionIndex: { type: Number },
      originalText: { type: String },
      suggestion: { type: String, required: true },
      rewriteExample: { type: String },
      dimension: { type: String },
    }],

    error: { type: String },
    completedAt: { type: Date },
  },
  { timestamps: true }
)

MultimodalAnalysisSchema.index({ userId: 1, createdAt: -1 })

export const MultimodalAnalysis: Model<IMultimodalAnalysis> =
  mongoose.models.MultimodalAnalysis ||
  mongoose.model<IMultimodalAnalysis>('MultimodalAnalysis', MultimodalAnalysisSchema)
