import { randomUUID } from 'node:crypto'
import mongoose from 'mongoose'
import { connectDB } from '@shared/db/connection'
import { User } from '@shared/db/models/User'
import type { PaidPersonalPlanKey } from '@shared/services/planConfig'
import { BillingConfig } from '../models/BillingConfig'
import { CouponCampaign } from '../models/CouponCampaign'
import { CouponCampaignRevision } from '../models/CouponCampaignRevision'
import { CouponReservation } from '../models/CouponReservation'
import { PlanCatalogVersion } from '../models/PlanCatalogVersion'
import { Subscription } from '../models/Subscription'
import { SubscriptionCycle } from '../models/SubscriptionCycle'
import type {
  CatalogApprovalSnapshot,
  CatalogContent,
  CatalogValidationSnapshot,
  CouponCampaignMode,
  CouponPolicyApprovalKind,
  CouponPolicyApprovalSnapshot,
  CouponRevisionTerms,
  CouponSegment,
  CouponValidationSnapshot,
  ProviderMode,
  ProviderVerificationSnapshot,
} from '../types/catalog'
import type {
  BillingQuoteSurface,
  CustomerBillingQuoteRequest,
} from '../validators/customerBilling'
import { validateCatalogContent } from './catalogValidation'
import {
  selectCouponForPricing,
  type CouponManualCodeResult,
  type CouponSelectionAvailability,
} from './couponSelectionService'
import {
  PR5_COUPON_ACTIVATION_READY,
} from './couponActivationGate'
import { validateCouponCampaignPolicy } from './couponValidation'

const QUOTE_TTL_MS = 5 * 60 * 1_000
const COUPON_PAGE_SIZE = 50
const CURRENT_SUBSCRIPTION_STATUSES = [
  'authenticated',
  'activation_pending',
  'active',
  'pending',
  'halted',
  'paused',
] as const

export interface ActiveCatalogRecord {
  version: string
  status: string
  effectiveAt?: Date
  content: CatalogContent
  contentHash: string
  validation?: CatalogValidationSnapshot
  approval?: CatalogApprovalSnapshot
}

export interface CustomerQuoteBillingContext {
  buyerExists: boolean
  buyerState?: string
  activeCatalogVersion?: string
  sellingMode: 'off' | 'qa' | 'all'
  couponMode: 'off' | 'qa' | 'all'
  qaUserIds: string[]
  catalog: ActiveCatalogRecord | null
}

export interface CustomerCouponHistory {
  providerMode: ProviderMode
  hasCapturedSubscription: boolean
  currentPlanKey?: PaidPersonalPlanKey
  resolvedSegment?: CouponSegment
  resolvedAcquisitionSource?: string
}

export interface CustomerQuoteCouponCandidate {
  campaignId: string
  campaignKey: string
  mode: CouponCampaignMode
  code?: string
  revision: number
  status: string
  terms: CouponRevisionTerms
  contentHash: string
  validation?: CouponValidationSnapshot
  approval?: CatalogApprovalSnapshot
  policyApprovals?: Partial<
    Record<CouponPolicyApprovalKind, CouponPolicyApprovalSnapshot>
  >
  providerVerification?: Partial<
    Record<ProviderMode, ProviderVerificationSnapshot>
  >
  availability: CouponSelectionAvailability
  selectable?: boolean
}

export interface CustomerCouponPageCursor {
  priority: number
  discountPaise: number
  campaignKey: string
  revisionId: string
}

export interface CustomerCouponCandidatePage {
  candidates: CustomerQuoteCouponCandidate[]
  nextCursor?: CustomerCouponPageCursor
}

interface CouponReadBase {
  planKey: PaidPersonalPlanKey
  surface: BillingQuoteSurface
  userId: string
  providerMode: ProviderMode
  now: Date
}

export interface CustomerBillingQuoteStore {
  readBillingContext(userId: string): Promise<CustomerQuoteBillingContext>
  readCustomerCouponHistory(input: {
    userId: string
    providerMode: ProviderMode
  }): Promise<CustomerCouponHistory>
  readAutomaticCouponCandidatePage(
    input: CouponReadBase & {
      limit: number
      cursor?: CustomerCouponPageCursor
    },
  ): Promise<CustomerCouponCandidatePage>
  readManualCouponCandidate(
    input: CouponReadBase & { couponCode: string },
  ): Promise<CustomerQuoteCouponCandidate | null>
}

export interface CustomerBillingQuoteDependencies {
  store: CustomerBillingQuoteStore
  now(): Date
  quoteId(): string
  couponActivationReady: boolean
}

export type CustomerBillingQuote = {
  quoteId: string
  expiresAt: string
  catalogVersion: string
  currency: 'INR'
  gstInclusive: true
  gstRatePercent: 18
  listPricePaise: number
  discountPaise: number
  payablePaise: number
  nextChargePaise?: number
  planKey?: PaidPersonalPlanKey
  sku?: 'single_interview' | 'premium_resume'
  coupon?: {
    campaignId: string
    revision: number
    mode: CouponCampaignMode
    code?: string
    displayText: string
    whyApplied: string
    termsText: string
  }
  manualCodeResult?: CouponManualCodeResult | 'system_unavailable'
  discountedBillingCycles?: number
  renewalPricePaise?: number
  disclosure: {
    summary: string
    why: string
    terms?: string
    gst: 'GST included.'
    cancellation?: 'Auto-renews until cancelled.'
  }
  entitlementSummary: Record<string, unknown>
}

export interface ResolvedCustomerBillingQuote {
  quote: CustomerBillingQuote
  context: CustomerQuoteBillingContext
  catalog: ActiveCatalogRecord
  providerMode: ProviderMode | null
  history?: CustomerCouponHistory
  selectedCandidate?: CustomerQuoteCouponCandidate
}

export class CustomerBillingQuoteUnavailableError extends Error {
  readonly code: 'buyer_unavailable' | 'active_catalog_unavailable'
  constructor(code: CustomerBillingQuoteUnavailableError['code']) {
    super('Billing quote is temporarily unavailable')
    this.name = 'CustomerBillingQuoteUnavailableError'
    this.code = code
  }
}

type CampaignRow = {
  _id: mongoose.Types.ObjectId
  key: string
  mode: CouponCampaignMode
  code?: string
}
type RevisionRow = Omit<
  CustomerQuoteCouponCandidate,
  'campaignId' | 'campaignKey' | 'mode' | 'code' | 'availability'
> & {
  _id: mongoose.Types.ObjectId
  campaignId: mongoose.Types.ObjectId
}
type JoinedRevisionRow = RevisionRow & { campaign: CampaignRow }
type UsageRow = CouponSelectionAvailability & {
  _id: { toString(): string }
}

function revisionFilter(input: CouponReadBase) {
  return {
    status: 'active' as const,
    'terms.applicablePlanKeys': input.planKey,
    'terms.visibility': input.surface,
    $and: [
      {
        $or: [
          { 'terms.startsAt': { $exists: false } },
          { 'terms.startsAt': { $lte: input.now } },
        ],
      },
      {
        $or: [
          { 'terms.endsAt': { $exists: false } },
          { 'terms.endsAt': { $gt: input.now } },
        ],
      },
    ],
  }
}

function rankAfter(cursor: CustomerCouponPageCursor) {
  const samePriority = { 'terms.priority': cursor.priority }
  const sameDiscount = { 'terms.discountPaise': cursor.discountPaise }
  return {
    $or: [
      { 'terms.priority': { $lt: cursor.priority } },
      { ...samePriority, 'terms.discountPaise': { $lt: cursor.discountPaise } },
      {
        ...samePriority,
        ...sameDiscount,
        'campaign.key': { $gt: cursor.campaignKey },
      },
      {
        ...samePriority,
        ...sameDiscount,
        'campaign.key': cursor.campaignKey,
        _id: { $gt: new mongoose.Types.ObjectId(cursor.revisionId) },
      },
    ],
  }
}

function toCandidate(
  row: JoinedRevisionRow,
  availability: CouponSelectionAvailability,
): CustomerQuoteCouponCandidate {
  const { _id: _revisionId, campaign, ...revision } = row
  return {
    ...revision,
    campaignId: revision.campaignId.toString(),
    campaignKey: campaign.key,
    mode: campaign.mode,
    ...(campaign.code ? { code: campaign.code } : {}),
    availability,
  }
}

async function readAvailability(
  rows: JoinedRevisionRow[],
  userId: string,
  providerMode: ProviderMode,
): Promise<Map<string, CouponSelectionAvailability>> {
  if (rows.length === 0) return new Map()
  const campaignIds = Array.from(new Map(
    rows.map((row) => [row.campaignId.toString(), row.campaignId]),
  ).values())
  const userObjectId = new mongoose.Types.ObjectId(userId)
  const usage = await CouponReservation.aggregate<UsageRow>([
    {
      $match: {
        providerMode,
        campaignId: { $in: campaignIds },
        capacityDisposition: { $in: ['held', 'converted'] },
      },
    },
    {
      $group: {
        _id: '$campaignId',
        redemptions: {
          $sum: {
            $cond: [{ $eq: ['$capacityDisposition', 'converted'] }, 1, 0],
          },
        },
        openReservations: {
          $sum: { $cond: [{ $eq: ['$capacityDisposition', 'held'] }, 1, 0] },
        },
        userRedemptions: {
          $sum: {
            $cond: [
              {
                $and: [
                  { $eq: ['$capacityDisposition', 'converted'] },
                  { $eq: ['$userId', userObjectId] },
                ],
              },
              1,
              0,
            ],
          },
        },
        userOpenReservations: {
          $sum: {
            $cond: [
              {
                $and: [
                  { $eq: ['$capacityDisposition', 'held'] },
                  { $eq: ['$userId', userObjectId] },
                ],
              },
              1,
              0,
            ],
          },
        },
      },
    },
  ])
  return new Map(usage.map((row) => [
    row._id.toString(),
    {
      providerMode,
      redemptions: row.redemptions,
      openReservations: row.openReservations,
      userRedemptions: row.userRedemptions,
      userOpenReservations: row.userOpenReservations,
    },
  ]))
}

async function hydrateCandidates(
  rows: JoinedRevisionRow[],
  userId: string,
  providerMode: ProviderMode,
): Promise<CustomerQuoteCouponCandidate[]> {
  const usage = await readAvailability(rows, userId, providerMode)
  const empty = {
    providerMode,
    redemptions: 0,
    openReservations: 0,
    userRedemptions: 0,
    userOpenReservations: 0,
  } as const
  return rows.map((row) =>
    toCandidate(row, usage.get(row.campaignId.toString()) ?? empty))
}

export const mongoCustomerBillingQuoteStore: CustomerBillingQuoteStore = {
  async readBillingContext(userId) {
    await connectDB()
    const config = await BillingConfig.findOne({ key: 'singleton' })
      .select('activeCatalogVersion sellingMode couponMode qaUserIds')
      .lean<{
        activeCatalogVersion?: string
        sellingMode: 'off' | 'qa' | 'all'
        couponMode: 'off' | 'qa' | 'all'
        qaUserIds?: Array<{ toString(): string }>
      }>()
    const fallback = {
      buyerExists: false,
      activeCatalogVersion: config?.activeCatalogVersion,
      sellingMode: config?.sellingMode ?? 'off',
      couponMode: config?.couponMode ?? 'off',
      qaUserIds: config?.qaUserIds?.map(String) ?? [],
      catalog: null,
    }
    if (
      !config?.activeCatalogVersion ||
      !mongoose.Types.ObjectId.isValid(userId)
    ) return fallback
    const [buyer, catalog] = await Promise.all([
      User.findById(userId)
        .select('_id buyerState')
        .lean<{ _id: unknown; buyerState?: string }>(),
      PlanCatalogVersion.findOne({
        version: config.activeCatalogVersion,
        status: 'published',
      }).lean<ActiveCatalogRecord>(),
    ])
    return {
      ...fallback,
      buyerExists: Boolean(buyer),
      buyerState: buyer?.buyerState,
      catalog,
    }
  },

  async readCustomerCouponHistory(input) {
    await connectDB()
    const userObjectId = new mongoose.Types.ObjectId(input.userId)
    const [capturedCycle, currentSubscription] = await Promise.all([
      SubscriptionCycle.exists({
        userId: userObjectId,
        providerMode: input.providerMode,
        fulfillmentStatus: 'captured',
      }),
      Subscription.findOne({
        userId: userObjectId,
        providerMode: input.providerMode,
        status: { $in: CURRENT_SUBSCRIPTION_STATUSES },
      })
        .sort({ updatedAt: -1 })
        .select('planKey')
        .lean<{ planKey: PaidPersonalPlanKey }>(),
    ])
    return {
      providerMode: input.providerMode,
      hasCapturedSubscription: Boolean(capturedCycle),
      currentPlanKey: currentSubscription?.planKey,
    }
  },

  async readAutomaticCouponCandidatePage(input) {
    await connectDB()
    const limit = Math.max(1, Math.min(input.limit, COUPON_PAGE_SIZE))
    const rows = await CouponCampaignRevision.aggregate<JoinedRevisionRow>([
      { $match: revisionFilter(input) },
      {
        $lookup: {
          from: CouponCampaign.collection.name,
          localField: 'campaignId',
          foreignField: '_id',
          as: 'campaign',
        },
      },
      { $unwind: '$campaign' },
      { $match: { 'campaign.mode': { $in: ['automatic', 'targeted'] } } },
      ...(input.cursor ? [{ $match: rankAfter(input.cursor) }] : []),
      {
        $sort: {
          'terms.priority': -1,
          'terms.discountPaise': -1,
          'campaign.key': 1,
          _id: 1,
        },
      },
      { $limit: limit + 1 },
    ])
    const pageRows = rows.slice(0, limit)
    const candidates = await hydrateCandidates(
      pageRows,
      input.userId,
      input.providerMode,
    )
    const last = pageRows.at(-1)
    return {
      candidates,
      ...(rows.length > limit && last
        ? {
            nextCursor: {
              priority: last.terms.priority,
              discountPaise: last.terms.discountPaise,
              campaignKey: last.campaign.key,
              revisionId: last._id.toString(),
            },
          }
        : {}),
    }
  },

  async readManualCouponCandidate(input) {
    await connectDB()
    const campaign = await CouponCampaign.findOne({
      mode: 'code',
      code: input.couponCode.trim().toUpperCase(),
    }).select('_id key mode code').lean<CampaignRow>()
    if (!campaign) return null
    const revision = await CouponCampaignRevision.findOne({
      ...revisionFilter(input),
      campaignId: campaign._id,
    }).lean<RevisionRow>()
    if (!revision) return null
    const row = { ...revision, campaign }
    return (await hydrateCandidates(
      [row],
      input.userId,
      input.providerMode,
    ))[0] ?? null
  },
}

const defaultDependencies: CustomerBillingQuoteDependencies = {
  store: mongoCustomerBillingQuoteStore,
  now: () => new Date(),
  quoteId: randomUUID,
  couponActivationReady: PR5_COUPON_ACTIVATION_READY,
}

function providerModeForSelling(
  context: CustomerQuoteBillingContext,
  userId: string,
): ProviderMode | null {
  if (context.sellingMode === 'all') return 'live'
  return context.sellingMode === 'qa' && context.qaUserIds.includes(userId)
    ? 'test'
    : null
}

function providerModeForCoupons(
  context: CustomerQuoteBillingContext,
  userId: string,
  couponActivationReady: boolean,
): ProviderMode | null {
  if (!couponActivationReady) return null
  const qaUser = context.qaUserIds.includes(userId)
  if (
    context.couponMode !== 'all' &&
    !(context.couponMode === 'qa' && qaUser)
  ) return null
  return providerModeForSelling(context, userId)
}

function validActiveCatalog(
  context: CustomerQuoteBillingContext,
  now: Date,
): ActiveCatalogRecord | null {
  const catalog = context.catalog
  if (
    !context.activeCatalogVersion ||
    !catalog ||
    catalog.version !== context.activeCatalogVersion ||
    catalog.status !== 'published' ||
    (catalog.effectiveAt && catalog.effectiveAt > now)
  ) return null
  const validation = validateCatalogContent(catalog.content)
  return (
      validation.valid &&
      validation.contentHash === catalog.contentHash &&
      catalog.validation?.contentHash === catalog.contentHash &&
      catalog.validation.errors.length === 0 &&
      catalog.approval?.contentHash === catalog.contentHash
    )
    ? catalog
    : null
}

function campaignControlPlaneIsValid(
  candidate: CustomerQuoteCouponCandidate,
  catalog: ActiveCatalogRecord,
  providerMode: ProviderMode,
): boolean {
  const validation = candidate.validation
  const verification = candidate.providerVerification?.[providerMode]
  if (
    candidate.status !== 'active' ||
    !validation ||
    validation.contentHash !== candidate.contentHash ||
    validation.catalogVersion !== catalog.version ||
    validation.catalogContentHash !== catalog.contentHash ||
    validation.providerMode !== providerMode ||
    validation.errors.length > 0 ||
    candidate.approval?.contentHash !== candidate.contentHash ||
    verification?.status !== 'verified' ||
    verification.normalizedTermsHash !== candidate.contentHash ||
    verification.errors.length > 0
  ) return false
  const policy = validateCouponCampaignPolicy(
    candidate.terms,
    catalog.content,
    {
      campaignMode: candidate.mode,
      providerMode,
      couponContentHash: candidate.contentHash,
      catalogVersion: catalog.version,
      catalogContentHash: catalog.contentHash,
      policyApprovals: candidate.policyApprovals,
      requireApprovals: true,
    },
  )
  return policy.valid && policy.contentHash === candidate.contentHash
}

function entitlementSummary(
  request: CustomerBillingQuoteRequest,
  catalog: CatalogContent,
): Record<string, unknown> {
  if (request.planKey) {
    const plan = catalog.plans[request.planKey]
    return {
      kind: 'subscription',
      displayName: plan.displayName,
      billingPeriod: plan.billingPeriod,
      interview: plan.interview,
      resume: plan.resume,
    }
  }
  const product = catalog.oneTimeProducts[request.sku!]
  return {
    kind: request.sku,
    displayName: product.displayName,
    entitlement: product.entitlement,
  }
}

function selectionInput(
  planKey: PaidPersonalPlanKey,
  surface: BillingQuoteSurface,
  catalog: ActiveCatalogRecord,
  now: Date,
  customer: CustomerCouponHistory & { userId: string },
  automaticCandidates: CustomerQuoteCouponCandidate[],
  manualCode?: string,
  manualCandidates?: CustomerQuoteCouponCandidate[],
) {
  return {
    mode: 'server' as const,
    providerMode: customer.providerMode,
    planKey,
    surface,
    now,
    listPricePaise: catalog.content.plans[planKey].listPricePaise,
    currency: catalog.content.currency,
    gstInclusive: catalog.content.gstInclusive,
    gstRatePercent: catalog.content.gstRatePercent,
    customer: {
      userId: customer.userId,
      isNewCustomer: !customer.hasCapturedSubscription,
      isUpgrade: planKey === 'pro' && customer.currentPlanKey === 'plus',
      resolvedSegment: customer.resolvedSegment,
      resolvedAcquisitionSource: customer.resolvedAcquisitionSource,
    },
    automaticCandidates,
    manualCode,
    manualCandidates,
  }
}

async function bestAutomaticCandidate(
  input: CouponReadBase & {
    catalog: ActiveCatalogRecord
    history: CustomerCouponHistory
  },
  store: CustomerBillingQuoteStore,
): Promise<CustomerQuoteCouponCandidate | undefined> {
  const { catalog, history, ...readInput } = input
  let cursor: CustomerCouponPageCursor | undefined
  const seenCursors = new Set<string>()
  do {
    const page = await store.readAutomaticCouponCandidatePage({
      ...readInput,
      limit: COUPON_PAGE_SIZE,
      ...(cursor ? { cursor } : {}),
    })
    const candidates = page.candidates.map((candidate) => ({
      ...candidate,
      selectable: campaignControlPlaneIsValid(
        candidate,
        catalog,
        input.providerMode,
      ),
    }))
    const selected = selectCouponForPricing(selectionInput(
      input.planKey,
      input.surface,
      catalog,
      input.now,
      { ...history, userId: input.userId },
      candidates,
    )).selected
    if (selected) return selected
    cursor = page.nextCursor
    if (cursor) {
      const identity = JSON.stringify(cursor)
      if (seenCursors.has(identity)) {
        throw new Error('Coupon candidate pagination cursor did not advance')
      }
      seenCursors.add(identity)
    }
  } while (cursor)
  return undefined
}

export async function resolveCustomerBillingQuote(
  input: { userId: string; request: CustomerBillingQuoteRequest },
  dependencies: CustomerBillingQuoteDependencies = defaultDependencies,
): Promise<ResolvedCustomerBillingQuote> {
  const now = dependencies.now()
  let context: CustomerQuoteBillingContext
  try {
    context = await dependencies.store.readBillingContext(input.userId)
  } catch {
    throw new CustomerBillingQuoteUnavailableError('active_catalog_unavailable')
  }
  const catalog = validActiveCatalog(context, now)
  if (!catalog) {
    throw new CustomerBillingQuoteUnavailableError('active_catalog_unavailable')
  }
  if (!context.buyerExists || context.buyerState === 'deletion_pending') {
    throw new CustomerBillingQuoteUnavailableError('buyer_unavailable')
  }
  const base = {
    quoteId: dependencies.quoteId(),
    expiresAt: new Date(now.getTime() + QUOTE_TTL_MS).toISOString(),
    catalogVersion: catalog.version,
    currency: catalog.content.currency,
    gstInclusive: catalog.content.gstInclusive,
    gstRatePercent: catalog.content.gstRatePercent,
  } as const
  const providerMode = providerModeForSelling(context, input.userId)
  if (input.request.sku) {
    const product = catalog.content.oneTimeProducts[input.request.sku]
    const quote = {
      ...base,
      sku: input.request.sku,
      listPricePaise: product.listPricePaise,
      discountPaise: 0,
      payablePaise: product.listPricePaise,
      disclosure: {
        summary: `₹${product.listPricePaise / 100} one-time. GST included.`,
        why: 'One-time products are not coupon eligible.',
        gst: 'GST included.' as const,
      },
      entitlementSummary: entitlementSummary(input.request, catalog.content),
    }
    return { quote, context, catalog, providerMode }
  }

  const planKey = input.request.planKey!
  const plan = catalog.content.plans[planKey]
  const couponProviderMode = providerModeForCoupons(
    context,
    input.userId,
    dependencies.couponActivationReady,
  )
  let history: CustomerCouponHistory | undefined
  let couponSystemUnavailable = false
  let selection = selectCouponForPricing<CustomerQuoteCouponCandidate>({
    mode: 'simulation',
    planKey,
    surface: input.request.surface,
    now,
    listPricePaise: plan.listPricePaise,
    currency: catalog.content.currency,
    gstInclusive: catalog.content.gstInclusive,
    gstRatePercent: catalog.content.gstRatePercent,
    customer: {
      userId: input.userId,
      isNewCustomer: false,
      isUpgrade: false,
    },
    automaticCandidates: [],
  })
  if (couponProviderMode) {
    try {
      history = await dependencies.store.readCustomerCouponHistory({
        userId: input.userId,
        providerMode: couponProviderMode,
      })
      if (history.providerMode !== couponProviderMode) {
        throw new Error('Coupon history provider mode mismatch')
      }
      const readBase = {
        userId: input.userId,
        providerMode: couponProviderMode,
        planKey,
        surface: input.request.surface,
        now,
      }
      const automatic = await bestAutomaticCandidate({
        ...readBase,
        catalog,
        history,
      }, dependencies.store)
      const manual = input.request.manualCouponCode
        ? await dependencies.store.readManualCouponCandidate({
            ...readBase,
            couponCode: input.request.manualCouponCode,
          })
        : null
      const manualCandidate = manual
        ? {
            ...manual,
            selectable: campaignControlPlaneIsValid(
              manual,
              catalog,
              couponProviderMode,
            ),
          }
        : undefined
      selection = selectCouponForPricing(selectionInput(
        planKey,
        input.request.surface,
        catalog,
        now,
        { ...history, userId: input.userId },
        automatic ? [automatic] : [],
        input.request.manualCouponCode,
        manualCandidate ? [manualCandidate] : [],
      ))
    } catch {
      history = undefined
      couponSystemUnavailable = true
    }
  }
  const selected = selection.selected
  const discountPaise = selected?.terms.discountPaise ?? 0
  const disclosure = selection.disclosure
  const quote: CustomerBillingQuote = {
    ...base,
    planKey,
    listPricePaise: plan.listPricePaise,
    discountPaise,
    payablePaise: plan.listPricePaise - discountPaise,
    nextChargePaise: selection.pricing.nextChargePaise,
    renewalPricePaise: plan.listPricePaise,
    ...(selected
      ? {
          discountedBillingCycles: selected.terms.discountedBillingCycles,
          coupon: {
            campaignId: selected.campaignId,
            revision: selected.revision,
            mode: selected.mode,
            ...(selected.mode === 'code' && selected.code
              ? { code: selected.code }
              : {}),
            displayText: selected.terms.bannerText ??
              `₹${selected.terms.discountPaise / 100} off`,
            whyApplied: disclosure.why,
            termsText: selected.terms.termsText,
          },
        }
      : {}),
    ...(input.request.manualCouponCode
      ? {
          manualCodeResult: couponSystemUnavailable
            ? 'system_unavailable'
            : selection.manualCodeResult ?? 'invalid',
        }
      : {}),
    disclosure,
    entitlementSummary: entitlementSummary(input.request, catalog.content),
  }
  return {
    quote,
    context,
    catalog,
    providerMode,
    ...(history ? { history } : {}),
    ...(selected ? { selectedCandidate: selected } : {}),
  }
}

export async function createCustomerBillingQuote(
  input: { userId: string; request: CustomerBillingQuoteRequest },
  dependencies: CustomerBillingQuoteDependencies = defaultDependencies,
): Promise<CustomerBillingQuote> {
  return (await resolveCustomerBillingQuote(input, dependencies)).quote
}
