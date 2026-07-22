import mongoose, { Schema, Document, Model } from 'mongoose'
import type { ModelExecutionProvenance } from '@shared/services/scoringProvenance'

/**
 * JobPracticeEvidence — per-answer → must-have attribution rows
 * (READINESS.md §1, PR-R1). Its OWN collection because replace-not-
 * duplicate needs a REAL unique index and array subdocs cannot carry one
 * (ServedProblem precedent; panel finding R12/R24).
 *
 * A row asserts: in `sessionId`, an answer scoring `answerScore` gave
 * `strength` evidence for requirement `requirementId` of the JD version
 * `xrayHash`. Rows never claim competence — strength is DEPTH of evidence;
 * quality lives in answerScore (row-level floor applied by the reader).
 * 'none' verdicts are never stored.
 */
export interface IJobPracticeEvidence extends Document {
  _id: mongoose.Types.ObjectId
  userId: mongoose.Types.ObjectId
  applicationId: mongoose.Types.ObjectId
  jobPostingId: mongoose.Types.ObjectId
  sessionId: mongoose.Types.ObjectId
  /** Missing means legacy/browser-attributed evidence. Such rows remain
   * exportable but are quarantined from readiness and evidence counts. */
  handoffVersion?: 1
  /** Full normalized SHA-256 from the verified Jobs session marker. */
  handoffJdHash?: string
  /** X-ray requirement id — bound to the parse of `xrayHash` (parse cache
   *  is first-write-wins per hash, so these ids are stable). */
  requirementId: string
  /** The JD version this evidence addressed (xrayHashOf == the jdHash
   *  vocabulary used by the ATS/tailor subdocs — never bodyHashOf). */
  xrayHash: string
  strength: 'strong' | 'partial'
  /** round(mean of the 4 universal dims), recomputed by the worker. */
  answerScore: number
  /** Exact scoring-execution fingerprint for attested rows. Historical
   * model-only values remain exportable but never enter readiness. */
  scoringEpoch: string
  provenance?: {
    schemaVersion: 1
    status: 'attested' | 'legacy-unverifiable'
    scoring?: ModelExecutionProvenance
    attribution?: ModelExecutionProvenance
    quarantineReason?: 'pre-provenance-contract'
    quarantinedAt?: Date
  }
  at: Date
  createdAt: Date
  updatedAt: Date
}

const ModelExecutionProvenanceSchema = new Schema(
  {
    schemaVersion: { type: Number, enum: [1], required: true },
    taskSlot: { type: String, required: true, maxlength: 100 },
    contractVersion: { type: String, required: true, maxlength: 100 },
    model: { type: String, required: true, maxlength: 200 },
    provider: { type: String, required: true, maxlength: 60 },
    usedFallback: { type: Boolean, required: true },
    attemptKind: { type: String, enum: ['primary', 'configured-fallback', 'task-default'], required: true },
    configDigest: { type: String, required: true, match: /^[a-f0-9]{64}$/ },
    fingerprint: { type: String, required: true, match: /^[a-f0-9]{64}$/ },
  },
  { _id: false },
)

const EvidenceProvenanceSchema = new Schema(
  {
    schemaVersion: { type: Number, enum: [1], required: true },
    status: { type: String, enum: ['attested', 'legacy-unverifiable'], required: true },
    scoring: { type: ModelExecutionProvenanceSchema },
    attribution: { type: ModelExecutionProvenanceSchema },
    quarantineReason: { type: String, enum: ['pre-provenance-contract'] },
    quarantinedAt: { type: Date },
  },
  { _id: false },
)

const JobPracticeEvidenceSchema = new Schema<IJobPracticeEvidence>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    applicationId: { type: Schema.Types.ObjectId, ref: 'JobApplication', required: true },
    jobPostingId: { type: Schema.Types.ObjectId, ref: 'JobPosting', required: true },
    sessionId: { type: Schema.Types.ObjectId, ref: 'InterviewSession', required: true },
    handoffVersion: { type: Number, enum: [1] },
    handoffJdHash: { type: String, maxlength: 64 },
    requirementId: { type: String, required: true, maxlength: 120 },
    xrayHash: { type: String, required: true, maxlength: 64 },
    strength: { type: String, enum: ['strong', 'partial'], required: true },
    answerScore: { type: Number, required: true, min: 0, max: 100 },
    scoringEpoch: { type: String, required: true, maxlength: 120 },
    provenance: {
      type: EvidenceProvenanceSchema,
      validate: {
        validator(value: unknown) {
          if (value == null) return true
          const candidate = value as {
            status?: string
            scoring?: unknown
            attribution?: unknown
            quarantineReason?: string
            quarantinedAt?: Date
          }
          if (candidate.status === 'attested') {
            return !!candidate.scoring && !!candidate.attribution &&
              candidate.quarantineReason == null && candidate.quarantinedAt == null
          }
          if (candidate.status === 'legacy-unverifiable') {
            return candidate.scoring == null && candidate.attribution == null &&
              candidate.quarantineReason === 'pre-provenance-contract' && !!candidate.quarantinedAt
          }
          return false
        },
        message: 'evidence provenance status and fields are inconsistent',
      },
    },
    at: { type: Date, required: true },
  },
  { timestamps: true }
)

// THE replace-not-duplicate guarantee (R12): re-attribution of a session
// upserts against this key; duplicate delivery cannot skew quality.
JobPracticeEvidenceSchema.index({ sessionId: 1, requirementId: 1, xrayHash: 1 }, { unique: true })
// Band computation reads by application; GDPR reads by user/session.
JobPracticeEvidenceSchema.index({ applicationId: 1, xrayHash: 1 })
JobPracticeEvidenceSchema.index({ userId: 1 })

export const JobPracticeEvidence: Model<IJobPracticeEvidence> =
  mongoose.models.JobPracticeEvidence ||
  mongoose.model<IJobPracticeEvidence>('JobPracticeEvidence', JobPracticeEvidenceSchema)
