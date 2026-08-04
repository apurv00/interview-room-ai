import type { ProviderMode } from '../types/catalog'
import type { SupportedRazorpayWebhookEvent } from './webhookInboxService'
import type {
  VerifiedPaymentWebhookEnvelope,
} from './webhookProcessingService'

const PAYMENT_EVENTS = [
  'payment.authorized',
  'payment.captured',
  'payment.failed',
] as const

const SUBSCRIPTION_EVENTS = [
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
] as const

const REFUND_EVENTS = [
  'refund.created',
  'refund.processed',
  'refund.failed',
  'refund.speed_changed',
] as const

const DISPUTE_EVENTS = [
  'payment.dispute.created',
  'payment.dispute.won',
  'payment.dispute.lost',
  'payment.dispute.closed',
  'payment.dispute.under_review',
  'payment.dispute.action_required',
] as const

type PaymentEvent = (typeof PAYMENT_EVENTS)[number]
type SubscriptionEvent = (typeof SUBSCRIPTION_EVENTS)[number]
type SubscriptionEventWithoutRequiredPayment = Exclude<
  SubscriptionEvent,
  'subscription.charged'
>
type RefundEvent = (typeof REFUND_EVENTS)[number]
type DisputeEvent = (typeof DISPUTE_EVENTS)[number]

type WebhookReferenceFamily =
  | 'order'
  | 'payment'
  | 'subscription'
  | 'refund'
  | 'dispute'

const EVENT_FAMILY = {
  'order.paid': 'order',
  'payment.authorized': 'payment',
  'payment.captured': 'payment',
  'payment.failed': 'payment',
  'subscription.authenticated': 'subscription',
  'subscription.activated': 'subscription',
  'subscription.charged': 'subscription',
  'subscription.completed': 'subscription',
  'subscription.updated': 'subscription',
  'subscription.pending': 'subscription',
  'subscription.halted': 'subscription',
  'subscription.cancelled': 'subscription',
  'subscription.paused': 'subscription',
  'subscription.resumed': 'subscription',
  'refund.created': 'refund',
  'refund.processed': 'refund',
  'refund.failed': 'refund',
  'refund.speed_changed': 'refund',
  'payment.dispute.created': 'dispute',
  'payment.dispute.won': 'dispute',
  'payment.dispute.lost': 'dispute',
  'payment.dispute.closed': 'dispute',
  'payment.dispute.under_review': 'dispute',
  'payment.dispute.action_required': 'dispute',
} as const satisfies Record<
  SupportedRazorpayWebhookEvent,
  WebhookReferenceFamily
>

export const WEBHOOK_REFERENCE_ERROR_CODES = [
  'event_type_unsupported',
  'payload_invalid',
  'order_entity_missing',
  'order_entity_tag_invalid',
  'order_id_missing',
  'order_id_invalid',
  'payment_entity_missing',
  'payment_entity_tag_invalid',
  'payment_id_missing',
  'payment_id_invalid',
  'payment_order_id_missing',
  'payment_order_id_invalid',
  'payment_order_id_mismatch',
  'payment_invoice_id_invalid',
  'subscription_entity_missing',
  'subscription_entity_tag_invalid',
  'subscription_id_missing',
  'subscription_id_invalid',
  'subscription_payment_missing',
  'refund_entity_missing',
  'refund_entity_tag_invalid',
  'refund_id_missing',
  'refund_id_invalid',
  'refund_payment_id_missing',
  'refund_payment_id_invalid',
  'refund_payment_id_mismatch',
  'dispute_entity_missing',
  'dispute_entity_tag_invalid',
  'dispute_id_missing',
  'dispute_id_invalid',
  'dispute_payment_id_missing',
  'dispute_payment_id_invalid',
  'dispute_payment_id_mismatch',
] as const

export type WebhookReferenceErrorCode =
  (typeof WEBHOOK_REFERENCE_ERROR_CODES)[number]

export class WebhookReferenceParseError extends Error {
  readonly code: WebhookReferenceErrorCode

  constructor(code: WebhookReferenceErrorCode) {
    super('Verified Razorpay webhook references are invalid')
    this.name = 'WebhookReferenceParseError'
    this.code = code
  }
}

interface WebhookReferenceContext {
  inboxEventId: string
  providerMode: ProviderMode
}

interface PaymentCorrelationReferences {
  razorpayPaymentId: string
  razorpayOrderId?: string
  razorpayInvoiceId?: string
}

export interface OrderPaidWebhookReferences
  extends WebhookReferenceContext,
  PaymentCorrelationReferences {
  kind: 'order'
  eventType: 'order.paid'
  razorpayOrderId: string
}

export interface PaymentWebhookReferences
  extends WebhookReferenceContext,
  PaymentCorrelationReferences {
  kind: 'payment'
  eventType: PaymentEvent
}

export interface SubscriptionChargedWebhookReferences
  extends WebhookReferenceContext,
  PaymentCorrelationReferences {
  kind: 'subscription'
  eventType: 'subscription.charged'
  razorpaySubscriptionId: string
}

export interface SubscriptionStateWebhookReferences
  extends WebhookReferenceContext {
  kind: 'subscription'
  eventType: SubscriptionEventWithoutRequiredPayment
  razorpaySubscriptionId: string
  razorpayPaymentId?: string
  razorpayOrderId?: string
  razorpayInvoiceId?: string
}

export interface RefundWebhookReferences
  extends WebhookReferenceContext,
  PaymentCorrelationReferences {
  kind: 'refund'
  eventType: RefundEvent
  razorpayRefundId: string
}

export interface DisputeWebhookReferences
  extends WebhookReferenceContext,
  PaymentCorrelationReferences {
  kind: 'dispute'
  eventType: DisputeEvent
  razorpayDisputeId: string
}

export type NormalizedRazorpayWebhookReferences =
  | OrderPaidWebhookReferences
  | PaymentWebhookReferences
  | SubscriptionChargedWebhookReferences
  | SubscriptionStateWebhookReferences
  | RefundWebhookReferences
  | DisputeWebhookReferences

type RazorpayEntityName =
  | 'order'
  | 'payment'
  | 'subscription'
  | 'refund'
  | 'dispute'

interface RequiredEntityErrorCodes {
  missing: WebhookReferenceErrorCode
  invalidTag: WebhookReferenceErrorCode
}

interface RequiredIdErrorCodes {
  missing: WebhookReferenceErrorCode
  invalid: WebhookReferenceErrorCode
}

const ENTITY_ERRORS: Record<
  RazorpayEntityName,
  RequiredEntityErrorCodes
> = {
  order: {
    missing: 'order_entity_missing',
    invalidTag: 'order_entity_tag_invalid',
  },
  payment: {
    missing: 'payment_entity_missing',
    invalidTag: 'payment_entity_tag_invalid',
  },
  subscription: {
    missing: 'subscription_entity_missing',
    invalidTag: 'subscription_entity_tag_invalid',
  },
  refund: {
    missing: 'refund_entity_missing',
    invalidTag: 'refund_entity_tag_invalid',
  },
  dispute: {
    missing: 'dispute_entity_missing',
    invalidTag: 'dispute_entity_tag_invalid',
  },
}

const ENTITY_ID_ERRORS: Record<
  RazorpayEntityName,
  RequiredIdErrorCodes
> = {
  order: {
    missing: 'order_id_missing',
    invalid: 'order_id_invalid',
  },
  payment: {
    missing: 'payment_id_missing',
    invalid: 'payment_id_invalid',
  },
  subscription: {
    missing: 'subscription_id_missing',
    invalid: 'subscription_id_invalid',
  },
  refund: {
    missing: 'refund_id_missing',
    invalid: 'refund_id_invalid',
  },
  dispute: {
    missing: 'dispute_id_missing',
    invalid: 'dispute_id_invalid',
  },
}

const ENTITY_ID_PREFIX: Record<RazorpayEntityName, string> = {
  order: 'order',
  payment: 'pay',
  subscription: 'sub',
  refund: 'rfnd',
  dispute: 'disp',
}

function fail(code: WebhookReferenceErrorCode): never {
  throw new WebhookReferenceParseError(code)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(
    value &&
    typeof value === 'object' &&
    !Array.isArray(value),
  )
}

/**
 * Razorpay-generated resource IDs in the documented webhook payloads use a
 * resource prefix followed by a 14-character alphanumeric identifier.
 * Payload shapes: https://razorpay.com/docs/webhooks/
 */
function isCanonicalRazorpayId(
  value: unknown,
  prefix: string,
): value is string {
  return (
    typeof value === 'string' &&
    new RegExp(`^${prefix}_[A-Za-z0-9]{14}$`).test(value)
  )
}

function requireEntity(
  payload: Record<string, unknown>,
  name: RazorpayEntityName,
): Record<string, unknown> {
  const wrapper = payload[name]
  const errors = ENTITY_ERRORS[name]
  if (!isRecord(wrapper) || !isRecord(wrapper.entity)) {
    return fail(errors.missing)
  }
  if (wrapper.entity.entity !== name) {
    return fail(errors.invalidTag)
  }
  return wrapper.entity
}

function requireEntityId(
  entity: Record<string, unknown>,
  name: RazorpayEntityName,
): string {
  const value = entity.id
  const errors = ENTITY_ID_ERRORS[name]
  if (value === undefined || value === null) {
    return fail(errors.missing)
  }
  if (!isCanonicalRazorpayId(value, ENTITY_ID_PREFIX[name])) {
    return fail(errors.invalid)
  }
  return value
}

function optionalCorrelationId(
  entity: Record<string, unknown>,
  field: string,
  prefix: string,
  invalidCode: WebhookReferenceErrorCode,
): string | undefined {
  const value = entity[field]
  if (value === undefined || value === null) return undefined
  if (!isCanonicalRazorpayId(value, prefix)) {
    return fail(invalidCode)
  }
  return value
}

function requiredCorrelationId(
  entity: Record<string, unknown>,
  field: string,
  prefix: string,
  missingCode: WebhookReferenceErrorCode,
  invalidCode: WebhookReferenceErrorCode,
): string {
  const value = entity[field]
  if (value === undefined || value === null) return fail(missingCode)
  if (!isCanonicalRazorpayId(value, prefix)) return fail(invalidCode)
  return value
}

function parsePaymentReferences(
  payload: Record<string, unknown>,
): PaymentCorrelationReferences {
  const payment = requireEntity(payload, 'payment')
  const razorpayPaymentId = requireEntityId(payment, 'payment')
  const razorpayOrderId = optionalCorrelationId(
    payment,
    'order_id',
    'order',
    'payment_order_id_invalid',
  )
  const razorpayInvoiceId = optionalCorrelationId(
    payment,
    'invoice_id',
    'inv',
    'payment_invoice_id_invalid',
  )
  return {
    razorpayPaymentId,
    ...(razorpayOrderId ? { razorpayOrderId } : {}),
    ...(razorpayInvoiceId ? { razorpayInvoiceId } : {}),
  }
}

function context(
  envelope: VerifiedPaymentWebhookEnvelope,
): WebhookReferenceContext {
  return {
    inboxEventId: envelope.inboxEventId,
    providerMode: envelope.providerMode,
  }
}

function parseOrderPaid(
  envelope: VerifiedPaymentWebhookEnvelope,
  payload: Record<string, unknown>,
): OrderPaidWebhookReferences {
  const order = requireEntity(payload, 'order')
  const razorpayOrderId = requireEntityId(order, 'order')
  const payment = parsePaymentReferences(payload)
  if (!payment.razorpayOrderId) {
    return fail('payment_order_id_missing')
  }
  if (payment.razorpayOrderId !== razorpayOrderId) {
    return fail('payment_order_id_mismatch')
  }
  return {
    ...context(envelope),
    kind: 'order',
    eventType: 'order.paid',
    razorpayOrderId,
    razorpayPaymentId: payment.razorpayPaymentId,
    ...(payment.razorpayInvoiceId
      ? { razorpayInvoiceId: payment.razorpayInvoiceId }
      : {}),
  }
}

function parsePaymentEvent(
  envelope: VerifiedPaymentWebhookEnvelope,
  payload: Record<string, unknown>,
): PaymentWebhookReferences {
  return {
    ...context(envelope),
    kind: 'payment',
    eventType: envelope.eventType as PaymentEvent,
    ...parsePaymentReferences(payload),
  }
}

function parseSubscriptionEvent(
  envelope: VerifiedPaymentWebhookEnvelope,
  payload: Record<string, unknown>,
): SubscriptionChargedWebhookReferences
  | SubscriptionStateWebhookReferences {
  const subscription = requireEntity(payload, 'subscription')
  const razorpaySubscriptionId = requireEntityId(
    subscription,
    'subscription',
  )
  const hasPayment = Object.prototype.hasOwnProperty.call(
    payload,
    'payment',
  )
  if (envelope.eventType === 'subscription.charged' && !hasPayment) {
    return fail('subscription_payment_missing')
  }
  const payment = hasPayment ? parsePaymentReferences(payload) : undefined
  if (envelope.eventType === 'subscription.charged') {
    if (!payment) return fail('subscription_payment_missing')
    return {
      ...context(envelope),
      kind: 'subscription',
      eventType: 'subscription.charged',
      razorpaySubscriptionId,
      ...payment,
    }
  }
  return {
    ...context(envelope),
    kind: 'subscription',
    eventType:
      envelope.eventType as SubscriptionEventWithoutRequiredPayment,
    razorpaySubscriptionId,
    ...payment,
  }
}

function parseRefundEvent(
  envelope: VerifiedPaymentWebhookEnvelope,
  payload: Record<string, unknown>,
): RefundWebhookReferences {
  const refund = requireEntity(payload, 'refund')
  const razorpayRefundId = requireEntityId(refund, 'refund')
  const linkedPaymentId = requiredCorrelationId(
    refund,
    'payment_id',
    'pay',
    'refund_payment_id_missing',
    'refund_payment_id_invalid',
  )
  const payment = parsePaymentReferences(payload)
  if (linkedPaymentId !== payment.razorpayPaymentId) {
    return fail('refund_payment_id_mismatch')
  }
  return {
    ...context(envelope),
    kind: 'refund',
    eventType: envelope.eventType as RefundEvent,
    razorpayRefundId,
    ...payment,
  }
}

function parseDisputeEvent(
  envelope: VerifiedPaymentWebhookEnvelope,
  payload: Record<string, unknown>,
): DisputeWebhookReferences {
  const dispute = requireEntity(payload, 'dispute')
  const razorpayDisputeId = requireEntityId(dispute, 'dispute')
  const linkedPaymentId = requiredCorrelationId(
    dispute,
    'payment_id',
    'pay',
    'dispute_payment_id_missing',
    'dispute_payment_id_invalid',
  )
  const payment = parsePaymentReferences(payload)
  if (linkedPaymentId !== payment.razorpayPaymentId) {
    return fail('dispute_payment_id_mismatch')
  }
  return {
    ...context(envelope),
    kind: 'dispute',
    eventType: envelope.eventType as DisputeEvent,
    razorpayDisputeId,
    ...payment,
  }
}

/**
 * Purely extracts correlation references from a signature-verified envelope.
 * Extra entity fields are deliberately ignored so PII cannot enter the
 * normalized dispatcher input or sanitized parse errors.
 */
export function parseVerifiedWebhookReferences(
  envelope: VerifiedPaymentWebhookEnvelope,
): NormalizedRazorpayWebhookReferences {
  if (!isRecord(envelope.payload)) return fail('payload_invalid')
  const eventType = envelope.eventType as SupportedRazorpayWebhookEvent
  const family = (
    EVENT_FAMILY as Partial<
      Record<SupportedRazorpayWebhookEvent, WebhookReferenceFamily>
    >
  )[eventType]
  if (!family) return fail('event_type_unsupported')

  switch (family) {
    case 'order':
      return parseOrderPaid(envelope, envelope.payload)
    case 'payment':
      return parsePaymentEvent(envelope, envelope.payload)
    case 'subscription':
      return parseSubscriptionEvent(envelope, envelope.payload)
    case 'refund':
      return parseRefundEvent(envelope, envelope.payload)
    case 'dispute':
      return parseDisputeEvent(envelope, envelope.payload)
  }
}
