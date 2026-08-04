import { createHmac } from 'node:crypto'
import type { ClientSession } from 'mongoose'
import {
  PAYMENT_COMMERCIAL_ANALYTICS_EVENT_WRITES_READY,
  appendCommercialAnalyticsEvent,
  appendCommercialAnalyticsEventForTest,
  type CommercialAnalyticsAppendStore,
  type CommercialAnalyticsEventInput,
  type CommercialAnalyticsTestAuthority,
} from '@modules/payment-commercial-analytics'
import type {
  SubscriptionEntitlementActivatedAnalyticsEvidence,
  SubscriptionRenewedCommercialAnalyticsProducer,
  SubscriptionStateCommercialAnalyticsEvidence,
  SubscriptionStateCommercialAnalyticsProducer,
} from '@payments'
const HMAC_SECRET_ENV =
  'PAYMENT_COMMERCIAL_ANALYTICS_HMAC_V1_SECRET_BASE64'
const HMAC_DOMAIN_PREFIX =
  'interviewprepguru:payment-commercial-analytics:v1'
const OBJECT_ID = /^[a-f0-9]{24}$/
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/
const MINIMUM_HMAC_KEY_BYTES = 32
const SUBSCRIPTION_STATUSES = new Set([
  'created',
  'authenticated',
  'activation_pending',
  'active',
  'pending',
  'halted',
  'paused',
  'cancelled',
  'completed',
  'expired',
  'review',
])
export interface SubscriptionLifecycleAnalyticsRecordedResult {
  readonly outcome: 'created' | 'replayed'
  readonly eventName:
    | 'activation_pending'
    | 'subscription_renewed'
    | 'subscription_pending'
    | 'subscription_halted'
  readonly eventId: string
  readonly eventDigest: string
}
export interface SubscriptionRenewedAnalyticsNotApplicable {
  readonly outcome: 'not_initial_renewal'
  readonly eventName: 'subscription_renewed'
}
function fail(message: string): never {
  throw new Error(`Subscription commercial analytics: ${message}`)
}
function objectId(value: string, label: string): string {
  if (!OBJECT_ID.test(value)) return fail(`${label} is not canonical`)
  return value
}
function token(value: string, label: string, max = 255): string {
  if (
    value.length === 0 ||
    value.length > max ||
    value !== value.trim() ||
    CONTROL.test(value)
  ) {
    return fail(`${label} is invalid`)
  }
  return value
}
function timestamp(value: Date, label: string): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    return fail(`${label} is invalid`)
  }
  return value.toISOString()
}
function money(input: {
  listPricePaise: number
  discountPaise: number
  payablePaise: number
  renewalPricePaise: number
}): void {
  if (
    !Number.isSafeInteger(input.listPricePaise) ||
    !Number.isSafeInteger(input.discountPaise) ||
    !Number.isSafeInteger(input.payablePaise) ||
    !Number.isSafeInteger(input.renewalPricePaise) ||
    input.listPricePaise <= 0 ||
    input.discountPaise < 0 ||
    input.payablePaise <= 0 ||
    input.renewalPricePaise <= 0 ||
    input.payablePaise !==
      input.listPricePaise - input.discountPaise
  ) {
    fail('immutable pricing evidence is invalid')
  }
}

function secret(encoded: string | undefined): Buffer {
  if (
    typeof encoded !== 'string' ||
    encoded.length === 0 ||
    encoded !== encoded.trim()
  ) {
    return fail('HMAC authority is unavailable')
  }
  const key = Buffer.from(encoded, 'base64')
  if (
    key.byteLength < MINIMUM_HMAC_KEY_BYTES ||
    key.toString('base64') !== encoded
  ) {
    key.fill(0)
    return fail('HMAC authority is unavailable')
  }
  return key
}

function digest(input: {
  key: Buffer
  domain:
    | 'subscription-cycle-renewal-source'
    | 'subscription-state-transition-source'
    | 'subscription-correlation'
    | 'commercial-subject'
  providerMode: 'test' | 'live'
  value: string
}): string {
  return createHmac('sha256', input.key)
    .update(HMAC_DOMAIN_PREFIX)
    .update('\0')
    .update(input.domain)
    .update('\0')
    .update(input.providerMode)
    .update('\0')
    .update(input.value)
    .digest('hex')
}

function privacyDigests(input: {
  key: Buffer
  providerMode: 'test' | 'live'
  sourceDomain:
    | 'subscription-cycle-renewal-source'
    | 'subscription-state-transition-source'
  source: string
  correlationId: string
  subjectId: string
}) {
  return {
    sourceEvidenceDigest: digest({
      key: input.key,
      domain: input.sourceDomain,
      providerMode: input.providerMode,
      value: input.source,
    }),
    correlationDigest: digest({
      key: input.key,
      domain: 'subscription-correlation',
      providerMode: input.providerMode,
      value: objectId(input.correlationId, 'correlation'),
    }),
    subjectDigest: digest({
      key: input.key,
      domain: 'commercial-subject',
      providerMode: input.providerMode,
      value: objectId(input.subjectId, 'subject'),
    }),
  }
}

function renewalEvent(
  evidence: SubscriptionEntitlementActivatedAnalyticsEvidence,
  key: Buffer,
): CommercialAnalyticsEventInput | null {
  if (evidence.activationKind === 'initial_subscription') return null
  if (
    evidence.activationKind !== 'renewal' ||
    !Number.isSafeInteger(evidence.interviewsRemaining) ||
    evidence.interviewsRemaining < 0 ||
    !Number.isSafeInteger(evidence.premiumResumesRemaining) ||
    evidence.premiumResumesRemaining < 0
  ) {
    return fail('renewal cycle evidence is invalid')
  }
  money({
    ...evidence,
    renewalPricePaise: evidence.listPricePaise,
  })
  const sourceEvidenceId = objectId(
    evidence.sourceEvidenceId,
    'renewal source',
  )
  const occurredAt = timestamp(evidence.occurredAt, 'renewal time')
  const accessEndsAt = timestamp(
    evidence.accessEndsAt,
    'renewal access end',
  )
  const catalogVersion = token(
    evidence.catalogVersion,
    'catalog version',
    120,
  )
  const couponCampaignId = evidence.couponCampaignId === null
    ? null
    : objectId(evidence.couponCampaignId, 'coupon campaign')
  const privacy = privacyDigests({
    key,
    providerMode: evidence.providerMode,
    sourceDomain: 'subscription-cycle-renewal-source',
    source: sourceEvidenceId,
    correlationId: evidence.correlationId,
    subjectId: evidence.subjectId,
  })
  return {
    schemaVersion: 'payment_commercial_analytics_event_v1',
    eventName: 'subscription_renewed',
    authority: 'server',
    source: 'subscription_transaction',
    ...privacy,
    providerMode: evidence.providerMode,
    occurredAt,
    dimensions: {
      surface: 'checkout',
      paywallReason: null,
      catalogVersion,
      pricingVariant: null,
      productKey: evidence.productKey,
      couponCampaignId,
      couponMode: null,
      eligibilitySegment: null,
      userState: null,
      eligiblePaywall: false,
      codeLength: null,
      interviewsRemaining: evidence.interviewsRemaining,
      premiumResumesRemaining: evidence.premiumResumesRemaining,
      durationMinutes: 30,
      accessEndsAt,
      firstPaidUseWithin24Hours: null,
      activationKind: 'renewal',
    },
    amounts: {
      listPricePaise: evidence.listPricePaise,
      discountPaise: evidence.discountPaise,
      payablePaise: evidence.payablePaise,
      renewalPricePaise: evidence.listPricePaise,
      eventAmountPaise: evidence.payablePaise,
      allocatedVariableCostPaise: 0,
    },
  }
}

function stateEvent(
  evidence: SubscriptionStateCommercialAnalyticsEvidence,
  key: Buffer,
): CommercialAnalyticsEventInput {
  const expectedEvent = evidence.providerStatus === 'pending'
    ? 'subscription_pending'
    : evidence.providerStatus === 'halted'
      ? 'subscription_halted'
      : evidence.providerStatus === 'activation_pending'
        ? 'activation_pending'
        : fail('provider state is invalid')
  if (
    evidence.eventName !== expectedEvent ||
    (
      evidence.observationSource !== 'signed_webhook' &&
      evidence.observationSource !== 'provider_fetch'
    ) ||
    (
      evidence.previousStatus !== null &&
      !SUBSCRIPTION_STATUSES.has(evidence.previousStatus)
    ) ||
    evidence.previousStatus === evidence.providerStatus ||
    (
      expectedEvent === 'activation_pending'
        ? (
            evidence.pendingReason !== 'awaiting_mandate' &&
            evidence.pendingReason !== 'awaiting_entitlement'
          )
        : evidence.pendingReason !== null
    ) ||
    !Number.isSafeInteger(evidence.providerPaidCount) ||
    evidence.providerPaidCount < 0 ||
    !Number.isSafeInteger(evidence.providerRemainingCount) ||
    evidence.providerRemainingCount < 0
  ) {
    return fail('state transition evidence is invalid')
  }
  money(evidence)
  const sourceEvidenceKey = token(
    evidence.sourceEvidenceKey,
    'source evidence key',
    512,
  )
  const localSubscriptionId = objectId(
    evidence.localSubscriptionId,
    'local subscription',
  )
  const occurredAt = timestamp(evidence.occurredAt, 'transition time')
  const catalogVersion = token(
    evidence.catalogVersion,
    'catalog version',
    120,
  )
  const couponCampaignId = evidence.couponCampaignId === null
    ? null
    : objectId(evidence.couponCampaignId, 'coupon campaign')
  const periodValues = [
    evidence.currentPeriodKey,
    evidence.currentPeriodStart,
    evidence.currentPeriodEnd,
  ]
  const present = periodValues.filter((value) => value !== null).length
  if (
    present !== 0 &&
    (
      present !== 3 ||
      !evidence.currentPeriodKey ||
      !evidence.currentPeriodStart ||
      !evidence.currentPeriodEnd ||
      evidence.currentPeriodEnd <= evidence.currentPeriodStart
    )
  ) {
    return fail('current cycle evidence is incomplete')
  }
  const currentPeriodKey = evidence.currentPeriodKey === null
    ? null
    : token(evidence.currentPeriodKey, 'current period', 255)
  const currentPeriodStart = evidence.currentPeriodStart === null
    ? null
    : timestamp(evidence.currentPeriodStart, 'current period start')
  const currentPeriodEnd = evidence.currentPeriodEnd === null
    ? null
    : timestamp(evidence.currentPeriodEnd, 'current period end')
  const source = JSON.stringify([
    evidence.observationSource,
    sourceEvidenceKey,
    localSubscriptionId,
    evidence.previousStatus,
    evidence.providerStatus,
    occurredAt,
    currentPeriodKey,
    currentPeriodStart,
    currentPeriodEnd,
    evidence.providerPaidCount,
    evidence.providerRemainingCount,
  ])
  const privacy = privacyDigests({
    key,
    providerMode: evidence.providerMode,
    sourceDomain: 'subscription-state-transition-source',
    source,
    correlationId: evidence.correlationId,
    subjectId: evidence.subjectId,
  })
  return {
    schemaVersion: 'payment_commercial_analytics_event_v1',
    eventName: evidence.eventName,
    authority: 'server',
    source: 'subscription_transaction',
    ...privacy,
    providerMode: evidence.providerMode,
    occurredAt,
    dimensions: {
      surface: 'settings',
      paywallReason: null,
      catalogVersion,
      pricingVariant: null,
      productKey: evidence.productKey,
      couponCampaignId,
      couponMode: null,
      eligibilitySegment: null,
      userState: null,
      eligiblePaywall: false,
      codeLength: null,
      interviewsRemaining: null,
      premiumResumesRemaining: null,
      durationMinutes: null,
      accessEndsAt: currentPeriodEnd,
      firstPaidUseWithin24Hours: null,
      activationKind: null,
      ...(evidence.eventName === 'activation_pending'
        ? {
            lifecycleStage: 'subscription_activation' as const,
            lifecycleReason: evidence.pendingReason!,
          }
        : {}),
    },
    amounts: {
      listPricePaise: evidence.listPricePaise,
      discountPaise: evidence.discountPaise,
      payablePaise: evidence.payablePaise,
      renewalPricePaise: evidence.renewalPricePaise,
      eventAmountPaise: 0,
      allocatedVariableCostPaise: 0,
    },
  }
}

async function appendProduction<TSession extends object>(
  eventFactory: (
    key: Buffer,
  ) =>
    | CommercialAnalyticsEventInput
    | null
    | Promise<CommercialAnalyticsEventInput | null>,
  session: TSession,
): Promise<void> {
  const key = secret(process.env[HMAC_SECRET_ENV])
  try {
    const event = await eventFactory(key)
    if (event) {
      await appendCommercialAnalyticsEvent({
        event,
        session: session as unknown as ClientSession,
      })
    }
  } finally {
    key.fill(0)
  }
}

export const subscriptionLifecycleCommercialAnalyticsProducer = {
  async appendSubscriptionRenewedInSession(evidenceFactory, session) {
    if (!PAYMENT_COMMERCIAL_ANALYTICS_EVENT_WRITES_READY) return
    const evidence = await evidenceFactory()
    if (evidence.activationKind === 'initial_subscription') return
    await appendProduction(
      (key) => renewalEvent(evidence, key),
      session,
    )
  },
  async appendSubscriptionStateTransitionInSession(
    evidenceFactory,
    session,
  ) {
    if (!PAYMENT_COMMERCIAL_ANALYTICS_EVENT_WRITES_READY) return
    const evidence = evidenceFactory()
    await appendProduction(
      (key) => stateEvent(evidence, key),
      session,
    )
  },
} satisfies SubscriptionRenewedCommercialAnalyticsProducer &
  SubscriptionStateCommercialAnalyticsProducer

async function appendForTest<TSession extends object>(
  authority: CommercialAnalyticsTestAuthority,
  event: CommercialAnalyticsEventInput,
  session: TSession,
  store: CommercialAnalyticsAppendStore<TSession>,
): Promise<SubscriptionLifecycleAnalyticsRecordedResult> {
  const result = await appendCommercialAnalyticsEventForTest(
    authority,
    { event, session },
    store,
  )
  return {
    ...result,
    eventName: event.eventName as
      SubscriptionLifecycleAnalyticsRecordedResult['eventName'],
  }
}

export async function appendSubscriptionRenewedCommercialAnalyticsForTest<
  TSession extends object,
>(
  authority: CommercialAnalyticsTestAuthority,
  input: {
    readonly evidence:
      SubscriptionEntitlementActivatedAnalyticsEvidence
    readonly session: TSession
    readonly secretBase64: string
  },
  store: CommercialAnalyticsAppendStore<TSession>,
): Promise<
  | SubscriptionLifecycleAnalyticsRecordedResult
  | SubscriptionRenewedAnalyticsNotApplicable
> {
  const key = secret(input.secretBase64)
  try {
    const event = renewalEvent(input.evidence, key)
    return event
      ? appendForTest(authority, event, input.session, store)
      : {
          outcome: 'not_initial_renewal',
          eventName: 'subscription_renewed',
        }
  } finally {
    key.fill(0)
  }
}

export async function appendSubscriptionStateCommercialAnalyticsForTest<
  TSession extends object,
>(
  authority: CommercialAnalyticsTestAuthority,
  input: {
    readonly evidence: SubscriptionStateCommercialAnalyticsEvidence
    readonly session: TSession
    readonly secretBase64: string
  },
  store: CommercialAnalyticsAppendStore<TSession>,
): Promise<SubscriptionLifecycleAnalyticsRecordedResult> {
  const key = secret(input.secretBase64)
  try {
    return appendForTest(
      authority,
      stateEvent(input.evidence, key),
      input.session,
      store,
    )
  } finally {
    key.fill(0)
  }
}
