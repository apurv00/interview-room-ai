import mongoose, { Schema, Document, Model } from 'mongoose'

/**
 * ProductEvent — first-party product telemetry (PRODUCT_FLOW.md §2), the
 * substrate for the jobs feature's 60-day verdict metrics. 180-day TTL.
 *
 * Identity: `userId` when authed; otherwise `anonId` from the SIGNED anon
 * cookie (ruling: signed cookie primary, never IP — Jio/Airtel CGNAT makes
 * IP identity wrong for India). Signup writes an `identity_aliased` event
 * {anonId, userId} and backfills — the anon→user stitch.
 *
 * Server-side writes wherever a route exists; the client-keepalive
 * `/api/events` endpoint exists only for anon surfaces.
 */
export interface IProductEvent extends Document {
  _id: mongoose.Types.ObjectId
  name: string
  anonId?: string
  userId?: mongoose.Types.ObjectId
  jobPostingId?: mongoose.Types.ObjectId
  applicationId?: mongoose.Types.ObjectId
  sessionId?: mongoose.Types.ObjectId
  props?: Record<string, unknown>
  ts: Date
  expiresAt: Date
}

const TTL_DAYS = 180

const ProductEventSchema = new Schema<IProductEvent>(
  {
    name: { type: String, required: true, maxlength: 80 },
    anonId: { type: String, maxlength: 64 },
    userId: { type: Schema.Types.ObjectId, ref: 'User' },
    jobPostingId: { type: Schema.Types.ObjectId, ref: 'JobPosting' },
    applicationId: { type: Schema.Types.ObjectId, ref: 'JobApplication' },
    sessionId: { type: Schema.Types.ObjectId, ref: 'InterviewSession' },
    props: { type: Schema.Types.Mixed },
    ts: { type: Date, required: true },
    expiresAt: {
      type: Date,
      default: () => new Date(Date.now() + TTL_DAYS * 24 * 60 * 60 * 1000),
    },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
)

ProductEventSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 })
// Metric reads: per-event-name time series, per-user journeys, anon stitch.
ProductEventSchema.index({ name: 1, ts: -1 })
ProductEventSchema.index({ userId: 1, ts: -1 })
ProductEventSchema.index({ anonId: 1, ts: -1 })

export const ProductEvent: Model<IProductEvent> =
  mongoose.models.ProductEvent || mongoose.model<IProductEvent>('ProductEvent', ProductEventSchema)
