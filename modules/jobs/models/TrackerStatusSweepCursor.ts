import mongoose, { type Document, type Model, Schema } from 'mongoose'

export const JOBS_TRACKER_SWEEP_CURSOR_ID = 'jobs-tracker-status-sweep'

/** Global, non-user-owned continuation for the bounded tracker-status scan. */
export interface ITrackerStatusSweepCursor extends Document<string> {
  _id: string
  appliedAt: Date
  applicationId: mongoose.Types.ObjectId
  lastRunAt: Date
  createdAt: Date
  updatedAt: Date
}

const TrackerStatusSweepCursorSchema = new Schema<ITrackerStatusSweepCursor>(
  {
    _id: { type: String, required: true },
    appliedAt: { type: Date, required: true },
    applicationId: { type: Schema.Types.ObjectId, required: true },
    lastRunAt: { type: Date, required: true },
  },
  { timestamps: true, collection: 'jobs_tracker_status_sweep_cursors' },
)

export const TrackerStatusSweepCursor: Model<ITrackerStatusSweepCursor> =
  mongoose.models.TrackerStatusSweepCursor ||
  mongoose.model<ITrackerStatusSweepCursor>(
    'TrackerStatusSweepCursor',
    TrackerStatusSweepCursorSchema,
  )
