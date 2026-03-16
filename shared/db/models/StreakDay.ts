import mongoose, { Schema, Document, Model } from 'mongoose'

export interface IStreakDay extends Document {
  userId: mongoose.Types.ObjectId
  date: string // "YYYY-MM-DD"
  type: 'active' | 'freeze'
  activities: number
  createdAt: Date
}

const StreakDaySchema = new Schema<IStreakDay>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    date: { type: String, required: true },
    type: { type: String, enum: ['active', 'freeze'], default: 'active' },
    activities: { type: Number, default: 1 },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
)

StreakDaySchema.index({ userId: 1, date: -1 }, { unique: true })
// Auto-delete after 120 days
StreakDaySchema.index({ createdAt: 1 }, { expireAfterSeconds: 120 * 24 * 60 * 60 })

export const StreakDay: Model<IStreakDay> =
  mongoose.models.StreakDay || mongoose.model<IStreakDay>('StreakDay', StreakDaySchema)
