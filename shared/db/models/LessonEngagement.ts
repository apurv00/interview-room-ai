import mongoose, { Schema, Document, Model } from 'mongoose'

export interface ILessonEngagement extends Document {
  _id: mongoose.Types.ObjectId
  userId: mongoose.Types.ObjectId
  lessonId: mongoose.Types.ObjectId
  competency: string
  domain: string

  openedAt: Date
  expandedAt?: Date
  drillStartedAt?: Date
  skippedAt?: Date

  dwellTimeMs: number
  drillStarted: boolean

  createdAt: Date
  updatedAt: Date
}

const LessonEngagementSchema = new Schema<ILessonEngagement>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    lessonId: { type: Schema.Types.ObjectId, ref: 'GeneratedLesson', required: true },
    competency: { type: String, required: true },
    domain: { type: String, required: true },

    openedAt: { type: Date, required: true },
    expandedAt: { type: Date },
    drillStartedAt: { type: Date },
    skippedAt: { type: Date },

    dwellTimeMs: { type: Number, default: 0 },
    drillStarted: { type: Boolean, default: false },
  },
  { timestamps: true }
)

LessonEngagementSchema.index({ userId: 1, lessonId: 1 })
LessonEngagementSchema.index({ userId: 1, createdAt: -1 })
LessonEngagementSchema.index({ drillStarted: 1, createdAt: -1 })

export const LessonEngagement: Model<ILessonEngagement> =
  mongoose.models.LessonEngagement ||
  mongoose.model<ILessonEngagement>('LessonEngagement', LessonEngagementSchema)
