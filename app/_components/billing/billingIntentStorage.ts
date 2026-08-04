import { z } from 'zod'

const AUTH_INTENT_KEY = 'ipg_billing_auth_intent_v1'
const CHECKOUT_RECOVERY_KEY = 'ipg_billing_checkout_v1'
const AUTH_INTENT_TTL_MS = 24 * 60 * 60 * 1_000
const CHECKOUT_RECOVERY_TTL_MS = 24 * 60 * 60 * 1_000

const PaidPlanKeySchema = z.enum(['plus', 'pro'])
const TimestampSchema = z.number().int().nonnegative().safe()

const BillingAuthIntentSchema = z.object({
  schemaVersion: z.literal(1),
  planKey: PaidPlanKeySchema,
  surface: z.enum(['pricing', 'settings']),
  createdAtMs: TimestampSchema,
  expiresAtMs: TimestampSchema,
}).strict()

const BillingCheckoutRecoverySchema = z.object({
  schemaVersion: z.literal(1),
  intentId: z.string().regex(/^[a-f\d]{24}$/i),
  planKey: PaidPlanKeySchema,
  catalogVersion: z.string().min(1).max(100),
  idempotencyKey: z.string().min(8).max(100),
  manualCouponCode: z.string().min(1).max(40).optional(),
  createdAtMs: TimestampSchema,
  expiresAtMs: TimestampSchema,
}).strict()

export type BillingAuthIntent = z.infer<typeof BillingAuthIntentSchema>
export type BillingCheckoutRecovery = z.infer<
  typeof BillingCheckoutRecoverySchema
>

function storage(): Storage | null {
  if (typeof window === 'undefined') return null
  try {
    return window.localStorage
  } catch {
    return null
  }
}

function readStored<T>(
  key: string,
  schema: z.ZodType<T>,
): T | null {
  const target = storage()
  if (!target) return null
  try {
    const raw = target.getItem(key)
    if (!raw) return null
    const parsed = schema.safeParse(JSON.parse(raw))
    if (
      !parsed.success ||
      !parsed.data ||
      typeof parsed.data !== 'object' ||
      !('expiresAtMs' in parsed.data) ||
      typeof parsed.data.expiresAtMs !== 'number' ||
      parsed.data.expiresAtMs <= Date.now()
    ) {
      target.removeItem(key)
      return null
    }
    return parsed.data
  } catch {
    try {
      target.removeItem(key)
    } catch {
      // Storage is optional. Failing closed means checkout can still restart.
    }
    return null
  }
}

function writeStored(key: string, value: object): boolean {
  const target = storage()
  if (!target) return false
  try {
    target.setItem(key, JSON.stringify(value))
    return true
  } catch {
    return false
  }
}

function removeStored(key: string): void {
  try {
    storage()?.removeItem(key)
  } catch {
    // Storage is a recovery enhancement, never a payment authority.
  }
}

export function saveBillingAuthIntent(
  planKey: 'plus' | 'pro',
  surface: 'pricing' | 'settings',
): BillingAuthIntent {
  const now = Date.now()
  const intent: BillingAuthIntent = {
    schemaVersion: 1,
    planKey,
    surface,
    createdAtMs: now,
    expiresAtMs: now + AUTH_INTENT_TTL_MS,
  }
  writeStored(AUTH_INTENT_KEY, intent)
  return intent
}

export function readBillingAuthIntent(): BillingAuthIntent | null {
  return readStored(AUTH_INTENT_KEY, BillingAuthIntentSchema)
}

export function clearBillingAuthIntent(): void {
  removeStored(AUTH_INTENT_KEY)
}

export function saveBillingCheckoutRecovery(input: {
  intentId: string
  planKey: 'plus' | 'pro'
  catalogVersion: string
  idempotencyKey: string
  manualCouponCode?: string
}): BillingCheckoutRecovery {
  const now = Date.now()
  const recovery: BillingCheckoutRecovery = {
    schemaVersion: 1,
    intentId: input.intentId,
    planKey: input.planKey,
    catalogVersion: input.catalogVersion,
    idempotencyKey: input.idempotencyKey,
    ...(input.manualCouponCode
      ? { manualCouponCode: input.manualCouponCode }
      : {}),
    createdAtMs: now,
    expiresAtMs: now + CHECKOUT_RECOVERY_TTL_MS,
  }
  writeStored(CHECKOUT_RECOVERY_KEY, recovery)
  return recovery
}

export function readBillingCheckoutRecovery():
  BillingCheckoutRecovery | null {
  return readStored(
    CHECKOUT_RECOVERY_KEY,
    BillingCheckoutRecoverySchema,
  )
}

export function clearBillingCheckoutRecovery(): void {
  removeStored(CHECKOUT_RECOVERY_KEY)
}

export function createBillingIdempotencyKey(): string {
  const random = globalThis.crypto?.randomUUID?.()
  if (random) return `billing-subscription:${random}`

  if (globalThis.crypto?.getRandomValues) {
    const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16))
    const token = Array.from(bytes, (byte) =>
      byte.toString(16).padStart(2, '0')).join('')
    return `billing-subscription:${token}`
  }

  return `billing-subscription:${Date.now()}:${Math.random()
    .toString(36)
    .slice(2)}`
}
