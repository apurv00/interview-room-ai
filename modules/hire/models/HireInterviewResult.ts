import mongoose, { Document, Model, Schema } from 'mongoose'

export type HireEvidenceType =
  | 'transcript_span'
  | 'recording_range'
  | 'integrity_observation'
  | 'identity_photo'

export interface HireEvidenceRef {
  id: string
  type: HireEvidenceType
  attemptId: string
  questionId?: string
  transcriptStart?: number
  transcriptEnd?: number
  /** Exact, bounded text copied from the immutable ingested transcript span. */
  transcriptExcerpt?: string
  startMs?: number
  endMs?: number
  mediaAssetId?: string
}

export interface HireNumericSummary {
  overallScore: number | null
  dimensions: Array<{ key: string; score: number | null }>
}

export interface HireAssessmentProjection {
  overallScore: number | null
  overallEvidenceIds: string[]
  recommendation?: string
  confidence?: string
  dimensions: Array<{
    key: string
    label: string
    score: number | null
    evidenceIds: string[]
  }>
  findings: Array<{
    kind: 'strength' | 'gap'
    text: string
    evidenceIds: string[]
  }>
  questions: Array<{
    questionId: string
    index: number
    prompt: string
    answer?: string
    score: number | null
    evidenceIds: string[]
    questionStartedMs?: number
    answerStartedMs?: number
    answerEndedMs?: number
  }>
}

export interface IHireInterviewResult extends Document {
  _id: mongoose.Types.ObjectId
  workspaceId: mongoose.Types.ObjectId
  applicationId: mongoose.Types.ObjectId
  jobId: mongoose.Types.ObjectId
  candidateId: mongoose.Types.ObjectId
  roundId: mongoose.Types.ObjectId
  attemptId: mongoose.Types.ObjectId
  adapterVersion: string
  engineContractVersion: string
  rawEngineOutput?: unknown
  rawDigest: string
  numericSummary: HireNumericSummary
  projection?: HireAssessmentProjection
  evidenceIndex?: HireEvidenceRef[]
  completedAt: Date
  piiPurgedAt?: Date
  createdAt: Date
  updatedAt: Date
}

const HireInterviewResultSchema = new Schema<IHireInterviewResult>(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: 'HireWorkspace', required: true, immutable: true },
    applicationId: { type: Schema.Types.ObjectId, ref: 'HireApplication', required: true, immutable: true },
    jobId: { type: Schema.Types.ObjectId, ref: 'HireJob', required: true, immutable: true },
    candidateId: { type: Schema.Types.ObjectId, ref: 'HireCandidate', required: true, immutable: true },
    roundId: { type: Schema.Types.ObjectId, ref: 'HireRound', required: true, immutable: true },
    attemptId: { type: Schema.Types.ObjectId, ref: 'HireInterviewAttempt', required: true, immutable: true },
    adapterVersion: { type: String, required: true, immutable: true, maxlength: 80 },
    engineContractVersion: { type: String, required: true, immutable: true, maxlength: 80 },
    rawEngineOutput: { type: Schema.Types.Mixed },
    rawDigest: { type: String, required: true, immutable: true, match: /^[a-f0-9]{64}$/ },
    numericSummary: { type: Schema.Types.Mixed, required: true },
    projection: { type: Schema.Types.Mixed },
    evidenceIndex: { type: [Schema.Types.Mixed], default: undefined },
    completedAt: { type: Date, required: true, immutable: true },
    piiPurgedAt: { type: Date },
  },
  { timestamps: true }
)

HireInterviewResultSchema.index(
  { workspaceId: 1, applicationId: 1, roundId: 1, attemptId: 1 },
  { unique: true }
)
HireInterviewResultSchema.index({ workspaceId: 1, candidateId: 1, completedAt: -1 })

export const HireInterviewResult: Model<IHireInterviewResult> =
  mongoose.models.HireInterviewResult ||
  mongoose.model<IHireInterviewResult>('HireInterviewResult', HireInterviewResultSchema)
