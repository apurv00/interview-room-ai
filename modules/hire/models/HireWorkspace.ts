import mongoose, { Schema, Document, Model } from 'mongoose'

/**
 * How candidates verify themselves on an AI-interview invite link — the
 * company's choice (founder decision, 2026-08-09):
 *   'magic_link' — possession of the emailed link is the authentication;
 *                  consent screen → straight into the interview.
 *   'otp'        — additionally proves CURRENT mailbox control: a 6-digit
 *                  code is emailed to the candidate's address on record.
 * The mode is snapshotted onto each round at send time, so flipping the
 * setting never changes the semantics of links already in candidates' inboxes.
 */
export const GUEST_AUTH_MODES = ['magic_link', 'otp'] as const
export type GuestAuthMode = (typeof GUEST_AUTH_MODES)[number]

export const HIRE_WORKSPACE_LIFECYCLE_STATES = ['active', 'deletion_pending'] as const
export type HireWorkspaceLifecycleState = (typeof HIRE_WORKSPACE_LIFECYCLE_STATES)[number]

export const HIRE_WORKSPACE_PURGE_STATES = ['pending', 'claimed', 'failed'] as const
export type HireWorkspacePurgeState = (typeof HIRE_WORKSPACE_PURGE_STATES)[number]

export interface IHireWorkspaceLifecycleEvent {
  type: 'deletion_scheduled' | 'deletion_cancelled'
  from: HireWorkspaceLifecycleState
  to: HireWorkspaceLifecycleState
  actorMemberId: mongoose.Types.ObjectId
  actorName: string
  operationId: string
  at: Date
}

export interface IHireWorkspaceAdminTransferEvent {
  fromMemberId: mongoose.Types.ObjectId
  toMemberId: mongoose.Types.ObjectId
  actorName: string
  operationId: string
  at: Date
}

/**
 * IPG Hire v2 workspace — one workspace = one company (build plan §Permission
 * model). Flat permissions: exactly one admin role distinction, held on the
 * member row (HireWorkspaceMember.role), not here. Every other hire table is
 * keyed by workspaceId; this collection is the tenancy root.
 */
export interface IHireWorkspace extends Document {
  _id: mongoose.Types.ObjectId
  name: string
  companyBlurb?: string
  guestAuthMode: GuestAuthMode
  lifecycleState: HireWorkspaceLifecycleState
  /** Serializes admin transfer against lifecycle actions. */
  authorityVersion: number
  /** Transactional write conflict target for Hire-owned personal-data writes. */
  writeFenceVersion: number
  /**
   * Invalidates immutable aggregate snapshots when a candidate becomes
   * privacy-pending or is anonymized. Aggregate workers capture and match
   * this value at their exact provider-authorization boundary.
   */
  privacyAggregateFenceVersion: number
  deletedAt?: Date
  purgeAfter?: Date
  deletedByMemberId?: mongoose.Types.ObjectId
  deletedByName?: string
  /** Durable worker lease. There is intentionally no TTL on the workspace root. */
  purgeState?: HireWorkspacePurgeState
  purgeClaimToken?: string
  purgeLeaseExpiresAt?: Date
  purgeAttempts?: number
  purgeLastError?: string
  lifecycleEvents: IHireWorkspaceLifecycleEvent[]
  adminTransferEvents: IHireWorkspaceAdminTransferEvent[]
  createdBy: mongoose.Types.ObjectId
  createdAt: Date
  updatedAt: Date
}

const HireWorkspaceLifecycleEventSchema = new Schema<IHireWorkspaceLifecycleEvent>(
  {
    type: {
      type: String,
      enum: ['deletion_scheduled', 'deletion_cancelled'],
      required: true,
    },
    from: { type: String, enum: HIRE_WORKSPACE_LIFECYCLE_STATES, required: true },
    to: { type: String, enum: HIRE_WORKSPACE_LIFECYCLE_STATES, required: true },
    actorMemberId: {
      type: Schema.Types.ObjectId,
      ref: 'HireWorkspaceMember',
      required: true,
    },
    actorName: { type: String, required: true, maxlength: 120 },
    operationId: { type: String, required: true, maxlength: 80 },
    at: { type: Date, required: true },
  },
  { _id: false },
)

const HireWorkspaceAdminTransferEventSchema = new Schema<IHireWorkspaceAdminTransferEvent>(
  {
    fromMemberId: {
      type: Schema.Types.ObjectId,
      ref: 'HireWorkspaceMember',
      required: true,
    },
    toMemberId: {
      type: Schema.Types.ObjectId,
      ref: 'HireWorkspaceMember',
      required: true,
    },
    actorName: { type: String, required: true, maxlength: 120 },
    operationId: { type: String, required: true, maxlength: 80 },
    at: { type: Date, required: true },
  },
  { _id: false },
)

const HireWorkspaceSchema = new Schema<IHireWorkspace>(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    companyBlurb: { type: String, trim: true, maxlength: 2000 },
    guestAuthMode: { type: String, enum: GUEST_AUTH_MODES, default: 'magic_link' },
    lifecycleState: {
      type: String,
      enum: HIRE_WORKSPACE_LIFECYCLE_STATES,
      default: 'active',
    },
    authorityVersion: { type: Number, default: 1, min: 1 },
    writeFenceVersion: { type: Number, default: 0, min: 0 },
    privacyAggregateFenceVersion: { type: Number, default: 0, min: 0 },
    deletedAt: { type: Date },
    purgeAfter: { type: Date },
    deletedByMemberId: { type: Schema.Types.ObjectId, ref: 'HireWorkspaceMember' },
    deletedByName: { type: String, maxlength: 120 },
    purgeState: { type: String, enum: HIRE_WORKSPACE_PURGE_STATES },
    purgeClaimToken: { type: String, maxlength: 80 },
    purgeLeaseExpiresAt: { type: Date },
    purgeAttempts: { type: Number, default: 0, min: 0 },
    purgeLastError: { type: String, maxlength: 500 },
    lifecycleEvents: { type: [HireWorkspaceLifecycleEventSchema], default: [] },
    adminTransferEvents: { type: [HireWorkspaceAdminTransferEventSchema], default: [] },
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      immutable: true,
    },
  },
  { timestamps: true }
)

// Deliberately NOT a TTL index: a retention worker must purge the complete
// workspace graph atomically/order-safely rather than Mongo deleting only the
// tenancy root and orphaning jobs, candidates, and media.
HireWorkspaceSchema.index({ lifecycleState: 1, purgeAfter: 1, purgeState: 1 })
HireWorkspaceSchema.index({ 'lifecycleEvents.operationId': 1 })
HireWorkspaceSchema.index({ 'adminTransferEvents.operationId': 1 })

export const HireWorkspace: Model<IHireWorkspace> =
  mongoose.models.HireWorkspace ||
  mongoose.model<IHireWorkspace>('HireWorkspace', HireWorkspaceSchema)
