import mongoose, { Schema, Document, Model } from 'mongoose'

export const HIRE_MEMBER_ROLES = ['admin', 'member'] as const
export type HireMemberRole = (typeof HIRE_MEMBER_ROLES)[number]

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
  name?: string
  userId?: mongoose.Types.ObjectId
  role: HireMemberRole
  addedBy: mongoose.Types.ObjectId
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
    email: { type: String, required: true, trim: true, lowercase: true, maxlength: 254 },
    name: { type: String, trim: true, maxlength: 120 },
    userId: { type: Schema.Types.ObjectId, ref: 'User' },
    role: { type: String, enum: HIRE_MEMBER_ROLES, default: 'member' },
    addedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true }
)

// One membership per email per workspace — the add-member idempotency guarantee.
HireWorkspaceMemberSchema.index({ workspaceId: 1, email: 1 }, { unique: true })
// Sign-in resolution paths: by linked user, and by email for the lazy backfill.
HireWorkspaceMemberSchema.index({ userId: 1 }, { sparse: true })
HireWorkspaceMemberSchema.index({ email: 1 })

export const HireWorkspaceMember: Model<IHireWorkspaceMember> =
  mongoose.models.HireWorkspaceMember ||
  mongoose.model<IHireWorkspaceMember>('HireWorkspaceMember', HireWorkspaceMemberSchema)
