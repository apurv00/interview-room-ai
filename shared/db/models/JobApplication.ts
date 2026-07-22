import mongoose, { Schema, Document, Model } from 'mongoose'
import type { ModelExecutionProvenance } from '@shared/services/scoringProvenance'
import { MAX_JOB_TAILORED_TEXT_CHARS } from '@shared/jobsContract'

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
  | 'interviewed' | 'offer' | 'rejected' | 'ghosted' | 'withdrawn'

export const JOB_APPLICATION_STATUSES: JobApplicationStatus[] = [
  'saved', 'apply_clicked', 'applied', 'interview_scheduled',
  'interviewed', 'offer', 'rejected', 'ghosted', 'withdrawn',
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
  /** User-authored coarse window. It never authorizes exact-date plans or reminders. */
  interviewDatePreference?: 'this-week' | 'next-week' | 'unknown'
  outcome: {
    passedScreen?: boolean
    interviewRounds?: number
    offerReceived?: boolean
    latestResult?: 'advanced' | 'waiting' | 'rejected' | 'offer'
    latestRound?: number
    latestReportedAt?: Date
    /** Monotonic optimistic token for lifecycle/outcome writes. */
    revision?: number
    lastInterviewedAt?: Date
    lastDeferredRound?: number
    lastAskedAt?: Date
    /** Anti-nag budget — outcome prompts stop when this runs out. */
    askCount: number
  }
  tailoredVersion?: {
    /** Absent for paste/upload-sourced tailors — only saved-resume sources have one. */
    sourceResumeId?: string
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
  /** Opaque ids observed by click telemetry. These are not proof that the
   * server opened the external destination. */
  clickedApplyOptionIds: string[]
  /** Trusted server-side Apply opens. A report is authorized only by a recent
   * attempt for the exact current subject, generation, and incident. */
  applyOpenAttempts: Array<{
    optionId: string
    subject: string
    generation: string
    incidentVersion: number
    openedAt: Date
  }>
  brokenLinkReports: Array<{
    /** Absent only on legacy reports written before canonical option ids. */
    optionId?: string
    url: string
    tier?: string
    reportedAt: Date
    subject?: string
    generation?: string
    incidentVersion?: number
    disposition?: 'pending-verification' | 'crowd-demoted' | 'machine-demoted'
  }>
  /** Historical attendance links, including rows created before signed Jobs
   * handoffs existed. Kept for operational/backcompat consumers only. */
  practiceSessionIds: mongoose.Types.ObjectId[]
  /** Sessions whose Jobs handoff was verified server-side (v1). Only this
   * array may drive candidate-facing evidence counts. */
  verifiedPracticeSessionIds?: mongoose.Types.ObjectId[]
  /** Denormalized readiness snapshot (READINESS.md §1 — recomputed by the
   *  attribution worker at evidence-write time; consumers NEVER recompute
   *  per-request). Absent until the first attribution lands. */
  readiness?: {
    /** Missing on legacy snapshots, which consumers must not surface. */
    handoffVersion?: 1
    band: 'none' | 'building' | 'practiced' | 'strong-evidence'
    sessions: number
    practicedCount: number
    mustHaveTotal: number
    quality: number
    strongCoverage: number
    xrayHash: string
    scoringEpoch: string
    /** Exact execution facts represented by this snapshot. Absence means a
     * legacy snapshot that must not surface or survive the repair gate. */
    provenance?: {
      schemaVersion: 1
      scoring: ModelExecutionProvenance[]
      attribution: ModelExecutionProvenance[]
    }
    at: Date
  }
  /** Optimistic fence for denormalized readiness writes. Snapshot publishers
   * increment it atomically; evidence deletion increments it to invalidate
   * any writer that read the pre-deletion evidence set. */
  readinessRevision: number
  ghostSuggestedAt?: Date
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

const ReadinessProvenanceSchema = new Schema(
  {
    schemaVersion: { type: Number, enum: [1], required: true },
    scoring: { type: [ModelExecutionProvenanceSchema], required: true },
    attribution: { type: [ModelExecutionProvenanceSchema], required: true },
  },
  { _id: false },
)

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
    interviewDatePreference: { type: String, enum: ['this-week', 'next-week', 'unknown'] },
    outcome: {
      passedScreen: { type: Boolean },
      interviewRounds: { type: Number, min: 0, default: 0 },
      offerReceived: { type: Boolean },
      latestResult: { type: String, enum: ['advanced', 'waiting', 'rejected', 'offer'] },
      latestRound: { type: Number, min: 1 },
      latestReportedAt: { type: Date },
      revision: { type: Number, min: 0, default: 0 },
      lastInterviewedAt: { type: Date },
      lastDeferredRound: { type: Number, min: 1 },
      lastAskedAt: { type: Date },
      askCount: { type: Number, default: 0 },
    },
    tailoredVersion: {
      type: new Schema(
        {
          sourceResumeId: { type: String },
          tailoredText: { type: String, required: true, maxlength: MAX_JOB_TAILORED_TEXT_CHARS },
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
    clickedApplyOptionIds: {
      type: [{ type: String, maxlength: 64 }],
      default: [],
    },
    applyOpenAttempts: {
      type: [
        new Schema(
          {
            optionId: { type: String, required: true, maxlength: 64 },
            subject: { type: String, required: true, maxlength: 64 },
            generation: { type: String, required: true, maxlength: 64 },
            incidentVersion: { type: Number, required: true, min: 1 },
            openedAt: { type: Date, required: true },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
    brokenLinkReports: {
      type: [
        new Schema(
          {
            optionId: { type: String, maxlength: 64 },
            url: { type: String, required: true, maxlength: 2000 },
            tier: { type: String, maxlength: 40 },
            reportedAt: { type: Date, required: true },
            subject: { type: String, maxlength: 64 },
            generation: { type: String, maxlength: 64 },
            incidentVersion: { type: Number, min: 1 },
            disposition: {
              type: String,
              enum: ['pending-verification', 'crowd-demoted', 'machine-demoted'],
            },
          },
          { _id: false }
        ),
      ],
      default: [],
    },
    practiceSessionIds: { type: [Schema.Types.ObjectId], ref: 'InterviewSession', default: [] },
    verifiedPracticeSessionIds: { type: [Schema.Types.ObjectId], ref: 'InterviewSession', default: [] },
    readiness: {
      type: new Schema(
        {
          handoffVersion: { type: Number, enum: [1] },
          band: { type: String, enum: ['none', 'building', 'practiced', 'strong-evidence'], required: true },
          sessions: { type: Number, required: true, min: 0 },
          practicedCount: { type: Number, required: true, min: 0 },
          mustHaveTotal: { type: Number, required: true, min: 0 },
          quality: { type: Number, required: true, min: 0, max: 100 },
          strongCoverage: { type: Number, required: true, min: 0, max: 1 },
          xrayHash: { type: String, required: true },
          scoringEpoch: { type: String, required: true },
          provenance: { type: ReadinessProvenanceSchema },
          at: { type: Date, required: true },
        },
        { _id: false }
      ),
      required: false,
    },
    readinessRevision: { type: Number, default: 0, min: 0 },
    ghostSuggestedAt: { type: Date },
  },
  { timestamps: true }
)

// Internal transaction-conflict token for authority-bound readers that must
// serialize against tracker deletion without changing candidate-visible
// status, history, readiness, or updatedAt.
JobApplicationSchema.add({
  derivedAuthorityRevision: { type: Number, default: 0, select: false },
} as never)

// One application row per user per posting — double-saves collapse.
JobApplicationSchema.index({ userId: 1, jobPostingId: 1 }, { unique: true })
// Tracker list: grouped by status, most recently touched first.
JobApplicationSchema.index({ userId: 1, status: 1, updatedAt: -1 })
// Global scheduled work: confirmed applications that crossed the 35-day
// response threshold. The partial predicate keeps clicks and terminal rows
// out of the index entirely.
JobApplicationSchema.index(
  { status: 1, appliedAt: 1, _id: 1 },
  {
    name: 'jobs_tracker_status_sweep_due',
    partialFilterExpression: { status: 'applied', appliedAt: { $type: 'date' } },
  },
)

export const JobApplication: Model<IJobApplication> =
  mongoose.models.JobApplication || mongoose.model<IJobApplication>('JobApplication', JobApplicationSchema)
