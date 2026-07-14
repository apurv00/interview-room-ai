import mongoose, { Schema, Document, Model } from 'mongoose'

/**
 * JobApplication — one user's relationship with one job posting
 * (PRODUCT_FLOW.md §2). The tracker's source of truth and the anchor for
 * the practice loop: `practiceSessionIds` ties job-attributed interview
 * sessions here, and all three 60-day verdict metrics read this model.
 *
 * Honesty invariants (ruling #12): `apply_clicked` (machine fact) and
 * `applied` (user claim) are distinct statuses, never conflated.
 * `ghosted` renders as "No response"; the status machine is LOOSE —
 * forward jumps, backward corrections, and ghosted/rejected recovery are
 * all legal; statusHistory is append-only.
 *
 * `jobSnapshot` survives the posting's close/purge (the tracker must not
 * lose rows when ingestion GCs a posting). Creation sets the posting's
 * `userReferenced` pin; ingestion ALSO re-derives the pin by scanning
 * JobApplication existence during GC — idempotent, immune to cascade drift.
 *
 * `tailoredVersion` lives HERE (latest-wins) and does NOT count against
 * the 3-resume cap — savedResumes is a doc-size bound on the curated
 * library; per-job volume belongs on the application record.
 */

export type JobApplicationStatus =
  | 'saved' | 'apply_clicked' | 'applied' | 'interview_scheduled'
  | 'offer' | 'rejected' | 'ghosted' | 'withdrawn'

export const JOB_APPLICATION_STATUSES: JobApplicationStatus[] = [
  'saved', 'apply_clicked', 'applied', 'interview_scheduled',
  'offer', 'rejected', 'ghosted', 'withdrawn',
]

export interface IJobApplication extends Document {
  _id: mongoose.Types.ObjectId
  userId: mongoose.Types.ObjectId
  jobPostingId: mongoose.Types.ObjectId
  jobSnapshot: {
    title: string
    company: string
    location?: string
    source?: string
    applyTierAtClick?: string
    applyUrlAtClick?: string
  }
  status: JobApplicationStatus
  statusHistory: Array<{ status: JobApplicationStatus; at: Date; source: 'user' | 'system' }>
  appliedAt?: Date
  appliedWith?: { resumeId?: string; wasTailored: boolean; tailoredFromResumeId?: string }
  interviewDate?: Date
  interviewDateConfidence?: 'exact' | 'week' | 'unknown'
  outcome: {
    passedScreen?: boolean
    interviewRounds?: number
    offerReceived?: boolean
    lastAskedAt?: Date
    /** Anti-nag budget — outcome prompts stop when this runs out. */
    askCount: number
  }
  tailoredVersion?: {
    sourceResumeId: string
    tailoredText: string
    structured?: unknown
    matchScore?: number
    addedKeywords: string[]
    missingKeywords: string[]
    jdHash: string
    createdAt: Date
  }
  /** Save-gated per-job ATS check result (founder decision 2026-07-12). */
  atsResult?: {
    score: number
    missingKeywords: string[]
    jdHash: string
    /** The result is for a (resume x JD) PAIR — a resume edit invalidates it
     *  exactly like a JD merge does (Codex on #521). */
    resumeHash?: string
    checkedAt: Date
  }
  /** Set when a background check is queued; cleared on completion/failure.
   *  Pending = atsRequestedAt set AND (no atsResult OR older checkedAt). */
  atsRequestedAt?: Date
  notes?: string
  brokenLinkReports: Array<{ url: string; reportedAt: Date }>
  practiceSessionIds: mongoose.Types.ObjectId[]
  ghostSuggestedAt?: Date
  createdAt: Date
  updatedAt: Date
}

const JobApplicationSchema = new Schema<IJobApplication>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    jobPostingId: { type: Schema.Types.ObjectId, ref: 'JobPosting', required: true },
    jobSnapshot: {
      title: { type: String, required: true, maxlength: 300 },
      company: { type: String, required: true, maxlength: 300 },
      location: { type: String, maxlength: 200 },
      source: { type: String, maxlength: 100 },
      applyTierAtClick: { type: String, maxlength: 40 },
      applyUrlAtClick: { type: String, maxlength: 2000 },
    },
    status: { type: String, enum: JOB_APPLICATION_STATUSES, default: 'saved' },
    statusHistory: {
      type: [
        new Schema(
          {
            status: { type: String, enum: JOB_APPLICATION_STATUSES, required: true },
            at: { type: Date, required: true },
            source: { type: String, enum: ['user', 'system'], required: true },
          },
          { _id: false }
        ),
      ],
      default: [],
    },
    appliedAt: { type: Date },
    appliedWith: {
      type: new Schema(
        {
          resumeId: { type: String },
          wasTailored: { type: Boolean, required: true },
          tailoredFromResumeId: { type: String },
        },
        { _id: false }
      ),
    },
    interviewDate: { type: Date },
    interviewDateConfidence: { type: String, enum: ['exact', 'week', 'unknown'] },
    outcome: {
      passedScreen: { type: Boolean },
      interviewRounds: { type: Number, min: 0 },
      offerReceived: { type: Boolean },
      lastAskedAt: { type: Date },
      askCount: { type: Number, default: 0 },
    },
    tailoredVersion: {
      type: new Schema(
        {
          sourceResumeId: { type: String, required: true },
          tailoredText: { type: String, required: true, maxlength: 60000 },
          structured: { type: Schema.Types.Mixed },
          matchScore: { type: Number, min: 0, max: 100 },
          addedKeywords: { type: [String], default: [] },
          missingKeywords: { type: [String], default: [] },
          jdHash: { type: String, required: true },
          createdAt: { type: Date, required: true },
        },
        { _id: false }
      ),
    },
    atsResult: {
      type: new Schema(
        {
          score: { type: Number, min: 0, max: 100, required: true },
          missingKeywords: { type: [String], default: [] },
          jdHash: { type: String, required: true },
          resumeHash: { type: String },
          checkedAt: { type: Date, required: true },
        },
        { _id: false }
      ),
    },
    atsRequestedAt: { type: Date },
    notes: { type: String, maxlength: 5000 },
    brokenLinkReports: {
      type: [
        new Schema(
          { url: { type: String, required: true, maxlength: 2000 }, reportedAt: { type: Date, required: true } },
          { _id: false }
        ),
      ],
      default: [],
    },
    practiceSessionIds: { type: [Schema.Types.ObjectId], ref: 'InterviewSession', default: [] },
    ghostSuggestedAt: { type: Date },
  },
  { timestamps: true }
)

// One application row per user per posting — double-saves collapse.
JobApplicationSchema.index({ userId: 1, jobPostingId: 1 }, { unique: true })
// Tracker list: grouped by status, most recently touched first.
JobApplicationSchema.index({ userId: 1, status: 1, updatedAt: -1 })

export const JobApplication: Model<IJobApplication> =
  mongoose.models.JobApplication || mongoose.model<IJobApplication>('JobApplication', JobApplicationSchema)
