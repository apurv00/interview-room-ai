import mongoose, { Schema, Document, Model } from 'mongoose'

export const HIRE_MEMBER_SETUP_TOKEN_INDEX_NAME =
  'hire_member_setup_workspace_token_unique'
export const HIRE_MEMBER_SETUP_TOKEN_INDEX_KEY = { workspaceId: 1, tokenHash: 1 } as const

export interface IHireMemberSetup extends Document {
  _id: mongoose.Types.ObjectId
  workspaceId: mongoose.Types.ObjectId
  memberId: mongoose.Types.ObjectId
  tokenHash: string
  expiresAt: Date
  consumedAt?: Date
  attempts: number
  createdAt: Date
  updatedAt: Date
}

const HireMemberSetupSchema = new Schema<IHireMemberSetup>(
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
    expiresAt: { type: Date, required: true },
    consumedAt: { type: Date },
    attempts: { type: Number, default: 0, min: 0, max: 10 },
  },
  { timestamps: true }
)

HireMemberSetupSchema.index(
  HIRE_MEMBER_SETUP_TOKEN_INDEX_KEY,
  { name: HIRE_MEMBER_SETUP_TOKEN_INDEX_NAME, unique: true },
)
HireMemberSetupSchema.index({ workspaceId: 1, memberId: 1, createdAt: -1 })
HireMemberSetupSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 })

export const HireMemberSetup: Model<IHireMemberSetup> =
  mongoose.models.HireMemberSetup ||
  mongoose.model<IHireMemberSetup>('HireMemberSetup', HireMemberSetupSchema)
