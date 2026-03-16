import mongoose, { Schema, Document, Model } from 'mongoose'

export type XpEventType =
  | 'interview_complete'
  | 'drill_complete'
  | 'daily_challenge'
  | 'streak_bonus'
  | 'badge_earned'
  | 'pathway_task'

export interface IXpEvent extends Document {
  userId: mongoose.Types.ObjectId
  type: XpEventType
  amount: number
  metadata: Record<string, unknown>
  createdAt: Date
}

const XpEventSchema = new Schema<IXpEvent>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    type: {
      type: String,
      enum: ['interview_complete', 'drill_complete', 'daily_challenge', 'streak_bonus', 'badge_earned', 'pathway_task'],
      required: true,
    },
    amount: { type: Number, required: true },
    metadata: { type: Schema.Types.Mixed, default: {} },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
)

XpEventSchema.index({ userId: 1, createdAt: -1 })
XpEventSchema.index({ userId: 1, type: 1, createdAt: -1 })

export const XpEvent: Model<IXpEvent> =
  mongoose.models.XpEvent || mongoose.model<IXpEvent>('XpEvent', XpEventSchema)
