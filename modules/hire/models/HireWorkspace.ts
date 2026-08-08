import mongoose, { Schema, Document, Model } from 'mongoose'

/**
 * IPG Hire v2 workspace — one workspace = one company (build plan §Permission
 * model). Flat permissions: exactly one admin role distinction, held on the
 * member row (HireWorkspaceMember.role), not here. Every other hire table is
 * keyed by workspaceId; this collection is the tenancy root.
 */
export interface IHireWorkspace extends Document {
  _id: mongoose.Types.ObjectId
  name: string
  createdBy: mongoose.Types.ObjectId
  createdAt: Date
  updatedAt: Date
}

const HireWorkspaceSchema = new Schema<IHireWorkspace>(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      immutable: true,
    },
  },
  { timestamps: true }
)

export const HireWorkspace: Model<IHireWorkspace> =
  mongoose.models.HireWorkspace ||
  mongoose.model<IHireWorkspace>('HireWorkspace', HireWorkspaceSchema)
