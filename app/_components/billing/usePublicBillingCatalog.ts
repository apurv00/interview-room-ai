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

export function usePublicBillingCatalog(): PublicBillingCatalogState {
  const [catalog, setCatalog] = useState<PublicBillingCatalog | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [requestVersion, setRequestVersion] = useState(0)
  const mounted = useRef(true)

  const reload = useCallback(() => {
    setRequestVersion((version) => version + 1)
  }, [])

  useEffect(() => {
    mounted.current = true
    const controller = new AbortController()
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
        if (mounted.current) setCatalog(nextCatalog)
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted || !mounted.current) return
        setCatalog(null)
        setError(
          cause instanceof BillingClientError
            ? cause.message
            : 'Pricing is temporarily unavailable.',
        )
      })
      .finally(() => {
        if (mounted.current && !controller.signal.aborted) {
          setLoading(false)
        }
      })

    return () => {
      mounted.current = false
      controller.abort()
    }
  }, [requestVersion])

  return { catalog, error, loading, reload }
}
