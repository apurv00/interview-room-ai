'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  billingResponseSchemas,
  BillingClientError,
  parseBillingResponse,
  type PublicBillingCatalog,
} from './billingClient'
import { billingFetch } from './billingRequestTimeout'

interface PublicBillingCatalogState {
  catalog: PublicBillingCatalog | null
  error: string | null
  loading: boolean
  reload: () => void
}

export interface PublicBillingCatalogOptions {
  readonly cachePolicy?: 'none' | 'homepage-memory'
}

interface HomepageCatalogCacheEntry {
  readonly catalog: PublicBillingCatalog
  readonly expiresAt: number
}

export const HOMEPAGE_CATALOG_CACHE_TTL_MS = 30_000

let homepageCatalogCache: HomepageCatalogCacheEntry | null = null

function clearHomepageCatalogCache() {
  homepageCatalogCache = null
}

function readHomepageCatalogCache(): HomepageCatalogCacheEntry | null {
  const entry = homepageCatalogCache
  if (!entry || entry.expiresAt <= Date.now()) {
    clearHomepageCatalogCache()
    return null
  }
  const parsed = billingResponseSchemas.catalog.safeParse(entry.catalog)
  if (!parsed.success) {
    clearHomepageCatalogCache()
    return null
  }
  return {
    catalog: parsed.data,
    expiresAt: entry.expiresAt,
  }
}

function writeHomepageCatalogCache(
  catalog: PublicBillingCatalog,
): HomepageCatalogCacheEntry {
  const entry = {
    catalog: billingResponseSchemas.catalog.parse(catalog),
    expiresAt: Date.now() + HOMEPAGE_CATALOG_CACHE_TTL_MS,
  }
  homepageCatalogCache = entry
  return entry
}

/** Test-only escape hatch for the module-level public catalog cache. */
export function _resetPublicBillingCatalogCache() {
  clearHomepageCatalogCache()
}

export function usePublicBillingCatalog(
  options: PublicBillingCatalogOptions = {},
): PublicBillingCatalogState {
  const useHomepageCache = options.cachePolicy === 'homepage-memory'
  const [initialCache] = useState(() => (
    useHomepageCache ? readHomepageCatalogCache() : null
  ))
  const [catalog, setCatalog] = useState<PublicBillingCatalog | null>(
    initialCache?.catalog ?? null,
  )
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(!initialCache)
  const [cacheExpiresAt, setCacheExpiresAt] = useState<number | null>(
    initialCache?.expiresAt ?? null,
  )
  const [requestVersion, setRequestVersion] = useState(0)
  const mounted = useRef(true)
  const activeRequest = useRef(0)

  const reload = useCallback(() => {
    activeRequest.current += 1
    if (useHomepageCache) clearHomepageCatalogCache()
    setCatalog(null)
    setError(null)
    setLoading(true)
    setCacheExpiresAt(null)
    setRequestVersion((version) => version + 1)
  }, [useHomepageCache])

  useEffect(() => {
    mounted.current = true
    if (useHomepageCache && requestVersion === 0) {
      const cached = readHomepageCatalogCache()
      if (cached) {
        setCatalog(cached.catalog)
        setError(null)
        setLoading(false)
        setCacheExpiresAt(cached.expiresAt)

        return () => {
          mounted.current = false
        }
      }
    }

    const controller = new AbortController()
    const requestId = ++activeRequest.current
    const requestIsCurrent = () => (
      mounted.current &&
      !controller.signal.aborted &&
      activeRequest.current === requestId
    )
    if (useHomepageCache) setCatalog(null)
    setLoading(true)
    setError(null)

    void billingFetch('/api/billing/catalog', {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    })
      .then((response) => parseBillingResponse(
        response,
        billingResponseSchemas.catalog,
        'Pricing is temporarily unavailable.',
      ))
      .then((nextCatalog) => {
        if (!requestIsCurrent()) return
        if (useHomepageCache) {
          const entry = writeHomepageCatalogCache(nextCatalog)
          setCacheExpiresAt(entry.expiresAt)
        }
        setCatalog(nextCatalog)
      })
      .catch((cause: unknown) => {
        if (!requestIsCurrent()) return
        setCacheExpiresAt(null)
        setCatalog(null)
        setError(
          cause instanceof BillingClientError
            ? cause.message
            : 'Pricing is temporarily unavailable.',
        )
      })
      .finally(() => {
        if (requestIsCurrent()) setLoading(false)
      })

    return () => {
      mounted.current = false
      controller.abort()
    }
  }, [requestVersion, useHomepageCache])

  useEffect(() => {
    if (!useHomepageCache || cacheExpiresAt === null) return

    let refreshStarted = false
    const refreshIfExpired = () => {
      if (refreshStarted || Date.now() < cacheExpiresAt) return
      refreshStarted = true
      activeRequest.current += 1
      clearHomepageCatalogCache()
      setCacheExpiresAt(null)
      setCatalog(null)
      setError(null)
      setLoading(true)
      setRequestVersion((version) => version + 1)
    }
    const refreshWhenVisible = () => {
      if (document.visibilityState === 'visible') refreshIfExpired()
    }
    window.addEventListener('online', refreshWhenVisible)
    window.addEventListener('pageshow', refreshWhenVisible)
    document.addEventListener('visibilitychange', refreshWhenVisible)

    return () => {
      window.removeEventListener('online', refreshWhenVisible)
      window.removeEventListener('pageshow', refreshWhenVisible)
      document.removeEventListener('visibilitychange', refreshWhenVisible)
    }
  }, [cacheExpiresAt, useHomepageCache])

  return { catalog, error, loading, reload }
}
