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
  CapturedCommercialAnalyticsEvidence,
  CapturedCommercialAnalyticsProducer,
  CheckoutIntentCreatedCommercialAnalyticsProducer,
  PaymentStateCommercialAnalyticsEvidence,
  PaymentStateCommercialAnalyticsProducer,
} from '@payments'
const HMAC_SECRET_ENV =
  'PAYMENT_COMMERCIAL_ANALYTICS_HMAC_V1_SECRET_BASE64'
const HMAC_DOMAIN_PREFIX =
  'interviewprepguru:payment-commercial-analytics:v1'
const OBJECT_ID = /^[a-f0-9]{24}$/
const MINIMUM_HMAC_KEY_BYTES = 32
type CaptureEventName =
  | 'payment_captured'
  | 'single_interview_purchased'
  | 'premium_resume_purchased'
export interface CapturedCommercialAnalyticsRecordedEvent {
  readonly eventName: CaptureEventName
  readonly outcome: 'created' | 'replayed'
  readonly eventId: string
  readonly eventDigest: string
}
export interface CapturedCommercialAnalyticsRecordedResult {
  readonly outcome: 'recorded'
  readonly eventCount: 1 | 2
  readonly events:
    readonly CapturedCommercialAnalyticsRecordedEvent[]
}
function fail(message: string): never {
  throw new Error(`Captured commercial analytics: ${message}`)
}
function canonicalObjectId(value: string, label: string): string {
  if (!OBJECT_ID.test(value)) {
    return fail(`${label} is not canonical`)
  }
  return value
}
function canonicalOccurredAt(value: Date): string {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    return fail('capture timestamp is invalid')
  }
  return value.toISOString()
}
type ExactCapturedEvidence =
  CapturedCommercialAnalyticsEvidence & {
    readonly productKey:
      | 'plus'
      | 'pro'
      | 'single_interview'
      | 'premium_resume'
    readonly catalogVersion: string
    readonly listPricePaise: number
    readonly discountPaise: number
  }
function exactCapturedEvidence(
  evidence: CapturedCommercialAnalyticsEvidence,
): ExactCapturedEvidence {
  const subscription =
    evidence.checkoutKind === 'subscription' &&
    (evidence.productKey === 'plus' || evidence.productKey === 'pro')
  const oneTime =
    (
      evidence.checkoutKind === 'single_interview' ||
      evidence.checkoutKind === 'premium_resume'
    ) &&
    evidence.productKey === evidence.checkoutKind
  if (
    (!subscription && !oneTime) ||
    typeof evidence.catalogVersion !== 'string' ||
    evidence.catalogVersion.length === 0 ||
    !Number.isSafeInteger(evidence.listPricePaise) ||
    !Number.isSafeInteger(evidence.discountPaise) ||
    evidence.listPricePaise === null ||
    evidence.discountPaise === null ||
    evidence.listPricePaise < 0 ||
    evidence.discountPaise < 0 ||
    evidence.payablePaise !==
      evidence.listPricePaise - evidence.discountPaise ||
    (
      evidence.renewalPricePaise !== null &&
      (
        !Number.isSafeInteger(evidence.renewalPricePaise) ||
        evidence.renewalPricePaise < 0
      )
    )
  ) {
    return fail('immutable quote evidence is invalid')
  }
  return evidence as ExactCapturedEvidence
}
function decodeSecret(encoded: string | undefined): Buffer {
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
function loadProductionSecret(): Buffer {
  return decodeSecret(process.env[HMAC_SECRET_ENV])
}
function keyedDigest(input: {
  readonly key: Buffer
  readonly domain:
    | 'capture-source'
    | 'checkout-intent-source'
    | 'payment-state-source'
    | 'checkout-correlation'
    | 'commercial-subject'
  readonly providerMode: 'test' | 'live'
  readonly value: string
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
function captureEventNames(
  productKey: ExactCapturedEvidence['productKey'],
): readonly CaptureEventName[] {
  switch (productKey) {
    case 'single_interview':
      return ['payment_captured', 'single_interview_purchased']
    case 'premium_resume':
      return ['payment_captured', 'premium_resume_purchased']
    case 'plus':
    case 'pro':
      return ['payment_captured']
  }
}
function composeEvents(
  evidence: CapturedCommercialAnalyticsEvidence,
  key: Buffer,
): readonly CommercialAnalyticsEventInput[] {
  const exact = exactCapturedEvidence(evidence)
  return captureEventNames(exact.productKey).map((eventName) =>
    composeTransactionEvent(exact, key, {
      eventName,
      source: 'payment_verification',
      sourceDomain: 'capture-source',
      eventAmountPaise: exact.payablePaise,
    }))
}
function composeTransactionEvent(
  evidence: CapturedCommercialAnalyticsEvidence,
  key: Buffer,
  classification: {
    eventName: CommercialAnalyticsEventInput['eventName']
    source: CommercialAnalyticsEventInput['source']
    sourceDomain: 'capture-source' | 'checkout-intent-source' |
      'payment-state-source'
    eventAmountPaise: number
    lifecycleStage?: NonNullable<
      CommercialAnalyticsEventInput['dimensions']['lifecycleStage']
    >
    lifecycleReason?: NonNullable<
      CommercialAnalyticsEventInput['dimensions']['lifecycleReason']
    >
  },
): CommercialAnalyticsEventInput {
  const exact = exactCapturedEvidence(evidence)
  const digest = (
    domain: Parameters<typeof keyedDigest>[0]['domain'],
    value: string,
  ) => keyedDigest({
    key, domain, providerMode: exact.providerMode,
    value: canonicalObjectId(value, domain),
  })
  return {
    schemaVersion: 'payment_commercial_analytics_event_v1',
    eventName: classification.eventName,
    authority: 'server',
    source: classification.source,
    sourceEvidenceDigest:
      digest(classification.sourceDomain, exact.sourceEvidenceId),
    correlationDigest:
      digest('checkout-correlation', exact.correlationId),
    subjectDigest: digest('commercial-subject', exact.subjectId),
    providerMode: exact.providerMode,
    occurredAt: canonicalOccurredAt(exact.occurredAt),
    dimensions: {
      surface: 'checkout', paywallReason: null,
      catalogVersion: exact.catalogVersion, pricingVariant: null,
      productKey: exact.productKey,
      couponCampaignId: exact.couponCampaignId, couponMode: null,
      eligibilitySegment: null, userState: null,
      eligiblePaywall: false, codeLength: null,
      interviewsRemaining: null, premiumResumesRemaining: null,
      durationMinutes: null, accessEndsAt: null,
      firstPaidUseWithin24Hours: null,
      activationKind: null,
      ...(classification.lifecycleStage
        ? {
            lifecycleStage: classification.lifecycleStage,
            lifecycleReason: classification.lifecycleReason!,
          }
        : {}),
    },
    amounts: {
      listPricePaise: exact.listPricePaise,
      discountPaise: exact.discountPaise,
      payablePaise: exact.payablePaise,
      renewalPricePaise: exact.renewalPricePaise,
      eventAmountPaise: classification.eventAmountPaise,
      allocatedVariableCostPaise: 0,
    },
  }
}
function transactionClassification(
  evidence: CapturedCommercialAnalyticsEvidence |
    PaymentStateCommercialAnalyticsEvidence,
) {
  if ('eventName' in evidence) {
    return {
      eventName: evidence.eventName,
      source: evidence.observationSource === 'signed_webhook'
        ? 'signed_webhook' as const : 'reconciliation' as const,
      sourceDomain: 'payment-state-source' as const,
      eventAmountPaise: 0,
      lifecycleStage: evidence.lifecycleStage,
      lifecycleReason: evidence.lifecycleReason,
    }
  }
  return {
    eventName: 'checkout_intent_created' as const,
    source: 'checkout_intent_transaction' as const,
    sourceDomain: 'checkout-intent-source' as const,
    eventAmountPaise: 0,
    lifecycleStage: 'checkout_intent' as const,
    lifecycleReason: 'intent_created' as const,
  }
}
type AppendResult = {
  readonly outcome: 'created' | 'replayed'
  readonly eventId: string
  readonly eventDigest: string
}
async function appendComposedEvents<TSession extends object>(input: {
  readonly evidence: CapturedCommercialAnalyticsEvidence
  readonly key: Buffer
  readonly session: TSession
  readonly append: (
    event: CommercialAnalyticsEventInput,
    session: TSession,
  ) => Promise<AppendResult>
}): Promise<CapturedCommercialAnalyticsRecordedResult> {
  const events = composeEvents(input.evidence, input.key)
  const recorded: CapturedCommercialAnalyticsRecordedEvent[] = []
  for (const event of events) {
    const result = await input.append(event, input.session)
    recorded.push(Object.freeze({
      eventName: event.eventName as CaptureEventName,
      ...result,
    }))
  }
  return Object.freeze({
    outcome: 'recorded',
    eventCount: events.length as 1 | 2,
    events: Object.freeze(recorded),
  })
}
async function appendTransactionProduction(
  evidenceFactory: () =>
    CapturedCommercialAnalyticsEvidence |
    PaymentStateCommercialAnalyticsEvidence,
  session: ClientSession,
): Promise<void> {
  if (!PAYMENT_COMMERCIAL_ANALYTICS_EVENT_WRITES_READY) return
  const evidence = evidenceFactory()
  const key = loadProductionSecret()
  try {
    await appendCommercialAnalyticsEvent({
      event: composeTransactionEvent(
        evidence,
        key,
        transactionClassification(evidence),
      ),
      session,
    })
  } finally {
    key.fill(0)
  }
}
export const capturedCommercialAnalyticsProducer = {
  async appendCapturedInSession(evidenceFactory, session) {
    if (!PAYMENT_COMMERCIAL_ANALYTICS_EVENT_WRITES_READY) {
      return
    }
    const evidence = evidenceFactory()
    const key = loadProductionSecret()
    try {
      await appendComposedEvents({
        evidence,
        key,
        session,
        append: (event, session) =>
          appendCommercialAnalyticsEvent({ event, session }),
      })
    } finally {
      key.fill(0)
    }
  },
  appendCheckoutIntentCreatedInSession: (evidence, session) =>
    appendTransactionProduction(evidence, session),
  appendPaymentStateTransitionInSession: (evidence, session) =>
    appendTransactionProduction(evidence, session),
} satisfies CapturedCommercialAnalyticsProducer &
  CheckoutIntentCreatedCommercialAnalyticsProducer &
  PaymentStateCommercialAnalyticsProducer
export async function appendCapturedCommercialAnalyticsForTest<
  TSession extends object,
>(
  authority: CommercialAnalyticsTestAuthority,
  input: {
    readonly evidence: CapturedCommercialAnalyticsEvidence
    readonly session: TSession
    readonly secretBase64: string
  },
  store: CommercialAnalyticsAppendStore<TSession>,
): Promise<CapturedCommercialAnalyticsRecordedResult> {
  const key = decodeSecret(input.secretBase64)
  try {
    return await appendComposedEvents({
      evidence: input.evidence,
      key,
      session: input.session,
      append: (event, session) =>
        appendCommercialAnalyticsEventForTest(
          authority,
          { event, session },
          store,
        ),
    })
  } finally {
    key.fill(0)
  }
}
export async function appendTransactionCommercialAnalyticsForTest<
  TSession extends object,
>(
  authority: CommercialAnalyticsTestAuthority,
  input: {
    evidence: CapturedCommercialAnalyticsEvidence |
      PaymentStateCommercialAnalyticsEvidence
    session: TSession
    secretBase64: string
  },
  store: CommercialAnalyticsAppendStore<TSession>,
) {
  const key = decodeSecret(input.secretBase64)
  try {
    return appendCommercialAnalyticsEventForTest(authority, {
      event: composeTransactionEvent(
        input.evidence,
        key,
        transactionClassification(input.evidence),
      ),
      session: input.session,
    }, store)
  } finally {
    key.fill(0)
  }
}
