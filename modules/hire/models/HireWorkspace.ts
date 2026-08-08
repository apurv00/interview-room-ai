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

/**
 * IPG Hire v2 workspace — one workspace = one company (build plan §Permission
 * model). Flat permissions: exactly one admin role distinction, held on the
 * member row (HireWorkspaceMember.role), not here. Every other hire table is
 * keyed by workspaceId; this collection is the tenancy root.
 */
export interface IHireWorkspace extends Document {
  _id: mongoose.Types.ObjectId
  name: string
  guestAuthMode: GuestAuthMode
  createdBy: mongoose.Types.ObjectId
  createdAt: Date
  updatedAt: Date
}

const HireWorkspaceSchema = new Schema<IHireWorkspace>(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    guestAuthMode: { type: String, enum: GUEST_AUTH_MODES, default: 'magic_link' },
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
