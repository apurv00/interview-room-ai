/**
 * Idempotent one-founder Razorpay Test launch bootstrap.
 *
 * Dry-run (default):
 *   npx tsx scripts/bootstrap-razorpay-test-launch.ts
 *
 * Apply the already-validated Test control plane:
 *   npx tsx scripts/bootstrap-razorpay-test-launch.ts --apply
 *
 * Required environment:
 *   MONGODB_URI_PROD (falls back to MONGODB_URI)
 *   BILLING_QA_USER_ID
 *   RAZORPAY_TEST_KEY_ID
 *   RAZORPAY_TEST_KEY_SECRET
 *   RAZORPAY_TEST_PLUS_PLAN_ID
 *   RAZORPAY_TEST_PRO_PLAN_ID
 *
 * Optional coupon environment:
 *   RAZORPAY_TEST_OFFER_ID
 *   RAZORPAY_TEST_OFFER_SNAPSHOT_JSON
 *
 * The official razorpay@2.9.8 SDK has no Offers read resource. Consequently,
 * an Offer ID is accepted only with a normalized Dashboard-exported snapshot;
 * the snapshot is routed through the production binding verifier and compared
 * exactly with the catalog and generated coupon terms. Coupon mode otherwise
 * remains off.
 */

import { config as loadDotenv } from 'dotenv'
import mongoose, { type ClientSession } from 'mongoose'
import { z } from 'zod'
import {
  buildCouponLifecycleTransition,
  validateCouponLifecycleHistory,
} from '../modules/payments/lib/couponLifecycleHistory'
import { sha256CanonicalJson } from '../modules/payments/lib/canonicalJson'
import { BillingConfig } from '../modules/payments/models/BillingConfig'
import { CouponCampaign } from '../modules/payments/models/CouponCampaign'
import { CouponCampaignRevision } from '../modules/payments/models/CouponCampaignRevision'
import { PlanCatalogVersion } from '../modules/payments/models/PlanCatalogVersion'
import { createRazorpayPaymentBindingVerifier } from '../modules/payments/providers/razorpayBindingVerifier'
import { createRazorpayClientFactory } from '../modules/payments/providers/razorpayClientFactory'
import type { RazorpayOfferReader } from '../modules/payments/providers/razorpayServerAdapter'
import {
  buildInitialCatalogContent,
  validateCatalogContent,
} from '../modules/payments/services/catalogValidation'
import { validateCouponCampaignPolicy } from '../modules/payments/services/couponValidation'
import type {
  CatalogContent,
  CouponPolicyApprovalKind,
  CouponPolicyApprovalSnapshot,
  CouponRevisionTerms,
  CouponValidationSnapshot,
  ProviderVerificationSnapshot,
} from '../modules/payments/types/catalog'
import { CouponRevisionTermsSchema } from '../modules/payments/validators/coupon'
import {
  LAUNCH_COUPON_POLICY,
} from '../shared/services/planConfig'

loadDotenv({ path: '.env.local', override: false, quiet: true })

mongoose.set('autoCreate', false)
mongoose.set('autoIndex', false)

const PLAN_ID_PATTERN = /^plan_[A-Za-z0-9]+$/
const OFFER_ID_PATTERN = /^offer_[A-Za-z0-9]+$/
const OBJECT_ID_PATTERN = /^[a-f\d]{24}$/i
const CATALOG_VERSION_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,119}$/
const DEFAULT_CATALOG_VERSION =
  'consumer-inr-2026-07-v1-razorpay-test'
const TEST_CATALOG_EFFECTIVE_AT_ISO = '2026-07-01T00:00:00.000Z'
const COUPON_CAMPAIGN_KEY = 'razorpay-test-auto-launch'
const COUPON_CAMPAIGN_NAME = 'Razorpay Test automatic launch offer'
const BOOTSTRAP_REASON =
  'Bootstrap the founder-only Razorpay Test payment launch control plane'

type WriteDisposition = 'create' | 'update' | 'existing'

interface BootstrapInput {
  mongoUri: string
  qaUserId: string
  plusPlanId: string
  proPlanId: string
  catalogVersion: string
  offerId?: string
  offerSnapshot?: ProviderOfferSnapshot
}

interface CatalogArtifact {
  version: string
  effectiveAt: Date
  content: CatalogContent
  contentHash: string
  verification: ProviderVerificationSnapshot
}

interface CouponArtifact {
  offerId: string
  terms: CouponRevisionTerms
  contentHash: string
  validation: CouponValidationSnapshot
  policyApprovals: Partial<
    Record<CouponPolicyApprovalKind, CouponPolicyApprovalSnapshot>
  >
  verification: ProviderVerificationSnapshot
}

interface ExistingCatalogRow {
  _id: mongoose.Types.ObjectId
  version: string
  status: string
  editRevision: number
  content: CatalogContent
  contentHash: string
  validation?: {
    contentHash: string
    errors: string[]
  }
  approval?: { contentHash: string }
  providerVerification?: {
    test?: ProviderVerificationSnapshot
  }
  effectiveAt?: Date
  publishedAt?: Date
}

interface ExistingBillingConfigRow {
  revision: number
  sellingMode: string
  enforcementMode: string
  couponMode: string
  qaUserIds?: Array<{ toString(): string }>
  newUserRolloutPercent: number
  enforcementStartedAt?: Date
  legacyGrandfatherEndsAt?: Date
  activeCatalogVersion?: string
  autoCouponRequired: boolean
  webhookProcessingEnabled: boolean
  reconciliationEnabled: boolean
  rolloutPolicy?: unknown
}

interface ExistingCouponCampaignRow {
  _id: mongoose.Types.ObjectId
  key: string
  name: string
  mode: string
  code?: string
  latestRevision: number
}

interface ExistingCouponRevisionRow {
  campaignId: mongoose.Types.ObjectId
  revision: number
  status: string
  editRevision: number
  terms: CouponRevisionTerms
  contentHash: string
  validation?: CouponValidationSnapshot
  approval?: { contentHash: string }
  policyApprovals?: Partial<
    Record<CouponPolicyApprovalKind, CouponPolicyApprovalSnapshot>
  >
  providerVerification?: { test?: ProviderVerificationSnapshot }
  lifecycleClaim?: string
  lifecycleHistory?: unknown[]
}

class BootstrapFailure extends Error {
  constructor(readonly errorId: string) {
    super(errorId)
    this.name = 'BootstrapFailure'
  }
}

const ProviderOfferSnapshotSchema = z.object({
  id: z.string().regex(OFFER_ID_PATTERN),
  active: z.literal(true),
  discountType: z.literal('flat'),
  discountAmountPaise: z.number().int().positive(),
  currency: z.literal('INR'),
  applicablePlanIds: z.array(z.string().regex(PLAN_ID_PATTERN)).length(2),
  discountedBillingCycles: z.number().int().min(1).max(12),
  startsAtEpochSeconds: z.number().int().positive().optional(),
  endsAtEpochSeconds: z.number().int().positive().optional(),
}).strict().superRefine((offer, context) => {
  if (new Set(offer.applicablePlanIds).size !== 2) {
    context.addIssue({
      code: 'custom',
      path: ['applicablePlanIds'],
      message: 'Offer Plan IDs must be unique',
    })
  }
  if (
    offer.startsAtEpochSeconds !== undefined &&
    offer.endsAtEpochSeconds !== undefined &&
    offer.endsAtEpochSeconds <= offer.startsAtEpochSeconds
  ) {
    context.addIssue({
      code: 'custom',
      path: ['endsAtEpochSeconds'],
      message: 'Offer end must follow its start',
    })
  }
})

type ProviderOfferSnapshot = z.output<typeof ProviderOfferSnapshotSchema>

function fail(errorId: string): never {
  throw new BootstrapFailure(errorId)
}

function deterministicObjectId(domain: string, identity: string) {
  return new mongoose.Types.ObjectId(
    sha256CanonicalJson({ domain, identity }).slice(0, 24),
  )
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) fail(`missing_${name.toLowerCase()}`)
  return value
}

function parseOfferSnapshot(
  raw: string,
  expectedOfferId: string,
): ProviderOfferSnapshot {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    fail('invalid_razorpay_test_offer_snapshot_json')
  }
  const parsed = ProviderOfferSnapshotSchema.safeParse(value)
  if (!parsed.success || parsed.data.id !== expectedOfferId) {
    fail('invalid_razorpay_test_offer_snapshot')
  }
  return parsed.data
}

function loadInput(): BootstrapInput {
  const mongoUri = (
    process.env.MONGODB_URI_PROD ?? process.env.MONGODB_URI
  )?.trim()
  if (!mongoUri) fail('missing_mongodb_uri_prod_or_mongodb_uri')

  const qaUserId = requiredEnvironment('BILLING_QA_USER_ID').toLowerCase()
  if (!OBJECT_ID_PATTERN.test(qaUserId)) {
    fail('invalid_billing_qa_user_id')
  }

  requiredEnvironment('RAZORPAY_TEST_KEY_ID')
  requiredEnvironment('RAZORPAY_TEST_KEY_SECRET')

  const plusPlanId = requiredEnvironment('RAZORPAY_TEST_PLUS_PLAN_ID')
  const proPlanId = requiredEnvironment('RAZORPAY_TEST_PRO_PLAN_ID')
  if (
    !PLAN_ID_PATTERN.test(plusPlanId) ||
    !PLAN_ID_PATTERN.test(proPlanId) ||
    plusPlanId === proPlanId
  ) {
    fail('invalid_razorpay_test_plan_ids')
  }

  const catalogVersion = (
    process.env.BILLING_TEST_CATALOG_VERSION?.trim() ||
    DEFAULT_CATALOG_VERSION
  )
  if (!CATALOG_VERSION_PATTERN.test(catalogVersion)) {
    fail('invalid_billing_test_catalog_version')
  }

  const offerId = process.env.RAZORPAY_TEST_OFFER_ID?.trim()
  const offerSnapshotRaw =
    process.env.RAZORPAY_TEST_OFFER_SNAPSHOT_JSON?.trim()
  if (offerId && !OFFER_ID_PATTERN.test(offerId)) {
    fail('invalid_razorpay_test_offer_id')
  }
  if (Boolean(offerId) !== Boolean(offerSnapshotRaw)) {
    fail('offer_id_and_snapshot_must_be_configured_together')
  }

  return {
    mongoUri,
    qaUserId,
    plusPlanId,
    proPlanId,
    catalogVersion,
    ...(offerId && offerSnapshotRaw
      ? {
          offerId,
          offerSnapshot: parseOfferSnapshot(offerSnapshotRaw, offerId),
        }
      : {}),
  }
}

function buildCatalog(input: BootstrapInput): {
  version: string
  effectiveAt: Date
  content: CatalogContent
  contentHash: string
} {
  const initial = buildInitialCatalogContent()
  const content: CatalogContent = {
    ...initial,
    plans: {
      ...initial.plans,
      plus: {
        ...initial.plans.plus,
        razorpayPlanIdByMode: { test: input.plusPlanId },
      },
      pro: {
        ...initial.plans.pro,
        razorpayPlanIdByMode: { test: input.proPlanId },
      },
    },
  }
  const validation = validateCatalogContent(content)
  if (!validation.valid || !validation.content || !validation.contentHash) {
    fail('catalog_validation_failed')
  }
  return {
    version: input.catalogVersion,
    effectiveAt: new Date(TEST_CATALOG_EFFECTIVE_AT_ISO),
    content: validation.content,
    contentHash: validation.contentHash,
  }
}

function sameStringSet(left: string[], right: string[]): boolean {
  const normalizedLeft = [...left].sort()
  const normalizedRight = [...right].sort()
  return normalizedLeft.length === normalizedRight.length &&
    normalizedLeft.every(
      (value, index) => value === normalizedRight[index],
    )
}

function offerReaderFor(
  snapshot: ProviderOfferSnapshot | undefined,
): RazorpayOfferReader | undefined {
  if (!snapshot) return undefined
  return {
    async fetchOffer({ providerMode, offerId }) {
      if (providerMode !== 'test' || offerId !== snapshot.id) {
        fail('offer_reader_binding_mismatch')
      }
      return {
        id: snapshot.id,
        active: snapshot.active,
        discountAmountPaise: snapshot.discountAmountPaise,
        applicablePlanIds: [...snapshot.applicablePlanIds],
        discountedBillingCycles: snapshot.discountedBillingCycles,
        startsAtEpochSeconds: snapshot.startsAtEpochSeconds,
        endsAtEpochSeconds: snapshot.endsAtEpochSeconds,
      }
    },
  }
}

async function verifyCatalog(
  input: BootstrapInput,
  catalog: Omit<CatalogArtifact, 'verification'>,
) {
  const verifier = createRazorpayPaymentBindingVerifier({
    clientFactory: createRazorpayClientFactory({
      offerReader: offerReaderFor(input.offerSnapshot),
    }),
  })
  const verification = await verifier.verifyCatalog({
    mode: 'test',
    content: catalog.content,
    contentHash: catalog.contentHash,
  })
  if (
    verification.status !== 'verified' ||
    verification.normalizedTermsHash !== catalog.contentHash ||
    verification.errors.length > 0
  ) {
    fail('catalog_provider_verification_failed')
  }
  return { verifier, verification }
}

function dateFromEpochSeconds(value: number | undefined): Date | undefined {
  return value === undefined ? undefined : new Date(value * 1_000)
}

async function buildCouponArtifact(input: {
  bootstrap: BootstrapInput
  catalog: CatalogArtifact
  verifier: ReturnType<typeof createRazorpayPaymentBindingVerifier>
}): Promise<CouponArtifact | undefined> {
  const offer = input.bootstrap.offerSnapshot
  const offerId = input.bootstrap.offerId
  if (!offer || !offerId) return undefined

  const expectedPlanIds = [
    input.bootstrap.plusPlanId,
    input.bootstrap.proPlanId,
  ]
  if (!sameStringSet(offer.applicablePlanIds, expectedPlanIds)) {
    fail('offer_plan_bindings_do_not_match_catalog')
  }

  const nowEpochSeconds = Math.floor(Date.now() / 1_000)
  if (
    (offer.startsAtEpochSeconds !== undefined &&
      offer.startsAtEpochSeconds > nowEpochSeconds) ||
    (offer.endsAtEpochSeconds !== undefined &&
      offer.endsAtEpochSeconds <= nowEpochSeconds)
  ) {
    fail('offer_is_not_currently_active')
  }

  const discountRupees = offer.discountAmountPaise / 100
  const cycleLabel = offer.discountedBillingCycles === 1
    ? 'first billing cycle'
    : `first ${offer.discountedBillingCycles} billing cycles`
  const parsedTerms = CouponRevisionTermsSchema.safeParse({
    discountPaise: offer.discountAmountPaise,
    applicablePlanKeys: ['plus', 'pro'],
    discountedBillingCycles: offer.discountedBillingCycles,
    razorpayOfferIdByMode: { test: offerId },
    startsAt: dateFromEpochSeconds(offer.startsAtEpochSeconds),
    endsAt: dateFromEpochSeconds(offer.endsAtEpochSeconds),
    priority: 100,
    eligibility: {
      newCustomerOnly: false,
      userIds: [],
      segments: ['all'],
      acquisitionSources: [],
      upgradesEligible: true,
    },
    maxRedemptionsPerUser: 1,
    minPayablePaiseByPlan: {
      plus: LAUNCH_COUPON_POLICY.plans.plus.minimumPayablePaise,
      pro: LAUNCH_COUPON_POLICY.plans.pro.minimumPayablePaise,
    },
    reservationTtlHours: 24,
    visibility: [
      'pricing',
      'checkout',
      'interviewPaywall',
      'feedback',
      'resume',
    ],
    bannerText: `Save ₹${discountRupees} on your subscription`,
    termsText:
      `Save ₹${discountRupees} for the ${cycleLabel}. ` +
      'The subscription renews at the plan list price thereafter.',
    holdoutBps: 0,
  })
  if (!parsedTerms.success) fail('coupon_terms_validation_failed')
  const terms = parsedTerms.data as CouponRevisionTerms
  const contentHash = sha256CanonicalJson(terms)

  const preliminary = validateCouponCampaignPolicy(
    terms,
    input.catalog.content,
    {
      campaignMode: 'automatic',
      providerMode: 'test',
      couponContentHash: contentHash,
      catalogVersion: input.catalog.version,
      catalogContentHash: input.catalog.contentHash,
      requireApprovals: false,
    },
  )
  if (!preliminary.valid || preliminary.contentHash !== contentHash) {
    fail('coupon_policy_validation_failed')
  }

  const approvedAt = new Date()
  const policyApprovals = Object.fromEntries(
    preliminary.requiredPolicyApprovals.map((kind) => [
      kind,
      {
        kind,
        couponContentHash: contentHash,
        catalogVersion: input.catalog.version,
        catalogContentHash: input.catalog.contentHash,
        providerMode: 'test' as const,
        approvedBy: input.bootstrap.qaUserId,
        approvedAt,
        reason: BOOTSTRAP_REASON,
      },
    ]),
  ) as Partial<
    Record<CouponPolicyApprovalKind, CouponPolicyApprovalSnapshot>
  >
  const validated = validateCouponCampaignPolicy(
    terms,
    input.catalog.content,
    {
      campaignMode: 'automatic',
      providerMode: 'test',
      couponContentHash: contentHash,
      catalogVersion: input.catalog.version,
      catalogContentHash: input.catalog.contentHash,
      policyApprovals,
      requireApprovals: true,
    },
  )
  if (!validated.valid || validated.contentHash !== contentHash) {
    fail('coupon_policy_approval_validation_failed')
  }

  const verification = await input.verifier.verifyCoupon({
    mode: 'test',
    terms,
    contentHash,
    catalogContentHash: input.catalog.contentHash,
    applicablePlanIds: expectedPlanIds,
  })
  if (
    verification.status !== 'verified' ||
    verification.normalizedTermsHash !== contentHash ||
    verification.errors.length > 0
  ) {
    fail('coupon_provider_verification_failed')
  }

  return {
    offerId,
    terms,
    contentHash,
    validation: {
      contentHash,
      errors: validated.errors,
      warnings: validated.warnings,
      validatedBy: input.bootstrap.qaUserId,
      validatedAt: new Date(),
      catalogVersion: input.catalog.version,
      catalogContentHash: input.catalog.contentHash,
      providerMode: 'test',
      requiredPolicyApprovals: validated.requiredPolicyApprovals,
    },
    policyApprovals,
    verification,
  }
}

function providerSnapshotMatches(
  snapshot: ProviderVerificationSnapshot | undefined,
  contentHash: string,
): boolean {
  return Boolean(
    snapshot &&
      snapshot.status === 'verified' &&
      snapshot.normalizedTermsHash === contentHash &&
      snapshot.errors.length === 0 &&
      snapshot.fetchedAt instanceof Date &&
      Number.isFinite(snapshot.fetchedAt.getTime()),
  )
}

function assertCatalogHasNoSemanticDrift(
  existing: ExistingCatalogRow,
  artifact: CatalogArtifact,
): 'update' | 'existing' {
  if (
    existing.version !== artifact.version ||
    existing.status !== 'published' ||
    existing.editRevision !== 0 ||
    sha256CanonicalJson(existing.content) !== artifact.contentHash ||
    existing.contentHash !== artifact.contentHash ||
    existing.validation?.contentHash !== artifact.contentHash ||
    (existing.validation?.errors?.length ?? 1) !== 0 ||
    existing.approval?.contentHash !== artifact.contentHash ||
    !providerSnapshotMatches(
      existing.providerVerification?.test,
      artifact.contentHash,
    ) ||
    !(existing.publishedAt instanceof Date) ||
    !Number.isFinite(existing.publishedAt.getTime())
  ) {
    fail('published_catalog_semantic_drift')
  }
  if (existing.effectiveAt === undefined) return 'update'
  if (
    !(existing.effectiveAt instanceof Date) ||
    !Number.isFinite(existing.effectiveAt.getTime()) ||
    existing.effectiveAt.getTime() !== artifact.effectiveAt.getTime()
  ) {
    fail('published_catalog_effective_at_drift')
  }
  return 'existing'
}

function billingConfigMatches(
  existing: ExistingBillingConfigRow,
  input: BootstrapInput,
  couponEnabled: boolean,
): boolean {
  const qaUserIds = (existing.qaUserIds ?? []).map((id) =>
    id.toString().toLowerCase(),
  )
  return (
    existing.sellingMode === 'qa' &&
    existing.enforcementMode === 'off' &&
    existing.couponMode === (couponEnabled ? 'qa' : 'off') &&
    qaUserIds.length === 1 &&
    qaUserIds[0] === input.qaUserId &&
    existing.newUserRolloutPercent === 0 &&
    existing.enforcementStartedAt === undefined &&
    existing.legacyGrandfatherEndsAt === undefined &&
    existing.activeCatalogVersion === input.catalogVersion &&
    existing.autoCouponRequired === true &&
    existing.webhookProcessingEnabled === false &&
    existing.reconciliationEnabled === false &&
    existing.rolloutPolicy === undefined
  )
}

function assertCampaignHasNoSemanticDrift(
  campaign: ExistingCouponCampaignRow,
): void {
  if (
    campaign.key !== COUPON_CAMPAIGN_KEY ||
    campaign.name !== COUPON_CAMPAIGN_NAME ||
    campaign.mode !== 'automatic' ||
    campaign.code !== undefined ||
    campaign.latestRevision !== 1
  ) {
    fail('coupon_campaign_semantic_drift')
  }
}

function assertCouponRevisionHasNoSemanticDrift(input: {
  revision: ExistingCouponRevisionRow
  campaign: ExistingCouponCampaignRow
  artifact: CouponArtifact
  catalog: CatalogArtifact
}): void {
  const validation = validateCouponCampaignPolicy(
    input.revision.terms,
    input.catalog.content,
    {
      campaignMode: 'automatic',
      providerMode: 'test',
      couponContentHash: input.revision.contentHash,
      catalogVersion: input.catalog.version,
      catalogContentHash: input.catalog.contentHash,
      policyApprovals: input.revision.policyApprovals,
      requireApprovals: true,
    },
  )
  const lifecycle = validateCouponLifecycleHistory({
    campaignId: input.campaign._id.toString(),
    revision: 1,
    value: input.revision.lifecycleHistory,
    terms: input.revision.terms,
    currentStatus: 'active',
  })
  if (
    input.revision.campaignId.toString() !==
      input.campaign._id.toString() ||
    input.revision.revision !== 1 ||
    input.revision.status !== 'active' ||
    input.revision.editRevision !== 0 ||
    sha256CanonicalJson(input.revision.terms) !== input.artifact.contentHash ||
    input.revision.contentHash !== input.artifact.contentHash ||
    input.revision.validation?.contentHash !== input.artifact.contentHash ||
    (input.revision.validation?.errors?.length ?? 1) !== 0 ||
    input.revision.validation.catalogVersion !== input.catalog.version ||
    input.revision.validation.catalogContentHash !==
      input.catalog.contentHash ||
    input.revision.validation.providerMode !== 'test' ||
    input.revision.approval?.contentHash !== input.artifact.contentHash ||
    !validation.valid ||
    validation.contentHash !== input.artifact.contentHash ||
    !providerSnapshotMatches(
      input.revision.providerVerification?.test,
      input.artifact.contentHash,
    ) ||
    input.revision.lifecycleClaim !== 'live' ||
    !lifecycle
  ) {
    fail('coupon_revision_semantic_drift')
  }
}

async function requireFounderUser(
  qaUserId: string,
  session?: ClientSession,
): Promise<void> {
  const user = await mongoose.connection.collection('users').findOne(
    {
      _id: new mongoose.Types.ObjectId(qaUserId),
      role: 'platform_admin',
    },
    {
      projection: { _id: 1 },
      ...(session ? { session } : {}),
    },
  )
  if (!user) fail('qa_platform_admin_user_not_found')
}

async function readCatalog(
  version: string,
  session?: ClientSession,
): Promise<ExistingCatalogRow | null> {
  return PlanCatalogVersion.findOne({ version })
    .session(session ?? null)
    .lean<ExistingCatalogRow>()
}

async function readConfig(
  session?: ClientSession,
): Promise<ExistingBillingConfigRow | null> {
  return BillingConfig.findOne({ key: 'singleton' })
    .session(session ?? null)
    .lean<ExistingBillingConfigRow>()
}

async function readCoupon(input: {
  session?: ClientSession
}): Promise<{
  campaign: ExistingCouponCampaignRow | null
  revision: ExistingCouponRevisionRow | null
}> {
  const campaign = await CouponCampaign.findOne({ key: COUPON_CAMPAIGN_KEY })
    .session(input.session ?? null)
    .lean<ExistingCouponCampaignRow>()
  if (!campaign) return { campaign: null, revision: null }
  const revision = await CouponCampaignRevision.findOne({
    campaignId: campaign._id,
    revision: 1,
  })
    .session(input.session ?? null)
    .lean<ExistingCouponRevisionRow>()
  return { campaign, revision }
}

async function inspectExistingState(input: {
  bootstrap: BootstrapInput
  catalog: CatalogArtifact
  coupon?: CouponArtifact
  session?: ClientSession
}): Promise<{
  catalog: WriteDisposition
  config: WriteDisposition
  coupon?: WriteDisposition
  couponCampaignId?: string
}> {
  await requireFounderUser(input.bootstrap.qaUserId, input.session)
  const [catalogRow, configRow] = await Promise.all([
    readCatalog(input.catalog.version, input.session),
    readConfig(input.session),
  ])
  const catalogDisposition = catalogRow
    ? assertCatalogHasNoSemanticDrift(catalogRow, input.catalog)
    : 'create'

  let couponDisposition: WriteDisposition | undefined
  let couponCampaignId: string | undefined
  if (input.coupon) {
    const stored = await readCoupon({ session: input.session })
    if (stored.campaign) {
      assertCampaignHasNoSemanticDrift(stored.campaign)
      if (!stored.revision) fail('coupon_revision_missing')
      assertCouponRevisionHasNoSemanticDrift({
        revision: stored.revision,
        campaign: stored.campaign,
        artifact: input.coupon,
        catalog: input.catalog,
      })
      couponDisposition = 'existing'
      couponCampaignId = stored.campaign._id.toString()
    } else if (stored.revision) {
      fail('orphan_coupon_revision')
    } else {
      couponDisposition = 'create'
    }
  }

  return {
    catalog: catalogDisposition,
    config: configRow
      ? billingConfigMatches(
          configRow,
          input.bootstrap,
          Boolean(input.coupon),
        )
        ? 'existing'
        : 'update'
      : 'create',
    ...(couponDisposition ? { coupon: couponDisposition } : {}),
    ...(couponCampaignId ? { couponCampaignId } : {}),
  }
}

async function createCatalog(input: {
  artifact: CatalogArtifact
  qaUserId: string
  session: ClientSession
  now: Date
}): Promise<void> {
  const actorId = new mongoose.Types.ObjectId(input.qaUserId)
  await PlanCatalogVersion.create([{
    _id: deterministicObjectId('test-catalog', input.artifact.version),
    version: input.artifact.version,
    status: 'published',
    editRevision: 0,
    effectiveAt: input.artifact.effectiveAt,
    content: input.artifact.content,
    contentHash: input.artifact.contentHash,
    validation: {
      contentHash: input.artifact.contentHash,
      errors: [],
      warnings: [
        'live Razorpay Plan bindings intentionally remain unconfigured',
      ],
      validatedBy: input.qaUserId,
      validatedAt: input.now,
    },
    approval: {
      contentHash: input.artifact.contentHash,
      approvedBy: input.qaUserId,
      approvedAt: input.now,
    },
    providerVerification: { test: input.artifact.verification },
    createdBy: actorId,
    publishedBy: actorId,
    changeReason: BOOTSTRAP_REASON,
    publishedAt: input.now,
  }], { session: input.session })
}

async function repairCatalogEffectiveAt(input: {
  artifact: CatalogArtifact
  session: ClientSession
}): Promise<void> {
  const existing = await readCatalog(input.artifact.version, input.session)
  if (
    !existing ||
    assertCatalogHasNoSemanticDrift(existing, input.artifact) !== 'update'
  ) {
    fail('catalog_effective_at_repair_precondition_failed')
  }
  const result = await PlanCatalogVersion.collection.updateOne(
    {
      _id: existing._id,
      version: input.artifact.version,
      status: 'published',
      editRevision: 0,
      contentHash: input.artifact.contentHash,
      effectiveAt: { $exists: false },
      'validation.contentHash': input.artifact.contentHash,
      'validation.errors': { $size: 0 },
      'approval.contentHash': input.artifact.contentHash,
      'providerVerification.test.status': 'verified',
      'providerVerification.test.normalizedTermsHash':
        input.artifact.contentHash,
      'providerVerification.test.errors': { $size: 0 },
    },
    { $set: { effectiveAt: input.artifact.effectiveAt } },
    { session: input.session },
  )
  if (result.matchedCount !== 1 || result.modifiedCount !== 1) {
    fail('catalog_effective_at_repair_conflict')
  }
}

async function createCoupon(input: {
  artifact: CouponArtifact
  qaUserId: string
  session: ClientSession
  now: Date
}): Promise<string> {
  const actorId = new mongoose.Types.ObjectId(input.qaUserId)
  const campaignId = deterministicObjectId(
    'test-coupon-campaign',
    COUPON_CAMPAIGN_KEY,
  )
  const revisionId = deterministicObjectId(
    'test-coupon-revision',
    `${campaignId.toString()}:1`,
  )
  const actor = {
    userId: input.qaUserId,
    email: 'bootstrap@invalid.local',
    role: 'platform_admin' as const,
  }
  const lifecycleHistory = [buildCouponLifecycleTransition({
    campaignId: campaignId.toString(),
    revision: 1,
    actor,
    mutationId: `bootstrap-${input.artifact.offerId}`,
    correlationId: `bootstrap-${input.artifact.offerId}`,
    reason: BOOTSTRAP_REASON,
    fromStatus: 'draft',
    toStatus: 'active',
    terms: input.artifact.terms,
    history: [],
    recordedAt: input.now,
  })]

  await CouponCampaign.create([{
    _id: campaignId,
    key: COUPON_CAMPAIGN_KEY,
    name: COUPON_CAMPAIGN_NAME,
    mode: 'automatic',
    latestRevision: 1,
    createdBy: actorId,
  }], { session: input.session })
  await CouponCampaignRevision.create([{
    _id: revisionId,
    campaignId,
    revision: 1,
    status: 'active',
    editRevision: 0,
    terms: input.artifact.terms,
    contentHash: input.artifact.contentHash,
    validation: input.artifact.validation,
    approval: {
      contentHash: input.artifact.contentHash,
      approvedBy: input.qaUserId,
      approvedAt: input.now,
    },
    policyApprovals: input.artifact.policyApprovals,
    providerVerification: { test: input.artifact.verification },
    lifecycleClaim: 'live',
    lifecycleHistory,
    createdBy: actorId,
    changeReason: BOOTSTRAP_REASON,
  }], { session: input.session })
  return campaignId.toString()
}

async function upsertConfig(input: {
  bootstrap: BootstrapInput
  couponEnabled: boolean
  session: ClientSession
}): Promise<void> {
  const existing = await readConfig(input.session)
  if (
    existing &&
    billingConfigMatches(existing, input.bootstrap, input.couponEnabled)
  ) return

  const actorId = new mongoose.Types.ObjectId(input.bootstrap.qaUserId)
  const exactConfiguration = {
    sellingMode: 'qa' as const,
    enforcementMode: 'off' as const,
    couponMode: input.couponEnabled ? 'qa' as const : 'off' as const,
    qaUserIds: [actorId],
    newUserRolloutPercent: 0,
    activeCatalogVersion: input.bootstrap.catalogVersion,
    autoCouponRequired: true,
    webhookProcessingEnabled: false,
    reconciliationEnabled: false,
    updatedBy: actorId,
  }
  if (!existing) {
    await BillingConfig.create([{
      _id: deterministicObjectId('billing-config', 'singleton'),
      key: 'singleton',
      revision: 1,
      ...exactConfiguration,
    }], { session: input.session })
    return
  }

  const updated = await BillingConfig.findOneAndUpdate(
    { key: 'singleton', revision: existing.revision },
    {
      $set: exactConfiguration,
      $unset: {
        enforcementStartedAt: 1,
        legacyGrandfatherEndsAt: 1,
        rolloutPolicy: 1,
      },
      $inc: { revision: 1 },
    },
    { new: true, runValidators: true, session: input.session },
  ).lean<ExistingBillingConfigRow>()
  if (
    !updated ||
    !billingConfigMatches(
      updated,
      input.bootstrap,
      input.couponEnabled,
    )
  ) {
    fail('billing_config_concurrent_change')
  }
}

async function applyBootstrap(input: {
  bootstrap: BootstrapInput
  catalog: CatalogArtifact
  coupon?: CouponArtifact
}): Promise<{
  catalog: WriteDisposition
  config: WriteDisposition
  coupon?: WriteDisposition
  couponCampaignId?: string
}> {
  // Fail on missing founder authority or semantic drift before even creating
  // anything. The transaction repeats the same checks to close the race.
  await inspectExistingState(input)

  const session = await mongoose.startSession()
  let outcome:
    | {
        catalog: WriteDisposition
        config: WriteDisposition
        coupon?: WriteDisposition
        couponCampaignId?: string
      }
    | undefined
  try {
    await session.withTransaction(async () => {
      const before = await inspectExistingState({
        ...input,
        session,
      })
      const now = new Date()
      if (before.catalog === 'create') {
        await createCatalog({
          artifact: input.catalog,
          qaUserId: input.bootstrap.qaUserId,
          session,
          now,
        })
      } else if (before.catalog === 'update') {
        await repairCatalogEffectiveAt({
          artifact: input.catalog,
          session,
        })
      }
      let couponCampaignId = before.couponCampaignId
      if (input.coupon && before.coupon === 'create') {
        couponCampaignId = await createCoupon({
          artifact: input.coupon,
          qaUserId: input.bootstrap.qaUserId,
          session,
          now,
        })
      }
      await upsertConfig({
        bootstrap: input.bootstrap,
        couponEnabled: Boolean(input.coupon),
        session,
      })
      outcome = {
        ...before,
        ...(couponCampaignId ? { couponCampaignId } : {}),
      }
    }, {
      readConcern: { level: 'snapshot' },
      writeConcern: { w: 'majority' },
      readPreference: 'primary',
    })
  } finally {
    await session.endSession()
  }
  if (!outcome) fail('transaction_did_not_commit')
  return outcome
}

function requestedMode(): 'dry_run' | 'apply' {
  const args = process.argv.slice(2)
  if (args.length === 0 || (args.length === 1 && args[0] === '--dry-run')) {
    return 'dry_run'
  }
  if (args.length === 1 && args[0] === '--apply') return 'apply'
  fail('invalid_arguments')
}

function outputSuccess(input: {
  mode: 'dry_run' | 'apply'
  catalogVersion: string
  outcome: {
    catalog: WriteDisposition
    config: WriteDisposition
    coupon?: WriteDisposition
    couponCampaignId?: string
  }
}): void {
  console.log(JSON.stringify({
    status: input.mode === 'apply' ? 'applied' : 'validated',
    catalog: {
      id: input.catalogVersion,
      status: input.outcome.catalog,
    },
    billingConfig: {
      id: 'singleton',
      status: input.outcome.config,
    },
    coupon: input.outcome.coupon
      ? {
          ...(input.outcome.couponCampaignId
            ? { id: input.outcome.couponCampaignId }
            : {}),
          status: input.outcome.coupon,
        }
      : { status: 'off' },
  }))
}

async function main(): Promise<void> {
  const mode = requestedMode()
  const bootstrap = loadInput()
  const localCatalog = buildCatalog(bootstrap)
  const verified = await verifyCatalog(bootstrap, localCatalog)
  const catalog: CatalogArtifact = {
    ...localCatalog,
    verification: verified.verification,
  }
  const coupon = await buildCouponArtifact({
    bootstrap,
    catalog,
    verifier: verified.verifier,
  })

  try {
    await mongoose.connect(bootstrap.mongoUri, {
      autoCreate: false,
      autoIndex: false,
      serverSelectionTimeoutMS: 10_000,
    })
  } catch {
    fail('database_connection_failed')
  }

  const outcome = mode === 'apply'
    ? await applyBootstrap({ bootstrap, catalog, coupon })
    : await inspectExistingState({ bootstrap, catalog, coupon })
  outputSuccess({
    mode,
    catalogVersion: catalog.version,
    outcome,
  })
}

main()
  .catch((error: unknown) => {
    console.log(JSON.stringify({
      status: 'failed',
      errorId: error instanceof BootstrapFailure
        ? error.errorId
        : 'unexpected_bootstrap_failure',
    }))
    process.exitCode = 1
  })
  .finally(async () => {
    if (mongoose.connection.readyState !== 0) {
      await mongoose.disconnect().catch(() => undefined)
    }
  })
