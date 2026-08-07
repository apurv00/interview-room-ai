import type {
  BillingRolloutAuthorityDecision,
  BillingRolloutSku,
} from '@modules/payment-rollout-control'
import {
  composeBillingCommercialSurfaceAuthority,
} from '@modules/payment-rollout-consumption'
import {
  PR6_CUSTOMER_BILLING_UI_READY,
} from '@shared/services/planConfig'

const OBJECT_ID = /^[a-f0-9]{24}$/
const REQUIRED_PRICING_SKUS: readonly BillingRolloutSku[] =
  Object.freeze([
    'additional_interview',
    'plus_subscription',
    'premium_resume_unlock',
    'pro_subscription',
  ])

interface PricingRolloutSubject {
  readonly createdAt?: Date
  readonly buyerState?: string
}

export interface PricingRolloutCompositionDependencies {
  readonly billingUiReady: boolean
  readonly readSessionUserId: () => Promise<string | null>
  readonly loadSubject: (
    userId: string,
  ) => Promise<PricingRolloutSubject | null>
  readonly readCatalogVersion: (
    now: Date,
  ) => Promise<string>
  readonly readDecision: (input: {
    readonly userId: string
    readonly userCreatedAt?: Date
    readonly buyerState?: string
    readonly now: Date
  }) => Promise<BillingRolloutAuthorityDecision>
  readonly now: () => Date
}

function exactTreatmentDecision(input: {
  readonly decision: BillingRolloutAuthorityDecision
  readonly catalogVersion: string
  readonly now: Date
}): boolean {
  return composeBillingCommercialSurfaceAuthority({
    decision: input.decision,
    catalogVersion: input.catalogVersion,
    requiredSkuScope: REQUIRED_PRICING_SKUS,
    boundAt: input.now,
  }) !== null
}

export async function resolvePricingRolloutExperience(
  dependencies: PricingRolloutCompositionDependencies,
): Promise<boolean> {
  if (!dependencies.billingUiReady) return false

  try {
    const userId =
      (await dependencies.readSessionUserId())?.toLowerCase()
    if (!userId || !OBJECT_ID.test(userId)) return false
    const subject = await dependencies.loadSubject(userId)
    if (
      !subject ||
      !(subject.createdAt instanceof Date) ||
      !Number.isFinite(subject.createdAt.getTime())
    ) return false
    const now = dependencies.now()
    if (!Number.isFinite(now.getTime())) return false
    const [catalogVersion, decision] = await Promise.all([
      dependencies.readCatalogVersion(now),
      dependencies.readDecision({
        userId,
        userCreatedAt: subject.createdAt,
        buyerState: subject.buyerState,
        now,
      }),
    ])
    return exactTreatmentDecision({
      decision,
      catalogVersion,
      now,
    })
  } catch {
    return false
  }
}

const productionDependencies:
PricingRolloutCompositionDependencies = Object.freeze({
  billingUiReady: PR6_CUSTOMER_BILLING_UI_READY,
  async readSessionUserId() {
    const [
      { getServerSession },
      { authOptions },
    ] = await Promise.all([
      import('next-auth'),
      import('@shared/auth/authOptions'),
    ])
    const session = await getServerSession(authOptions)
    return session?.user?.id ?? null
  },
  async loadSubject(userId: string) {
    const [
      { connectDB },
      { User },
    ] = await Promise.all([
      import('@shared/db/connection'),
      import('@shared/db/models'),
    ])
    await connectDB()
    const row = await User.findById(userId)
      .select('createdAt buyerState')
      .lean<{
        readonly createdAt?: Date
        readonly buyerState?: string
      }>()
      .exec()
    return row
      ? Object.freeze({
          createdAt: row.createdAt,
          buyerState: row.buyerState,
        })
      : null
  },
  async readCatalogVersion(now: Date) {
    const { readPublicBillingCatalog } =
      await import('@customer-billing')
    return (await readPublicBillingCatalog(now)).catalogVersion
  },
  async readDecision(
    input: Parameters<
      PricingRolloutCompositionDependencies[
        'readDecision'
      ]
    >[0],
  ) {
    const { readProductionBillingRolloutDecision } =
      await import('@modules/payment-rollout-runtime')
    return readProductionBillingRolloutDecision(input)
  },
  now: () => new Date(),
})

export async function resolveProductionPricingRolloutExperience():
Promise<boolean> {
  if (!PR6_CUSTOMER_BILLING_UI_READY) return false

  try {
    const [sessionUserId, { getBillingConfig }, paymentGate] =
      await Promise.all([
        productionDependencies.readSessionUserId(),
        import('@payments/services/billingConfigService'),
        import('@payments/services/paymentRuntimeGate'),
      ])
    const config = await getBillingConfig()
    const userId = sessionUserId?.toLowerCase() ??
      (
        config.sellingMode === 'qa'
          ? config.qaUserIds.find((candidate) => OBJECT_ID.test(candidate))
          : '0'.repeat(24)
      )
    if (!userId || !OBJECT_ID.test(userId)) return false
    const sale = paymentGate.evaluatePaymentSaleGate(
      config,
      userId,
    )
    if (!sale.allowed) return false
    await productionDependencies.readCatalogVersion(
      productionDependencies.now(),
    )
    return true
  } catch {
    return false
  }
}
