import { createHmac } from 'crypto'
import { redis } from '@shared/redis'

const WINDOW_MS = 60_000

const POLICIES = {
  quote: { limit: 30, windowMs: WINDOW_MS },
  checkout: { limit: 10, windowMs: WINDOW_MS },
  verify: { limit: 10, windowMs: WINDOW_MS },
  status: { limit: 60, windowMs: WINDOW_MS },
  read: { limit: 120, windowMs: WINDOW_MS },
  profile: { limit: 20, windowMs: WINDOW_MS },
} as const

const FIXED_WINDOW_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
local ttl = redis.call('PTTL', KEYS[1])
return {count, ttl}
`

export type BillingRouteRateLimitScope = keyof typeof POLICIES

export interface BillingRouteRateLimitDecision {
  allowed: boolean
  limit: number
  remaining: number
  retryAfterSeconds: number
}

export interface BillingRouteRateLimitRedis {
  eval(
    script: string,
    numberOfKeys: number,
    ...args: Array<string | number>
  ): Promise<unknown>
}

export interface BillingRouteRateLimitDependencies {
  redis: BillingRouteRateLimitRedis
  secretBase64: string | undefined
}

export class BillingRouteRateLimitUnavailableError extends Error {
  constructor() {
    super('Billing route rate limiting is unavailable')
    this.name = 'BillingRouteRateLimitUnavailableError'
  }
}

function decodeSecret(secretBase64: string | undefined): Buffer {
  if (
    !secretBase64 ||
    secretBase64.trim() !== secretBase64 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      secretBase64,
    )
  ) {
    throw new BillingRouteRateLimitUnavailableError()
  }

  const secret = Buffer.from(secretBase64, 'base64')
  if (
    secret.length < 32 ||
    secret.toString('base64') !== secretBase64
  ) {
    throw new BillingRouteRateLimitUnavailableError()
  }
  return secret
}

function integer(value: unknown): number | null {
  if (typeof value === 'number' && Number.isSafeInteger(value)) {
    return value
  }
  if (
    typeof value === 'string' &&
    /^\d+$/.test(value)
  ) {
    const parsed = Number(value)
    return Number.isSafeInteger(parsed) ? parsed : null
  }
  return null
}

function resultTuple(result: unknown): [number, number] {
  if (!Array.isArray(result) || result.length !== 2) {
    throw new BillingRouteRateLimitUnavailableError()
  }
  const count = integer(result[0])
  const ttlMs = integer(result[1])
  if (count === null || count < 1 || ttlMs === null || ttlMs < 1) {
    throw new BillingRouteRateLimitUnavailableError()
  }
  return [count, ttlMs]
}

const defaultDependencies: BillingRouteRateLimitDependencies = {
  redis: {
    eval: (script, numberOfKeys, ...args) => (
      redis.eval(script, numberOfKeys, ...args)
    ),
  },
  secretBase64:
    process.env.BILLING_RATE_LIMIT_HMAC_SECRET_BASE64,
}

export async function checkBillingRouteRateLimit(
  input: {
    userId: string
    scope: BillingRouteRateLimitScope
  },
  dependencies: BillingRouteRateLimitDependencies = defaultDependencies,
): Promise<BillingRouteRateLimitDecision> {
  try {
    const policy = POLICIES[input.scope]
    const secret = decodeSecret(dependencies.secretBase64)
    const subject = createHmac('sha256', secret)
      .update(input.userId, 'utf8')
      .digest('hex')
    secret.fill(0)

    const key = `billing-route-limit:v1:${input.scope}:${subject}`
    const result = await dependencies.redis.eval(
      FIXED_WINDOW_SCRIPT,
      1,
      key,
      policy.windowMs,
    )
    const [count, ttlMs] = resultTuple(result)
    const allowed = count <= policy.limit

    return {
      allowed,
      limit: policy.limit,
      remaining: Math.max(0, policy.limit - count),
      retryAfterSeconds: allowed
        ? 0
        : Math.max(1, Math.ceil(ttlMs / 1_000)),
    }
  } catch {
    throw new BillingRouteRateLimitUnavailableError()
  }
}
