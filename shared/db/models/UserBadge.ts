import mongoose, { Schema, Document, Model } from 'mongoose'

export interface IUserBadge extends Document {
  userId: mongoose.Types.ObjectId
  badgeId: string
  earnedAt: Date
  notified: boolean
  createdAt: Date
}

const UserBadgeSchema = new Schema<IUserBadge>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    badgeId: { type: String, required: true },
    earnedAt: { type: Date, default: Date.now },
    notified: { type: Boolean, default: false },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
)

UserBadgeSchema.index({ userId: 1, badgeId: 1 }, { unique: true })
UserBadgeSchema.index({ userId: 1, earnedAt: -1 })

export const UserBadge: Model<IUserBadge> =
  mongoose.models.UserBadge || mongoose.model<IUserBadge>('UserBadge', UserBadgeSchema)
