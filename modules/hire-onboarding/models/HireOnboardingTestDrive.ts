import mongoose, { Document, Model, Schema } from 'mongoose'

export const HIRE_ONBOARDING_TEST_DRIVE_COLLECTION = 'hireonboardingtestdrives'

export const HIRE_ONBOARDING_TEST_DRIVE_STATES = [
  'provisioning',
  'ready',
  'removed',
] as const

export type HireOnboardingTestDriveState =
  (typeof HIRE_ONBOARDING_TEST_DRIVE_STATES)[number]

/**
 * Hire-only marker for the deliberately synthetic graph created by the
 * “Interview yourself” test drive. The normal job, candidate, application,
 * and round schemas remain unmodified; aggregate readers explicitly join this
 * coordinate record and exclude it before producing operational metrics.
 *
 * No raw invite value, capability, delivery payload, candidate email, or
 * generic audit payload belongs here. The four opaque coordinates and the
 * bounded member snapshots are sufficient for later cleanup and audit views.
 */
export interface IHireOnboardingTestDrive extends Document {
  _id: mongoose.Types.ObjectId
  workspaceId: mongoose.Types.ObjectId
  issuedByMemberId: mongoose.Types.ObjectId
  issuedByName: string
  operationId: string
  label: 'Interview yourself'
  state: HireOnboardingTestDriveState
  /** One active test drive per member; also backs the partial unique index. */
  active: boolean
  /** Durable aggregate exclusion marker, retained through member removal. */
  excludeFromAggregates: true
  jobId: mongoose.Types.ObjectId
  candidateId: mongoose.Types.ObjectId
  applicationId: mongoose.Types.ObjectId
  roundId?: mongoose.Types.ObjectId
  inviteReleasedAt?: Date
  cleanupAfter: Date
  /** Bounded lifecycle-worker lease; never exposed in member or audit DTOs. */
  cleanupClaimToken?: string
  cleanupClaimedAt?: Date
  cleanupLeaseExpiresAt?: Date
  cleanupAttempts?: number
  cleanupLastError?: string
  removedAt?: Date
  removedByMemberId?: mongoose.Types.ObjectId
  removedByName?: string
  createdAt: Date
  updatedAt: Date
}

const HireOnboardingTestDriveSchema = new Schema<IHireOnboardingTestDrive>(
  {
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: 'HireWorkspace',
      required: true,
      immutable: true,
    },
    issuedByMemberId: {
      type: Schema.Types.ObjectId,
      ref: 'HireWorkspaceMember',
      required: true,
      immutable: true,
    },
    issuedByName: { type: String, required: true, trim: true, maxlength: 120, immutable: true },
    operationId: { type: String, required: true, trim: true, maxlength: 80, immutable: true },
    label: { type: String, enum: ['Interview yourself'], required: true, immutable: true },
    state: {
      type: String,
      enum: HIRE_ONBOARDING_TEST_DRIVE_STATES,
      required: true,
      default: 'provisioning',
    },
    active: { type: Boolean, required: true, default: true },
    excludeFromAggregates: {
      type: Boolean,
      required: true,
      default: true,
      immutable: true,
    },
    jobId: {
      type: Schema.Types.ObjectId,
      ref: 'HireJob',
      required: true,
      immutable: true,
    },
    candidateId: {
      type: Schema.Types.ObjectId,
      ref: 'HireCandidate',
      required: true,
      immutable: true,
    },
    applicationId: {
      type: Schema.Types.ObjectId,
      ref: 'HireApplication',
      required: true,
      immutable: true,
    },
    // Assigned once when the existing AI-round service creates or recovers the
    // normal invite. Service guards prevent reassignment after that handoff.
    roundId: { type: Schema.Types.ObjectId, ref: 'HireRound' },
    // This tracks that the first response was allowed to carry the raw invite;
    // it is deliberately a timestamp only, never the capability itself.
    inviteReleasedAt: { type: Date },
    cleanupAfter: { type: Date, required: true },
    // These fields make the eventual graph teardown recoverable without
    // retaining any capability, delivery payload, candidate contact detail,
    // or generic audit body. Do not add an index here: rollout owns indexes
    // separately, and the existing workspace/cleanup/state index bounds the
    // recovery scan.
    cleanupClaimToken: { type: String, maxlength: 80 },
    cleanupClaimedAt: { type: Date },
    cleanupLeaseExpiresAt: { type: Date },
    cleanupAttempts: { type: Number, min: 0 },
    cleanupLastError: { type: String, maxlength: 120 },
    removedAt: { type: Date },
    removedByMemberId: { type: Schema.Types.ObjectId, ref: 'HireWorkspaceMember' },
    removedByName: { type: String, trim: true, maxlength: 120 },
  },
  {
    collection: HIRE_ONBOARDING_TEST_DRIVE_COLLECTION,
    timestamps: true,
  },
)

// Operation retries are scoped to the issuing Hire member and workspace.
HireOnboardingTestDriveSchema.index(
  { workspaceId: 1, issuedByMemberId: 1, operationId: 1 },
  { unique: true },
)
// A member gets at most one live practice graph. Removed records remain as
// exclusion markers until lifecycle cleanup removes the full graph safely.
HireOnboardingTestDriveSchema.index(
  { workspaceId: 1, issuedByMemberId: 1, active: 1 },
  { unique: true, partialFilterExpression: { active: true } },
)
HireOnboardingTestDriveSchema.index({ workspaceId: 1, cleanupAfter: 1, state: 1 })
HireOnboardingTestDriveSchema.index({ workspaceId: 1, applicationId: 1, excludeFromAggregates: 1 })
HireOnboardingTestDriveSchema.index({ workspaceId: 1, jobId: 1, excludeFromAggregates: 1 })
HireOnboardingTestDriveSchema.index({ workspaceId: 1, candidateId: 1, excludeFromAggregates: 1 })
HireOnboardingTestDriveSchema.index({ workspaceId: 1, roundId: 1, excludeFromAggregates: 1 })

export const HireOnboardingTestDrive: Model<IHireOnboardingTestDrive> =
  mongoose.models.HireOnboardingTestDrive ||
  mongoose.model<IHireOnboardingTestDrive>(
    'HireOnboardingTestDrive',
    HireOnboardingTestDriveSchema,
  )
