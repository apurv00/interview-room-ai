import mongoose, { Document, Model, Schema } from 'mongoose'
import {
  PROVIDER_MODES,
  type ProviderMode,
} from '../types/catalog'

export const PAYMENT_WEBHOOK_EVENT_STATUSES = [
  'received',
  'processing',
  'processed',
  'failed',
  'dead_letter',
] as const
export type PaymentWebhookEventStatus =
  (typeof PAYMENT_WEBHOOK_EVENT_STATUSES)[number]

export const WEBHOOK_PAYLOAD_STORAGE_STRATEGIES = [
  'encrypted',
  'retained_reference',
  'hash_only',
] as const
export type WebhookPayloadStorageStrategy =
  (typeof WEBHOOK_PAYLOAD_STORAGE_STRATEGIES)[number]

export interface IWebhookPayloadStorage {
  strategy: WebhookPayloadStorageStrategy
  algorithm?: 'aes-256-gcm'
  ciphertext?: string
  reference?: string
  keyVersion?: string
}

export interface IPaymentWebhookEvent extends Document {
  providerMode: ProviderMode
  razorpayEventId?: string
  dedupeKey: string
  eventType: string
  razorpayAccountId?: string
  payloadHash: string
  rawPayloadStorage: IWebhookPayloadStorage
  signatureVerified: true
  signatureSecretVersion: 'current' | 'previous'
  status: PaymentWebhookEventStatus
  attempts: number
  lastError?: string
  receivedAt: Date
  processedAt?: Date
  createdAt: Date
  updatedAt: Date
}

export function paymentWebhookDedupeKey(input: {
  razorpayEventId?: string
  payloadHash: string
}): string {
  const eventId = input.razorpayEventId?.trim()
  if (eventId) return `event:${eventId}`
  return `payload-sha256:${input.payloadHash.toLowerCase()}`
}

const WebhookPayloadStorageSchema = new Schema<IWebhookPayloadStorage>(
  {
    strategy: {
      type: String,
      enum: WEBHOOK_PAYLOAD_STORAGE_STRATEGIES,
      required: true,
    },
    algorithm: {
      type: String,
      enum: ['aes-256-gcm'],
    },
    ciphertext: { type: String },
    reference: { type: String, trim: true, maxlength: 2048 },
    keyVersion: { type: String, trim: true, maxlength: 255 },
  },
  { _id: false },
)

const PaymentWebhookEventSchema = new Schema<IPaymentWebhookEvent>(
  {
    providerMode: {
      type: String,
      enum: PROVIDER_MODES,
      required: true,
      immutable: true,
    },
    razorpayEventId: {
      type: String,
      trim: true,
      maxlength: 255,
      immutable: true,
    },
    dedupeKey: {
      type: String,
      required: true,
      trim: true,
      maxlength: 320,
      immutable: true,
    },
    eventType: {
      type: String,
      required: true,
      trim: true,
      maxlength: 255,
      immutable: true,
    },
    razorpayAccountId: {
      type: String,
      trim: true,
      maxlength: 255,
      immutable: true,
    },
    payloadHash: {
      type: String,
      required: true,
      lowercase: true,
      match: /^[a-f0-9]{64}$/,
      immutable: true,
    },
    rawPayloadStorage: {
      type: WebhookPayloadStorageSchema,
      required: true,
      immutable: true,
    },
    signatureVerified: {
      type: Boolean,
      required: true,
      immutable: true,
      validate: {
        validator: (value: boolean) => value === true,
        message: 'Only signature-verified webhook events may be persisted',
      },
    },
    signatureSecretVersion: {
      type: String,
      enum: ['current', 'previous'],
      required: true,
      immutable: true,
    },
    status: {
      type: String,
      enum: PAYMENT_WEBHOOK_EVENT_STATUSES,
      required: true,
      default: 'received',
    },
    attempts: {
      type: Number,
      required: true,
      default: 0,
      validate: {
        validator: (value: number) => (
          Number.isSafeInteger(value) && value >= 0
        ),
        message: 'Attempts must be a non-negative safe integer',
      },
    },
    lastError: {
      type: String,
      maxlength: 2000,
    },
    receivedAt: {
      type: Date,
      required: true,
      default: Date.now,
      immutable: true,
    },
    processedAt: { type: Date },
  },
  { timestamps: true },
)

PaymentWebhookEventSchema.index(
  { providerMode: 1, dedupeKey: 1 },
  { unique: true },
)
PaymentWebhookEventSchema.index({ status: 1, receivedAt: 1 })
PaymentWebhookEventSchema.index({ providerMode: 1, eventType: 1, receivedAt: -1 })

PaymentWebhookEventSchema.pre('validate', function normalizeAndValidateEvent() {
  this.dedupeKey = paymentWebhookDedupeKey({
    razorpayEventId: this.razorpayEventId,
    payloadHash: this.payloadHash,
  })

  const storage = this.rawPayloadStorage
  if (storage?.strategy === 'encrypted') {
    if (storage.algorithm !== 'aes-256-gcm') {
      this.invalidate(
        'rawPayloadStorage.algorithm',
        'Encrypted webhook payload storage requires aes-256-gcm',
      )
    }
    if (!storage.ciphertext) {
      this.invalidate(
        'rawPayloadStorage.ciphertext',
        'Encrypted webhook payload storage requires ciphertext',
      )
    }
    if (!storage.keyVersion) {
      this.invalidate(
        'rawPayloadStorage.keyVersion',
        'Encrypted webhook payload storage requires a key version',
      )
    }
  }
  if (
    storage?.strategy === 'retained_reference' &&
    !storage.reference
  ) {
    this.invalidate(
      'rawPayloadStorage.reference',
      'Retained webhook payload storage requires a reference',
    )
  }
})

export const PaymentWebhookEvent: Model<IPaymentWebhookEvent> =
  mongoose.models.PaymentWebhookEvent ||
  mongoose.model<IPaymentWebhookEvent>(
    'PaymentWebhookEvent',
    PaymentWebhookEventSchema,
  )
