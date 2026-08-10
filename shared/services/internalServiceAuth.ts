import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { redis } from '@shared/redis'

export const INTERNAL_SERVICE_AUTH_HEADERS = {
  keyId: 'x-ipg-key-id',
  timestamp: 'x-ipg-timestamp',
  nonce: 'x-ipg-nonce',
  signature: 'x-ipg-signature',
} as const

const MAX_CLOCK_SKEW_SECONDS = 60
const REPLAY_TTL_SECONDS = 2 * MAX_CLOCK_SKEW_SECONDS
const NONCE_PATTERN = /^[a-f0-9]{64}$/i
const SIGNATURE_PATTERN = /^[a-f0-9]{64}$/i

export interface InternalServiceKey {
  keyId: string
  secret: string
}

export interface InternalServiceReplayStore {
  /** Return true only when this nonce was absent and is now claimed. */
  claim(key: string, ttlSeconds: number): Promise<boolean>
}

export type InternalServiceAuthResult =
  | { ok: true; keyId: string; timestamp: number; nonce: string }
  | {
      ok: false
      reason:
        | 'unconfigured'
        | 'malformed'
        | 'expired'
        | 'invalid-signature'
        | 'replayed'
        | 'replay-store-unavailable'
    }

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function requireSigningKey(key?: InternalServiceKey): InternalServiceKey {
  const resolved = key ?? {
    keyId: process.env.HIRE_ENGINE_BRIDGE_KEY_ID || 'current',
    secret: process.env.HIRE_ENGINE_BRIDGE_SECRET || '',
  }
  if (!resolved.keyId || resolved.secret.length < 32) {
    throw new Error('Hire engine bridge signing key is not configured securely')
  }
  return resolved
}

function configuredVerificationKeys(): InternalServiceKey[] {
  const keys: InternalServiceKey[] = []
  if (process.env.HIRE_ENGINE_BRIDGE_SECRET) {
    keys.push({
      keyId: process.env.HIRE_ENGINE_BRIDGE_KEY_ID || 'current',
      secret: process.env.HIRE_ENGINE_BRIDGE_SECRET,
    })
  }
  if (process.env.HIRE_ENGINE_BRIDGE_SECRET_PREVIOUS) {
    keys.push({
      keyId: process.env.HIRE_ENGINE_BRIDGE_KEY_ID_PREVIOUS || 'previous',
      secret: process.env.HIRE_ENGINE_BRIDGE_SECRET_PREVIOUS,
    })
  }
  return keys.filter((key) => key.secret.length >= 32)
}

export function internalServiceCanonicalMessage(input: {
  method: string
  path: string
  timestamp: number
  nonce: string
  body: string
}): string {
  return [
    input.method.toUpperCase(),
    input.path,
    String(input.timestamp),
    input.nonce.toLowerCase(),
    sha256(input.body),
  ].join('\n')
}

export function createInternalServiceHeaders(input: {
  method: string
  path: string
  body: string
  key?: InternalServiceKey
  now?: Date
  nonce?: string
}): Record<string, string> {
  const key = requireSigningKey(input.key)
  const timestamp = Math.floor((input.now ?? new Date()).getTime() / 1_000)
  const nonce = (input.nonce ?? randomBytes(32).toString('hex')).toLowerCase()
  if (!NONCE_PATTERN.test(nonce)) throw new Error('Internal service nonce must be 32 bytes')
  const message = internalServiceCanonicalMessage({
    method: input.method,
    path: input.path,
    timestamp,
    nonce,
    body: input.body,
  })
  const signature = createHmac('sha256', key.secret).update(message).digest('hex')
  return {
    [INTERNAL_SERVICE_AUTH_HEADERS.keyId]: key.keyId,
    [INTERNAL_SERVICE_AUTH_HEADERS.timestamp]: String(timestamp),
    [INTERNAL_SERVICE_AUTH_HEADERS.nonce]: nonce,
    [INTERNAL_SERVICE_AUTH_HEADERS.signature]: signature,
  }
}

function headerValue(headers: Headers | Record<string, string | undefined>, name: string) {
  if (headers instanceof Headers) return headers.get(name) ?? undefined
  return headers[name] ?? headers[name.toLowerCase()]
}

const redisReplayStore: InternalServiceReplayStore = {
  async claim(key, ttlSeconds) {
    const claimed = await redis.set(key, '1', 'EX', ttlSeconds, 'NX')
    return claimed === 'OK'
  },
}

export async function verifyInternalServiceRequest(input: {
  method: string
  path: string
  body: string
  headers: Headers | Record<string, string | undefined>
  keys?: InternalServiceKey[]
  replayStore?: InternalServiceReplayStore
  now?: Date
}): Promise<InternalServiceAuthResult> {
  const keys = input.keys ?? configuredVerificationKeys()
  if (keys.length === 0) return { ok: false, reason: 'unconfigured' }

  const keyId = headerValue(input.headers, INTERNAL_SERVICE_AUTH_HEADERS.keyId)
  const timestampRaw = headerValue(input.headers, INTERNAL_SERVICE_AUTH_HEADERS.timestamp)
  const nonce = headerValue(input.headers, INTERNAL_SERVICE_AUTH_HEADERS.nonce)?.toLowerCase()
  const signature = headerValue(input.headers, INTERNAL_SERVICE_AUTH_HEADERS.signature)?.toLowerCase()
  if (
    !keyId ||
    !timestampRaw ||
    !nonce ||
    !signature ||
    !NONCE_PATTERN.test(nonce) ||
    !SIGNATURE_PATTERN.test(signature)
  ) {
    return { ok: false, reason: 'malformed' }
  }

  const timestamp = Number(timestampRaw)
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0) {
    return { ok: false, reason: 'malformed' }
  }
  const nowSeconds = Math.floor((input.now ?? new Date()).getTime() / 1_000)
  if (Math.abs(nowSeconds - timestamp) > MAX_CLOCK_SKEW_SECONDS) {
    return { ok: false, reason: 'expired' }
  }

  const key = keys.find((candidate) => candidate.keyId === keyId)
  if (!key || key.secret.length < 32) return { ok: false, reason: 'invalid-signature' }
  const message = internalServiceCanonicalMessage({
    method: input.method,
    path: input.path,
    timestamp,
    nonce,
    body: input.body,
  })
  const expected = createHmac('sha256', key.secret).update(message).digest()
  const supplied = Buffer.from(signature, 'hex')
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    return { ok: false, reason: 'invalid-signature' }
  }

  const replayStore = input.replayStore ?? redisReplayStore
  try {
    const claimed = await replayStore.claim(
      `hire-engine:internal-auth:${keyId}:${nonce}`,
      REPLAY_TTL_SECONDS,
    )
    if (!claimed) return { ok: false, reason: 'replayed' }
  } catch {
    // Internal mutations fail closed if replay protection is unavailable.
    return { ok: false, reason: 'replay-store-unavailable' }
  }

  return { ok: true, keyId, timestamp, nonce }
}

export const __internalServiceAuth = {
  MAX_CLOCK_SKEW_SECONDS,
  REPLAY_TTL_SECONDS,
}
