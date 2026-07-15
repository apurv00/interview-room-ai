import mongoose, { Schema, Document, Model } from 'mongoose'

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
  /** X-ray requirement id — bound to the parse of `xrayHash` (parse cache
   *  is first-write-wins per hash, so these ids are stable). */
  requirementId: string
  /** The JD version this evidence addressed (xrayHashOf == the jdHash
   *  vocabulary used by the ATS/tailor subdocs — never bodyHashOf). */
  xrayHash: string
  strength: 'strong' | 'partial'
  /** round(mean of the 4 universal dims), recomputed by the worker. */
  answerScore: number
  /** The evaluate-answer slot's model at ATTRIBUTION time — bands count
   *  only current-epoch rows (panel finding R8). Not read per-evaluation:
   *  AnswerEvaluation never persists its judge model (Codex #538 P1);
   *  see currentScoringEpoch in evidenceAttributionJob. */
  scoringEpoch: string
  at: Date
  createdAt: Date
  updatedAt: Date
}

const JobPracticeEvidenceSchema = new Schema<IJobPracticeEvidence>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    applicationId: { type: Schema.Types.ObjectId, ref: 'JobApplication', required: true },
    jobPostingId: { type: Schema.Types.ObjectId, ref: 'JobPosting', required: true },
    sessionId: { type: Schema.Types.ObjectId, ref: 'InterviewSession', required: true },
    requirementId: { type: String, required: true, maxlength: 120 },
    xrayHash: { type: String, required: true, maxlength: 64 },
    strength: { type: String, enum: ['strong', 'partial'], required: true },
    answerScore: { type: Number, required: true, min: 0, max: 100 },
    scoringEpoch: { type: String, required: true, maxlength: 120 },
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
