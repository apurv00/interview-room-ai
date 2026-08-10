import mongoose, { Schema, Document, Model } from 'mongoose'

export const HIRE_MEMBER_ROLES = ['admin', 'member'] as const
export type HireMemberRole = (typeof HIRE_MEMBER_ROLES)[number]
export const HIRE_MEMBER_AUTH_STATES = ['pending', 'active', 'removed'] as const
export type HireMemberAuthState = (typeof HIRE_MEMBER_AUTH_STATES)[number]

export const HIRE_MEMBER_ACTIVE_EMAIL_INDEX_NAME =
  'hire_member_workspace_pending_active_normalized_email_unique'
export const HIRE_MEMBER_ACTIVE_EMAIL_INDEX_KEY = {
  workspaceId: 1,
  normalizedEmail: 1,
} as const
export const HIRE_MEMBER_ACTIVE_EMAIL_INDEX_PARTIAL = {
  authState: { $in: ['pending', 'active'] },
} as const

/** Canonical login/member key. Candidate identity never enters this model. */
export function normalizeHireMemberEmail(value: string): string {
  return value.trim().toLowerCase()
}

/**
 * Workspace membership — members are the HR team only (build plan §Principles).
 * Interviewers and stakeholders are never members; they get guest links.
 *
 * userId is nullable on purpose: the admin adds a member by name + email, and
 * the row links to a User lazily on the member's first sign-in (matched by
 * email). We deliberately do NOT mint a password-less User row at add time —
 * that would break the member's future OAuth sign-in (NextAuth refuses to link
 * an OAuth account onto a pre-existing bare-email user: OAuthAccountNotLinked).
 */
export interface IHireWorkspaceMember extends Document {
  _id: mongoose.Types.ObjectId
  workspaceId: mongoose.Types.ObjectId
  email: string
  normalizedEmail: string
  name: string
  userId?: mongoose.Types.ObjectId
  role: HireMemberRole
  authState: HireMemberAuthState
  passwordHash?: string
  passwordSetAt?: Date
  sessionVersion: number
  removedAt?: Date
  addedBy?: mongoose.Types.ObjectId
  addedByMemberId?: mongoose.Types.ObjectId
  addedByName: string
  createdAt: Date
  updatedAt: Date
}

const HireWorkspaceMemberSchema = new Schema<IHireWorkspaceMember>(
  {
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: 'HireWorkspace',
      required: true,
      immutable: true,
    },
    email: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      maxlength: 254,
      immutable: true,
      set: normalizeHireMemberEmail,
    },
    normalizedEmail: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      maxlength: 254,
      immutable: true,
      set: normalizeHireMemberEmail,
    },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    userId: { type: Schema.Types.ObjectId, ref: 'User' },
    role: { type: String, enum: HIRE_MEMBER_ROLES, default: 'member' },
    authState: { type: String, enum: HIRE_MEMBER_AUTH_STATES, default: 'active' },
    passwordHash: { type: String, select: false },
    passwordSetAt: { type: Date },
    sessionVersion: { type: Number, default: 1, min: 1 },
    removedAt: { type: Date },
    // Legacy B2C actor pointer retained for historical compatibility only.
    // Hire-owned actorMemberId/name snapshots are authoritative for new work.
    addedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    addedByMemberId: { type: Schema.Types.ObjectId, ref: 'HireWorkspaceMember' },
    addedByName: { type: String, required: true, trim: true, maxlength: 120 },
  },
  { timestamps: true }
)

HireWorkspaceMemberSchema.pre('validate', function canonicalizeMemberEmail() {
  const normalizedEmail = normalizeHireMemberEmail(this.email)
  this.email = normalizedEmail
  this.normalizedEmail = normalizedEmail
})

// Login always carries a workspace coordinate. Within that workspace, an
// email resolves to exactly one pending/active Hire member. The same HR email
// may legitimately belong to another company without becoming a cross-tenant
// discovery key. Removed rows leave the partial index so the person can be
// re-added while their historical actor row remains.
HireWorkspaceMemberSchema.index(
  HIRE_MEMBER_ACTIVE_EMAIL_INDEX_KEY,
  {
    name: HIRE_MEMBER_ACTIVE_EMAIL_INDEX_NAME,
    unique: true,
    partialFilterExpression: HIRE_MEMBER_ACTIVE_EMAIL_INDEX_PARTIAL,
  },
)
// ONE LINKED workspace per user, enforced by the database (Phase 1 rule) —
// the service-level pre-checks are only the friendly-error fast path;
// concurrent creates/links race into this index. Sparse: email-only
// (not-yet-signed-in) rows are exempt.
HireWorkspaceMemberSchema.index({ userId: 1 }, { unique: true, sparse: true })
HireWorkspaceMemberSchema.index({ workspaceId: 1, authState: 1 })
// Database backstop for the one-admin invariant. Transfer demotes and promotes
// in one transaction, so no committed state can contain two admins.
HireWorkspaceMemberSchema.index(
  { workspaceId: 1, role: 1 },
  { unique: true, partialFilterExpression: { role: 'admin' } },
)

export const HireWorkspaceMember: Model<IHireWorkspaceMember> =
  mongoose.models.HireWorkspaceMember ||
  mongoose.model<IHireWorkspaceMember>('HireWorkspaceMember', HireWorkspaceMemberSchema)
