import mongoose, { Document, Model, Schema } from 'mongoose'

/** One explicit, opt-in preference for a Hire workspace member. */
export interface IHireDigestPreference extends Document {
  _id: mongoose.Types.ObjectId
  workspaceId: mongoose.Types.ObjectId
  memberId: mongoose.Types.ObjectId
  enabled: boolean
  /** Serializes an opt-out with worker authorization immediately before egress. */
  writeFenceVersion: number
  updatedByMemberId: mongoose.Types.ObjectId
  updatedByName: string
  createdAt: Date
  updatedAt: Date
}

const HireDigestPreferenceSchema = new Schema<IHireDigestPreference>(
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
    // Safe default: Phase 5 never starts emailing existing members merely by
    // being deployed. A member actively opts in from their authenticated view.
    enabled: { type: Boolean, required: true, default: false },
    writeFenceVersion: { type: Number, required: true, default: 0, min: 0 },
    updatedByMemberId: {
      type: Schema.Types.ObjectId,
      ref: 'HireWorkspaceMember',
      required: true,
    },
    updatedByName: { type: String, required: true, trim: true, maxlength: 120 },
  },
  { timestamps: true, strict: 'throw' },
)

HireDigestPreferenceSchema.index({ workspaceId: 1, memberId: 1 }, { unique: true })
HireDigestPreferenceSchema.index({ workspaceId: 1, enabled: 1, updatedAt: 1 })

export const HireDigestPreference: Model<IHireDigestPreference> =
  mongoose.models.HireDigestPreference ||
  mongoose.model<IHireDigestPreference>('HireDigestPreference', HireDigestPreferenceSchema)
