import mongoose from 'mongoose'
import { connectDB } from '@shared/db/connection'
import {
  FinancialLedgerReadError,
  MAX_FINANCIAL_DOCUMENT_PAGE_SIZE,
  listFinancialDocuments,
  parseFinancialDocumentCursor,
  readFinancialInvoiceRecord,
  type FinancialDocumentPage,
  type FinancialDocumentSummary,
} from '@financial-ledger'
import { User } from '@shared/db/models/User'
import { withPersonalDataWriteTransaction } from '@shared/services/accountDeletion'
import {
  BillingConfig,
  CheckoutIntent,
  CouponCampaignRevision,
  CouponReservation,
  CustomerBillingProfile,
  CustomerBillingProfileConflictError,
  CustomerBillingProfileUpsertSchema,
  CustomerBillingProfileWritesUnavailableError,
  CustomerBillingUnavailableError,
  CustomerFinancialDocumentNotFoundError,
  PaidInterviewUnlock,
  PlanCatalogVersion,
  PLAN_CHANGE_REQUEST_STATUSES,
  PlanChangeRequest,
  PR6_BILLING_PROFILE_WRITES_READY,
  PR6_CUSTOMER_BILLING_UI_READY,
  ResumeEntitlement,
  sha256CanonicalJson,
  SUBSCRIPTION_STATUSES,
  Subscription,
  SubscriptionCycle,
  addInrPaise,
  evaluatePaymentSaleGate,
  inrPaise,
  isInrPaise,
  subtractInrPaise,
  validateCatalogContent,
  CouponRevisionTermsSchema,
  type BillingConfigView,
  type CatalogContent,
  type CatalogPlanTerms,
  type ConsumerPlanKey,
  type CouponCampaignMode,
  type CouponRevisionStatus,
  type CustomerBillingProfileUpsertInput,
  type ICustomerPlaceOfSupply,
  type InrPaise,
  type PlanChangeRequestStatus,
  type ProviderMode,
  type SubscriptionStatus,
} from '@payments/customer-billing-authority'

export {
  CustomerBillingProfileConflictError,
  CustomerBillingProfileWritesUnavailableError,
  CustomerBillingUnavailableError,
  CustomerFinancialDocumentNotFoundError,
  PR6_BILLING_PROFILE_WRITES_READY,
  PR6_CUSTOMER_BILLING_UI_READY,
  PR6_FINANCIAL_PDF_READY,
} from '@payments/customer-billing-authority'

const CURRENT_PLAN_CHANGE_STATUSES: readonly PlanChangeRequestStatus[] =
  PLAN_CHANGE_REQUEST_STATUSES.filter(
    (status) => !['applied', 'cancelled', 'failed'].includes(status),
  )
const BILLING_SUBSCRIPTION_STATUSES: readonly SubscriptionStatus[] =
  SUBSCRIPTION_STATUSES

export interface PublicCatalogPlan {
  key: CatalogPlanTerms['key']
  displayName: CatalogPlanTerms['displayName']
  listPricePaise: number
  billingPeriod: CatalogPlanTerms['billingPeriod']
  interview: CatalogPlanTerms['interview']
  resume: CatalogPlanTerms['resume']
}

export interface PublicBillingCatalog {
  schemaVersion: 1
  catalogVersion: string
  effectiveAt: string
  currency: 'INR'
  gstInclusive: true
  gstRatePercent: 18
  customerBillingUiReady: boolean
  checkoutRequiresAuthentication: true
  plans: {
    free: PublicCatalogPlan
    plus: PublicCatalogPlan
    pro: PublicCatalogPlan
  }
  oneTimeProducts: CatalogContent['oneTimeProducts']
}

interface ActiveCatalogRow {
  version: string
  status: string
  effectiveAt?: Date
  content: CatalogContent
  contentHash: string
  validation?: {
    contentHash: string
    errors: string[]
  }
  approval?: {
    contentHash: string
  }
}

function publicPlan(plan: CatalogPlanTerms): PublicCatalogPlan {
  return {
    key: plan.key,
    displayName: plan.displayName,
    listPricePaise: plan.listPricePaise,
    billingPeriod: plan.billingPeriod,
    interview: structuredClone(plan.interview),
    resume: structuredClone(plan.resume),
  }
}

function validPublishedCatalog(
  row: ActiveCatalogRow | null,
  activeVersion: string | undefined,
  now: Date,
): row is ActiveCatalogRow & { effectiveAt: Date } {
  if (
    !row ||
    !activeVersion ||
    row.version !== activeVersion ||
    row.status !== 'published' ||
    !(row.effectiveAt instanceof Date) ||
    !Number.isFinite(row.effectiveAt.getTime()) ||
    row.effectiveAt > now ||
    row.validation?.contentHash !== row.contentHash ||
    (row.validation?.errors.length ?? 1) > 0 ||
    row.approval?.contentHash !== row.contentHash
  ) {
    return false
  }
  const validation = validateCatalogContent(row.content)
  return Boolean(validation.valid && validation.contentHash === row.contentHash)
}

export async function readPublicBillingCatalog(
  now = new Date(),
): Promise<PublicBillingCatalog> {
  await connectDB()
  const config = await BillingConfig.findOne({ key: 'singleton' })
    .select('activeCatalogVersion')
    .lean<{ activeCatalogVersion?: string }>()
  const row = config?.activeCatalogVersion
    ? await PlanCatalogVersion.findOne({
        version: config.activeCatalogVersion,
      })
        .select(
          'version status effectiveAt content contentHash validation approval',
        )
        .lean<ActiveCatalogRow>()
    : null
  if (!validPublishedCatalog(row, config?.activeCatalogVersion, now)) {
    throw new CustomerBillingUnavailableError('catalog_unavailable')
  }
  return {
    schemaVersion: 1,
    catalogVersion: row.version,
    effectiveAt: row.effectiveAt.toISOString(),
    currency: row.content.currency,
    gstInclusive: row.content.gstInclusive,
    gstRatePercent: row.content.gstRatePercent,
    customerBillingUiReady: PR6_CUSTOMER_BILLING_UI_READY,
    checkoutRequiresAuthentication: true,
    plans: {
      free: publicPlan(row.content.plans.free),
      plus: publicPlan(row.content.plans.plus),
      pro: publicPlan(row.content.plans.pro),
    },
    oneTimeProducts: structuredClone(row.content.oneTimeProducts),
  }
}

export interface CustomerBillingProfileView {
  configured: true
  version: number
  placeOfSupply: ICustomerPlaceOfSupply
  updatedAt: string
}

interface BillingProfileRow {
  userId: mongoose.Types.ObjectId
  version: number
  placeOfSupply: ICustomerPlaceOfSupply
  contentHash: string
  lastMutationId: string
  createdAt: Date
  updatedAt: Date
}

function profileView(profile: BillingProfileRow): CustomerBillingProfileView {
  return {
    configured: true,
    version: profile.version,
    placeOfSupply: structuredClone(profile.placeOfSupply),
    updatedAt: profile.updatedAt.toISOString(),
  }
}

function profileContent(input: CustomerBillingProfileUpsertInput) {
  return {
    placeOfSupply: {
      stateCode: input.placeOfSupply.stateCode,
      countryCode: input.placeOfSupply.countryCode,
    },
  }
}

function isDuplicateKeyError(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === 'object' &&
    'code' in error &&
    error.code === 11_000,
  )
}

export async function readCustomerBillingProfile(
  userId: string,
): Promise<CustomerBillingProfileView | null> {
  if (!mongoose.isValidObjectId(userId)) {
    throw new CustomerBillingUnavailableError('customer_unavailable')
  }
  await connectDB()
  const profile = await CustomerBillingProfile.findOne({
    userId: new mongoose.Types.ObjectId(userId),
  }).lean<BillingProfileRow>()
  return profile ? profileView(profile) : null
}

export async function upsertCustomerBillingProfile(
  userId: string,
  rawInput: CustomerBillingProfileUpsertInput,
  options: {
    allowWhenReadinessDisabledForTests?: boolean
  } = {},
): Promise<CustomerBillingProfileView> {
  const testOverride =
    process.env.NODE_ENV === 'test' &&
    options.allowWhenReadinessDisabledForTests === true
  if (!PR6_BILLING_PROFILE_WRITES_READY && !testOverride) {
    throw new CustomerBillingProfileWritesUnavailableError()
  }
  const input = CustomerBillingProfileUpsertSchema.parse(rawInput)
  const content = profileContent(input)
  const contentHash = sha256CanonicalJson(content)

  try {
    return await withPersonalDataWriteTransaction(
      userId,
      async (session, userObjectId) => {
        const current = await CustomerBillingProfile.findOne({
          userId: userObjectId,
        })
          .session(session)
          .lean<BillingProfileRow>()
        if (current?.lastMutationId === input.mutationId) {
          if (current.contentHash !== contentHash) {
            throw new CustomerBillingProfileConflictError()
          }
          return profileView(current)
        }
        if ((current?.version ?? 0) !== input.expectedVersion) {
          throw new CustomerBillingProfileConflictError()
        }

        if (!current) {
          const [created] = await CustomerBillingProfile.create(
            [
              {
                userId: userObjectId,
                version: 1,
                ...content,
                contentHash,
                lastMutationId: input.mutationId,
              },
            ],
            { session },
          )
          return profileView(created.toObject() as unknown as BillingProfileRow)
        }

        const updated = await CustomerBillingProfile.findOneAndUpdate(
          {
            userId: userObjectId,
            version: input.expectedVersion,
          },
          {
            $set: {
              ...content,
              contentHash,
              lastMutationId: input.mutationId,
            },
            $inc: { version: 1 },
          },
          {
            new: true,
            runValidators: true,
            session,
          },
        ).lean<BillingProfileRow>()
        if (!updated) throw new CustomerBillingProfileConflictError()
        return profileView(updated)
      },
    )
  } catch (error) {
    if (
      error instanceof CustomerBillingProfileConflictError ||
      isDuplicateKeyError(error)
    ) {
      throw new CustomerBillingProfileConflictError()
    }
    throw error
  }
}

interface CustomerRow {
  _id: mongoose.Types.ObjectId
  plan?: string
  entitlementSource?: 'free' | 'subscription' | 'admin_grant'
  planExpiresAt?: Date
  usagePeriodKey?: string
  interviewsUsed?: number
  interviewLimit?: number
  premiumResumesUsed?: number
  premiumResumeLimit?: number
  usageResetAt?: Date
  freeBasicResumeId?: string
  entitlementVersion?: number
  buyerState?: string
}

interface SubscriptionRow {
  _id: mongoose.Types.ObjectId
  providerMode: ProviderMode
  planKey: 'plus' | 'pro'
  catalogVersion: string
  razorpaySubscriptionId: string
  checkoutIntentId?: mongoose.Types.ObjectId
  status: SubscriptionStatus
  currentPeriodKey?: string
  currentPeriodStart?: Date
  currentPeriodEnd?: Date
  cancelAtPeriodEnd: boolean
  discountedCyclesRemaining?: number
  scheduledPlanChange?: {
    targetPlanKey: 'plus' | 'pro'
    effectiveAt: Date
    requestedAt: Date
    source: 'customer' | 'admin'
  }
  couponCampaignId?: mongoose.Types.ObjectId
  createdAt: Date
  updatedAt: Date
}

interface SubscriptionCycleRow {
  _id: mongoose.Types.ObjectId
  providerMode: ProviderMode
  subscriptionId: mongoose.Types.ObjectId
  planKey: 'plus' | 'pro'
  periodKey: string
  periodStart: Date
  periodEnd: Date
  projectionDisposition: 'projected'
}

interface SubscriptionIntentRow {
  _id: mongoose.Types.ObjectId
  providerMode: ProviderMode
  planKey: 'plus' | 'pro'
  razorpaySubscriptionId: string
  catalogVersion: string
  createdAt: Date
  quoteSnapshot: {
    currency: 'INR'
    listPricePaise: number
    discountPaise: number
    payablePaise: number
    renewalPricePaise?: number
    discountedBillingCycles?: number
    couponCampaignId?: mongoose.Types.ObjectId
    couponCampaignRevision?: number
  }
}

interface CouponReservationRow {
  providerMode: ProviderMode
  campaignId: mongoose.Types.ObjectId
  campaignRevision: number
  userId: mongoose.Types.ObjectId
  checkoutIntentId: mongoose.Types.ObjectId
  catalogVersion: string
  planKey: 'plus' | 'pro'
  campaignModeSnapshot: CouponCampaignMode
  codeSnapshot?: string
  discountPaise: number
  discountedBillingCycles: number
  status: string
  capacityDisposition: string
}

interface CouponRevisionRow {
  campaignId: mongoose.Types.ObjectId
  revision: number
  status: CouponRevisionStatus
  terms: unknown
  contentHash: string
  validation?: {
    contentHash: string
    errors: string[]
  }
  approval?: {
    contentHash: string
  }
}

interface PlanChangeRow {
  _id: mongoose.Types.ObjectId
  fromPlanKey: ConsumerPlanKey
  toPlanKey: ConsumerPlanKey
  status: PlanChangeRequestStatus
  requestedAt: Date
  requestedEffectiveAt: Date
  updatedAt: Date
}

interface UsageCountRow {
  _id: string
  count: number
}

interface CurrentSubscriptionCoupon {
  source: 'subscription_checkout'
  campaignId: string
  revision: number
  mode: CouponCampaignMode
  code?: string
  displayText: string
  termsText: string
}

interface CurrentSubscriptionCouponResolution {
  consistent: boolean
  coupon?: CurrentSubscriptionCoupon
}

function validDate(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime())
}

function sameObjectId(left: unknown, right: unknown): boolean {
  return Boolean(
    left &&
    right &&
    mongoose.isValidObjectId(left) &&
    mongoose.isValidObjectId(right) &&
    left.toString() === right.toString(),
  )
}

function resolveCurrentSubscriptionCoupon(input: {
  userId: mongoose.Types.ObjectId
  subscription: SubscriptionRow
  intent: SubscriptionIntentRow | null
  reservation: CouponReservationRow | null
  revision: CouponRevisionRow | null
}): CurrentSubscriptionCouponResolution {
  const { userId, subscription, intent, reservation, revision } = input
  const remaining = subscription.discountedCyclesRemaining
  const subscriptionHasCoupon =
    subscription.couponCampaignId !== undefined
  const subscriptionHasDiscountedCycles =
    remaining !== undefined && remaining > 0

  if (!intent) {
    return {
      consistent:
        !subscriptionHasCoupon && !subscriptionHasDiscountedCycles,
    }
  }

  const quote = intent.quoteSnapshot
  const quoteIsCoherent =
    intent.providerMode === subscription.providerMode &&
    intent.planKey === subscription.planKey &&
    intent.catalogVersion === subscription.catalogVersion &&
    intent.razorpaySubscriptionId ===
      subscription.razorpaySubscriptionId &&
    typeof intent.catalogVersion === 'string' &&
    intent.catalogVersion.length >= 1 &&
    intent.catalogVersion.length <= 100 &&
    validDate(intent.createdAt) &&
    quote.currency === 'INR' &&
    isInrPaise(quote.listPricePaise) &&
    isInrPaise(quote.discountPaise) &&
    isInrPaise(quote.payablePaise) &&
    isInrPaise(quote.renewalPricePaise) &&
    quote.discountPaise <= quote.listPricePaise &&
    quote.payablePaise === quote.listPricePaise - quote.discountPaise &&
    quote.renewalPricePaise === quote.listPricePaise
  if (!quoteIsCoherent) return { consistent: false }

  if (quote.discountPaise === 0) {
    return {
      consistent:
        quote.couponCampaignId === undefined &&
        quote.couponCampaignRevision === undefined &&
        quote.discountedBillingCycles === undefined &&
        !reservation &&
        !subscriptionHasCoupon &&
        !subscriptionHasDiscountedCycles,
    }
  }

  if (
    !quote.couponCampaignId ||
    !Number.isSafeInteger(quote.couponCampaignRevision) ||
    (quote.couponCampaignRevision ?? 0) <= 0 ||
    !Number.isSafeInteger(quote.discountedBillingCycles) ||
    (quote.discountedBillingCycles ?? 0) <= 0 ||
    !subscription.couponCampaignId ||
    !Number.isSafeInteger(remaining) ||
    (remaining ?? -1) < 0 ||
    (remaining ?? Number.MAX_SAFE_INTEGER) >
      (quote.discountedBillingCycles ?? -1) ||
    !reservation ||
    !revision
  ) {
    return { consistent: false }
  }

  const parsedTerms = CouponRevisionTermsSchema.safeParse(revision.terms)
  if (!parsedTerms.success) return { consistent: false }
  const terms = parsedTerms.data
  const code = reservation.codeSnapshot?.trim().toUpperCase()
  const codeIsCoherent =
    reservation.campaignModeSnapshot === 'code'
      ? Boolean(
          code &&
          reservation.codeSnapshot === code &&
          /^[A-Z0-9][A-Z0-9_-]{2,39}$/.test(code),
        )
      : reservation.codeSnapshot === undefined
  const exactLineage =
    sameObjectId(subscription.checkoutIntentId, intent._id) &&
    sameObjectId(subscription.couponCampaignId, quote.couponCampaignId) &&
    reservation.providerMode === subscription.providerMode &&
    sameObjectId(reservation.campaignId, quote.couponCampaignId) &&
    reservation.campaignRevision === quote.couponCampaignRevision &&
    sameObjectId(reservation.userId, userId) &&
    sameObjectId(reservation.checkoutIntentId, intent._id) &&
    reservation.catalogVersion === intent.catalogVersion &&
    reservation.planKey === subscription.planKey &&
    ['automatic', 'code', 'targeted'].includes(
      reservation.campaignModeSnapshot,
    ) &&
    codeIsCoherent &&
    reservation.discountPaise === quote.discountPaise &&
    reservation.discountedBillingCycles ===
      quote.discountedBillingCycles &&
    reservation.status === 'converted' &&
    reservation.capacityDisposition === 'converted' &&
    sameObjectId(revision.campaignId, quote.couponCampaignId) &&
    revision.revision === quote.couponCampaignRevision &&
    !['draft', 'scheduled'].includes(revision.status) &&
    typeof revision.contentHash === 'string' &&
    revision.contentHash.length === 64 &&
    sha256CanonicalJson(terms) === revision.contentHash &&
    revision.validation?.contentHash === revision.contentHash &&
    Array.isArray(revision.validation?.errors) &&
    revision.validation?.errors.length === 0 &&
    revision.approval?.contentHash === revision.contentHash &&
    terms.discountPaise === quote.discountPaise &&
    terms.discountedBillingCycles === quote.discountedBillingCycles &&
    terms.applicablePlanKeys.includes(subscription.planKey) &&
    typeof terms.razorpayOfferIdByMode[subscription.providerMode] ===
      'string' &&
    (!terms.startsAt || terms.startsAt <= intent.createdAt) &&
    (!terms.endsAt || terms.endsAt > intent.createdAt)
  if (!exactLineage) return { consistent: false }

  return {
    consistent: true,
    coupon: {
      source: 'subscription_checkout',
      campaignId: quote.couponCampaignId.toString(),
      revision: quote.couponCampaignRevision as number,
      mode: reservation.campaignModeSnapshot,
      ...(reservation.campaignModeSnapshot === 'code'
        ? { code: code as string }
        : {}),
      displayText:
        terms.bannerText?.trim() || `₹${terms.discountPaise / 100} off`,
      termsText: terms.termsText.trim(),
    },
  }
}

function toBillingConfigView(
  config: {
    revision: number
    sellingMode: BillingConfigView['sellingMode']
    enforcementMode: BillingConfigView['enforcementMode']
    couponMode: BillingConfigView['couponMode']
    qaUserIds?: Array<{ toString(): string }>
    newUserRolloutPercent: number
    enforcementStartedAt?: Date
    legacyGrandfatherEndsAt?: Date
    activeCatalogVersion?: string
    autoCouponRequired: boolean
    webhookProcessingEnabled: boolean
    reconciliationEnabled: boolean
    updatedAt?: Date
  } | null,
): BillingConfigView {
  if (!config) {
    return {
      persisted: false,
      revision: 0,
      sellingMode: 'off',
      enforcementMode: 'off',
      couponMode: 'off',
      qaUserIds: [],
      newUserRolloutPercent: 0,
      autoCouponRequired: true,
      webhookProcessingEnabled: false,
      reconciliationEnabled: false,
    }
  }
  return {
    persisted: true,
    revision: config.revision,
    sellingMode: config.sellingMode,
    enforcementMode: config.enforcementMode,
    couponMode: config.couponMode,
    qaUserIds: (config.qaUserIds ?? []).map((id) => id.toString()),
    newUserRolloutPercent: config.newUserRolloutPercent,
    enforcementStartedAt: config.enforcementStartedAt,
    legacyGrandfatherEndsAt: config.legacyGrandfatherEndsAt,
    activeCatalogVersion: config.activeCatalogVersion,
    autoCouponRequired: config.autoCouponRequired,
    webhookProcessingEnabled: config.webhookProcessingEnabled,
    reconciliationEnabled: config.reconciliationEnabled,
    updatedAt: config.updatedAt,
  }
}

function currentSubscription(
  subscriptions: SubscriptionRow[],
  cycles: SubscriptionCycleRow[],
  now: Date,
): {
  state: 'none' | 'activation_pending' | 'current' | 'review'
  subscription?: SubscriptionRow
} {
  const paidCycles = cycles.filter(
    (cycle) =>
      validDate(cycle.periodStart) &&
      validDate(cycle.periodEnd) &&
      cycle.periodStart <= now &&
      cycle.periodEnd > now,
  )
  if (paidCycles.length > 1) return { state: 'review' }
  if (paidCycles.length === 1) {
    const cycle = paidCycles[0]
    const matches = subscriptions.filter(
      (subscription) =>
        subscription._id.equals(cycle.subscriptionId) &&
        subscription.providerMode === cycle.providerMode &&
        subscription.planKey === cycle.planKey &&
        subscription.currentPeriodKey === cycle.periodKey &&
        validDate(subscription.currentPeriodStart) &&
        validDate(subscription.currentPeriodEnd) &&
        subscription.currentPeriodStart.getTime() ===
          cycle.periodStart.getTime() &&
        subscription.currentPeriodEnd.getTime() === cycle.periodEnd.getTime(),
    )
    return matches.length === 1
      ? { state: 'current', subscription: matches[0] }
      : { state: 'review' }
  }
  const activationPending = subscriptions.filter((subscription) =>
    ['created', 'authenticated', 'activation_pending'].includes(
      subscription.status,
    ),
  )
  const operational = subscriptions.filter(
    (subscription) =>
      !['cancelled', 'completed', 'expired'].includes(subscription.status),
  )
  if (activationPending.length === 1 && operational.length === 1) {
    return {
      state: 'activation_pending',
      subscription: activationPending[0],
    }
  }
  if (operational.length === 1) {
    return { state: 'review', subscription: operational[0] }
  }
  return operational.length > 1 ? { state: 'review' } : { state: 'none' }
}

function subscriptionBillingHealth(
  subscription: SubscriptionRow,
): 'healthy' | 'pending' | 'action_required' | 'ending' | 'ended' | 'review' {
  if (subscription.status === 'review') return 'review'
  if (['cancelled', 'completed', 'expired'].includes(subscription.status))
    return 'ended'
  if (subscription.cancelAtPeriodEnd) return 'ending'
  switch (subscription.status) {
    case 'active':
      return 'healthy'
    case 'created':
    case 'authenticated':
    case 'activation_pending':
    case 'pending':
      return 'pending'
    case 'halted':
    case 'paused':
      return 'action_required'
    default:
      return 'review'
  }
}

function countMap(rows: UsageCountRow[]): Record<string, number> {
  return Object.fromEntries(rows.map((row) => [row._id, row.count]))
}

export interface CustomerBillingSummary {
  schemaVersion: 1
  environment: ProviderMode
  customerBillingUiReady: boolean
  accountState: 'active' | 'deletion_pending'
  saleAvailability: 'available' | 'unavailable' | 'account_restricted'
  entitlement: {
    initialized: boolean
    planKey: ConsumerPlanKey
    source: 'free' | 'subscription' | 'admin_grant'
    planExpiresAt?: string
    usagePeriodKey: string
    interviewsUsed: number
    interviewLimit: number
    interviewsRemaining: number
    premiumResumesUsed: number
    premiumResumeLimit: number
    premiumResumesRemaining: number
    usageResetAt?: string
    hasFreeBasicResume: boolean
    version: number
    environmentConsistency: 'verified' | 'mismatch' | 'not_applicable'
  }
  subscription: {
    state: 'none' | 'activation_pending' | 'current' | 'review'
    billingHealth?:
      'healthy' | 'pending' | 'action_required' | 'ending' | 'ended' | 'review'
    planKey?: 'plus' | 'pro'
    status?: SubscriptionStatus
    currentPeriodStart?: string
    currentPeriodEnd?: string
    cancelAtPeriodEnd?: boolean
    discountedCyclesRemaining?: number
    currentCoupon?: CurrentSubscriptionCoupon
    nextCharge?: {
      amountPaise: number
      currency: 'INR'
      scheduledAt: string
    }
  }
  scheduledPlanChange?: {
    planChangeRequestId: string
    fromPlanKey: ConsumerPlanKey
    toPlanKey: ConsumerPlanKey
    status: PlanChangeRequestStatus
    requestedAt: string
    effectiveAt: string
  }
  interviewUnlocks: Record<string, number>
  resumeEntitlements: Record<string, number>
  billingProfile: { configured: true; version: number } | { configured: false }
}

function configuredQaUser(
  config: {
    qaUserIds?: Array<{ toString(): string }>
  } | null,
  userId: mongoose.Types.ObjectId,
): boolean {
  return (
    config?.qaUserIds?.some(
      (candidate) => candidate.toString() === userId.toString(),
    ) ?? false
  )
}

export async function readCustomerBillingSummary(
  userId: string,
  options: {
    now?: Date
    environment?: ProviderMode
  } = {},
): Promise<CustomerBillingSummary> {
  if (!mongoose.isValidObjectId(userId)) {
    throw new CustomerBillingUnavailableError('customer_unavailable')
  }
  const now = options.now ?? new Date()
  if (!validDate(now)) {
    throw new CustomerBillingUnavailableError('customer_unavailable')
  }
  await connectDB()
  const userObjectId = new mongoose.Types.ObjectId(userId)
  const session = await mongoose.startSession({ snapshot: true })
  try {
    const user = await User.findById(userObjectId)
      .session(session)
      .select(
        'plan entitlementSource planExpiresAt usagePeriodKey ' +
          'interviewsUsed interviewLimit premiumResumesUsed ' +
          'premiumResumeLimit usageResetAt freeBasicResumeId ' +
          'entitlementVersion buyerState',
      )
      .lean<CustomerRow>()
    if (!user) {
      throw new CustomerBillingUnavailableError('customer_unavailable')
    }
    const config = await BillingConfig.findOne({ key: 'singleton' })
      .session(session)
      .lean()
    const providerMode = options.environment ?? (
      config?.sellingMode === 'qa' && configuredQaUser(config, userObjectId)
        ? 'test'
        : 'live'
    )
    if (providerMode === 'test' && !configuredQaUser(config, userObjectId)) {
      throw new CustomerBillingUnavailableError('test_mode_unavailable')
    }
    const subscriptions = await Subscription.find({
      userId: userObjectId,
      providerMode,
      status: { $in: BILLING_SUBSCRIPTION_STATUSES },
    })
      .session(session)
      .sort({ currentPeriodEnd: -1, createdAt: -1, _id: -1 })
      .limit(20)
      .select(
        'providerMode planKey catalogVersion razorpaySubscriptionId ' +
          'checkoutIntentId status ' +
          'currentPeriodKey currentPeriodStart ' +
          'currentPeriodEnd cancelAtPeriodEnd discountedCyclesRemaining ' +
          'scheduledPlanChange couponCampaignId createdAt updatedAt',
      )
      .lean<SubscriptionRow[]>()
    const cycles = await SubscriptionCycle.find({
      userId: userObjectId,
      providerMode,
      projectionDisposition: 'projected',
      periodStart: { $lte: now },
      periodEnd: { $gt: now },
    })
      .session(session)
      .sort({ periodEnd: -1, _id: -1 })
      .limit(3)
      .select(
        'providerMode subscriptionId planKey periodKey periodStart ' +
          'periodEnd projectionDisposition',
      )
      .lean<SubscriptionCycleRow[]>()
    const planChanges = await PlanChangeRequest.find({
      userId: userObjectId,
      providerMode,
      status: { $in: CURRENT_PLAN_CHANGE_STATUSES },
    })
      .session(session)
      .sort({ requestedAt: -1, _id: -1 })
      .limit(2)
      .select(
        '_id fromPlanKey toPlanKey status requestedAt ' +
          'requestedEffectiveAt updatedAt',
      )
      .lean<PlanChangeRow[]>()
    const unlockCounts = await PaidInterviewUnlock.aggregate<UsageCountRow>([
      { $match: { userId: userObjectId, providerMode } },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]).session(session)
    const resumeCounts = await ResumeEntitlement.aggregate<UsageCountRow>([
      { $match: { userId: userObjectId, providerMode } },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]).session(session)
    const profile = await CustomerBillingProfile.findOne({
      userId: userObjectId,
    })
      .session(session)
      .select('version')
      .lean<{ version: number }>()

    const planKey: ConsumerPlanKey =
      user.plan === 'plus' || user.plan === 'pro' ? user.plan : 'free'
    const interviewLimit = Math.max(0, user.interviewLimit ?? 1)
    const interviewsUsed = Math.max(0, user.interviewsUsed ?? 0)
    const premiumResumeLimit = Math.max(0, user.premiumResumeLimit ?? 0)
    const premiumResumesUsed = Math.max(0, user.premiumResumesUsed ?? 0)
    const selectedSubscription = currentSubscription(subscriptions, cycles, now)
    const saleGate = evaluatePaymentSaleGate(
      toBillingConfigView(config),
      userId,
      undefined,
      user.buyerState,
    )
    const gatedSaleAvailability =
      user.buyerState === 'deletion_pending'
        ? ('account_restricted' as const)
        : !saleGate.allowed
          ? ('unavailable' as const)
          : saleGate.providerMode === providerMode
            ? ('available' as const)
            : ('unavailable' as const)
    const subscription = selectedSubscription.subscription
    const entitlementEnvironmentConsistency =
      selectedSubscription.state === 'current' && subscription
        ? user.entitlementSource === 'subscription' &&
          planKey === subscription.planKey &&
          user.usagePeriodKey === subscription.currentPeriodKey &&
          validDate(user.planExpiresAt) &&
          validDate(subscription.currentPeriodEnd) &&
          user.planExpiresAt.getTime() ===
            subscription.currentPeriodEnd.getTime()
          ? ('verified' as const)
          : ('mismatch' as const)
        : user.entitlementSource === 'subscription'
          ? ('mismatch' as const)
          : ('not_applicable' as const)
    const saleAvailability =
      entitlementEnvironmentConsistency === 'mismatch'
        ? ('unavailable' as const)
        : gatedSaleAvailability
    const renewalExpected = Boolean(
      selectedSubscription.state === 'current' &&
      entitlementEnvironmentConsistency === 'verified' &&
      subscription?.status === 'active' &&
      !subscription.cancelAtPeriodEnd,
    )
    const subscriptionIntent =
      subscription &&
      selectedSubscription.state === 'current' &&
      entitlementEnvironmentConsistency === 'verified' &&
      subscription.checkoutIntentId
        ? await CheckoutIntent.findOne({
            _id: subscription.checkoutIntentId,
            userId: userObjectId,
            kind: 'subscription',
            providerMode: subscription.providerMode,
            planKey: subscription.planKey,
            razorpaySubscriptionId: subscription.razorpaySubscriptionId,
          })
            .session(session)
            .select(
              'providerMode planKey razorpaySubscriptionId catalogVersion ' +
                'createdAt quoteSnapshot',
            )
            .lean<SubscriptionIntentRow>()
        : null
    const couponReservation = subscriptionIntent
      ? await CouponReservation.findOne({
          providerMode: subscriptionIntent.providerMode,
          userId: userObjectId,
          checkoutIntentId: subscriptionIntent._id,
        })
          .session(session)
          .select(
            'providerMode campaignId campaignRevision userId checkoutIntentId ' +
              'catalogVersion planKey campaignModeSnapshot codeSnapshot ' +
              'discountPaise discountedBillingCycles status capacityDisposition',
          )
          .lean<CouponReservationRow>()
      : null
    const quotedCouponCampaignId =
      subscriptionIntent?.quoteSnapshot.couponCampaignId
    const quotedCouponRevision =
      subscriptionIntent?.quoteSnapshot.couponCampaignRevision
    const couponRevision =
      quotedCouponCampaignId &&
      Number.isSafeInteger(quotedCouponRevision) &&
      (quotedCouponRevision ?? 0) > 0
        ? await CouponCampaignRevision.findOne({
            campaignId: quotedCouponCampaignId,
            revision: quotedCouponRevision,
          })
            .session(session)
            .select(
              'campaignId revision status terms contentHash validation approval',
            )
            .lean<CouponRevisionRow>()
        : null
    const couponResolution: CurrentSubscriptionCouponResolution =
      subscription && selectedSubscription.state === 'current'
        ? resolveCurrentSubscriptionCoupon({
            userId: userObjectId,
            subscription,
            intent: subscriptionIntent,
            reservation: couponReservation,
            revision: couponRevision,
          })
        : { consistent: true }
    const nextChargeAmount =
      subscription &&
      subscriptionIntent &&
      couponResolution.consistent &&
      renewalExpected &&
      validDate(subscription.currentPeriodEnd)
        ? (subscription.discountedCyclesRemaining ?? 0) > 0
          ? subscriptionIntent.quoteSnapshot.payablePaise
          : subscriptionIntent.quoteSnapshot.renewalPricePaise
        : undefined
    const subscriptionState =
      planChanges.length > 1 ||
      entitlementEnvironmentConsistency === 'mismatch' ||
      !couponResolution.consistent ||
      (selectedSubscription.state === 'current' &&
        subscription?.status === 'review') ||
      (renewalExpected &&
        (!subscription ||
          !subscriptionIntent ||
          subscriptionIntent.providerMode !== subscription.providerMode ||
          subscriptionIntent.planKey !== subscription.planKey ||
          subscriptionIntent.razorpaySubscriptionId !==
            subscription.razorpaySubscriptionId ||
          nextChargeAmount === undefined))
        ? ('review' as const)
        : selectedSubscription.state
    const summarySaleAvailability = couponResolution.consistent
      ? saleAvailability
      : ('unavailable' as const)

    return {
      schemaVersion: 1,
      environment: providerMode,
      customerBillingUiReady: PR6_CUSTOMER_BILLING_UI_READY,
      accountState:
        user.buyerState === 'deletion_pending' ? 'deletion_pending' : 'active',
      saleAvailability: summarySaleAvailability,
      entitlement: {
        initialized: typeof user.entitlementVersion === 'number',
        planKey,
        source: user.entitlementSource ?? 'free',
        ...(validDate(user.planExpiresAt)
          ? { planExpiresAt: user.planExpiresAt.toISOString() }
          : {}),
        usagePeriodKey: user.usagePeriodKey ?? 'uninitialized',
        interviewsUsed,
        interviewLimit,
        interviewsRemaining: Math.max(0, interviewLimit - interviewsUsed),
        premiumResumesUsed,
        premiumResumeLimit,
        premiumResumesRemaining: Math.max(
          0,
          premiumResumeLimit - premiumResumesUsed,
        ),
        ...(validDate(user.usageResetAt)
          ? { usageResetAt: user.usageResetAt.toISOString() }
          : {}),
        hasFreeBasicResume: Boolean(user.freeBasicResumeId),
        version: user.entitlementVersion ?? 0,
        environmentConsistency: entitlementEnvironmentConsistency,
      },
      subscription: {
        state: subscriptionState,
        ...(subscription
          ? {
              billingHealth:
                subscriptionState === 'review'
                  ? ('review' as const)
                  : subscriptionBillingHealth(subscription),
              planKey: subscription.planKey,
              status: subscription.status,
              ...(validDate(subscription.currentPeriodStart)
                ? {
                    currentPeriodStart:
                      subscription.currentPeriodStart.toISOString(),
                  }
                : {}),
              ...(validDate(subscription.currentPeriodEnd)
                ? {
                    currentPeriodEnd:
                      subscription.currentPeriodEnd.toISOString(),
                  }
                : {}),
              cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
              ...(subscriptionState === 'current' &&
              couponResolution.coupon &&
              subscription.discountedCyclesRemaining !== undefined
                ? {
                    discountedCyclesRemaining:
                      subscription.discountedCyclesRemaining,
                    currentCoupon: couponResolution.coupon,
                  }
                : {}),
              ...(nextChargeAmount !== undefined &&
              validDate(subscription.currentPeriodEnd)
                ? {
                    nextCharge: {
                      amountPaise: nextChargeAmount,
                      currency: 'INR' as const,
                      scheduledAt: subscription.currentPeriodEnd.toISOString(),
                    },
                  }
                : {}),
            }
          : {}),
      },
      ...(planChanges.length === 1
        ? {
            scheduledPlanChange: {
              planChangeRequestId: planChanges[0]._id.toHexString(),
              fromPlanKey: planChanges[0].fromPlanKey,
              toPlanKey: planChanges[0].toPlanKey,
              status: planChanges[0].status,
              requestedAt: planChanges[0].requestedAt.toISOString(),
              effectiveAt: planChanges[0].requestedEffectiveAt.toISOString(),
            },
          }
        : {}),
      interviewUnlocks: countMap(unlockCounts),
      resumeEntitlements: countMap(resumeCounts),
      billingProfile: profile
        ? { configured: true, version: profile.version }
        : { configured: false },
    }
  } finally {
    await session.endSession()
  }
}

export type CustomerFinancialDocumentSummary = FinancialDocumentSummary

export type CustomerFinancialDocumentPage = FinancialDocumentPage

async function resolveCustomerFinancialDocumentMode(
  userId: mongoose.Types.ObjectId,
  requestedMode: ProviderMode,
): Promise<ProviderMode> {
  if (requestedMode === 'live') return 'live'
  const config = await BillingConfig.findOne({ key: 'singleton' })
    .select('qaUserIds')
    .lean<{
      qaUserIds?: Array<{ toString(): string }>
    }>()
  const qaUser =
    config?.qaUserIds?.some(
      (candidate) => candidate.toString() === userId.toString(),
    ) ?? false
  if (!qaUser) {
    throw new CustomerBillingUnavailableError('test_mode_unavailable')
  }
  return 'test'
}

export async function listCustomerFinancialDocuments(input: {
  userId: string
  limit?: number
  cursor?: string
  environment?: ProviderMode
}): Promise<CustomerFinancialDocumentPage> {
  if (!mongoose.isValidObjectId(input.userId)) {
    throw new CustomerBillingUnavailableError('customer_unavailable')
  }
  const limit = Math.min(
    Math.max(input.limit ?? 20, 1),
    MAX_FINANCIAL_DOCUMENT_PAGE_SIZE,
  )
  let cursor: ReturnType<typeof parseFinancialDocumentCursor>
  try {
    cursor = parseFinancialDocumentCursor(input.cursor)
  } catch (error) {
    if (
      error instanceof FinancialLedgerReadError &&
      error.code === 'invalid_cursor'
    ) {
      throw new CustomerBillingUnavailableError('invalid_cursor')
    }
    throw error
  }
  if (input.cursor !== undefined && cursor === null) {
    throw new CustomerBillingUnavailableError('invalid_cursor')
  }
  await connectDB()
  const userId = new mongoose.Types.ObjectId(input.userId)
  const providerMode = await resolveCustomerFinancialDocumentMode(
    userId,
    input.environment ?? 'live',
  )
  if (cursor && cursor.providerMode !== providerMode) {
    throw new CustomerBillingUnavailableError('invalid_cursor')
  }
  return listFinancialDocuments({
    userId,
    providerMode,
    limit,
    cursor,
  })
}

export interface CustomerInvoiceDetail {
  environment: ProviderMode
  invoice: CustomerFinancialDocumentSummary
  creditNotes: CustomerFinancialDocumentSummary[]
  netPaidPaise: number
  rendering: {
    pdfAvailable: false
    reason: 'financial_policy_not_approved'
  }
}

export async function readCustomerInvoiceDetail(input: {
  userId: string
  invoiceId: string
  environment?: ProviderMode
}): Promise<CustomerInvoiceDetail> {
  if (
    !mongoose.isValidObjectId(input.userId) ||
    !mongoose.isValidObjectId(input.invoiceId)
  ) {
    throw new CustomerFinancialDocumentNotFoundError()
  }
  await connectDB()
  const userId = new mongoose.Types.ObjectId(input.userId)
  const invoiceId = new mongoose.Types.ObjectId(input.invoiceId)
  const providerMode = await resolveCustomerFinancialDocumentMode(
    userId,
    input.environment ?? 'live',
  )
  let record
  try {
    record = await readFinancialInvoiceRecord({
      userId,
      invoiceId,
      providerMode,
    })
  } catch (error) {
    if (
      error instanceof FinancialLedgerReadError &&
      error.code === 'not_found'
    ) {
      throw new CustomerFinancialDocumentNotFoundError()
    }
    throw error
  }
  const capturedPaise = inrPaise(record.capturedPaise)
  const refundedPaise = record.refundedPaise.reduce<InrPaise>(
    (total, value) =>
      addInrPaise(total, inrPaise(value)),
    inrPaise(0),
  )
  if (refundedPaise > capturedPaise) {
    throw new CustomerBillingUnavailableError('financial_integrity_review')
  }
  return {
    environment: providerMode,
    invoice: record.invoice,
    creditNotes: record.creditNotes,
    netPaidPaise: subtractInrPaise(capturedPaise, refundedPaise),
    rendering: {
      pdfAvailable: false,
      reason: 'financial_policy_not_approved',
    },
  }
}
