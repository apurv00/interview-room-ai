import { readPublicBillingCatalog } from '@customer-billing'
import { PublicBillingCatalogResponseSchema } from '@payments/validators/customerBillingResponses'
import { logger } from '@shared/logger'
import type { PublicBillingCatalog } from '@/app/_components/billing/billingClient'

export const HOMEPAGE_PRICING_CATALOG_TTL_MS = 30_000
export const HOMEPAGE_PRICING_CATALOG_READ_DEADLINE_MS = 2_000
export const HOMEPAGE_PRICING_CATALOG_FAILURE_COOLDOWN_MS = 1_000

interface HomepagePricingCatalogCacheEntry {
  readonly catalog: PublicBillingCatalog
  readonly expiresAt: number
}

export interface HomepagePricingCatalogDependencies {
  readonly now: () => number
  readonly readCatalog: () => Promise<unknown>
}

const homepagePricingLogger = logger.child({
  module: 'homepage-pricing-catalog',
})

const defaultDependencies: HomepagePricingCatalogDependencies = {
  now: Date.now,
  readCatalog: readPublicBillingCatalog,
}

let cachedCatalog: HomepagePricingCatalogCacheEntry | null = null
let catalogReadInFlight: Promise<PublicBillingCatalog | null> | null = null
let unavailableUntil = 0

function cloneCatalog(catalog: PublicBillingCatalog): PublicBillingCatalog {
  return PublicBillingCatalogResponseSchema.parse(catalog)
}

function startCatalogRead(
  dependencies: HomepagePricingCatalogDependencies,
): Promise<PublicBillingCatalog | null> {
  const request = (async () => {
    try {
      const catalog = PublicBillingCatalogResponseSchema.parse(
        await dependencies.readCatalog(),
      )
      cachedCatalog = {
        catalog,
        expiresAt: dependencies.now() + HOMEPAGE_PRICING_CATALOG_TTL_MS,
      }
      unavailableUntil = 0
      return catalog
    } catch (error) {
      unavailableUntil = dependencies.now()
        + HOMEPAGE_PRICING_CATALOG_FAILURE_COOLDOWN_MS
      homepagePricingLogger.warn(
        {
          errorName: error instanceof Error ? error.name : 'UnknownError',
        },
        'Homepage pricing catalog refresh failed',
      )
      return null
    }
  })()

  catalogReadInFlight = request
  void request.finally(() => {
    if (catalogReadInFlight === request) catalogReadInFlight = null
  })
  return request
}

async function waitForCatalogRead(
  request: Promise<PublicBillingCatalog | null>,
): Promise<PublicBillingCatalog | null> {
  let deadline: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      request,
      new Promise<null>((resolve) => {
        deadline = setTimeout(
          () => resolve(null),
          HOMEPAGE_PRICING_CATALOG_READ_DEADLINE_MS,
        )
      }),
    ])
  } finally {
    if (deadline) clearTimeout(deadline)
  }
}

export async function readHomepagePricingCatalogSnapshot(
  dependencies: HomepagePricingCatalogDependencies = defaultDependencies,
): Promise<PublicBillingCatalog | null> {
  const now = dependencies.now()
  if (cachedCatalog && cachedCatalog.expiresAt > now) {
    return cloneCatalog(cachedCatalog.catalog)
  }
  cachedCatalog = null
  if (!catalogReadInFlight && unavailableUntil > now) return null

  const catalog = await waitForCatalogRead(
    catalogReadInFlight ?? startCatalogRead(dependencies),
  )
  return catalog ? cloneCatalog(catalog) : null
}

/** Test-only reset for the process-local homepage cache. */
export function _resetHomepagePricingCatalogCache() {
  cachedCatalog = null
  catalogReadInFlight = null
  unavailableUntil = 0
}
