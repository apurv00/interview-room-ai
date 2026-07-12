import mongoose, { Schema, Document, Model } from 'mongoose'

/**
 * JobIngestCursor — freshness cursor per source × bucket (INGESTION §4.4):
 * page 1 uses the smallest date_posted window covering newestPostedAt;
 * page N+1 fetches only while page N's already-known rate < 60%.
 */
export interface IJobIngestCursor extends Document {
  _id: mongoose.Types.ObjectId
  sourceId: string
  bucket: string
  newestPostedAt?: Date
  lastPage: number
  lastWindow?: string
  lastRunAt?: Date
  createdAt: Date
  updatedAt: Date
}

const JobIngestCursorSchema = new Schema<IJobIngestCursor>(
  {
    sourceId: { type: String, required: true },
    bucket: { type: String, required: true },
    newestPostedAt: { type: Date },
    lastPage: { type: Number, default: 0 },
    lastWindow: { type: String },
    lastRunAt: { type: Date },
  },
  { timestamps: true }
)

JobIngestCursorSchema.index({ sourceId: 1, bucket: 1 }, { unique: true })

export const JobIngestCursor: Model<IJobIngestCursor> =
  mongoose.models.JobIngestCursor || mongoose.model<IJobIngestCursor>('JobIngestCursor', JobIngestCursorSchema)
