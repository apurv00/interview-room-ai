import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from 'node:crypto'
import { z } from 'zod'
import type { ProviderMode } from '../types/catalog'

const AES_256_KEY_BYTES = 32
const GCM_IV_BYTES = 12
const GCM_AUTH_TAG_BYTES = 16

export const PAYMENT_WEBHOOK_PAYLOAD_KEY_ENV = {
  keyBase64: 'PAYMENT_WEBHOOK_PAYLOAD_KEY_BASE64',
  keyVersion: 'PAYMENT_WEBHOOK_PAYLOAD_KEY_VERSION',
  previousKeyBase64: 'PAYMENT_WEBHOOK_PAYLOAD_PREVIOUS_KEY_BASE64',
  previousKeyVersion: 'PAYMENT_WEBHOOK_PAYLOAD_PREVIOUS_KEY_VERSION',
} as const

export interface WebhookPayloadEncryptionKey {
  version: string
  key: Uint8Array
}

export interface WebhookPayloadCipherContext {
  providerMode: ProviderMode
  payloadHash: string
  eventType: string
}

export interface EncryptedWebhookPayload {
  algorithm: 'aes-256-gcm'
  keyVersion: string
  ciphertext: string
}

export class WebhookPayloadCipherConfigurationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WebhookPayloadCipherConfigurationError'
  }
}

const KeyVersionSchema = z.string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[a-zA-Z0-9._-]+$/)

function decodeBase64Key(value: string, environmentName: string): Buffer {
  if (!/^[a-zA-Z0-9+/]+={0,2}$/.test(value)) {
    throw new WebhookPayloadCipherConfigurationError(
      `${environmentName} must be canonical base64`,
    )
  }
  const decoded = Buffer.from(value, 'base64')
  if (
    decoded.length !== AES_256_KEY_BYTES ||
    decoded.toString('base64') !== value
  ) {
    throw new WebhookPayloadCipherConfigurationError(
      `${environmentName} must encode exactly 32 bytes`,
    )
  }
  return decoded
}

/** Lazy lookup so all-off builds do not require a webhook encryption key. */
export function loadWebhookPayloadEncryptionKey(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): WebhookPayloadEncryptionKey {
  const encodedKey =
    environment[PAYMENT_WEBHOOK_PAYLOAD_KEY_ENV.keyBase64]?.trim()
  const versionResult = KeyVersionSchema.safeParse(
    environment[PAYMENT_WEBHOOK_PAYLOAD_KEY_ENV.keyVersion],
  )
  if (!encodedKey) {
    throw new WebhookPayloadCipherConfigurationError(
      `Missing ${PAYMENT_WEBHOOK_PAYLOAD_KEY_ENV.keyBase64}`,
    )
  }
  if (!versionResult.success) {
    throw new WebhookPayloadCipherConfigurationError(
      `Missing or invalid ${PAYMENT_WEBHOOK_PAYLOAD_KEY_ENV.keyVersion}`,
    )
  }
  return {
    version: versionResult.data,
    key: decodeBase64Key(
      encodedKey,
      PAYMENT_WEBHOOK_PAYLOAD_KEY_ENV.keyBase64,
    ),
  }
}

/**
 * Loads the current key and, during rotation, one retained previous key.
 * Receipt encryption always uses `keys[0]`; processing resolves the recorded
 * key version so queued events survive a deployment-time rotation.
 */
export function loadWebhookPayloadEncryptionKeys(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): readonly WebhookPayloadEncryptionKey[] {
  const current = loadWebhookPayloadEncryptionKey(environment)
  const previousEncoded =
    environment[PAYMENT_WEBHOOK_PAYLOAD_KEY_ENV.previousKeyBase64]?.trim()
  const previousVersionRaw =
    environment[PAYMENT_WEBHOOK_PAYLOAD_KEY_ENV.previousKeyVersion]
  if (!previousEncoded && !previousVersionRaw) return [current]
  if (!previousEncoded || !previousVersionRaw) {
    throw new WebhookPayloadCipherConfigurationError(
      'Previous webhook payload key and version must be configured together',
    )
  }
  const previousVersion = KeyVersionSchema.safeParse(previousVersionRaw)
  if (!previousVersion.success) {
    throw new WebhookPayloadCipherConfigurationError(
      `Invalid ${PAYMENT_WEBHOOK_PAYLOAD_KEY_ENV.previousKeyVersion}`,
    )
  }
  if (previousVersion.data === current.version) {
    throw new WebhookPayloadCipherConfigurationError(
      'Current and previous webhook payload key versions must differ',
    )
  }
  const previous = {
    version: previousVersion.data,
    key: decodeBase64Key(
      previousEncoded,
      PAYMENT_WEBHOOK_PAYLOAD_KEY_ENV.previousKeyBase64,
    ),
  }
  if (
    Buffer.from(previous.key).equals(Buffer.from(current.key))
  ) {
    throw new WebhookPayloadCipherConfigurationError(
      'Current and previous webhook payload keys must differ',
    )
  }
  return [current, previous]
}

export function resolveWebhookPayloadDecryptionKey(
  keyVersion: string,
  keys: readonly WebhookPayloadEncryptionKey[],
): WebhookPayloadEncryptionKey {
  const matched = keys.find((key) => key.version === keyVersion)
  if (!matched) {
    throw new WebhookPayloadCipherConfigurationError(
      'No retained webhook payload key matches the recorded version',
    )
  }
  return matched
}

function additionalAuthenticatedData(
  context: WebhookPayloadCipherContext,
): Buffer {
  if (!/^[a-f0-9]{64}$/.test(context.payloadHash)) {
    throw new TypeError('Webhook payload hash must be lowercase SHA-256 hex')
  }
  if (
    !context.eventType ||
    context.eventType.trim() !== context.eventType ||
    context.eventType.length > 255
  ) {
    throw new TypeError('Webhook event type must be canonical')
  }
  return Buffer.from(JSON.stringify({
    eventType: context.eventType,
    payloadHash: context.payloadHash,
    providerMode: context.providerMode,
    schemaVersion: 1,
  }), 'utf8')
}

/**
 * Ciphertext wire format is base64(iv || authTag || ciphertext). The provider
 * mode, payload hash, and event type are authenticated but not encrypted,
 * preventing a stored body from being swapped between inbox rows.
 */
export function encryptWebhookPayload(input: {
  rawBody: Uint8Array
  context: WebhookPayloadCipherContext
  encryptionKey: WebhookPayloadEncryptionKey
  iv?: Uint8Array
}): EncryptedWebhookPayload {
  const key = Buffer.from(input.encryptionKey.key)
  if (key.length !== AES_256_KEY_BYTES) {
    throw new TypeError('Webhook payload encryption key must be 32 bytes')
  }
  const iv = input.iv ? Buffer.from(input.iv) : randomBytes(GCM_IV_BYTES)
  if (iv.length !== GCM_IV_BYTES) {
    throw new TypeError('Webhook payload encryption IV must be 12 bytes')
  }

  const cipher = createCipheriv('aes-256-gcm', key, iv, {
    authTagLength: GCM_AUTH_TAG_BYTES,
  })
  cipher.setAAD(additionalAuthenticatedData(input.context))
  const encrypted = Buffer.concat([
    cipher.update(Buffer.from(input.rawBody)),
    cipher.final(),
  ])
  const authTag = cipher.getAuthTag()
  return {
    algorithm: 'aes-256-gcm',
    keyVersion: input.encryptionKey.version,
    ciphertext: Buffer.concat([iv, authTag, encrypted]).toString('base64'),
  }
}

export function decryptWebhookPayload(input: {
  encrypted: EncryptedWebhookPayload
  context: WebhookPayloadCipherContext
  decryptionKey: WebhookPayloadEncryptionKey
}): Buffer {
  if (input.encrypted.algorithm !== 'aes-256-gcm') {
    throw new TypeError('Unsupported webhook payload cipher')
  }
  if (input.encrypted.keyVersion !== input.decryptionKey.version) {
    throw new TypeError('Webhook payload key version mismatch')
  }

  const key = Buffer.from(input.decryptionKey.key)
  if (key.length !== AES_256_KEY_BYTES) {
    throw new TypeError('Webhook payload decryption key must be 32 bytes')
  }
  const packed = Buffer.from(input.encrypted.ciphertext, 'base64')
  if (packed.length < GCM_IV_BYTES + GCM_AUTH_TAG_BYTES) {
    throw new TypeError('Malformed encrypted webhook payload')
  }
  const iv = packed.subarray(0, GCM_IV_BYTES)
  const authTag = packed.subarray(
    GCM_IV_BYTES,
    GCM_IV_BYTES + GCM_AUTH_TAG_BYTES,
  )
  const ciphertext = packed.subarray(GCM_IV_BYTES + GCM_AUTH_TAG_BYTES)
  const decipher = createDecipheriv('aes-256-gcm', key, iv, {
    authTagLength: GCM_AUTH_TAG_BYTES,
  })
  decipher.setAAD(additionalAuthenticatedData(input.context))
  decipher.setAuthTag(authTag)
  return Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ])
}
