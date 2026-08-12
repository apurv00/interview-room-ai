import mongoose, { Schema, Document, Model } from 'mongoose'

export const HIRE_MEMBER_SESSION_TOKEN_INDEX_NAME =
  'hire_member_session_workspace_token_unique'
export const HIRE_MEMBER_SESSION_TOKEN_INDEX_KEY = { workspaceId: 1, tokenHash: 1 } as const

export interface IHireMemberSession extends Document {
  _id: mongoose.Types.ObjectId
  workspaceId: mongoose.Types.ObjectId
  memberId: mongoose.Types.ObjectId
  tokenHash: string
  sessionVersion: number
  expiresAt: Date
  revokedAt?: Date
  lastSeenAt: Date
  createdAt: Date
  updatedAt: Date
}

const HireMemberSessionSchema = new Schema<IHireMemberSession>(
  {
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: 'HireWorkspace',
      required: true,
      immutable: true,
    },
    memberId: {
      type: Schema.Types.ObjectId,
      ref: 'HireWorkspaceMember',
      required: true,
      immutable: true,
    },
    tokenHash: { type: String, required: true, immutable: true },
    sessionVersion: { type: Number, required: true, immutable: true, min: 1 },
    expiresAt: { type: Date, required: true },
    revokedAt: { type: Date },
    lastSeenAt: { type: Date, required: true },
  },
  { timestamps: true }
)

HireMemberSessionSchema.index(
  HIRE_MEMBER_SESSION_TOKEN_INDEX_KEY,
  { name: HIRE_MEMBER_SESSION_TOKEN_INDEX_NAME, unique: true },
)
HireMemberSessionSchema.index({ workspaceId: 1, memberId: 1, revokedAt: 1 })
HireMemberSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 })

export const HireMemberSession: Model<IHireMemberSession> =
  mongoose.models.HireMemberSession ||
  mongoose.model<IHireMemberSession>('HireMemberSession', HireMemberSessionSchema)
