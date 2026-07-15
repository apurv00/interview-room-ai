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
  /** Last pagination of this bucket ended on a failed page (Codex #528 P1):
   *  the next run must distrust the known-rate cutoff — rows it already
   *  stored from the partial run would otherwise read as "window exhausted"
   *  before the failed pages are ever retried. Cleared on a full clean exit. */
  windowIncomplete?: boolean
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
    windowIncomplete: { type: Boolean },
  },
  { timestamps: true }
)

JobIngestCursorSchema.index({ sourceId: 1, bucket: 1 }, { unique: true })

export const JobIngestCursor: Model<IJobIngestCursor> =
  mongoose.models.JobIngestCursor || mongoose.model<IJobIngestCursor>('JobIngestCursor', JobIngestCursorSchema)
