import mongoose, { Document, Model, Schema } from 'mongoose'
import { HIRE_MULTIMODAL_OBSERVATION_MAX_REVISIONS } from '@shared/contracts/hireMultimodalObservationBridge'

export type HireRuntimeObservationCaptureState =
  | 'captured'
  | 'unavailable'
  | 'insufficient_signal'

export type HireRuntimeObservationEventKind =
  | 'browser_window_not_visible'
  | 'browser_window_focus_lost'
  | 'fullscreen_exited'
  | 'camera_interrupted'
  | 'microphone_interrupted'
  | 'screen_share_wrong_surface'
  | 'screen_share_interrupted'
  | 'screen_recording_interrupted'
  | 'sustained_camera_away'
  | 'speech_video_unverified'

export type HireRuntimeObservationEventSource =
  | 'camera'
  | 'browser_visibility'
  | 'browser_focus'
  | 'fullscreen'
  | 'camera_track'
  | 'microphone_track'
  | 'display_surface'
  | 'display_track'
  | 'display_recorder'
  | 'speech_video_corroboration'

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
      browserFocus?: HireRuntimeObservationCaptureState
      fullscreen?: HireRuntimeObservationCaptureState
      cameraTrack?: HireRuntimeObservationCaptureState
      microphoneTrack?: HireRuntimeObservationCaptureState
      displayShare?: HireRuntimeObservationCaptureState
      speechVideoCorroboration?: HireRuntimeObservationCaptureState
    }
    events: Array<{
      kind: HireRuntimeObservationEventKind
      source: HireRuntimeObservationEventSource
      startMs: number
      endMs: number
    }>
    playbackClock?: {
      protocolVersion: 1
      cameraRecorderStartOffsetMs?: number
      screenRecorderStartOffsetMs?: number
    }
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

const HireRuntimeObservationPlaybackClockSchema = new Schema(
  {
    protocolVersion: { type: Number, enum: [1], required: true },
    cameraRecorderStartOffsetMs: {
      type: Number,
      min: 0,
      max: 30 * 60 * 1_000,
    },
    screenRecorderStartOffsetMs: {
      type: Number,
      min: 0,
      max: 30 * 60 * 1_000,
    },
  },
  { _id: false, strict: 'throw' },
)

const HireRuntimeMultimodalObservationOutboxSchema =
  new Schema<IHireRuntimeMultimodalObservationOutbox>(
    {
      workspaceId: { type: Schema.Types.ObjectId, required: true, immutable: true },
      applicationId: { type: Schema.Types.ObjectId, required: true, immutable: true },
      roundId: { type: Schema.Types.ObjectId, required: true, immutable: true },
      principalId: { type: Schema.Types.ObjectId, required: true, immutable: true },
      runtimeSessionId: { type: Schema.Types.ObjectId, required: true, immutable: true },
      attempt: { type: Number, required: true, min: 1, max: 10, immutable: true },
      revision: {
        type: Number,
        required: true,
        min: 1,
        max: HIRE_MULTIMODAL_OBSERVATION_MAX_REVISIONS,
        immutable: true,
      },
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
          browserFocus: {
            type: String,
            enum: ['captured', 'unavailable', 'insufficient_signal'],
          },
          fullscreen: {
            type: String,
            enum: ['captured', 'unavailable', 'insufficient_signal'],
          },
          cameraTrack: {
            type: String,
            enum: ['captured', 'unavailable', 'insufficient_signal'],
          },
          microphoneTrack: {
            type: String,
            enum: ['captured', 'unavailable', 'insufficient_signal'],
          },
          displayShare: {
            type: String,
            enum: ['captured', 'unavailable', 'insufficient_signal'],
          },
          speechVideoCorroboration: {
            type: String,
            enum: ['captured', 'unavailable', 'insufficient_signal'],
          },
        },
        events: {
          type: [
            new Schema(
              {
                kind: {
                  type: String,
                  enum: [
                    'browser_window_not_visible',
                    'browser_window_focus_lost',
                    'fullscreen_exited',
                    'camera_interrupted',
                    'microphone_interrupted',
                    'screen_share_wrong_surface',
                    'screen_share_interrupted',
                    'screen_recording_interrupted',
                    'sustained_camera_away',
                    'speech_video_unverified',
                  ],
                  required: true,
                },
                source: {
                  type: String,
                  enum: [
                    'camera',
                    'browser_visibility',
                    'browser_focus',
                    'fullscreen',
                    'camera_track',
                    'microphone_track',
                    'display_surface',
                    'display_track',
                    'display_recorder',
                    'speech_video_corroboration',
                  ],
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
        playbackClock: {
          type: HireRuntimeObservationPlaybackClockSchema,
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
