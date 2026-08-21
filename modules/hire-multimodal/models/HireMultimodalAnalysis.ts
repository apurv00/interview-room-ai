import mongoose, { Document, Model, Schema } from 'mongoose'
import type {
  FacialSegment,
  ProsodySegment,
} from '@shared/types/multimodal'

export const HIRE_MULTIMODAL_ANALYSIS_STATUSES = [
  'pending',
  'processing',
  'completed',
  'failed',
  'stale',
] as const
export type HireMultimodalAnalysisStatus =
  (typeof HIRE_MULTIMODAL_ANALYSIS_STATUSES)[number]

/** Automatic worker attempts before a recruiter may explicitly requeue. */
export const HIRE_MULTIMODAL_ANALYSIS_MAX_RETRY_ATTEMPTS = 3

export interface HireMultimodalAnalysisTimelineEvent {
  startMs: number
  endMs: number
  type: 'strength' | 'attention' | 'observation'
  signal: 'audio' | 'facial' | 'content' | 'fused'
  title: string
  description: string
  severity: 'positive' | 'neutral' | 'attention'
  questionIndex?: number
}

export interface HireMultimodalAnalysisSummary {
  bodyLanguageScore: number | null
  eyeContactScore: number | null
  deliverySummary: string
  reviewerNotes: string[]
  topMoments: HireMultimodalAnalysisTimelineEvent[]
  attentionMoments: HireMultimodalAnalysisTimelineEvent[]
}

interface HireMultimodalAnalysisTranscriptEntry {
  speaker: 'interviewer' | 'candidate'
  text: string
  timestampMs: number
  questionIndex?: number | null
}

interface HireMultimodalAnalysisLiveWord {
  word: string
  startMs: number
  endMs: number
  confidence: number
}

/**
 * A control-owned, recruiter-only analysis of a recorded Hire attempt. It is
 * intentionally not a result/ranking model: overall JD scoring remains in
 * HireInterviewResult and this record never feeds that calculation.
 */
export interface IHireMultimodalAnalysis extends Document {
  _id: mongoose.Types.ObjectId
  workspaceId: mongoose.Types.ObjectId
  applicationId: mongoose.Types.ObjectId
  jobId: mongoose.Types.ObjectId
  candidateId: mongoose.Types.ObjectId
  roundId: mongoose.Types.ObjectId
  attemptId: mongoose.Types.ObjectId
  runtimeSessionId: mongoose.Types.ObjectId
  revision: number
  eventId: string
  inputDigest: string
  consentVersion: string
  policyVersion: string
  capturedAt: Date
  durationMs: number
  facialFrameCount?: number
  landmarksAssetId: mongoose.Types.ObjectId
  inputTranscript: HireMultimodalAnalysisTranscriptEntry[]
  liveTranscriptWords: HireMultimodalAnalysisLiveWord[]
  status: HireMultimodalAnalysisStatus
  processingLeaseExpiresAt?: Date
  /** Bounded automatic recovery after a transient worker/provider failure. */
  retryAttemptCount: number
  retryAt?: Date
  prosodySegments?: ProsodySegment[]
  facialSegments?: FacialSegment[]
  facialTimeseries?: FacialSegment[]
  timeline?: HireMultimodalAnalysisTimelineEvent[]
  summary?: HireMultimodalAnalysisSummary
  /** Supplemental model identifier, never the Mongoose document `model()` method. */
  modelName?: string
  inputTokens?: number
  outputTokens?: number
  errorCode?: string
  completedAt?: Date
  purgeEligibleAt?: Date
  purgeReason?: 'job_closed'
  createdAt: Date
  updatedAt: Date
}

const HireMultimodalAnalysisTimelineSchema = new Schema(
  {
    startMs: { type: Number, required: true, min: 0, max: 30 * 60 * 1_000 },
    endMs: { type: Number, required: true, min: 0, max: 30 * 60 * 1_000 },
    type: { type: String, enum: ['strength', 'attention', 'observation'], required: true },
    signal: { type: String, enum: ['audio', 'facial', 'content', 'fused'], required: true },
    title: { type: String, required: true, maxlength: 240 },
    description: { type: String, required: true, maxlength: 2_000 },
    severity: { type: String, enum: ['positive', 'neutral', 'attention'], required: true },
    questionIndex: { type: Number, min: 0, max: 500 },
  },
  { _id: false, strict: 'throw' },
)

const HireMultimodalAnalysisSummarySchema = new Schema(
  {
    bodyLanguageScore: { type: Number, min: 0, max: 100 },
    eyeContactScore: { type: Number, min: 0, max: 100 },
    deliverySummary: { type: String, required: true, maxlength: 2_000 },
    reviewerNotes: { type: [String], required: true, default: [], maxlength: 12 },
    topMoments: { type: [HireMultimodalAnalysisTimelineSchema], required: true, default: [] },
    attentionMoments: { type: [HireMultimodalAnalysisTimelineSchema], required: true, default: [] },
  },
  { _id: false, strict: 'throw' },
)

const HireMultimodalAnalysisTranscriptEntrySchema = new Schema<
  HireMultimodalAnalysisTranscriptEntry
>(
  {
    speaker: { type: String, enum: ['interviewer', 'candidate'], required: true },
    text: { type: String, required: true, maxlength: 20_000 },
    timestampMs: { type: Number, required: true, min: 0, max: 30 * 60 * 1_000 },
    questionIndex: { type: Number, min: 0, max: 500, default: undefined },
  },
  { _id: false, strict: 'throw' },
)

const HireMultimodalAnalysisLiveWordSchema = new Schema<
  HireMultimodalAnalysisLiveWord
>(
  {
    word: { type: String, required: true, maxlength: 200 },
    startMs: { type: Number, required: true, min: 0, max: 30 * 60 * 1_000 },
    endMs: { type: Number, required: true, min: 0, max: 30 * 60 * 1_000 },
    confidence: { type: Number, required: true, min: 0, max: 1 },
  },
  { _id: false, strict: 'throw' },
)

const HireMultimodalAnalysisSchema = new Schema<IHireMultimodalAnalysis>(
  {
    workspaceId: { type: Schema.Types.ObjectId, required: true, immutable: true },
    applicationId: { type: Schema.Types.ObjectId, required: true, immutable: true },
    jobId: { type: Schema.Types.ObjectId, required: true, immutable: true },
    candidateId: { type: Schema.Types.ObjectId, required: true, immutable: true },
    roundId: { type: Schema.Types.ObjectId, required: true, immutable: true },
    attemptId: { type: Schema.Types.ObjectId, required: true, immutable: true },
    runtimeSessionId: { type: Schema.Types.ObjectId, required: true, immutable: true },
    revision: { type: Number, required: true, min: 1, max: 10, immutable: true },
    eventId: { type: String, required: true, match: /^[a-f0-9]{64}$/, immutable: true },
    inputDigest: { type: String, required: true, match: /^[a-f0-9]{64}$/, immutable: true },
    consentVersion: { type: String, required: true, maxlength: 80, immutable: true },
    policyVersion: { type: String, required: true, maxlength: 80, immutable: true },
    capturedAt: { type: Date, required: true, immutable: true },
    durationMs: { type: Number, required: true, min: 1, max: 30 * 60 * 1_000, immutable: true },
    facialFrameCount: { type: Number, min: 0, max: 10_000 },
    landmarksAssetId: { type: Schema.Types.ObjectId, ref: 'HireMediaAsset', required: true, immutable: true },
    inputTranscript: { type: [HireMultimodalAnalysisTranscriptEntrySchema], required: true, immutable: true },
    liveTranscriptWords: { type: [HireMultimodalAnalysisLiveWordSchema], required: true, immutable: true },
    status: { type: String, enum: HIRE_MULTIMODAL_ANALYSIS_STATUSES, required: true },
    processingLeaseExpiresAt: { type: Date },
    retryAttemptCount: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
      max: HIRE_MULTIMODAL_ANALYSIS_MAX_RETRY_ATTEMPTS,
    },
    retryAt: { type: Date },
    prosodySegments: { type: [Schema.Types.Mixed] },
    facialSegments: { type: [Schema.Types.Mixed] },
    facialTimeseries: { type: [Schema.Types.Mixed] },
    timeline: { type: [HireMultimodalAnalysisTimelineSchema] },
    summary: { type: HireMultimodalAnalysisSummarySchema },
    modelName: { type: String, maxlength: 160 },
    inputTokens: { type: Number, min: 0 },
    outputTokens: { type: Number, min: 0 },
    errorCode: { type: String, maxlength: 160 },
    completedAt: { type: Date },
    purgeEligibleAt: { type: Date },
    purgeReason: { type: String, enum: ['job_closed'] },
  },
  { timestamps: true, strict: 'throw' },
)

HireMultimodalAnalysisSchema.index(
  {
    workspaceId: 1,
    applicationId: 1,
    roundId: 1,
    attemptId: 1,
    runtimeSessionId: 1,
    revision: 1,
  },
  { unique: true },
)
HireMultimodalAnalysisSchema.index({ eventId: 1 }, { unique: true })
HireMultimodalAnalysisSchema.index({ workspaceId: 1, candidateId: 1, capturedAt: -1 })
HireMultimodalAnalysisSchema.index({ workspaceId: 1, jobId: 1, purgeEligibleAt: 1 })
HireMultimodalAnalysisSchema.index({ workspaceId: 1, status: 1, retryAt: 1, createdAt: 1 })

export const HireMultimodalAnalysis: Model<IHireMultimodalAnalysis> =
  mongoose.models.HireMultimodalAnalysis ||
  mongoose.model<IHireMultimodalAnalysis>(
    'HireMultimodalAnalysis',
    HireMultimodalAnalysisSchema,
  )
