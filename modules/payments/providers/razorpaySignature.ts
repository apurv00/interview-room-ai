import { createHmac, timingSafeEqual } from 'node:crypto'
import type {
  RazorpayWebhookSigningSecret,
} from './razorpayEnvironment'

export interface RazorpaySignatureVerification {
  verified: boolean
  matchedSecretVersion?: RazorpayWebhookSigningSecret['version']
}

function requiredProtocolValue(value: string, label: string): string {
  if (!value || value.trim() !== value || value.length > 255) {
    throw new TypeError(`${label} must be a non-empty canonical value`)
  }
  return value
}

function requiredSecret(secret: string): string {
  if (!secret) {
    throw new TypeError('Razorpay signing secret is required')
  }
  return secret
}

function hmacSha256Hex(message: string | Uint8Array, secret: string): string {
  return createHmac('sha256', requiredSecret(secret))
    .update(message)
    .digest('hex')
}

function constantTimeHexMatch(expectedHex: string, candidate: string): boolean {
  if (!/^[a-fA-F0-9]{64}$/.test(candidate)) return false
  const expected = Buffer.from(expectedHex, 'hex')
  const supplied = Buffer.from(candidate, 'hex')
  return expected.length === supplied.length && timingSafeEqual(expected, supplied)
}

/**
 * Standard Checkout order callback:
 * HMAC_SHA256(trusted_server_order_id + "|" + payment_id, key_secret).
 *
 * The order id is deliberately named trustedOrderId: callers must load it
 * from the local CheckoutIntent and never trust the browser-returned order id.
 */
export function verifyRazorpayOrderCheckoutSignature(input: {
  trustedOrderId: string
  razorpayPaymentId: string
  signature: string
  keySecret: string
}): boolean {
  const orderId = requiredProtocolValue(input.trustedOrderId, 'Order id')
  const paymentId = requiredProtocolValue(
    input.razorpayPaymentId,
    'Payment id',
  )
  const expected = hmacSha256Hex(
    `${orderId}|${paymentId}`,
    input.keySecret,
  )
  return constantTimeHexMatch(expected, input.signature)
}

/**
 * Subscription Checkout callback uses the provider-documented inverse
 * identifier order: payment_id + "|" + trusted_server_subscription_id.
 */
export function verifyRazorpaySubscriptionCheckoutSignature(input: {
  razorpayPaymentId: string
  trustedSubscriptionId: string
  signature: string
  keySecret: string
}): boolean {
  const paymentId = requiredProtocolValue(
    input.razorpayPaymentId,
    'Payment id',
  )
  const subscriptionId = requiredProtocolValue(
    input.trustedSubscriptionId,
    'Subscription id',
  )
  const expected = hmacSha256Hex(
    `${paymentId}|${subscriptionId}`,
    input.keySecret,
  )
  return constantTimeHexMatch(expected, input.signature)
}

/**
 * Verify the exact raw webhook bytes against every retained signing secret.
 * The function evaluates every secret even after a match, avoiding a
 * secret-position timing signal during rotation.
 */
export function verifyRazorpayWebhookSignature(input: {
  rawBody: Uint8Array
  signature: string
  signingSecrets: readonly RazorpayWebhookSigningSecret[]
}): RazorpaySignatureVerification {
  const rawBodyTag = Object.prototype.toString.call(input.rawBody)
  if (
    !Buffer.isBuffer(input.rawBody) &&
    rawBodyTag !== '[object Uint8Array]'
  ) {
    throw new TypeError('Webhook signature verification requires raw bytes')
  }
  if (input.signingSecrets.length === 0) {
    throw new TypeError('At least one Razorpay webhook secret is required')
  }

  let matchedSecretVersion:
    | RazorpayWebhookSigningSecret['version']
    | undefined
  for (const signingSecret of input.signingSecrets) {
    const expected = hmacSha256Hex(input.rawBody, signingSecret.value)
    if (constantTimeHexMatch(expected, input.signature)) {
      matchedSecretVersion = signingSecret.version
    }
  }
  return {
    verified: matchedSecretVersion !== undefined,
    ...(matchedSecretVersion ? { matchedSecretVersion } : {}),
  }
}
