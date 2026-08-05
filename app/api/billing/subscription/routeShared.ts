import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import type { ZodType } from 'zod'
import { authOptions } from '@shared/auth/authOptions'
import { logger } from '@shared/logger'
import {
  checkBillingRouteRateLimit,
} from '@payments/services/billingRouteRateLimitService'
import {
  SubscriptionLifecycleError,
} from '@payments/services/subscriptionLifecycleService'
import {
  CustomerBillingIdempotencyKeySchema,
} from '@payments/validators/customerBilling'

const MAX_BODY_BYTES = 512
const lifecycleLogger = logger.child({
  module: 'subscription-lifecycle-route',
})

class LifecycleBodyError extends Error {
  constructor(readonly status: 413 | 415) {
    super('Invalid lifecycle request body')
  }
}

function json(
  body: object,
  status: number,
  headers: Record<string, string> = {},
) {
  return NextResponse.json(body, {
    status,
    headers: {
      'Cache-Control': 'no-store, private',
      ...headers,
    },
  })
}

async function readJson(request: NextRequest): Promise<unknown> {
  const mediaType = (request.headers.get('content-type') ?? '')
    .split(';', 1)[0]?.trim().toLowerCase()
  if (mediaType !== 'application/json') {
    throw new LifecycleBodyError(415)
  }
  const declared = request.headers.get('content-length')
  if (
    declared !== null &&
    /^\d+$/.test(declared) &&
    Number(declared) > MAX_BODY_BYTES
  ) {
    throw new LifecycleBodyError(413)
  }
  if (!request.body) return JSON.parse('')
  const reader = request.body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let bytes = 0
  let body = ''
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      bytes += chunk.value.byteLength
      if (bytes > MAX_BODY_BYTES) {
        await reader.cancel().catch(() => undefined)
        throw new LifecycleBodyError(413)
      }
      body += decoder.decode(chunk.value, { stream: true })
    }
    body += decoder.decode()
  } finally {
    reader.releaseLock()
  }
  return JSON.parse(body)
}

function lifecycleFailure(error: SubscriptionLifecycleError) {
  switch (error.code) {
    case 'invalid_request':
    case 'signature_invalid':
      return json({ error: 'Invalid subscription lifecycle request' }, 400)
    case 'not_found':
      return json({ error: 'Subscription lifecycle was not found' }, 404)
    case 'lifecycle_conflict':
    case 'commercial_conflict':
    case 'persistence_conflict':
    case 'review_required':
      return json({ error: 'Subscription lifecycle requires review' }, 409)
    case 'sale_blocked':
    case 'provider_unavailable':
      return json(
        { error: 'Subscription lifecycle is temporarily unavailable' },
        503,
        { 'Retry-After': '5' },
      )
  }
}

export async function handleSubscriptionLifecycle<T>(
  request: NextRequest,
  input: {
    ready: boolean
    schema: ZodType<T>
    execute: (
      userId: string,
      idempotencyKey: string,
      body: T,
    ) => Promise<object & { reused?: boolean }>
    accepted?: boolean
  },
) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return json({ error: 'Unauthorized' }, 401)
  try {
    const rateLimit = await checkBillingRouteRateLimit({
      userId: session.user.id,
      scope: 'checkout',
    })
    if (!rateLimit.allowed) {
      return json(
        { error: 'Too many billing requests' },
        429,
        { 'Retry-After': String(rateLimit.retryAfterSeconds) },
      )
    }
  } catch {
    return json(
      { error: 'Billing request is temporarily unavailable' },
      503,
      { 'Retry-After': '5' },
    )
  }
  if (!input.ready) {
    return json(
      { error: 'Subscription lifecycle is not available yet' },
      503,
      { 'Retry-After': '30' },
    )
  }
  let body: T
  let idempotencyKey: string
  try {
    idempotencyKey = CustomerBillingIdempotencyKeySchema.parse(
      request.headers.get('idempotency-key'),
    )
    body = input.schema.parse(await readJson(request))
  } catch (error) {
    if (error instanceof LifecycleBodyError) {
      return json(
        { error: 'Invalid subscription lifecycle request' },
        error.status,
      )
    }
    return json({ error: 'Invalid subscription lifecycle request' }, 400)
  }
  try {
    const result = await input.execute(
      session.user.id,
      idempotencyKey,
      body,
    )
    const status = result.reused
      ? 200
      : input.accepted ? 202 : 201
    return json(
      result,
      status,
      status === 202 ? { 'Retry-After': '2' } : {},
    )
  } catch (error) {
    lifecycleLogger.warn(
      {
        errorCode: error instanceof SubscriptionLifecycleError
          ? error.code
          : 'unexpected',
      },
      'Subscription lifecycle request failed',
    )
    return error instanceof SubscriptionLifecycleError
      ? lifecycleFailure(error)
      : json(
          { error: 'Subscription lifecycle is temporarily unavailable' },
          503,
          { 'Retry-After': '5' },
        )
  }
}
