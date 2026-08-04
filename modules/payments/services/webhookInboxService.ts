import { createHash } from 'node:crypto'
import mongoose from 'mongoose'
import { z } from 'zod'
import { connectDB } from '@shared/db/connection'
import {
  PaymentWebhookEvent,
  paymentWebhookDedupeKey,
  type PaymentWebhookEventStatus,
} from '../models/PaymentWebhookEvent'
import type { ProviderMode } from '../types/catalog'
import type {
  RazorpayWebhookSigningSecret,
} from '../providers/razorpayEnvironment'
import {
  encryptWebhookPayload,
  type WebhookPayloadEncryptionKey,
} from '../providers/webhookPayloadCipher'
import {
  verifyRazorpayWebhookSignature,
} from '../providers/razorpaySignature'

export const MAX_RAZORPAY_WEBHOOK_BYTES = 1_048_576

export const SUPPORTED_RAZORPAY_WEBHOOK_EVENTS = [
  'order.paid',
  'payment.authorized',
  'payment.captured',
  'payment.failed',
  'subscription.authenticated',
  'subscription.activated',
  'subscription.charged',
  'subscription.completed',
  'subscription.updated',
  'subscription.pending',
  'subscription.halted',
  'subscription.cancelled',
  'subscription.paused',
  'subscription.resumed',
  'refund.created',
  'refund.processed',
  'refund.failed',
  'refund.speed_changed',
  'payment.dispute.created',
  'payment.dispute.won',
  'payment.dispute.lost',
  'payment.dispute.closed',
  'payment.dispute.under_review',
  'payment.dispute.action_required',
] as const
export type SupportedRazorpayWebhookEvent =
  (typeof SUPPORTED_RAZORPAY_WEBHOOK_EVENTS)[number]

const supportedEvents = new Set<string>(SUPPORTED_RAZORPAY_WEBHOOK_EVENTS)

const RazorpayWebhookEnvelopeSchema = z.object({
  entity: z.literal('event'),
  account_id: z.string().trim().min(1).max(255).optional(),
  event: z.string().trim().min(1).max(255),
  contains: z.array(z.string().trim().min(1).max(100)).max(30).optional(),
  payload: z.record(z.string(), z.unknown()),
  created_at: z.number().int().nonnegative().optional(),
}).passthrough()

export class RazorpayWebhookSignatureError extends Error {
  constructor() {
    super('Invalid Razorpay webhook signature')
    this.name = 'RazorpayWebhookSignatureError'
  }
}

export class RazorpayWebhookPayloadError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RazorpayWebhookPayloadError'
  }
}

export class RazorpayWebhookDedupeConflictError extends Error {
  constructor() {
    super('Razorpay webhook dedupe key was reused with different content')
    this.name = 'RazorpayWebhookDedupeConflictError'
  }
}

export interface PreparedRazorpayWebhook {
  providerMode: ProviderMode
  razorpayEventId?: string
  dedupeKey: string
  eventType: string
  razorpayAccountId?: string
  payloadHash: string
  rawPayloadStorage: {
    strategy: 'encrypted'
    algorithm: 'aes-256-gcm'
    ciphertext: string
    keyVersion: string
  }
  signatureVerified: true
  signatureSecretVersion: 'current' | 'previous'
  status: PaymentWebhookEventStatus
  attempts: 0
  lastError?: string
  receivedAt: Date
}

export interface ExistingWebhookReceipt {
  id: string
  eventType: string
  payloadHash: string
}

export interface WebhookInboxStore {
  insert(record: PreparedRazorpayWebhook): Promise<{ id: string }>
  findByDedupeKey(input: {
    providerMode: ProviderMode
    dedupeKey: string
  }): Promise<ExistingWebhookReceipt | null>
}

export interface ReceiveRazorpayWebhookResult {
  id: string
  duplicate: boolean
  eventType: string
  supported: boolean
}

function normalizeEventId(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  if (!value || value.trim() !== value || value.length > 255) {
    throw new RazorpayWebhookPayloadError(
      'Malformed X-Razorpay-Event-Id header',
    )
  }
  return value
}

function parseVerifiedEnvelope(rawBody: Uint8Array) {
  let parsedJson: unknown
  try {
    parsedJson = JSON.parse(Buffer.from(rawBody).toString('utf8'))
  } catch {
    throw new RazorpayWebhookPayloadError(
      'Signed Razorpay webhook body is not valid JSON',
    )
  }
  const parsed = RazorpayWebhookEnvelopeSchema.safeParse(parsedJson)
  if (!parsed.success) {
    throw new RazorpayWebhookPayloadError(
      'Signed Razorpay webhook envelope is invalid',
    )
  }
  return parsed.data
}

export function prepareRazorpayWebhook(input: {
  providerMode: ProviderMode
  rawBody: Uint8Array
  signature: string
  razorpayEventId?: string
  signingSecrets: readonly RazorpayWebhookSigningSecret[]
  payloadEncryptionKey: WebhookPayloadEncryptionKey
  receivedAt?: Date
}): PreparedRazorpayWebhook {
  if (
    input.rawBody.byteLength === 0 ||
    input.rawBody.byteLength > MAX_RAZORPAY_WEBHOOK_BYTES
  ) {
    throw new RazorpayWebhookPayloadError(
      'Razorpay webhook body size is invalid',
    )
  }

  const signatureResult = verifyRazorpayWebhookSignature({
    rawBody: input.rawBody,
    signature: input.signature,
    signingSecrets: input.signingSecrets,
  })
  if (
    !signatureResult.verified ||
    !signatureResult.matchedSecretVersion
  ) {
    throw new RazorpayWebhookSignatureError()
  }

  const envelope = parseVerifiedEnvelope(input.rawBody)
  const razorpayEventId = normalizeEventId(input.razorpayEventId)
  const payloadHash = createHash('sha256')
    .update(input.rawBody)
    .digest('hex')
  const encrypted = encryptWebhookPayload({
    rawBody: input.rawBody,
    context: {
      providerMode: input.providerMode,
      payloadHash,
      eventType: envelope.event,
    },
    encryptionKey: input.payloadEncryptionKey,
  })
  return {
    providerMode: input.providerMode,
    ...(razorpayEventId ? { razorpayEventId } : {}),
    dedupeKey: paymentWebhookDedupeKey({
      razorpayEventId,
      payloadHash,
    }),
    eventType: envelope.event,
    ...(envelope.account_id
      ? { razorpayAccountId: envelope.account_id }
      : {}),
    payloadHash,
    rawPayloadStorage: {
      strategy: 'encrypted',
      algorithm: encrypted.algorithm,
      ciphertext: encrypted.ciphertext,
      keyVersion: encrypted.keyVersion,
    },
    signatureVerified: true,
    signatureSecretVersion: signatureResult.matchedSecretVersion,
    status: supportedEvents.has(envelope.event)
      ? 'received'
      : 'dead_letter',
    attempts: 0,
    ...(!supportedEvents.has(envelope.event)
      ? { lastError: 'unsupported_event_type' }
      : {}),
    receivedAt: input.receivedAt ?? new Date(),
  }
}

function isMongoDuplicateKeyError(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === 'object' &&
    'code' in error &&
    error.code === 11000,
  )
}

const mongoWebhookInboxStore: WebhookInboxStore = {
  async insert(record) {
    await connectDB()
    const created = await PaymentWebhookEvent.create(record)
    return { id: created._id.toString() }
  },

  async findByDedupeKey({ providerMode, dedupeKey }) {
    await connectDB()
    const found = await PaymentWebhookEvent
      .findOne({ providerMode, dedupeKey })
      .select('_id eventType payloadHash')
      .lean<{
        _id: mongoose.Types.ObjectId
        eventType: string
        payloadHash: string
      }>()
    return found
      ? {
          id: found._id.toString(),
          eventType: found.eventType,
          payloadHash: found.payloadHash,
        }
      : null
  },
}

/**
 * Persists signature-valid raw bytes before returning. Duplicate delivery is
 * successful only when the immutable event type and payload hash agree.
 */
export async function receiveRazorpayWebhook(
  input: Parameters<typeof prepareRazorpayWebhook>[0],
  store: WebhookInboxStore = mongoWebhookInboxStore,
): Promise<ReceiveRazorpayWebhookResult> {
  const prepared = prepareRazorpayWebhook(input)
  try {
    const inserted = await store.insert(prepared)
    return {
      id: inserted.id,
      duplicate: false,
      eventType: prepared.eventType,
      supported: supportedEvents.has(prepared.eventType),
    }
  } catch (error) {
    if (!isMongoDuplicateKeyError(error)) throw error
  }

  const existing = await store.findByDedupeKey({
    providerMode: prepared.providerMode,
    dedupeKey: prepared.dedupeKey,
  })
  if (
    !existing ||
    existing.eventType !== prepared.eventType ||
    existing.payloadHash !== prepared.payloadHash
  ) {
    throw new RazorpayWebhookDedupeConflictError()
  }
  return {
    id: existing.id,
    duplicate: true,
    eventType: existing.eventType,
    supported: supportedEvents.has(existing.eventType),
  }
}
