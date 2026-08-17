import mongoose, { Document, Model, Schema } from 'mongoose'

export type HireRuntimeObservationCaptureState =
  | 'captured'
  | 'unavailable'
  | 'insufficient_signal'

export type HireRuntimeObservationEventKind =
  | 'browser_window_not_visible'
  | 'sustained_camera_away'

export interface IHireRuntimeMultimodalObservationOutbox extends Document {
  workspaceId: mongoose.Types.ObjectId
  applicationId: mongoose.Types.ObjectId
  roundId: mongoose.Types.ObjectId
  principalId: mongoose.Types.ObjectId
  runtimeSessionId: mongoose.Types.ObjectId
  attempt: number
  revision: number
  consentVersion: string
  policyVersion: string
  eventId: string
  observationDigest: string
  observedAt: Date
  /** Cleared after the control plane acknowledges the derived report. */
  report?: {
    status: 'completed' | 'insufficient_signal'
    capture: {
      camera: HireRuntimeObservationCaptureState
      browserVisibility: HireRuntimeObservationCaptureState
    }
    events: Array<{
      kind: HireRuntimeObservationEventKind
      source: 'camera' | 'browser_visibility'
      startMs: number
      endMs: number
    }>
  }
  status: 'pending' | 'published' | 'stale'
  publishLeaseToken?: string
  publishLeaseExpiresAt?: Date
  publishAttemptCount: number
  publishRetryAt?: Date
  publishedAt?: Date
  failureCode?: string
  createdAt: Date
  updatedAt: Date
}

const HireRuntimeMultimodalObservationOutboxSchema =
  new Schema<IHireRuntimeMultimodalObservationOutbox>(
    {
      workspaceId: { type: Schema.Types.ObjectId, required: true, immutable: true },
      applicationId: { type: Schema.Types.ObjectId, required: true, immutable: true },
      roundId: { type: Schema.Types.ObjectId, required: true, immutable: true },
      principalId: { type: Schema.Types.ObjectId, required: true, immutable: true },
      runtimeSessionId: { type: Schema.Types.ObjectId, required: true, immutable: true },
      attempt: { type: Number, required: true, min: 1, max: 10, immutable: true },
      revision: { type: Number, required: true, min: 1, max: 1, immutable: true },
      consentVersion: { type: String, required: true, maxlength: 80, immutable: true },
      policyVersion: { type: String, required: true, maxlength: 80, immutable: true },
      eventId: { type: String, required: true, match: /^[a-f0-9]{64}$/, immutable: true },
      observationDigest: {
        type: String,
        required: true,
        match: /^[a-f0-9]{64}$/,
        immutable: true,
      },
      observedAt: { type: Date, required: true, immutable: true },
      report: {
        status: {
          type: String,
          enum: ['completed', 'insufficient_signal'],
          required: true,
        },
        capture: {
          camera: {
            type: String,
            enum: ['captured', 'unavailable', 'insufficient_signal'],
            required: true,
          },
          browserVisibility: {
            type: String,
            enum: ['captured', 'unavailable', 'insufficient_signal'],
            required: true,
          },
        },
        events: {
          type: [
            new Schema(
              {
                kind: {
                  type: String,
                  enum: ['browser_window_not_visible', 'sustained_camera_away'],
                  required: true,
                },
                source: {
                  type: String,
                  enum: ['camera', 'browser_visibility'],
                  required: true,
                },
                startMs: { type: Number, required: true, min: 0, max: 30 * 60 * 1_000 },
                endMs: { type: Number, required: true, min: 0, max: 30 * 60 * 1_000 },
              },
              { _id: false, strict: 'throw' },
            ),
          ],
          required: true,
          default: [],
        },
      },
      status: { type: String, enum: ['pending', 'published', 'stale'], required: true },
      publishLeaseToken: { type: String, maxlength: 64 },
      publishLeaseExpiresAt: { type: Date },
      publishAttemptCount: { type: Number, required: true, default: 0, min: 0, max: 20 },
      publishRetryAt: { type: Date },
      publishedAt: { type: Date },
      failureCode: { type: String, maxlength: 120 },
    },
    { timestamps: true, strict: 'throw' },
  )

HireRuntimeMultimodalObservationOutboxSchema.index(
  { workspaceId: 1, roundId: 1, runtimeSessionId: 1, revision: 1 },
  { unique: true },
)
HireRuntimeMultimodalObservationOutboxSchema.index({
  workspaceId: 1,
  status: 1,
  publishRetryAt: 1,
  updatedAt: 1,
})

export const HireRuntimeMultimodalObservationOutbox: Model<IHireRuntimeMultimodalObservationOutbox> =
  mongoose.models.HireRuntimeMultimodalObservationOutbox ||
  mongoose.model<IHireRuntimeMultimodalObservationOutbox>(
    'HireRuntimeMultimodalObservationOutbox',
    HireRuntimeMultimodalObservationOutboxSchema,
  )
