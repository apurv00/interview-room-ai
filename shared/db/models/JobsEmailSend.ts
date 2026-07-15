import mongoose, { Schema, Document, Model } from 'mongoose'

/**
 * JobsEmailSend — the email send ledger (EMAILS.md §2 guard 1). One row per
 * attempted/completed send; the UNIQUE {userId, stream, dedupeKey} index is
 * what makes double-sends structurally impossible (the digest-incident
 * lesson: dedupe lives in the schema, never in job logic).
 *
 * Two disciplines share this collection (EMAILS.md §2):
 * - Solicitation (e1/e3/e4): reserve-first — row inserted BEFORE the send
 *   (no resendId), stamped after. Duplicate key on insert = already
 *   reserved/sent, skip. A reserved-unstamped row is dashboard-surfaced,
 *   never auto-retried.
 * - Transactional (e0/e2): send-first with a Resend idempotency key (= the
 *   dedupeKey), recorded AFTER; re-attempts permitted only within the
 *   provider's 24h idempotency window (Codex #530).
 */

export const JOBS_EMAIL_STREAMS = ['e0', 'e1', 'e2', 'e3', 'e4'] as const
export type JobsEmailStream = (typeof JOBS_EMAIL_STREAMS)[number]

export interface IJobsEmailSend extends Document {
  _id: mongoose.Types.ObjectId
  userId: mongoose.Types.ObjectId
  stream: JobsEmailStream
  dedupeKey: string
  /** Set when the provider accepted the send; a row without it is a
   *  reservation (solicitation) or an in-flight transactional record. */
  sentAt?: Date
  resendId?: string
  createdAt: Date
  updatedAt: Date
}

const JobsEmailSendSchema = new Schema<IJobsEmailSend>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    stream: { type: String, enum: JOBS_EMAIL_STREAMS, required: true },
    dedupeKey: { type: String, required: true, maxlength: 200 },
    sentAt: { type: Date },
    resendId: { type: String, maxlength: 100 },
  },
  { timestamps: true }
)

// THE dedupe guarantee — everything else is convention.
JobsEmailSendSchema.index({ userId: 1, stream: 1, dedupeKey: 1 }, { unique: true })
// Rolling-cap reads ("sends for user U in the last 7d") + dashboard counts.
JobsEmailSendSchema.index({ userId: 1, sentAt: -1 })
JobsEmailSendSchema.index({ stream: 1, createdAt: -1 })

export const JobsEmailSend: Model<IJobsEmailSend> =
  mongoose.models.JobsEmailSend ||
  mongoose.model<IJobsEmailSend>('JobsEmailSend', JobsEmailSendSchema)
