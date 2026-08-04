import mongoose, { Document, Model, Schema } from 'mongoose'

/**
 * The legacy resume object is intentionally opaque here. Keeping it in a
 * Mixed field prevents this collection model from applying defaults,
 * stripping unknown fields, or regenerating nested `_id` values while the
 * embedded User payload is migrated.
 */
export type SavedResumeLegacyPayload = Record<string, unknown> & {
  id: string
}

export interface ISavedResume extends Document {
  userId: mongoose.Types.ObjectId
  /** Public resume identity; this remains the legacy string `id`. */
  resumeId: string
  /** Stable position copied from User.savedResumes array order. */
  ordinal: number
  /** Untouched legacy object; consumers continue to see the old payload. */
  payload: SavedResumeLegacyPayload
  /** Repository envelope timestamps; distinct from legacy payload timestamps. */
  rowCreatedAt: Date
  rowUpdatedAt: Date
}

export const SAVED_RESUME_IDENTITY_INDEX = {
  name: 'saved_resume_user_resume_unique_v1',
  key: {
    userId: 1,
    resumeId: 1,
  },
  unique: true,
} as const

export const SAVED_RESUME_ORDER_INDEX = {
  name: 'saved_resume_user_ordinal_resume_v1',
  key: {
    userId: 1,
    ordinal: 1,
    resumeId: 1,
  },
  unique: false,
} as const

const SavedResumeSchema = new Schema<ISavedResume>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      immutable: true,
    },
    resumeId: {
      type: String,
      required: true,
      minlength: 1,
      maxlength: 255,
      immutable: true,
    },
    ordinal: {
      type: Number,
      required: true,
      min: 0,
    },
    payload: {
      type: Schema.Types.Mixed,
      required: true,
    },
    rowCreatedAt: {
      type: Date,
      required: true,
      default: Date.now,
      immutable: true,
    },
    rowUpdatedAt: {
      type: Date,
      required: true,
      default: Date.now,
    },
  },
  {
    autoCreate: false,
    autoIndex: false,
    collection: 'savedResumes',
  },
)

SavedResumeSchema.pre(
  'validate',
  function validatePublicResumeIdentity() {
    if (
      !this.payload ||
      typeof this.payload.id !== 'string' ||
      this.payload.id !== this.resumeId
    ) {
      this.invalidate(
        'payload',
        'Saved resume payload id must exactly match resumeId',
      )
    }
  },
)

SavedResumeSchema.index(
  SAVED_RESUME_IDENTITY_INDEX.key,
  {
    name: SAVED_RESUME_IDENTITY_INDEX.name,
    unique: SAVED_RESUME_IDENTITY_INDEX.unique,
  },
)
SavedResumeSchema.index(
  SAVED_RESUME_ORDER_INDEX.key,
  {
    name: SAVED_RESUME_ORDER_INDEX.name,
  },
)

export const SavedResume: Model<ISavedResume> =
  mongoose.models.SavedResume ||
  mongoose.model<ISavedResume>(
    'SavedResume',
    SavedResumeSchema,
  )
