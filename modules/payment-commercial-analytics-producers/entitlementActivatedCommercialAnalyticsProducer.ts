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
  OneTimeEntitlementActivatedAnalyticsEvidence,
  OneTimeEntitlementActivatedAnalyticsProducer,
  SubscriptionEntitlementActivatedAnalyticsEvidence,
  SubscriptionEntitlementActivatedAnalyticsProducer,
} from '@payments'

const HMAC_SECRET_ENV =
  'PAYMENT_COMMERCIAL_ANALYTICS_HMAC_V1_SECRET_BASE64'
const HMAC_DOMAIN_PREFIX =
  'interviewprepguru:payment-commercial-analytics:v1'
const OBJECT_ID = /^[a-f0-9]{24}$/
const MINIMUM_HMAC_KEY_BYTES = 32

export type EntitlementActivatedAnalyticsEvidence =
  | OneTimeEntitlementActivatedAnalyticsEvidence
  | SubscriptionEntitlementActivatedAnalyticsEvidence

export interface EntitlementActivatedAnalyticsRecordedResult {
  readonly outcome: 'created' | 'replayed'
  readonly eventId: string
  readonly eventDigest: string
}

function fail(message: string): never {
  throw new Error(`Entitlement commercial analytics: ${message}`)
}

function objectId(value: string, label: string): string {
  if (!OBJECT_ID.test(value)) return fail(`${label} is not canonical`)
  return value
}

function canonicalDate(value: Date, label: string): string {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    return fail(`${label} is invalid`)
  }
  return value.toISOString()
}

function exactMoney(input: {
  listPricePaise: number | null
  discountPaise: number | null
  payablePaise: number
}): asserts input is {
  listPricePaise: number
  discountPaise: number
  payablePaise: number
} {
  if (
    !Number.isSafeInteger(input.listPricePaise) ||
    !Number.isSafeInteger(input.discountPaise) ||
    !Number.isSafeInteger(input.payablePaise) ||
    (input.listPricePaise ?? -1) < 0 ||
    (input.discountPaise ?? -1) < 0 ||
    input.payablePaise <= 0 ||
    input.payablePaise !==
      (input.listPricePaise ?? -1) - (input.discountPaise ?? -1)
  ) {
    fail('immutable quote evidence is invalid')
  }
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

function keyedDigest(input: {
  key: Buffer
  domain:
    | 'one-time-entitlement-source'
    | 'subscription-cycle-source'
    | 'entitlement-correlation'
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

function isSubscriptionEvidence(
  evidence: EntitlementActivatedAnalyticsEvidence,
): evidence is SubscriptionEntitlementActivatedAnalyticsEvidence {
  return 'activationKind' in evidence
}

function composeEvent(
  evidence: EntitlementActivatedAnalyticsEvidence,
  key: Buffer,
): CommercialAnalyticsEventInput {
  const subscription = isSubscriptionEvidence(evidence)
  const oneTime = subscription
    ? null
    : evidence as OneTimeEntitlementActivatedAnalyticsEvidence
  exactMoney(evidence)
  const sourceEvidenceId = objectId(
    evidence.sourceEvidenceId,
    'source evidence',
  )
  const correlationId = objectId(evidence.correlationId, 'correlation')
  const subjectId = objectId(evidence.subjectId, 'subject')
  const couponCampaignId = evidence.couponCampaignId === null
    ? null
    : objectId(evidence.couponCampaignId, 'coupon campaign')
  if (
    typeof evidence.catalogVersion !== 'string' ||
    evidence.catalogVersion.length === 0 ||
    evidence.catalogVersion !== evidence.catalogVersion.trim()
  ) {
    return fail('catalog version is invalid')
  }
  const occurredAt = canonicalDate(evidence.occurredAt, 'activation time')
  const accessEndsAt = evidence.accessEndsAt === null
    ? null
    : canonicalDate(evidence.accessEndsAt, 'access end')
  if (
    subscription &&
    (
      accessEndsAt === null ||
      (
        evidence.activationKind !== 'initial_subscription' &&
        evidence.activationKind !== 'renewal'
      ) ||
      !Number.isSafeInteger(evidence.interviewsRemaining) ||
      evidence.interviewsRemaining < 0 ||
      !Number.isSafeInteger(evidence.premiumResumesRemaining) ||
      evidence.premiumResumesRemaining < 0
    )
  ) {
    return fail('subscription entitlement evidence is invalid')
  }
  if (
    oneTime?.productKey === 'single_interview' &&
    accessEndsAt === null
  ) {
    return fail('interview unlock has no access end')
  }

  return {
    schemaVersion: 'payment_commercial_analytics_event_v1',
    eventName: 'entitlement_activated',
    authority: 'server',
    source: 'entitlement_transaction',
    sourceEvidenceDigest: keyedDigest({
      key,
      domain: subscription
        ? 'subscription-cycle-source'
        : 'one-time-entitlement-source',
      providerMode: evidence.providerMode,
      value: sourceEvidenceId,
    }),
    correlationDigest: keyedDigest({
      key,
      domain: 'entitlement-correlation',
      providerMode: evidence.providerMode,
      value: correlationId,
    }),
    subjectDigest: keyedDigest({
      key,
      domain: 'commercial-subject',
      providerMode: evidence.providerMode,
      value: subjectId,
    }),
    providerMode: evidence.providerMode,
    occurredAt,
    dimensions: {
      surface: 'checkout',
      paywallReason: null,
      catalogVersion: evidence.catalogVersion,
      pricingVariant: null,
      productKey: evidence.productKey,
      couponCampaignId,
      couponMode: null,
      eligibilitySegment: null,
      userState: null,
      eligiblePaywall: false,
      codeLength: null,
      interviewsRemaining: subscription
        ? evidence.interviewsRemaining
        : oneTime?.productKey === 'single_interview' ? 1 : null,
      premiumResumesRemaining: subscription
        ? evidence.premiumResumesRemaining
        : oneTime?.productKey === 'premium_resume' ? 1 : null,
      durationMinutes: subscription ||
        oneTime?.productKey === 'single_interview' ? 30 : null,
      accessEndsAt,
      firstPaidUseWithin24Hours: null,
      activationKind: subscription
        ? evidence.activationKind
        : 'one_time',
    },
    amounts: {
      listPricePaise: evidence.listPricePaise,
      discountPaise: evidence.discountPaise,
      payablePaise: evidence.payablePaise,
      renewalPricePaise: subscription
        ? evidence.listPricePaise
        : null,
      eventAmountPaise: 0,
      allocatedVariableCostPaise: 0,
    },
  }
}

async function appendProduction<TSession extends object>(
  evidenceFactory: () =>
    | EntitlementActivatedAnalyticsEvidence
    | Promise<EntitlementActivatedAnalyticsEvidence>,
  session: TSession,
): Promise<void> {
  if (!PAYMENT_COMMERCIAL_ANALYTICS_EVENT_WRITES_READY) return
  const evidence = await evidenceFactory()
  const key = decodeSecret(process.env[HMAC_SECRET_ENV])
  try {
    await appendCommercialAnalyticsEvent({
      event: composeEvent(evidence, key),
      session: session as unknown as ClientSession,
    })
  } finally {
    key.fill(0)
  }
}

/**
 * Both methods remain inert until the shared analytics write gate is
 * independently approved. The gate precedes evidence evaluation, secrets,
 * identity derivation, and analytics persistence.
 */
export const entitlementActivatedCommercialAnalyticsProducer = {
  appendOneTimeEntitlementActivatedInSession:
    appendProduction,
  appendSubscriptionEntitlementActivatedInSession:
    appendProduction,
} satisfies OneTimeEntitlementActivatedAnalyticsProducer &
  SubscriptionEntitlementActivatedAnalyticsProducer

export async function appendEntitlementActivatedCommercialAnalyticsForTest<
  TSession extends object,
>(
  authority: CommercialAnalyticsTestAuthority,
  input: {
    readonly evidence: EntitlementActivatedAnalyticsEvidence
    readonly session: TSession
    readonly secretBase64: string
  },
  store: CommercialAnalyticsAppendStore<TSession>,
): Promise<EntitlementActivatedAnalyticsRecordedResult> {
  const key = decodeSecret(input.secretBase64)
  try {
    return appendCommercialAnalyticsEventForTest(
      authority,
      {
        event: composeEvent(input.evidence, key),
        session: input.session,
      },
      store,
    )
  } finally {
    key.fill(0)
  }
}
