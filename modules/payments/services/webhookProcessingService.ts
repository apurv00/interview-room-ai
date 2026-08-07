import { createHash } from 'node:crypto'
import mongoose from 'mongoose'
import { z } from 'zod'
import { connectDB } from '@shared/db/connection'
import {
  PaymentWebhookEvent,
  type PaymentWebhookEventStatus,
} from '../models/PaymentWebhookEvent'
import {
  decryptWebhookPayload,
  loadWebhookPayloadEncryptionKeys,
  resolveWebhookPayloadDecryptionKey,
  type EncryptedWebhookPayload,
  type WebhookPayloadEncryptionKey,
} from '../providers/webhookPayloadCipher'
import type { ProviderMode } from '../types/catalog'
import {
  SUPPORTED_RAZORPAY_WEBHOOK_EVENTS,
  type SupportedRazorpayWebhookEvent,
} from './webhookInboxService'

export const PAYMENT_WEBHOOK_MAX_PROCESSING_ATTEMPTS = 8
export const PAYMENT_WEBHOOK_STALE_CLAIM_MS = 10 * 60 * 1000

const supportedEventTypes = new Set<string>(
  SUPPORTED_RAZORPAY_WEBHOOK_EVENTS,
)

const ProcessingEnvelopeSchema = z.object({
  entity: z.literal('event'),
  account_id: z.string().trim().min(1).max(255).optional(),
  event: z.string().trim().min(1).max(255),
  payload: z.record(z.string(), z.unknown()),
  created_at: z.number().int().nonnegative().optional(),
}).passthrough()

export interface ClaimedPaymentWebhookEvent {
  id: string
  providerMode: ProviderMode
  eventType: string
  razorpayAccountId?: string
  payloadHash: string
  rawPayloadStorage: EncryptedWebhookPayload & { strategy: 'encrypted' }
  signatureVerified: true
  attempts: number
}

export interface VerifiedPaymentWebhookEnvelope {
  inboxEventId: string
  providerMode: ProviderMode
  eventType: SupportedRazorpayWebhookEvent
  razorpayAccountId?: string
  providerCreatedAtEpochSeconds?: number
  payload: Record<string, unknown>
}

export type PaymentWebhookHandler = (
  event: VerifiedPaymentWebhookEnvelope,
) => Promise<void>

export interface PaymentWebhookProcessingStore {
  claim(input: {
    eventId: string
    now: Date
    staleBefore: Date
    maxAttempts: number
  }): Promise<ClaimedPaymentWebhookEvent | null>
  readStatus(eventId: string): Promise<{
    status: PaymentWebhookEventStatus
    attempts: number
  } | null>
  markProcessed(input: {
    eventId: string
    claimAttempt: number
    processedAt: Date
  }): Promise<boolean>
  markFailed(input: {
    eventId: string
    claimAttempt: number
    status: 'failed' | 'dead_letter'
    errorCode: string
  }): Promise<boolean>
}

export type PaymentWebhookProcessingResult =
  | {
      outcome: 'processed'
      eventType: SupportedRazorpayWebhookEvent
      attempts: number
    }
  | {
      outcome: 'already_processed' | 'dead_letter' | 'busy'
      attempts: number
    }
  | {
      outcome: 'not_found'
      attempts: 0
    }
  | {
      outcome: 'failed'
      attempts: number
      willRetry: boolean
    }
  | {
      outcome: 'claim_lost'
      attempts: number
    }

export class PaymentWebhookProcessingInputError extends Error {
  readonly code: string

  constructor(code: string) {
    super('Stored payment webhook failed integrity validation')
    this.name = 'PaymentWebhookProcessingInputError'
    this.code = code
  }
}

function parseClaimedEnvelope(
  claimed: ClaimedPaymentWebhookEvent,
  keys: readonly WebhookPayloadEncryptionKey[],
): VerifiedPaymentWebhookEnvelope {
  if (
    claimed.rawPayloadStorage.strategy !== 'encrypted' ||
    claimed.rawPayloadStorage.algorithm !== 'aes-256-gcm' ||
    !claimed.rawPayloadStorage.ciphertext ||
    !claimed.rawPayloadStorage.keyVersion
  ) {
    throw new PaymentWebhookProcessingInputError(
      'payload_storage_not_decryptable',
    )
  }
  let rawBody: Buffer
  try {
    const key = resolveWebhookPayloadDecryptionKey(
      claimed.rawPayloadStorage.keyVersion,
      keys,
    )
    rawBody = decryptWebhookPayload({
      encrypted: claimed.rawPayloadStorage,
      context: {
        providerMode: claimed.providerMode,
        payloadHash: claimed.payloadHash,
        eventType: claimed.eventType,
      },
      decryptionKey: key,
    })
  } catch {
    throw new PaymentWebhookProcessingInputError(
      'payload_decryption_failed',
    )
  }

  const actualHash = createHash('sha256').update(rawBody).digest('hex')
  if (actualHash !== claimed.payloadHash) {
    throw new PaymentWebhookProcessingInputError('payload_hash_mismatch')
  }

  let json: unknown
  try {
    json = JSON.parse(rawBody.toString('utf8'))
  } catch {
    throw new PaymentWebhookProcessingInputError('payload_json_invalid')
  }
  const parsed = ProcessingEnvelopeSchema.safeParse(json)
  if (!parsed.success) {
    throw new PaymentWebhookProcessingInputError('payload_envelope_invalid')
  }
  if (parsed.data.event !== claimed.eventType) {
    throw new PaymentWebhookProcessingInputError('event_type_mismatch')
  }
  if (parsed.data.account_id !== claimed.razorpayAccountId) {
    throw new PaymentWebhookProcessingInputError('account_id_mismatch')
  }
  if (!supportedEventTypes.has(parsed.data.event)) {
    throw new PaymentWebhookProcessingInputError('event_type_unsupported')
  }

  return {
    inboxEventId: claimed.id,
    providerMode: claimed.providerMode,
    eventType: parsed.data.event as SupportedRazorpayWebhookEvent,
    ...(parsed.data.account_id
      ? { razorpayAccountId: parsed.data.account_id }
      : {}),
    ...(parsed.data.created_at !== undefined
      ? { providerCreatedAtEpochSeconds: parsed.data.created_at }
      : {}),
    payload: parsed.data.payload,
  }
}

const mongoPaymentWebhookProcessingStore: PaymentWebhookProcessingStore = {
  async claim({ eventId, staleBefore, maxAttempts }) {
    await connectDB()
    const claimed = await PaymentWebhookEvent.findOneAndUpdate(
      {
        _id: eventId,
        signatureVerified: true,
        attempts: { $lt: maxAttempts },
        $or: [
          { status: { $in: ['received', 'failed'] } },
          {
            status: 'processing',
            updatedAt: { $lte: staleBefore },
          },
        ],
      },
      {
        $set: { status: 'processing' },
        $unset: { lastError: 1, processedAt: 1 },
        $inc: { attempts: 1 },
      },
      { new: true, runValidators: true },
    ).lean<{
      _id: mongoose.Types.ObjectId
      providerMode: ProviderMode
      eventType: string
      razorpayAccountId?: string
      payloadHash: string
      rawPayloadStorage: ClaimedPaymentWebhookEvent['rawPayloadStorage']
      signatureVerified: true
      attempts: number
    }>()
    return claimed
      ? {
          id: claimed._id.toString(),
          providerMode: claimed.providerMode,
          eventType: claimed.eventType,
          razorpayAccountId: claimed.razorpayAccountId,
          payloadHash: claimed.payloadHash,
          rawPayloadStorage: claimed.rawPayloadStorage,
          signatureVerified: claimed.signatureVerified,
          attempts: claimed.attempts,
        }
      : null
  },

  async readStatus(eventId) {
    await connectDB()
    return PaymentWebhookEvent.findById(eventId)
      .select('status attempts')
      .lean<{
        status: PaymentWebhookEventStatus
        attempts: number
      }>()
  },

  async markProcessed({ eventId, claimAttempt, processedAt }) {
    await connectDB()
    const result = await PaymentWebhookEvent.updateOne(
      {
        _id: eventId,
        status: 'processing',
        attempts: claimAttempt,
      },
      {
        $set: { status: 'processed', processedAt },
        $unset: { lastError: 1 },
      },
      { runValidators: true },
    )
    return result.modifiedCount === 1
  },

  async markFailed({ eventId, claimAttempt, status, errorCode }) {
    await connectDB()
    const result = await PaymentWebhookEvent.updateOne(
      {
        _id: eventId,
        status: 'processing',
        attempts: claimAttempt,
      },
      {
        $set: {
          status,
          lastError: errorCode,
        },
      },
      { runValidators: true },
    )
    return result.modifiedCount === 1
  },
}

function skippedResult(
  status: PaymentWebhookEventStatus,
  attempts: number,
): PaymentWebhookProcessingResult {
  if (status === 'processed') {
    return { outcome: 'already_processed', attempts }
  }
  if (status === 'dead_letter') {
    return { outcome: 'dead_letter', attempts }
  }
  return { outcome: 'busy', attempts }
}

/**
 * Claims one durable inbox row, authenticates/decrypts it, and invokes the
 * injected domain dispatcher exactly once per successful claim. Handlers must
 * remain idempotent because a worker can crash after its side effect but before
 * the inbox row is marked processed.
 */
export async function processPaymentWebhookEvent(input: {
  eventId: string
  handler: PaymentWebhookHandler
  keys?: readonly WebhookPayloadEncryptionKey[]
  store?: PaymentWebhookProcessingStore
  now?: Date
  maxAttempts?: number
  staleClaimMs?: number
}): Promise<PaymentWebhookProcessingResult> {
  if (!mongoose.isValidObjectId(input.eventId)) {
    throw new TypeError('eventId must be a MongoDB ObjectId')
  }
  const now = input.now ?? new Date()
  const maxAttempts =
    input.maxAttempts ?? PAYMENT_WEBHOOK_MAX_PROCESSING_ATTEMPTS
  const staleClaimMs =
    input.staleClaimMs ?? PAYMENT_WEBHOOK_STALE_CLAIM_MS
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
    throw new TypeError('maxAttempts must be a positive safe integer')
  }
  if (!Number.isSafeInteger(staleClaimMs) || staleClaimMs < 1) {
    throw new TypeError('staleClaimMs must be a positive safe integer')
  }
  const store = input.store ?? mongoPaymentWebhookProcessingStore
  const claimed = await store.claim({
    eventId: input.eventId,
    now,
    staleBefore: new Date(now.getTime() - staleClaimMs),
    maxAttempts,
  })
  if (!claimed) {
    const current = await store.readStatus(input.eventId)
    return current
      ? skippedResult(current.status, current.attempts)
      : { outcome: 'not_found', attempts: 0 }
  }

  try {
    const keys = input.keys ?? loadWebhookPayloadEncryptionKeys()
    const envelope = parseClaimedEnvelope(claimed, keys)
    await input.handler(envelope)
    const completed = await store.markProcessed({
      eventId: claimed.id,
      claimAttempt: claimed.attempts,
      processedAt: now,
    })
    return completed
      ? {
          outcome: 'processed',
          eventType: envelope.eventType,
          attempts: claimed.attempts,
        }
      : { outcome: 'claim_lost', attempts: claimed.attempts }
  } catch (error) {
    const domainCode = (
      error instanceof Error &&
      error.name === 'WebhookDomainDispatchError' &&
      'code' in error &&
      typeof error.code === 'string' &&
      [
        'references_invalid',
        'provider_unavailable',
        'provider_mode_mismatch',
        'provider_reference_mismatch',
        'provider_state_not_ready',
        'local_store_unavailable',
        'local_mapping_missing',
        'local_mapping_mismatch',
        'financial_entity_reader_missing',
        'effect_handler_missing',
        'effect_failed',
        'effect_not_acknowledged',
        'capture_persistence_failed',
      ].includes(error.code)
    ) ? error.code : undefined
    const domainDisposition = (
      domainCode !== undefined &&
      error instanceof Error &&
      'disposition' in error &&
      (error.disposition === 'retry' || error.disposition === 'review')
    ) ? error.disposition : undefined
    const errorCode = error instanceof PaymentWebhookProcessingInputError
      ? error.code
      : domainCode ?? 'handler_failed'
    const terminal =
      domainDisposition === 'review' || claimed.attempts >= maxAttempts
    const updated = await store.markFailed({
      eventId: claimed.id,
      claimAttempt: claimed.attempts,
      status: terminal ? 'dead_letter' : 'failed',
      errorCode,
    })
    if (!updated) {
      return { outcome: 'claim_lost', attempts: claimed.attempts }
    }
    return terminal
      ? { outcome: 'dead_letter', attempts: claimed.attempts }
      : {
          outcome: 'failed',
          attempts: claimed.attempts,
          willRetry: true,
        }
  }
}
