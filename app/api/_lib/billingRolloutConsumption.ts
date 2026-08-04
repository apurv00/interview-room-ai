import { randomUUID } from 'node:crypto'
import mongoose from 'mongoose'
import { connectDB } from '@shared/db/connection'
import { User } from '@shared/db/models/User'
import {
  CheckoutIntent,
  mongoCustomerBillingQuoteStore,
  PR5_COUPON_ACTIVATION_READY,
  resolveCustomerBillingQuote,
  type CustomerBillingQuoteDependencies,
  type CustomerBillingQuoteStore,
  type PaymentCodeReadiness,
  type PaymentSaleBlockReason,
  type PaymentSaleGate,
  type ProviderMode,
  type ResolvedCustomerBillingQuote,
} from '@payments'
import {
  CustomerBillingProfile,
} from '@payments/models/CustomerBillingProfile'
import {
  CURRENT_PAYMENT_CODE_READINESS,
} from '@payments/services/paymentRuntimeGate'
import {
  checkoutBuyerSnapshot,
  createSubscriptionCheckout,
  SubscriptionCheckoutError,
  type SubscriptionCheckoutDependencies,
  type SubscriptionCheckoutInput,
  type SubscriptionCheckoutResult,
  type SubscriptionCheckoutSaleContext,
} from '@payments/services/subscriptionCheckoutService'
import {
  createOneTimeCheckout,
  type OneTimeCheckoutDependencies,
  type OneTimeCheckoutInput,
  type OneTimeCheckoutResult,
} from '@payments/services/oneTimeCheckoutService'
import {
  createOrReuseRemoteCheckout,
  RemoteCheckoutCreationError,
  type RemoteCheckoutCreationDependencies,
  type RemoteCheckoutCreationInput,
  type RemoteCheckoutCreationResult,
} from '@payments/services/remoteCheckoutCreationService'
import {
  createRazorpayClientFactory,
  type RazorpayClientFactory,
} from '@payments/providers/razorpayClientFactory'
import type {
  RazorpayOrderDto,
  RazorpayServerAdapter,
  RazorpaySubscriptionDto,
} from '@payments/providers/razorpayServerAdapter'
import type {
  CustomerBillingQuoteRequest,
} from '@payments/validators/customerBilling'
import {
  type BillingRolloutAuthorityDecision,
  type BillingRolloutDecisionInput,
  type BillingRolloutSku,
} from '@modules/payment-rollout-control'
import {
  BILLING_ROLLOUT_CHECKOUT_AUTHORITY_SCHEMA_VERSION,
  composeBillingRolloutCheckoutAuthority,
  parseBillingRolloutCheckoutAuthority,
  sameBillingRolloutCheckoutAuthority,
  type BillingRolloutCheckoutAuthority,
} from '@modules/payment-rollout-consumption'
import {
  readProductionBillingRolloutDecision,
} from '@modules/payment-rollout-runtime'

const OBJECT_ID_PATTERN = /^[a-f0-9]{24}$/

export {
  BILLING_ROLLOUT_CHECKOUT_AUTHORITY_SCHEMA_VERSION,
}
export type { BillingRolloutCheckoutAuthority }

export class BillingRolloutConsumptionError extends Error {
  constructor(
    readonly code:
      | 'buyer_unavailable'
      | 'authority_unavailable'
      | 'sale_blocked'
      | 'catalog_mismatch'
      | 'coupon_unavailable'
      | 'intent_authority_mismatch'
      | 'provider_authority_mismatch',
    readonly saleBlockReason: PaymentSaleBlockReason,
    cause?: unknown,
  ) {
    super(
      'Billing is temporarily unavailable',
      cause === undefined ? undefined : { cause },
    )
    this.name = 'BillingRolloutConsumptionError'
  }
}

interface BillingRolloutSubject {
  readonly buyerState?: string
  readonly createdAt?: Date
}

interface BillingRolloutCheckoutBuyer extends BillingRolloutSubject {
  readonly name: string
  readonly email: string
  readonly billingProfile: {
    readonly version: number
    readonly contentHash: string
    readonly placeOfSupply: unknown
  } | null
}

interface PersistedCheckoutAuthority {
  readonly authority: BillingRolloutCheckoutAuthority
  readonly providerMode: ProviderMode
  readonly catalogVersion: string
  readonly rolloutSku: BillingRolloutSku
}

export interface BillingRolloutConsumptionDependencies {
  readonly now: () => Date
  readonly quoteId: () => string
  readonly codeReadiness: Readonly<PaymentCodeReadiness>
  readonly couponActivationReady: boolean
  readonly readDecision: (
    input: BillingRolloutDecisionInput,
  ) => Promise<BillingRolloutAuthorityDecision>
  readonly loadSubject: (
    userId: string,
  ) => Promise<BillingRolloutSubject | null>
  readonly loadCheckoutBuyer: (
    userId: string,
  ) => Promise<BillingRolloutCheckoutBuyer | null>
  readonly quoteStore: CustomerBillingQuoteStore
  readonly resolveQuote: typeof resolveCustomerBillingQuote
  readonly createSubscription:
    typeof createSubscriptionCheckout
  readonly createOneTime: typeof createOneTimeCheckout
  readonly createRemote: typeof createOrReuseRemoteCheckout
  readonly clientFactory: RazorpayClientFactory
  readonly loadPersistedAuthority: (
    input: RemoteCheckoutCreationInput,
  ) => Promise<PersistedCheckoutAuthority | null>
}

export type BillingRolloutConsumptionOverrides =
  Partial<BillingRolloutConsumptionDependencies>

export interface AuthorizedBillingQuote {
  readonly resolved: ResolvedCustomerBillingQuote
  readonly authority: BillingRolloutCheckoutAuthority
}

export interface AuthorizedSubscriptionCheckout {
  readonly checkout: SubscriptionCheckoutResult
  readonly authority: BillingRolloutCheckoutAuthority
}

export interface AuthorizedOneTimeCheckout {
  readonly checkout: OneTimeCheckoutResult
  readonly authority: BillingRolloutCheckoutAuthority
}

let productionRazorpayClientFactory: RazorpayClientFactory | undefined

function getProductionRazorpayClientFactory(): RazorpayClientFactory {
  productionRazorpayClientFactory ??= createRazorpayClientFactory()
  return productionRazorpayClientFactory
}

function validDate(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime())
}

function validObjectId(value: string): boolean {
  return OBJECT_ID_PATTERN.test(value.toLowerCase())
}

async function loadMongoSubject(
  userId: string,
): Promise<BillingRolloutSubject | null> {
  if (!validObjectId(userId)) return null
  await connectDB()
  const buyer = await User.findById(userId)
    .select('buyerState createdAt')
    .lean<{ buyerState?: string; createdAt?: Date }>()
  return buyer
    ? {
        buyerState: buyer.buyerState,
        createdAt: validDate(buyer.createdAt)
          ? buyer.createdAt
          : undefined,
      }
    : null
}

async function loadMongoCheckoutBuyer(
  userId: string,
): Promise<BillingRolloutCheckoutBuyer | null> {
  if (!validObjectId(userId)) return null
  await connectDB()
  const userObjectId = new mongoose.Types.ObjectId(userId)
  const [buyer, billingProfile] = await Promise.all([
    User.findById(userObjectId)
      .select('name email buyerState createdAt')
      .lean<{
        name?: string
        email?: string
        buyerState?: string
        createdAt?: Date
      }>(),
    CustomerBillingProfile.findOne({ userId: userObjectId })
      .select('version contentHash placeOfSupply')
      .lean<{
        version: number
        contentHash: string
        placeOfSupply: unknown
      }>(),
  ])
  if (
    !buyer ||
    typeof buyer.name !== 'string' ||
    typeof buyer.email !== 'string'
  ) return null
  return {
    name: buyer.name,
    email: buyer.email,
    buyerState: buyer.buyerState,
    createdAt: validDate(buyer.createdAt)
      ? buyer.createdAt
      : undefined,
    billingProfile: billingProfile ?? null,
  }
}

function rolloutSkuFromRequest(
  request: CustomerBillingQuoteRequest,
): BillingRolloutSku {
  if (request.planKey === 'plus') return 'plus_subscription'
  if (request.planKey === 'pro') return 'pro_subscription'
  if (request.sku === 'single_interview') {
    return 'additional_interview'
  }
  return 'premium_resume_unlock'
}

function rolloutSkuFromSubscription(
  input: SubscriptionCheckoutInput,
): BillingRolloutSku {
  return input.request.planKey === 'plus'
    ? 'plus_subscription'
    : 'pro_subscription'
}

function rolloutSkuFromOneTime(
  input: OneTimeCheckoutInput,
): BillingRolloutSku {
  return input.request.sku === 'single_interview'
    ? 'additional_interview'
    : 'premium_resume_unlock'
}

function blocked(
  code: BillingRolloutConsumptionError['code'],
  saleBlockReason: PaymentSaleBlockReason,
  cause?: unknown,
): BillingRolloutConsumptionError {
  return new BillingRolloutConsumptionError(
    code,
    saleBlockReason,
    cause,
  )
}

function decisionBlockReason(
  decision: BillingRolloutAuthorityDecision,
): PaymentSaleBlockReason {
  if (decision.reason === 'deletion_pending') {
    return 'buyer_deletion_pending'
  }
  if (
    decision.reason === 'qa_control' ||
    decision.reason === 'public_control' ||
    decision.reason === 'grandfathered'
  ) return 'not_qa_user'
  return 'selling_off'
}

function authorityFromDecision(input: {
  readonly decision: BillingRolloutAuthorityDecision
  readonly rolloutSku: BillingRolloutSku
  readonly boundAt: Date
  readonly readiness: Readonly<PaymentCodeReadiness>
}): BillingRolloutCheckoutAuthority {
  const { decision, rolloutSku, boundAt, readiness } = input
  if (!readiness.remoteCreationReady) {
    throw blocked(
      'sale_blocked',
      'remote_creation_not_ready',
    )
  }
  if (!readiness.recoveryReady) {
    throw blocked(
      'sale_blocked',
      'payment_recovery_not_ready',
    )
  }
  if (
    !decision.enabled ||
    !decision.sellingAllowed ||
    !decision.cohortIncluded ||
    !decision.providerMode ||
    !decision.skuScope.includes(rolloutSku)
  ) {
    throw blocked(
      'sale_blocked',
      decisionBlockReason(decision),
    )
  }
  if (
    decision.providerMode === 'live' &&
    !readiness.liveCreationReady
  ) {
    throw blocked(
      'sale_blocked',
      'live_creation_not_ready',
    )
  }
  if (
    (rolloutSku === 'plus_subscription' ||
      rolloutSku === 'pro_subscription') &&
    !decision.couponEnabled
  ) {
    throw blocked('coupon_unavailable', 'selling_off')
  }
  const candidate = composeBillingRolloutCheckoutAuthority({
    decision,
    rolloutSku,
    boundAt,
  })
  if (!candidate) {
    throw blocked('authority_unavailable', 'selling_off')
  }
  return candidate
}

function exactAuthorityMatch(
  expected: BillingRolloutCheckoutAuthority,
  current: BillingRolloutCheckoutAuthority,
): boolean {
  return sameBillingRolloutCheckoutAuthority(
    expected,
    current,
  )
}

async function resolveAuthority(input: {
  readonly userId: string
  readonly rolloutSku: BillingRolloutSku
  readonly subject: BillingRolloutSubject
  readonly dependencies: BillingRolloutConsumptionDependencies
  readonly now: Date
}): Promise<BillingRolloutCheckoutAuthority> {
  let decision: BillingRolloutAuthorityDecision
  try {
    decision = await input.dependencies.readDecision({
      userId: input.userId,
      userCreatedAt: input.subject.createdAt,
      buyerState: input.subject.buyerState,
      now: input.now,
    })
  } catch (cause) {
    throw blocked('authority_unavailable', 'selling_off', cause)
  }
  return authorityFromDecision({
    decision,
    rolloutSku: input.rolloutSku,
    boundAt: input.now,
    readiness: input.dependencies.codeReadiness,
  })
}

function quoteStoreForAuthority(input: {
  readonly userId: string
  readonly authority: BillingRolloutCheckoutAuthority
  readonly base: CustomerBillingQuoteStore
}): CustomerBillingQuoteStore {
  return {
    ...input.base,
    async readBillingContext(userId) {
      if (userId !== input.userId) {
        throw blocked(
          'authority_unavailable',
          'buyer_not_found',
        )
      }
      const context = await input.base.readBillingContext(userId)
      if (
        !context.catalog ||
        context.catalog.version !== input.authority.catalogVersion ||
        context.catalog.contentHash !== input.authority.catalogHash ||
        context.activeCatalogVersion !==
          input.authority.catalogVersion
      ) {
        throw blocked('catalog_mismatch', 'selling_off')
      }
      const testMode = input.authority.providerMode === 'test'
      return {
        ...context,
        sellingMode: testMode ? 'qa' : 'all',
        couponMode: input.authority.couponEnabled
          ? (testMode ? 'qa' : 'all')
          : 'off',
        qaUserIds: testMode ? [userId] : [],
      }
    },
  }
}

function assertQuoteMatchesAuthority(input: {
  readonly resolved: ResolvedCustomerBillingQuote
  readonly authority: BillingRolloutCheckoutAuthority
  readonly request: CustomerBillingQuoteRequest
}): void {
  const { resolved, authority, request } = input
  if (
    resolved.providerMode !== authority.providerMode ||
    resolved.catalog.version !== authority.catalogVersion ||
    resolved.catalog.contentHash !== authority.catalogHash ||
    resolved.quote.catalogVersion !== authority.catalogVersion ||
    rolloutSkuFromRequest(request) !== authority.rolloutSku
  ) {
    throw blocked('catalog_mismatch', 'selling_off')
  }
  if (request.planKey) {
    const discount = resolved.quote.discountPaise
    if (
      !authority.couponEnabled ||
      !resolved.selectedCandidate ||
      discount < 5_000 ||
      discount > 20_000 ||
      resolved.selectedCandidate.terms.discountPaise !== discount
    ) {
      throw blocked('coupon_unavailable', 'selling_off')
    }
  } else if (
    resolved.quote.discountPaise !== 0 ||
    resolved.selectedCandidate
  ) {
    throw blocked('catalog_mismatch', 'selling_off')
  }
}

async function quoteWithAuthority(input: {
  readonly userId: string
  readonly request: CustomerBillingQuoteRequest
  readonly authority: BillingRolloutCheckoutAuthority
  readonly dependencies: BillingRolloutConsumptionDependencies
  readonly now: Date
}): Promise<ResolvedCustomerBillingQuote> {
  if (
    input.authority.couponEnabled &&
    input.request.planKey &&
    !input.dependencies.couponActivationReady
  ) {
    throw blocked(
      'coupon_unavailable',
      'remote_creation_not_ready',
    )
  }
  const quoteDependencies: CustomerBillingQuoteDependencies = {
    store: quoteStoreForAuthority({
      userId: input.userId,
      authority: input.authority,
      base: input.dependencies.quoteStore,
    }),
    now: () => new Date(input.now),
    quoteId: input.dependencies.quoteId,
    couponActivationReady: input.authority.couponEnabled,
  }
  const resolved = await input.dependencies.resolveQuote({
    userId: input.userId,
    request: input.request,
  }, quoteDependencies)
  assertQuoteMatchesAuthority({
    resolved,
    authority: input.authority,
    request: input.request,
  })
  return resolved
}

function authorityNotes(
  authority: BillingRolloutCheckoutAuthority,
): Readonly<Record<string, string | number>> {
  return Object.freeze({
    billing_rollout_decision: authority.decisionDigest,
    billing_rollout_activation: authority.activationId,
    billing_rollout_stop_epoch: authority.stopEpoch,
  })
}

function assertProviderAuthority(
  value: RazorpayOrderDto | RazorpaySubscriptionDto,
  authority: BillingRolloutCheckoutAuthority,
): void {
  const expected = authorityNotes(authority)
  const matches = Object.entries(expected).every(([key, expectedValue]) =>
    String(value.notes[key]) === String(expectedValue),
  )
  if (!matches) {
    throw blocked(
      'provider_authority_mismatch',
      'selling_off',
    )
  }
}

async function loadMongoPersistedAuthority(
  input: RemoteCheckoutCreationInput,
): Promise<PersistedCheckoutAuthority | null> {
  if (
    !validObjectId(input.userId) ||
    !validObjectId(input.intentId)
  ) return null
  await connectDB()
  const row = await CheckoutIntent.findOne({
    _id: new mongoose.Types.ObjectId(input.intentId),
    userId: new mongoose.Types.ObjectId(input.userId),
  }).select([
    'kind',
    'providerMode',
    'planKey',
    'sku',
    'catalogVersion',
    'buyerSnapshot',
  ].join(' ')).lean<{
    kind: 'subscription' | 'single_interview' | 'premium_resume'
    providerMode: ProviderMode
    planKey?: 'plus' | 'pro'
    sku?: 'single_interview' | 'premium_resume'
    catalogVersion: string
    buyerSnapshot?: Record<string, unknown>
  }>()
  if (!row) return null
  const parsed = parseBillingRolloutCheckoutAuthority(
    row.buyerSnapshot?.billingRolloutAuthority,
  )
  if (!parsed) return null
  const rolloutSku = row.kind === 'subscription'
    ? (
        row.planKey === 'plus'
          ? 'plus_subscription'
          : row.planKey === 'pro'
            ? 'pro_subscription'
            : undefined
      )
    : row.sku === 'single_interview'
      ? 'additional_interview'
      : row.sku === 'premium_resume'
        ? 'premium_resume_unlock'
        : undefined
  if (!rolloutSku) return null
  return {
    authority: parsed,
    providerMode: row.providerMode,
    catalogVersion: row.catalogVersion,
    rolloutSku,
  }
}

function assertPersistedAuthority(input: {
  readonly persisted: PersistedCheckoutAuthority | null
  readonly expected: BillingRolloutCheckoutAuthority
}): void {
  const { persisted, expected } = input
  if (
    !persisted ||
    persisted.providerMode !== expected.providerMode ||
    persisted.catalogVersion !== expected.catalogVersion ||
    persisted.rolloutSku !== expected.rolloutSku ||
    !exactAuthorityMatch(persisted.authority, expected)
  ) {
    throw new RemoteCheckoutCreationError(
      'sale_blocked',
      'Checkout rollout authority is stale',
      { saleBlockReason: 'selling_off' },
    )
  }
}

async function assertCurrentAuthority(input: {
  readonly userId: string
  readonly expected: BillingRolloutCheckoutAuthority
  readonly dependencies: BillingRolloutConsumptionDependencies
}): Promise<void> {
  const subject = await input.dependencies.loadSubject(input.userId)
  if (!subject) {
    throw blocked('buyer_unavailable', 'buyer_not_found')
  }
  const current = await resolveAuthority({
    userId: input.userId,
    rolloutSku: input.expected.rolloutSku,
    subject,
    dependencies: input.dependencies,
    now: input.dependencies.now(),
  })
  if (!exactAuthorityMatch(input.expected, current)) {
    throw blocked('sale_blocked', 'selling_off')
  }
}

function providerAdapterForAuthority(input: {
  readonly adapter: RazorpayServerAdapter
  readonly userId: string
  readonly authority: BillingRolloutCheckoutAuthority
  readonly dependencies: BillingRolloutConsumptionDependencies
}): RazorpayServerAdapter {
  const { adapter, userId, authority, dependencies } = input
  const current = () => assertCurrentAuthority({
    userId,
    expected: authority,
    dependencies,
  })
  return {
    ...adapter,
    async createOrder(createInput) {
      await current()
      const created = await adapter.createOrder({
        ...createInput,
        notes: {
          ...createInput.notes,
          ...authorityNotes(authority),
        },
      })
      assertProviderAuthority(created, authority)
      return created
    },
    async findOrderByReceipt(receipt) {
      const found = await adapter.findOrderByReceipt(receipt)
      if (found) assertProviderAuthority(found, authority)
      return found
    },
    async fetchOrder(orderId) {
      const found = await adapter.fetchOrder(orderId)
      assertProviderAuthority(found, authority)
      return found
    },
    async createSubscription(createInput) {
      await current()
      const created = await adapter.createSubscription({
        ...createInput,
        notes: {
          ...createInput.notes,
          ...authorityNotes(authority),
        },
      })
      assertProviderAuthority(created, authority)
      return created
    },
    async findSubscriptionByCheckoutReceipt(findInput) {
      const found = await adapter
        .findSubscriptionByCheckoutReceipt(findInput)
      if (found) assertProviderAuthority(found, authority)
      return found
    },
    async fetchSubscription(subscriptionId) {
      const found = await adapter.fetchSubscription(subscriptionId)
      assertProviderAuthority(found, authority)
      return found
    },
  }
}

function clientFactoryForAuthority(input: {
  readonly userId: string
  readonly authority: BillingRolloutCheckoutAuthority
  readonly dependencies: BillingRolloutConsumptionDependencies
}): RazorpayClientFactory {
  return {
    forMode(mode) {
      if (mode !== input.authority.providerMode) {
        throw blocked(
          'provider_authority_mismatch',
          'selling_off',
        )
      }
      return providerAdapterForAuthority({
        adapter: input.dependencies.clientFactory.forMode(mode),
        userId: input.userId,
        authority: input.authority,
        dependencies: input.dependencies,
      })
    },
  }
}

async function createRemoteWithAuthority(
  input: RemoteCheckoutCreationInput,
  expected: BillingRolloutCheckoutAuthority,
  dependencies: BillingRolloutConsumptionDependencies,
  remoteDependencies: RemoteCheckoutCreationDependencies = {},
): Promise<RemoteCheckoutCreationResult> {
  const persisted = await dependencies.loadPersistedAuthority(input)
  assertPersistedAuthority({ persisted, expected })
  const evaluateSaleGate = async (): Promise<PaymentSaleGate> => {
    try {
      await assertCurrentAuthority({
        userId: input.userId,
        expected,
        dependencies,
      })
      return {
        allowed: true,
        providerMode: expected.providerMode,
        rollout: expected.audience === 'qa' ? 'qa' : 'all',
      }
    } catch (error) {
      return {
        allowed: false,
        reason: error instanceof BillingRolloutConsumptionError
          ? error.saleBlockReason
          : 'selling_off',
      }
    }
  }
  return dependencies.createRemote(input, {
    ...remoteDependencies,
    evaluateSaleGate,
    clientFactory: clientFactoryForAuthority({
      userId: input.userId,
      authority: expected,
      dependencies,
    }),
  })
}

function productionDependencies(
  overrides: BillingRolloutConsumptionOverrides = {},
): BillingRolloutConsumptionDependencies {
  return {
    now: overrides.now ?? (() => new Date()),
    quoteId: overrides.quoteId ?? randomUUID,
    codeReadiness:
      overrides.codeReadiness ?? CURRENT_PAYMENT_CODE_READINESS,
    couponActivationReady:
      overrides.couponActivationReady ??
      PR5_COUPON_ACTIVATION_READY,
    readDecision:
      overrides.readDecision ??
      readProductionBillingRolloutDecision,
    loadSubject: overrides.loadSubject ?? loadMongoSubject,
    loadCheckoutBuyer:
      overrides.loadCheckoutBuyer ?? loadMongoCheckoutBuyer,
    quoteStore:
      overrides.quoteStore ?? mongoCustomerBillingQuoteStore,
    resolveQuote:
      overrides.resolveQuote ?? resolveCustomerBillingQuote,
    createSubscription:
      overrides.createSubscription ?? createSubscriptionCheckout,
    createOneTime:
      overrides.createOneTime ?? createOneTimeCheckout,
    createRemote:
      overrides.createRemote ?? createOrReuseRemoteCheckout,
    clientFactory:
      overrides.clientFactory ??
      getProductionRazorpayClientFactory(),
    loadPersistedAuthority:
      overrides.loadPersistedAuthority ??
      loadMongoPersistedAuthority,
  }
}

async function authorizedCheckoutContext(input: {
  readonly userId: string
  readonly rolloutSku: BillingRolloutSku
  readonly dependencies: BillingRolloutConsumptionDependencies
}): Promise<{
  readonly authority: BillingRolloutCheckoutAuthority
  readonly saleContext: SubscriptionCheckoutSaleContext
  readonly now: Date
}> {
  if (!input.dependencies.codeReadiness.remoteCreationReady) {
    throw new SubscriptionCheckoutError(
      'sale_blocked',
      'Billing rollout is not ready',
      { saleBlockReason: 'remote_creation_not_ready' },
    )
  }
  const buyer = await input.dependencies
    .loadCheckoutBuyer(input.userId)
  if (!buyer) {
    throw new SubscriptionCheckoutError(
      'buyer_unavailable',
      'Billing buyer was not found',
    )
  }
  const now = input.dependencies.now()
  let authority: BillingRolloutCheckoutAuthority
  try {
    authority = await resolveAuthority({
      userId: input.userId,
      rolloutSku: input.rolloutSku,
      subject: buyer,
      dependencies: input.dependencies,
      now,
    })
  } catch (error) {
    if (error instanceof BillingRolloutConsumptionError) {
      throw new SubscriptionCheckoutError(
        error.code === 'coupon_unavailable'
          ? 'commercial_unavailable'
          : 'sale_blocked',
        'Billing rollout denied checkout',
        {
          cause: error,
          saleBlockReason: error.saleBlockReason,
        },
      )
    }
    throw error
  }
  const baseBuyerSnapshot = checkoutBuyerSnapshot(
    { name: buyer.name, email: buyer.email },
    buyer.billingProfile,
  )
  return {
    authority,
    now,
    saleContext: {
      providerMode: authority.providerMode,
      buyerSnapshot: Object.freeze({
        ...baseBuyerSnapshot,
        billingRolloutAuthority: authority,
      }),
    },
  }
}

export async function resolveBillingRolloutQuote(
  input: {
    readonly userId: string
    readonly request: CustomerBillingQuoteRequest
  },
  overrides: BillingRolloutConsumptionOverrides = {},
): Promise<AuthorizedBillingQuote> {
  const dependencies = productionDependencies(overrides)
  if (!dependencies.codeReadiness.remoteCreationReady) {
    throw blocked(
      'sale_blocked',
      'remote_creation_not_ready',
    )
  }
  const subject = await dependencies.loadSubject(input.userId)
  if (!subject) {
    throw blocked('buyer_unavailable', 'buyer_not_found')
  }
  const now = dependencies.now()
  const authority = await resolveAuthority({
    userId: input.userId,
    rolloutSku: rolloutSkuFromRequest(input.request),
    subject,
    dependencies,
    now,
  })
  const resolved = await quoteWithAuthority({
    ...input,
    authority,
    dependencies,
    now,
  })
  return { resolved, authority }
}

export async function createBillingRolloutSubscriptionCheckout(
  input: SubscriptionCheckoutInput,
  serviceDependencies: Pick<
    SubscriptionCheckoutDependencies,
    'createIntent'
  > = {},
  overrides: BillingRolloutConsumptionOverrides = {},
): Promise<AuthorizedSubscriptionCheckout> {
  const dependencies = productionDependencies(overrides)
  const context = await authorizedCheckoutContext({
    userId: input.userId,
    rolloutSku: rolloutSkuFromSubscription(input),
    dependencies,
  })
  const createIntent = serviceDependencies.createIntent
    ? async (
        intentInput: Parameters<
          NonNullable<SubscriptionCheckoutDependencies['createIntent']>
        >[0],
      ) => {
        if (
          context.authority.couponEnabled &&
          !intentInput.couponReservation
        ) {
          throw new SubscriptionCheckoutError(
            'commercial_unavailable',
            'An approved discount is required for subscription checkout',
          )
        }
        return serviceDependencies.createIntent!(intentInput)
      }
    : undefined
  const checkout = await dependencies.createSubscription(input, {
    ...(createIntent ? { createIntent } : {}),
    resolveSaleContext: async (userId) => {
      if (userId !== input.userId) {
        throw new SubscriptionCheckoutError(
          'persistence_conflict',
          'Checkout user changed during rollout evaluation',
        )
      }
      return context.saleContext
    },
    resolveQuote: async (quoteInput) => {
      if (
        quoteInput.userId !== input.userId ||
        quoteInput.request.planKey !== input.request.planKey ||
        quoteInput.request.surface !== 'checkout'
      ) {
        throw new SubscriptionCheckoutError(
          'persistence_conflict',
          'Checkout quote target changed',
        )
      }
      return quoteWithAuthority({
        userId: input.userId,
        request: quoteInput.request,
        authority: context.authority,
        dependencies,
        now: context.now,
      })
    },
    createRemote: (
      remoteInput,
      remoteDependencies,
    ) => createRemoteWithAuthority(
      remoteInput,
      context.authority,
      dependencies,
      remoteDependencies,
    ),
  })
  return { checkout, authority: context.authority }
}

export async function createBillingRolloutOneTimeCheckout(
  input: OneTimeCheckoutInput,
  serviceDependencies: Pick<
    OneTimeCheckoutDependencies,
    'createIntent'
  > = {},
  overrides: BillingRolloutConsumptionOverrides = {},
): Promise<AuthorizedOneTimeCheckout> {
  const dependencies = productionDependencies(overrides)
  const context = await authorizedCheckoutContext({
    userId: input.userId,
    rolloutSku: rolloutSkuFromOneTime(input),
    dependencies,
  })
  const checkout = await dependencies.createOneTime(input, {
    ...serviceDependencies,
    resolveSaleContext: async (userId) => {
      if (userId !== input.userId) {
        throw new SubscriptionCheckoutError(
          'persistence_conflict',
          'Checkout user changed during rollout evaluation',
        )
      }
      return context.saleContext
    },
    resolveQuote: async (quoteInput) => {
      if (
        quoteInput.userId !== input.userId ||
        quoteInput.request.sku !== input.request.sku ||
        quoteInput.request.surface !== 'checkout'
      ) {
        throw new SubscriptionCheckoutError(
          'persistence_conflict',
          'Checkout quote target changed',
        )
      }
      return quoteWithAuthority({
        userId: input.userId,
        request: quoteInput.request,
        authority: context.authority,
        dependencies,
        now: context.now,
      })
    },
    createRemote: (
      remoteInput,
      remoteDependencies,
    ) => createRemoteWithAuthority(
      remoteInput,
      context.authority,
      dependencies,
      remoteDependencies,
    ),
  })
  return { checkout, authority: context.authority }
}

/**
 * Recovery/background entry point for an already persisted checkout. The
 * immutable buyer snapshot is the only source of its rollout authority; a
 * caller cannot supply or replace that authority.
 */
export async function createBillingRolloutRemoteCheckout(
  input: RemoteCheckoutCreationInput,
  remoteDependencies: RemoteCheckoutCreationDependencies = {},
  overrides: BillingRolloutConsumptionOverrides = {},
): Promise<RemoteCheckoutCreationResult> {
  const dependencies = productionDependencies(overrides)
  const persisted =
    await dependencies.loadPersistedAuthority(input)
  if (!persisted) {
    throw new RemoteCheckoutCreationError(
      'sale_blocked',
      'Checkout rollout authority is missing',
      { saleBlockReason: 'selling_off' },
    )
  }
  return createRemoteWithAuthority(
    input,
    persisted.authority,
    dependencies,
    remoteDependencies,
  )
}
