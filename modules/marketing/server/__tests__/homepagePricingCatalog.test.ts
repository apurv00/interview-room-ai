import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PublicBillingCatalogResponseSchema } from '@payments/validators/customerBillingResponses'
import { CONSUMER_CATALOG_V1 } from '@shared/services/planConfig'

const mocks = vi.hoisted(() => ({
  warn: vi.fn(),
}))

vi.mock('@customer-billing', () => ({
  readPublicBillingCatalog: vi.fn(),
}))

vi.mock('@shared/logger', () => ({
  logger: {
    child: () => ({ warn: mocks.warn }),
  },
}))

import {
  HOMEPAGE_PRICING_CATALOG_FAILURE_COOLDOWN_MS,
  HOMEPAGE_PRICING_CATALOG_READ_DEADLINE_MS,
  HOMEPAGE_PRICING_CATALOG_TTL_MS,
  _resetHomepagePricingCatalogCache,
  readHomepagePricingCatalogSnapshot,
} from '../homepagePricingCatalog'

const catalogV1 = PublicBillingCatalogResponseSchema.parse({
  ...CONSUMER_CATALOG_V1,
  catalogVersion: 'homepage-server-cache-v1',
  effectiveAt: '2026-08-22T00:00:00.000Z',
  customerBillingUiReady: true,
  checkoutRequiresAuthentication: true,
})

const catalogV2 = {
  ...catalogV1,
  catalogVersion: 'homepage-server-cache-v2',
}

beforeEach(() => {
  _resetHomepagePricingCatalogCache()
  mocks.warn.mockReset()
  vi.useRealTimers()
})

describe('homepage pricing server cache', () => {
  it('collapses concurrent cold reads and isolates returned snapshots', async () => {
    let resolveCatalog: ((value: unknown) => void) | undefined
    const readCatalog = vi.fn(() => new Promise<unknown>((resolve) => {
      resolveCatalog = resolve
    }))
    const dependencies = { now: () => 1_000, readCatalog }

    const first = readHomepagePricingCatalogSnapshot(dependencies)
    const second = readHomepagePricingCatalogSnapshot(dependencies)
    expect(readCatalog).toHaveBeenCalledTimes(1)

    resolveCatalog?.(catalogV1)
    const [firstResult, secondResult] = await Promise.all([first, second])

    expect(firstResult?.catalogVersion).toBe('homepage-server-cache-v1')
    expect(secondResult?.catalogVersion).toBe('homepage-server-cache-v1')
    expect(firstResult).not.toBe(secondResult)
    expect(firstResult?.plans).not.toBe(secondResult?.plans)
  })

  it('reuses a success only until the hard TTL expires', async () => {
    let now = 2_000
    const readCatalog = vi.fn()
      .mockResolvedValueOnce(catalogV1)
      .mockResolvedValueOnce(catalogV2)
    const dependencies = { now: () => now, readCatalog }

    expect((await readHomepagePricingCatalogSnapshot(dependencies))
      ?.catalogVersion).toBe('homepage-server-cache-v1')

    now += HOMEPAGE_PRICING_CATALOG_TTL_MS - 1
    expect((await readHomepagePricingCatalogSnapshot(dependencies))
      ?.catalogVersion).toBe('homepage-server-cache-v1')
    expect(readCatalog).toHaveBeenCalledTimes(1)

    now += 1
    expect((await readHomepagePricingCatalogSnapshot(dependencies))
      ?.catalogVersion).toBe('homepage-server-cache-v2')
    expect(readCatalog).toHaveBeenCalledTimes(2)
  })

  it('never serves an expired catalog when its foreground refresh fails', async () => {
    let now = 3_000
    const readCatalog = vi.fn()
      .mockResolvedValueOnce(catalogV1)
      .mockRejectedValueOnce(new Error('database unavailable'))
      .mockResolvedValueOnce(catalogV2)
    const dependencies = { now: () => now, readCatalog }

    expect((await readHomepagePricingCatalogSnapshot(dependencies))
      ?.catalogVersion).toBe('homepage-server-cache-v1')

    now += HOMEPAGE_PRICING_CATALOG_TTL_MS
    expect(await readHomepagePricingCatalogSnapshot(dependencies)).toBeNull()
    expect(mocks.warn).toHaveBeenCalledTimes(1)

    now += HOMEPAGE_PRICING_CATALOG_FAILURE_COOLDOWN_MS
    expect((await readHomepagePricingCatalogSnapshot(dependencies))
      ?.catalogVersion).toBe('homepage-server-cache-v2')
    expect(readCatalog).toHaveBeenCalledTimes(3)
  })

  it('does not cache a malformed public catalog response', async () => {
    let now = 4_000
    const readCatalog = vi.fn()
      .mockResolvedValueOnce({ catalogVersion: 'malformed' })
      .mockResolvedValueOnce(catalogV1)
    const dependencies = { now: () => now, readCatalog }

    expect(await readHomepagePricingCatalogSnapshot(dependencies)).toBeNull()
    expect(await readHomepagePricingCatalogSnapshot(dependencies)).toBeNull()
    expect(readCatalog).toHaveBeenCalledTimes(1)

    now += HOMEPAGE_PRICING_CATALOG_FAILURE_COOLDOWN_MS
    expect((await readHomepagePricingCatalogSnapshot(dependencies))
      ?.catalogVersion).toBe('homepage-server-cache-v1')
    expect(readCatalog).toHaveBeenCalledTimes(2)
  })

  it('bounds a cold read without cancelling its eventual cache warm-up', async () => {
    vi.useFakeTimers()
    let resolveCatalog: ((value: unknown) => void) | undefined
    const readCatalog = vi.fn(() => new Promise<unknown>((resolve) => {
      resolveCatalog = resolve
    }))
    const dependencies = { now: () => 5_000, readCatalog }

    const first = readHomepagePricingCatalogSnapshot(dependencies)
    await vi.advanceTimersByTimeAsync(
      HOMEPAGE_PRICING_CATALOG_READ_DEADLINE_MS,
    )
    await expect(first).resolves.toBeNull()
    expect(readCatalog).toHaveBeenCalledTimes(1)

    resolveCatalog?.(catalogV1)
    await vi.runAllTimersAsync()

    await expect(readHomepagePricingCatalogSnapshot(dependencies))
      .resolves.toMatchObject({
        catalogVersion: 'homepage-server-cache-v1',
      })
    expect(readCatalog).toHaveBeenCalledTimes(1)
  })
})
