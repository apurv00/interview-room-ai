import {
  createHmac,
  randomBytes as secureRandomBytes,
  timingSafeEqual,
} from 'node:crypto'
import mongoose, { type ClientSession } from 'mongoose'
import { getServerSession } from 'next-auth'
import { z } from 'zod'
import { authOptions } from '@shared/auth/authOptions'
import { connectDB } from '@shared/db/connection'
import { User } from '@shared/db/models/User'
import { logger } from '@shared/logger'
import {
  PAYMENT_COMMERCIAL_ANALYTICS_CMS_READ_READY,
  PAYMENT_COMMERCIAL_ANALYTICS_EVENT_WRITES_READY,
  appendCommercialAnalyticsEvent,
  appendCommercialAnalyticsEventForTest,
  type CommercialAnalyticsAppendStore,
  type CommercialAnalyticsEventInput,
  type CommercialAnalyticsTestAuthority,
} from '@modules/payment-commercial-analytics'
import {
  readBillingRolloutDecision,
  type BillingRolloutDecisionRead,
} from '@payments/services/billingConfigService'
import type {
  BillingRolloutAuthorityDecision,
} from '@modules/payment-rollout-control'
import {
  readProductionBillingRolloutDecision,
} from '@modules/payment-rollout-runtime'
import type {
  BillingRolloutCheckoutAuthority,
} from './billingRolloutConsumption'
import type {
  ResolvedCustomerBillingQuote,
} from '@payments/services/customerBillingQuoteService'
import type {
  SubscriptionStateCommercialAnalyticsEvidence,
} from '@payments/services/subscriptionStatePersistenceService'
import type {
  BillingQuoteSurface,
} from '@payments/validators/customerBilling'

const HMAC_SECRET_ENV =
  'PAYMENT_COMMERCIAL_ANALYTICS_HMAC_V1_SECRET_BASE64'
const HMAC_PREFIX =
  'interviewprepguru/commercial-funnel-analytics/v1'
const TOKEN_TTL_MS = 10 * 60 * 1_000
const DIGEST = /^[a-f0-9]{64}$/
const OBJECT_ID = /^[a-f0-9]{24}$/
const TOKEN_PART = /^[A-Za-z0-9_-]+$/
const OBSERVATION_EVENTS = [
  'checkout_opened',
  'checkout_dismissed',
] as const
const funnelLogger = typeof logger.child === 'function'
  ? logger.child({ module: 'commercial-funnel-analytics' })
  : logger

export type CheckoutObservationEventName =
  (typeof OBSERVATION_EVENTS)[number]

export interface CheckoutObservationAuthority {
  readonly schemaVersion:
    'commercial_checkout_observation_v1'
  readonly authorization: string
  readonly csrf: string
  readonly expiresAt: string
  readonly endpoint:
    '/api/billing/analytics/checkout-observation'
}

interface CommercialRolloutDecisionRead
  extends BillingRolloutDecisionRead {
  readonly authorityDecisionDigest?: string
  readonly authorityProviderMode?: 'test' | 'live'
  readonly authorityStopEpoch?: number
}

type RolloutReader = (
  input: Parameters<typeof readBillingRolloutDecision>[0],
) => Promise<CommercialRolloutDecisionRead>

export interface CommercialFunnelRuntime<TSession extends object> {
  readonly readRolloutDecision: RolloutReader
  readonly readUserCreatedAt: (
    userId: string,
  ) => Promise<Date | undefined>
  readonly runTransaction: <T>(
    work: (session: TSession) => Promise<T>,
  ) => Promise<T>
  readonly append: (
    event: CommercialAnalyticsEventInput,
    session: TSession,
  ) => Promise<'created' | 'replayed'>
  readonly now: () => Date
  readonly randomBytes: (size: number) => Buffer
  readonly secretBase64: string | undefined
}

export interface CommercialFunnelTestAuthority {
  readonly kind: 'commercial_funnel_analytics_test_v1'
  readonly analytics: CommercialAnalyticsTestAuthority
}

export class CommercialFunnelObservationError extends Error {
  constructor(
    readonly code:
      | 'disabled'
      | 'invalid_input'
      | 'invalid_authority'
      | 'expired'
      | 'origin_mismatch',
  ) {
    super('Commercial checkout observation was rejected')
    this.name = 'CommercialFunnelObservationError'
  }
}

interface ActiveDecision {
  readonly decision: BillingRolloutDecisionRead
  readonly providerMode: 'test' | 'live'
  readonly key: Buffer
}

interface CheckoutSnapshot {
  readonly userId: string
  readonly intentId: string
  readonly providerMode: 'test' | 'live'
  readonly catalogVersion: string
  readonly productKey:
    | 'plus'
    | 'pro'
    | 'single_interview'
    | 'premium_resume'
  readonly listPricePaise: number
  readonly discountPaise: number
  readonly payablePaise: number
  readonly renewalPricePaise: number | null
  readonly couponCampaignId?: string
  readonly couponMode?: 'automatic' | 'code' | 'targeted'
  readonly rolloutAuthority?: BillingRolloutCheckoutAuthority
}

const TokenPayloadSchema = z.object({
  version: z.literal(1),
  nonce: z.string().regex(DIGEST),
  subjectDigest: z.string().regex(DIGEST),
  intentDigest: z.string().regex(DIGEST),
  csrfDigest: z.string().regex(DIGEST),
  rolloutDigest: z.string().regex(DIGEST),
  providerMode: z.enum(['test', 'live']),
  issuedAt: z.string().datetime({
    offset: false,
    precision: 3,
  }),
  expiresAt: z.string().datetime({
    offset: false,
    precision: 3,
  }),
  origin: z.string().url().max(300),
  catalogVersion: z.string().trim().min(1).max(120),
  productKey: z.enum([
    'plus',
    'pro',
    'single_interview',
    'premium_resume',
  ]),
  couponCampaignDigest: z.string().regex(DIGEST).nullable(),
  couponMode: z.enum([
    'automatic',
    'code',
    'targeted',
  ]).nullable(),
  listPricePaise: z.number().int().nonnegative().safe(),
  discountPaise: z.number().int().nonnegative().safe(),
  payablePaise: z.number().int().nonnegative().safe(),
  renewalPricePaise:
    z.number().int().nonnegative().safe().nullable(),
}).strict().superRefine((value, context) => {
  const issuedAt = new Date(value.issuedAt)
  const expiresAt = new Date(value.expiresAt)
  if (
    issuedAt.toISOString() !== value.issuedAt ||
    expiresAt.toISOString() !== value.expiresAt ||
    expiresAt.getTime() - issuedAt.getTime() !== TOKEN_TTL_MS ||
    value.discountPaise > value.listPricePaise ||
    value.payablePaise !==
      value.listPricePaise - value.discountPaise ||
    Boolean(value.couponCampaignDigest) !==
      Boolean(value.couponMode)
  ) {
    context.addIssue({
      code: 'custom',
      message: 'Observation authority evidence is inconsistent',
    })
  }
})

type TokenPayload = z.infer<typeof TokenPayloadSchema>

const testAuthorities = new WeakSet<object>()

function failure(
  code: CommercialFunnelObservationError['code'],
): never {
  throw new CommercialFunnelObservationError(code)
}

function decodeSecret(secretBase64: string | undefined): Buffer {
  if (
    !secretBase64 ||
    secretBase64.trim() !== secretBase64 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      secretBase64,
    )
  ) return failure('disabled')
  const key = Buffer.from(secretBase64, 'base64')
  if (
    key.length < 32 ||
    key.toString('base64') !== secretBase64
  ) {
    key.fill(0)
    return failure('disabled')
  }
  return key
}

function hmac(
  key: Buffer,
  domain: string,
  ...values: readonly string[]
): string {
  const digest = createHmac('sha256', key)
    .update(HMAC_PREFIX)
    .update('\0')
    .update(domain)
  for (const value of values) digest.update('\0').update(value)
  return digest.digest('hex')
}

function exactOrigin(value: string | null | undefined): string {
  if (!value || value.trim() !== value) {
    return failure('origin_mismatch')
  }
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return failure('origin_mismatch')
  }
  if (
    !['https:', 'http:'].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== '/' ||
    parsed.search ||
    parsed.hash ||
    parsed.hostname.endsWith('.') ||
    parsed.origin !== value
  ) return failure('origin_mismatch')
  return value
}

function productionOrigin(): string {
  const app = process.env.APP_URL
  const auth = process.env.NEXTAUTH_URL
  if (!app || app !== auth) return failure('origin_mismatch')
  return exactOrigin(app)
}

function validDate(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime())
}

function exactNow(runtime: {
  readonly now: () => Date
}): Date {
  const now = runtime.now()
  return validDate(now)
    ? now
    : failure('invalid_input')
}

function rolloutDigest(
  key: Buffer,
  read: CommercialRolloutDecisionRead,
): string {
  if (
    DIGEST.test(read.authorityDecisionDigest ?? '') &&
    Number.isSafeInteger(read.authorityStopEpoch) &&
    (read.authorityStopEpoch ?? -1) >= 0
  ) {
    return hmac(
      key,
      'rollout-authority-decision',
      read.authorityDecisionDigest!,
      String(read.authorityStopEpoch),
    )
  }
  const decision = read.decision
  return hmac(
    key,
    'rollout-decision',
    String(read.configRevision),
    read.catalogVersion ?? '',
    decision.audience,
    String(decision.cohortBucket ?? ''),
    decision.cohortPolicyHash ?? '',
    decision.cohortSeedId ?? '',
  )
}

async function activeDecision<TSession extends object>(
  input: {
    readonly userId: string
    readonly catalogVersion?: string
    readonly providerMode?: 'test' | 'live' | null
    readonly rolloutAuthority?: BillingRolloutCheckoutAuthority
  },
  runtime: CommercialFunnelRuntime<TSession>,
): Promise<ActiveDecision | null> {
  if (!OBJECT_ID.test(input.userId)) {
    return failure('invalid_input')
  }
  const userCreatedAt =
    await runtime.readUserCreatedAt(input.userId)
  const decision = await runtime.readRolloutDecision({
    userId: input.userId,
    ...(userCreatedAt ? { userCreatedAt } : {}),
    now: exactNow(runtime),
    ...(input.catalogVersion
      ? { catalogVersion: input.catalogVersion }
      : {}),
  })
  if (
    input.rolloutAuthority &&
    (
      decision.authorityDecisionDigest !==
        input.rolloutAuthority.decisionDigest ||
      decision.authorityProviderMode !==
        input.rolloutAuthority.providerMode ||
      decision.authorityStopEpoch !==
        input.rolloutAuthority.stopEpoch ||
      decision.catalogVersion !==
        input.rolloutAuthority.catalogVersion
    )
  ) return failure('invalid_input')
  if (
    decision.schemaVersion !==
      'billing_rollout_decision_v1' ||
    decision.decision.analyticsEnabled !== true ||
    decision.rollout.decisionReadReady !== true ||
    (
      input.catalogVersion !== undefined &&
      decision.catalogVersion !== input.catalogVersion
    ) ||
    !['qa', 'public_treatment'].includes(
      decision.decision.audience,
    ) ||
    !DIGEST.test(
      decision.decision.cohortPolicyHash ?? '',
    )
  ) return null
  const providerMode = decision.authorityProviderMode ??
    (
      decision.decision.audience === 'qa'
        ? 'test'
        : 'live'
    )
  if (
    input.providerMode !== undefined &&
    input.providerMode !== null &&
    input.providerMode !== providerMode
  ) return failure('invalid_input')
  const key = decodeSecret(runtime.secretBase64)
  return { decision, providerMode, key }
}

function baseDimensions(
  overrides: Partial<
    CommercialAnalyticsEventInput['dimensions']
  > = {},
): CommercialAnalyticsEventInput['dimensions'] {
  return {
    surface: null,
    paywallReason: null,
    catalogVersion: null,
    pricingVariant: null,
    productKey: null,
    couponCampaignId: null,
    couponResult: null,
    couponMode: null,
    eligibilitySegment: null,
    userState: null,
    eligiblePaywall: false,
    codeLength: null,
    interviewsRemaining: null,
    premiumResumesRemaining: null,
    durationMinutes: null,
    accessEndsAt: null,
    firstPaidUseWithin24Hours: null,
    activationKind: null,
    ...overrides,
  }
}

function zeroAmounts():
CommercialAnalyticsEventInput['amounts'] {
  return {
    listPricePaise: 0,
    discountPaise: 0,
    payablePaise: 0,
    renewalPricePaise: null,
    eventAmountPaise: 0,
    allocatedVariableCostPaise: 0,
  }
}

function quoteAmounts(
  quote: ResolvedCustomerBillingQuote['quote'],
): CommercialAnalyticsEventInput['amounts'] {
  if (
    !Number.isSafeInteger(quote.listPricePaise) ||
    !Number.isSafeInteger(quote.discountPaise) ||
    !Number.isSafeInteger(quote.payablePaise) ||
    quote.listPricePaise < 0 ||
    quote.discountPaise < 0 ||
    quote.payablePaise !==
      quote.listPricePaise - quote.discountPaise ||
    (
      quote.renewalPricePaise !== undefined &&
      (
        !Number.isSafeInteger(quote.renewalPricePaise) ||
        quote.renewalPricePaise < 0
      )
    )
  ) return failure('invalid_input')
  return {
    listPricePaise: quote.listPricePaise,
    discountPaise: quote.discountPaise,
    payablePaise: quote.payablePaise,
    renewalPricePaise: quote.renewalPricePaise ?? null,
    eventAmountPaise: 0,
    allocatedVariableCostPaise: 0,
  }
}

function analyticsSurface(
  surface: BillingQuoteSurface,
): NonNullable<
  CommercialAnalyticsEventInput['dimensions']['surface']
> {
  return surface === 'interviewPaywall'
    ? 'interview_paywall'
    : surface
}

function event(
  input: {
    readonly eventName:
      | 'pricing_viewed'
      | 'coupon_exposed'
      | 'coupon_code_entered'
      | 'coupon_validated'
      | 'coupon_rejected'
      | 'plan_selected'
      | 'paywall_viewed'
      | 'checkout_opened'
      | 'mandate_started'
      | 'checkout_dismissed'
    readonly source:
      | 'server_pricing_decision'
      | 'verified_client_observation'
      | 'signed_webhook'
      | 'reconciliation'
    readonly sourceEvidenceDigest: string
    readonly correlationDigest: string
    readonly subjectDigest: string
    readonly providerMode: 'test' | 'live'
    readonly occurredAt: Date
    readonly dimensions:
      CommercialAnalyticsEventInput['dimensions']
    readonly amounts:
      CommercialAnalyticsEventInput['amounts']
  },
): CommercialAnalyticsEventInput {
  if (!validDate(input.occurredAt)) {
    return failure('invalid_input')
  }
  return {
    schemaVersion: 'payment_commercial_analytics_event_v1',
    authority: 'server',
    ...input,
    occurredAt: input.occurredAt.toISOString(),
  }
}

async function appendBatch<TSession extends object>(
  events: readonly CommercialAnalyticsEventInput[],
  runtime: CommercialFunnelRuntime<TSession>,
): Promise<readonly ('created' | 'replayed')[]> {
  return runtime.runTransaction(async (session) => {
    const outcomes: ('created' | 'replayed')[] = []
    for (const item of events) {
      outcomes.push(await runtime.append(item, session))
    }
    return outcomes
  })
}

async function recordPricingCore<TSession extends object>(
  input: {
    readonly userId: string
    readonly catalogVersion: string
  },
  runtime: CommercialFunnelRuntime<TSession>,
): Promise<void> {
  const active = await activeDecision(input, runtime)
  if (!active) return
  try {
    const nonce = runtime.randomBytes(32).toString('hex')
    const occurredAt = exactNow(runtime)
    await appendBatch([event({
      eventName: 'pricing_viewed',
      source: 'server_pricing_decision',
      sourceEvidenceDigest: hmac(
        active.key,
        'pricing-response-source',
        active.providerMode,
        nonce,
      ),
      correlationDigest: hmac(
        active.key,
        'pricing-response-correlation',
        active.providerMode,
        nonce,
      ),
      subjectDigest: hmac(
        active.key,
        'commercial-subject',
        active.providerMode,
        input.userId,
      ),
      providerMode: active.providerMode,
      occurredAt,
      dimensions: baseDimensions({
        surface: 'pricing',
        catalogVersion: input.catalogVersion,
        pricingVariant:
          active.decision.decision.cohortPolicyHash ?? null,
      }),
      amounts: zeroAmounts(),
    })], runtime)
  } finally {
    active.key.fill(0)
  }
}

function selectedCouponDigest(
  resolved: ResolvedCustomerBillingQuote,
  key: Buffer,
  providerMode: 'test' | 'live',
): string | undefined {
  const selected = resolved.selectedCandidate
  const disclosed = resolved.quote.coupon
  if (!selected && !disclosed) return undefined
  if (
    !selected ||
    !disclosed ||
    selected.campaignId !== disclosed.campaignId ||
    selected.revision !== disclosed.revision ||
    selected.mode !== disclosed.mode ||
    !OBJECT_ID.test(selected.campaignId)
  ) return failure('invalid_input')
  return hmac(
    key,
    'coupon-campaign',
    providerMode,
    selected.campaignId,
  )
}

async function recordQuoteCore<TSession extends object>(
  input: {
    readonly userId: string
    readonly surface: BillingQuoteSurface
    readonly manualCodeLength?: number
    readonly resolved: ResolvedCustomerBillingQuote
    readonly rolloutAuthority?: BillingRolloutCheckoutAuthority
  },
  runtime: CommercialFunnelRuntime<TSession>,
): Promise<void> {
  const quote = input.resolved.quote
  const active = await activeDecision({
    userId: input.userId,
    catalogVersion: quote.catalogVersion,
    providerMode: input.resolved.providerMode,
    rolloutAuthority: input.rolloutAuthority,
  }, runtime)
  if (!active) return
  try {
    if (
      typeof quote.quoteId !== 'string' ||
      quote.quoteId.length < 1 ||
      (
        input.manualCodeLength !== undefined &&
        (
          !Number.isSafeInteger(input.manualCodeLength) ||
          input.manualCodeLength < 3 ||
          input.manualCodeLength > 40
        )
      )
    ) return failure('invalid_input')
    const occurredAt = exactNow(runtime)
    const campaignDigest = selectedCouponDigest(
      input.resolved,
      active.key,
      active.providerMode,
    )
    const productKey = quote.planKey ?? quote.sku
    if (!productKey) return failure('invalid_input')
    const correlationDigest = hmac(
      active.key,
      'quote-correlation',
      active.providerMode,
      quote.quoteId,
    )
    const subjectDigest = hmac(
      active.key,
      'commercial-subject',
      active.providerMode,
      input.userId,
    )
    const commonDimensions = {
      surface: analyticsSurface(input.surface),
      catalogVersion: quote.catalogVersion,
      pricingVariant:
        active.decision.decision.cohortPolicyHash ?? null,
      productKey,
      eligibilitySegment:
        input.resolved.history?.resolvedSegment ?? null,
    } as const
    const events: CommercialAnalyticsEventInput[] = []
    const add = (
      eventName:
        | 'coupon_exposed'
        | 'coupon_code_entered'
        | 'coupon_validated'
        | 'coupon_rejected'
        | 'plan_selected',
      dimensions: Partial<
        CommercialAnalyticsEventInput['dimensions']
      >,
    ) => events.push(event({
      eventName,
      source: 'server_pricing_decision',
      sourceEvidenceDigest: hmac(
        active.key,
        'quote-decision-source',
        active.providerMode,
        quote.quoteId,
        eventName,
      ),
      correlationDigest,
      subjectDigest,
      providerMode: active.providerMode,
      occurredAt,
      dimensions: baseDimensions({
        ...commonDimensions,
        ...dimensions,
      }),
      amounts: quoteAmounts(quote),
    }))
    if (
      input.surface === 'checkout' &&
      input.manualCodeLength === undefined
    ) add('plan_selected', {})
    if (campaignDigest && quote.coupon) {
      add('coupon_exposed', {
        couponCampaignDigest: campaignDigest,
        couponMode: quote.coupon.mode,
      })
    }
    if (input.manualCodeLength !== undefined) {
      add('coupon_code_entered', {
        codeLength: input.manualCodeLength,
      })
      if (quote.manualCodeResult === 'applied' && campaignDigest) {
        add('coupon_validated', {
          couponCampaignDigest: campaignDigest,
          couponResult: 'applied',
          couponMode: quote.coupon?.mode ?? null,
        })
      } else {
        add('coupon_rejected', {
          codeLength: input.manualCodeLength,
          couponResult: quote.manualCodeResult ?? 'invalid',
        })
      }
    }
    if (events.length > 0) await appendBatch(events, runtime)
  } finally {
    active.key.fill(0)
  }
}

async function recordPaywallCore<TSession extends object>(
  input: {
    readonly userId: string
    readonly sourceKey: string
    readonly catalogVersion?: string
    readonly providerMode?: 'test' | 'live' | null
    readonly surface:
      | 'interview_paywall'
      | 'resume'
      | 'feedback'
    readonly reason:
      | 'interview_limit'
      | 'duration_limit'
      | 'premium_resume_required'
      | 'subscription_inactive'
    readonly durationMinutes?: 10 | 20 | 30
  },
  runtime: CommercialFunnelRuntime<TSession>,
): Promise<void> {
  const active = await activeDecision(input, runtime)
  if (!active) return
  try {
    if (
      typeof input.sourceKey !== 'string' ||
      input.sourceKey.length < 1 ||
      input.sourceKey.length > 512
    ) return failure('invalid_input')
    const occurredAt = exactNow(runtime)
    await appendBatch([event({
      eventName: 'paywall_viewed',
      source: 'server_pricing_decision',
      sourceEvidenceDigest: hmac(
        active.key,
        'paywall-decision-source',
        active.providerMode,
        input.sourceKey,
      ),
      correlationDigest: hmac(
        active.key,
        'paywall-correlation',
        active.providerMode,
        input.sourceKey,
      ),
      subjectDigest: hmac(
        active.key,
        'commercial-subject',
        active.providerMode,
        input.userId,
      ),
      providerMode: active.providerMode,
      occurredAt,
      dimensions: baseDimensions({
        surface: input.surface,
        paywallReason: input.reason,
        catalogVersion: input.catalogVersion ??
          active.decision.catalogVersion ?? null,
        pricingVariant:
          active.decision.decision.cohortPolicyHash ?? null,
        eligiblePaywall: true,
        durationMinutes: input.durationMinutes ?? null,
      }),
      amounts: zeroAmounts(),
    })], runtime)
  } finally {
    active.key.fill(0)
  }
}

function validCheckoutSnapshot(
  input: CheckoutSnapshot,
): void {
  if (
    !OBJECT_ID.test(input.userId) ||
    !OBJECT_ID.test(input.intentId) ||
    !input.catalogVersion ||
    input.catalogVersion.length > 120 ||
    !Number.isSafeInteger(input.listPricePaise) ||
    !Number.isSafeInteger(input.discountPaise) ||
    !Number.isSafeInteger(input.payablePaise) ||
    input.listPricePaise < 0 ||
    input.discountPaise < 0 ||
    input.payablePaise !==
      input.listPricePaise - input.discountPaise ||
    (
      input.renewalPricePaise !== null &&
      (
        !Number.isSafeInteger(input.renewalPricePaise) ||
        input.renewalPricePaise < 0
      )
    ) ||
    Boolean(input.couponCampaignId) !==
      Boolean(input.couponMode) ||
    (
      input.couponCampaignId !== undefined &&
      !OBJECT_ID.test(input.couponCampaignId)
    )
  ) failure('invalid_input')
}

function signPayload(key: Buffer, payload: TokenPayload): string {
  const encoded = Buffer
    .from(JSON.stringify(payload), 'utf8')
    .toString('base64url')
  const signature = createHmac('sha256', key)
    .update(HMAC_PREFIX)
    .update('\0checkout-observation-token\0')
    .update(encoded)
    .digest('base64url')
  return `${encoded}.${signature}`
}

function verifyPayload(
  key: Buffer,
  authorization: string,
): TokenPayload {
  if (
    authorization.length > 4_096 ||
    authorization.trim() !== authorization
  ) return failure('invalid_authority')
  const parts = authorization.split('.')
  if (
    parts.length !== 2 ||
    !parts.every((part) => TOKEN_PART.test(part))
  ) return failure('invalid_authority')
  const expected = createHmac('sha256', key)
    .update(HMAC_PREFIX)
    .update('\0checkout-observation-token\0')
    .update(parts[0])
    .digest()
  let supplied: Buffer
  try {
    supplied = Buffer.from(parts[1], 'base64url')
  } catch {
    return failure('invalid_authority')
  }
  if (
    supplied.length !== expected.length ||
    !timingSafeEqual(supplied, expected)
  ) return failure('invalid_authority')
  let raw: unknown
  try {
    raw = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'))
  } catch {
    return failure('invalid_authority')
  }
  const parsed = TokenPayloadSchema.safeParse(raw)
  return parsed.success
    ? parsed.data
    : failure('invalid_authority')
}

async function mintCheckoutCore<TSession extends object>(
  input: CheckoutSnapshot & {
    readonly requestOrigin: string | null
    readonly fetchSite: string | null
    readonly configuredOrigin: string
  },
  runtime: CommercialFunnelRuntime<TSession>,
): Promise<CheckoutObservationAuthority | null> {
  validCheckoutSnapshot(input)
  const configuredOrigin = exactOrigin(input.configuredOrigin)
  if (
    exactOrigin(input.requestOrigin) !== configuredOrigin ||
    input.fetchSite !== 'same-origin'
  ) return failure('origin_mismatch')
  const active = await activeDecision(input, runtime)
  if (!active) return null
  try {
    if (active.providerMode !== input.providerMode) {
      return failure('invalid_input')
    }
    const now = exactNow(runtime)
    const expiresAt = new Date(now.getTime() + TOKEN_TTL_MS)
    const csrf = runtime.randomBytes(32).toString('base64url')
    const payload = TokenPayloadSchema.parse({
      version: 1,
      nonce: runtime.randomBytes(32).toString('hex'),
      subjectDigest: hmac(
        active.key,
        'commercial-subject',
        input.providerMode,
        input.userId,
      ),
      intentDigest: hmac(
        active.key,
        'checkout-intent',
        input.providerMode,
        input.intentId,
      ),
      csrfDigest: hmac(
        active.key,
        'observation-csrf',
        input.providerMode,
        csrf,
      ),
      rolloutDigest: rolloutDigest(
        active.key,
        active.decision,
      ),
      providerMode: input.providerMode,
      issuedAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      origin: configuredOrigin,
      catalogVersion: input.catalogVersion,
      productKey: input.productKey,
      couponCampaignDigest: input.couponCampaignId
        ? hmac(
            active.key,
            'coupon-campaign',
            input.providerMode,
            input.couponCampaignId,
          )
        : null,
      couponMode: input.couponMode ?? null,
      listPricePaise: input.listPricePaise,
      discountPaise: input.discountPaise,
      payablePaise: input.payablePaise,
      renewalPricePaise: input.renewalPricePaise,
    })
    return {
      schemaVersion:
        'commercial_checkout_observation_v1',
      authorization: signPayload(active.key, payload),
      csrf,
      expiresAt: payload.expiresAt,
      endpoint:
        '/api/billing/analytics/checkout-observation',
    }
  } finally {
    active.key.fill(0)
  }
}

async function acceptCheckoutCore<TSession extends object>(
  input: {
    readonly userId: string
    readonly eventName: CheckoutObservationEventName
    readonly authorization: string
    readonly csrf: string
    readonly requestOrigin: string | null
    readonly fetchSite: string | null
    readonly configuredOrigin: string
  },
  runtime: CommercialFunnelRuntime<TSession>,
): Promise<'created' | 'replayed' | 'disabled'> {
  if (!OBSERVATION_EVENTS.includes(input.eventName)) {
    return failure('invalid_input')
  }
  const configuredOrigin = exactOrigin(input.configuredOrigin)
  if (
    exactOrigin(input.requestOrigin) !== configuredOrigin ||
    input.fetchSite !== 'same-origin'
  ) return failure('origin_mismatch')
  const active = await activeDecision({
    userId: input.userId,
  }, runtime)
  if (!active) return 'disabled'
  try {
    const payload = verifyPayload(
      active.key,
      input.authorization,
    )
    const now = exactNow(runtime)
    if (
      payload.origin !== configuredOrigin ||
      payload.providerMode !== active.providerMode ||
      active.decision.catalogVersion !==
        payload.catalogVersion ||
      payload.rolloutDigest !== rolloutDigest(
        active.key,
        active.decision,
      ) ||
      payload.subjectDigest !== hmac(
        active.key,
        'commercial-subject',
        payload.providerMode,
        input.userId,
      ) ||
      payload.csrfDigest !== hmac(
        active.key,
        'observation-csrf',
        payload.providerMode,
        input.csrf,
      )
    ) return failure('invalid_authority')
    if (
      now < new Date(payload.issuedAt) ||
      now > new Date(payload.expiresAt)
    ) return failure('expired')
    const [outcome] = await appendBatch([event({
      eventName: input.eventName,
      source: 'verified_client_observation',
      sourceEvidenceDigest: hmac(
        active.key,
        'client-observation-source',
        payload.providerMode,
        payload.intentDigest,
        input.eventName,
      ),
      correlationDigest: payload.intentDigest,
      subjectDigest: payload.subjectDigest,
      providerMode: payload.providerMode,
      occurredAt: now,
      dimensions: baseDimensions({
        surface: 'checkout',
        catalogVersion: payload.catalogVersion,
        pricingVariant:
          active.decision.decision.cohortPolicyHash ?? null,
        productKey: payload.productKey,
        couponCampaignDigest:
          payload.couponCampaignDigest ?? undefined,
        couponMode: payload.couponMode,
      }),
      amounts: {
        listPricePaise: payload.listPricePaise,
        discountPaise: payload.discountPaise,
        payablePaise: payload.payablePaise,
        renewalPricePaise: payload.renewalPricePaise,
        eventAmountPaise: 0,
        allocatedVariableCostPaise: 0,
      },
    })], runtime)
    return outcome
  } finally {
    active.key.fill(0)
  }
}

async function appendMandateCore<TSession extends object>(
  evidence: SubscriptionStateCommercialAnalyticsEvidence,
  session: TSession,
  runtime: CommercialFunnelRuntime<TSession>,
): Promise<void> {
  if (!evidence.providerMandateObserved) return
  const active = await activeDecision({
    userId: evidence.subjectId,
    catalogVersion: evidence.catalogVersion,
    providerMode: evidence.providerMode,
  }, runtime)
  if (!active) return
  try {
    await runtime.append(event({
      eventName: 'mandate_started',
      source: evidence.observationSource === 'signed_webhook'
        ? 'signed_webhook'
        : 'reconciliation',
      sourceEvidenceDigest: hmac(
        active.key,
        'provider-mandate-source',
        evidence.providerMode,
        evidence.sourceEvidenceKey,
      ),
      correlationDigest: hmac(
        active.key,
        'checkout-intent',
        evidence.providerMode,
        evidence.correlationId,
      ),
      subjectDigest: hmac(
        active.key,
        'commercial-subject',
        evidence.providerMode,
        evidence.subjectId,
      ),
      providerMode: evidence.providerMode,
      occurredAt: evidence.occurredAt,
      dimensions: baseDimensions({
        surface: 'checkout',
        catalogVersion: evidence.catalogVersion,
        productKey: evidence.productKey,
        couponCampaignDigest: evidence.couponCampaignId
          ? hmac(
              active.key,
              'coupon-campaign',
              evidence.providerMode,
              evidence.couponCampaignId,
            )
          : undefined,
        lifecycleStage: 'subscription_mandate',
        lifecycleReason: 'awaiting_entitlement',
      }),
      amounts: {
        listPricePaise: evidence.listPricePaise,
        discountPaise: evidence.discountPaise,
        payablePaise: evidence.payablePaise,
        renewalPricePaise: evidence.renewalPricePaise,
        eventAmountPaise: 0,
        allocatedVariableCostPaise: 0,
      },
    }), session)
  } finally {
    active.key.fill(0)
  }
}

async function readUserCreatedAt(
  userId: string,
): Promise<Date | undefined> {
  await connectDB()
  const user = await User.findById(userId)
    .select({ createdAt: 1 })
    .lean()
  return validDate(user?.createdAt)
    ? user.createdAt
    : undefined
}

function legacyDecisionFromAuthority(
  decision: BillingRolloutAuthorityDecision,
): CommercialRolloutDecisionRead['decision'] {
  const policyReady = DIGEST.test(
    decision.rolloutPolicyHash ?? '',
  )
  return {
    sellingAllowed: decision.sellingAllowed,
    enforcementEnabled: decision.enforcementEnabled,
    shadowOnly: false,
    copyEnabled: decision.copyEnabled,
    analyticsEnabled: decision.analyticsEnabled,
    communicationsEnabled: decision.communicationsEnabled,
    qaUser: decision.audience === 'qa',
    audience: decision.audience,
    cohortIncluded: decision.cohortIncluded,
    ...(decision.cohortBucket !== undefined
      ? { cohortBucket: decision.cohortBucket }
      : {}),
    ...(policyReady
      ? {
          cohortPolicyVersion: 1 as const,
          cohortPolicyHash: decision.rolloutPolicyHash,
          cohortSeedId: decision.activationId,
        }
      : {}),
    reason: decision.enabled
      ? 'selling_allowed'
      : decision.reason === 'grandfathered'
        ? 'grandfathered'
        : decision.reason === 'public_control'
          ? 'outside_cohort'
          : decision.reason === 'before_entry'
            ? 'before_enforcement_start'
            : 'selling_off',
  }
}

async function readProductionCommercialRolloutDecision(
  input: Parameters<typeof readBillingRolloutDecision>[0],
): Promise<CommercialRolloutDecisionRead> {
  const now = input.now ?? new Date()
  await connectDB()
  const buyer = await User.findById(input.userId)
    .select('buyerState')
    .lean<{ buyerState?: string }>()
  const decision = await readProductionBillingRolloutDecision({
    userId: input.userId,
    userCreatedAt: input.userCreatedAt,
    buyerState: buyer?.buyerState,
    now,
  })
  const decisionReadReady = Boolean(
    decision.enabled &&
    decision.analyticsEnabled &&
    decision.providerMode &&
    decision.catalogVersion &&
    decision.catalogHash &&
    DIGEST.test(decision.decisionDigest ?? '') &&
    DIGEST.test(decision.rolloutPolicyHash ?? ''),
  )
  return {
    schemaVersion: 'billing_rollout_decision_v1',
    configRevision: decision.authorityRevision ?? 0,
    configPersisted: decision.enabled,
    evaluatedAt: now.toISOString(),
    catalogVersion: decision.catalogVersion,
    rollout: {
      decisionReadReady,
    } as BillingRolloutDecisionRead['rollout'],
    decision: legacyDecisionFromAuthority(decision),
    authorityDecisionDigest: decision.decisionDigest,
    authorityProviderMode: decision.providerMode,
    authorityStopEpoch: decision.stopEpoch,
  }
}

async function runMongoTransaction<T>(
  work: (session: ClientSession) => Promise<T>,
): Promise<T> {
  await connectDB()
  const session = await mongoose.startSession()
  let result: T | undefined
  try {
    await session.withTransaction(async () => {
      result = await work(session)
    }, {
      readConcern: { level: 'snapshot' },
      writeConcern: { w: 'majority' },
      readPreference: 'primary',
    })
    return result as T
  } finally {
    await session.endSession()
  }
}

const productionRuntime:
CommercialFunnelRuntime<ClientSession> = {
  readRolloutDecision:
    readProductionCommercialRolloutDecision,
  readUserCreatedAt,
  runTransaction: runMongoTransaction,
  async append(item, session) {
    return (
      await appendCommercialAnalyticsEvent({
        event: item,
        session,
      })
    ).outcome
  },
  now: () => new Date(),
  randomBytes: secureRandomBytes,
  secretBase64: process.env[HMAC_SECRET_ENV],
}

function assertTestAuthority(
  authority: CommercialFunnelTestAuthority,
): void {
  if (
    process.env.NODE_ENV !== 'test' ||
    !testAuthorities.has(authority)
  ) failure('disabled')
}

export function composeCommercialFunnelTestAuthorityForTest(
  analytics: CommercialAnalyticsTestAuthority,
): CommercialFunnelTestAuthority {
  if (
    process.env.NODE_ENV !== 'test' ||
    PAYMENT_COMMERCIAL_ANALYTICS_EVENT_WRITES_READY ||
    PAYMENT_COMMERCIAL_ANALYTICS_CMS_READ_READY
  ) return failure('disabled')
  const authority = Object.freeze({
    kind: 'commercial_funnel_analytics_test_v1',
    analytics,
  } as const)
  testAuthorities.add(authority)
  return authority
}

export function commercialFunnelTestRuntime<TSession extends object>(
  authority: CommercialFunnelTestAuthority,
  input: Omit<
    CommercialFunnelRuntime<TSession>,
    'append'
  >,
  store: CommercialAnalyticsAppendStore<TSession>,
): CommercialFunnelRuntime<TSession> {
  assertTestAuthority(authority)
  return {
    ...input,
    async append(item, session) {
      return (
        await appendCommercialAnalyticsEventForTest(
          authority.analytics,
          { event: item, session },
          store,
        )
      ).outcome
    },
  }
}

export async function recordPricingViewedForTest<
  TSession extends object,
>(
  authority: CommercialFunnelTestAuthority,
  input: Parameters<typeof recordPricingCore<TSession>>[0],
  runtime: CommercialFunnelRuntime<TSession>,
) {
  assertTestAuthority(authority)
  return recordPricingCore(input, runtime)
}

export async function recordQuoteFunnelForTest<
  TSession extends object,
>(
  authority: CommercialFunnelTestAuthority,
  input: Parameters<typeof recordQuoteCore<TSession>>[0],
  runtime: CommercialFunnelRuntime<TSession>,
) {
  assertTestAuthority(authority)
  return recordQuoteCore(input, runtime)
}

export async function recordPaywallViewedForTest<
  TSession extends object,
>(
  authority: CommercialFunnelTestAuthority,
  input: Parameters<typeof recordPaywallCore<TSession>>[0],
  runtime: CommercialFunnelRuntime<TSession>,
) {
  assertTestAuthority(authority)
  return recordPaywallCore(input, runtime)
}

export async function mintCheckoutObservationForTest<
  TSession extends object,
>(
  authority: CommercialFunnelTestAuthority,
  input: Parameters<typeof mintCheckoutCore<TSession>>[0],
  runtime: CommercialFunnelRuntime<TSession>,
) {
  assertTestAuthority(authority)
  return mintCheckoutCore(input, runtime)
}

export async function acceptCheckoutObservationForTest<
  TSession extends object,
>(
  authority: CommercialFunnelTestAuthority,
  input: Parameters<typeof acceptCheckoutCore<TSession>>[0],
  runtime: CommercialFunnelRuntime<TSession>,
) {
  assertTestAuthority(authority)
  return acceptCheckoutCore(input, runtime)
}

export async function appendMandateStartedForTest<
  TSession extends object,
>(
  authority: CommercialFunnelTestAuthority,
  evidence: SubscriptionStateCommercialAnalyticsEvidence,
  session: TSession,
  runtime: CommercialFunnelRuntime<TSession>,
) {
  assertTestAuthority(authority)
  return appendMandateCore(evidence, session, runtime)
}

export async function recordAuthenticatedPricingResponse(
  catalogVersion: string,
): Promise<void> {
  if (!PAYMENT_COMMERCIAL_ANALYTICS_EVENT_WRITES_READY) return
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user?.id) return
    await recordPricingCore({
      userId: session.user.id,
      catalogVersion,
    }, productionRuntime)
  } catch (error) {
    funnelLogger.warn({
      stage: 'pricing_response',
      errorName: error instanceof Error ? error.name : 'UnknownError',
    }, 'Commercial funnel observation was unavailable')
  }
}

export async function recordResolvedQuoteFunnel(input: {
  readonly userId: string
  readonly surface: BillingQuoteSurface
  readonly manualCodeLength?: number
  readonly resolved: ResolvedCustomerBillingQuote
  readonly rolloutAuthority?: BillingRolloutCheckoutAuthority
}): Promise<void> {
  if (!PAYMENT_COMMERCIAL_ANALYTICS_EVENT_WRITES_READY) return
  try {
    await recordQuoteCore(input, productionRuntime)
  } catch (error) {
    funnelLogger.warn({
      stage: 'quote_decision',
      errorName: error instanceof Error ? error.name : 'UnknownError',
    }, 'Commercial funnel observation was unavailable')
  }
}

export async function recordAuthoritativePaywallViewed(
  input: Parameters<typeof recordPaywallCore<ClientSession>>[0],
): Promise<void> {
  if (!PAYMENT_COMMERCIAL_ANALYTICS_EVENT_WRITES_READY) return
  try {
    await recordPaywallCore(input, productionRuntime)
  } catch (error) {
    funnelLogger.warn({
      stage: 'paywall_decision',
      errorName: error instanceof Error ? error.name : 'UnknownError',
    }, 'Commercial funnel observation was unavailable')
  }
}

export async function mintCheckoutObservation(
  input: Omit<
    Parameters<typeof mintCheckoutCore<ClientSession>>[0],
    'configuredOrigin'
  >,
): Promise<CheckoutObservationAuthority | null> {
  if (!PAYMENT_COMMERCIAL_ANALYTICS_EVENT_WRITES_READY) return null
  try {
    return await mintCheckoutCore({
      ...input,
      configuredOrigin: productionOrigin(),
    }, productionRuntime)
  } catch (error) {
    funnelLogger.warn({
      stage: 'checkout_authority',
      errorName: error instanceof Error ? error.name : 'UnknownError',
    }, 'Commercial funnel observation was unavailable')
    return null
  }
}

export async function acceptCheckoutObservation(
  input: Omit<
    Parameters<typeof acceptCheckoutCore<ClientSession>>[0],
    'configuredOrigin'
  >,
): Promise<'created' | 'replayed' | 'disabled'> {
  if (!PAYMENT_COMMERCIAL_ANALYTICS_EVENT_WRITES_READY) {
    return 'disabled'
  }
  return acceptCheckoutCore({
    ...input,
    configuredOrigin: productionOrigin(),
  }, productionRuntime)
}

export async function appendMandateStartedInSession(
  evidence: SubscriptionStateCommercialAnalyticsEvidence,
  session: ClientSession,
): Promise<void> {
  if (!PAYMENT_COMMERCIAL_ANALYTICS_EVENT_WRITES_READY) return
  await appendMandateCore(evidence, session, productionRuntime)
}
