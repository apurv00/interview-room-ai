'use client'

import { useEffect, useState } from 'react'
import { useSession } from 'next-auth/react'
import { deduplicatedFetchJSON } from '@shared/cachedFetch'

/**
 * Cached /api/onboarding fetch with in-flight dedup + short TTL value
 * cache.
 *
 * Wave 3 / UAT-014: the interview setup page mounts InterviewSetupForm
 * AND ResourceLinks. Each had its own useEffect that hit
 * /api/onboarding, so a single page load produced two near-identical
 * GETs. `deduplicatedFetch` alone covers the case where both fire in
 * the same tick, but ResourceLinks lazy-fetches after status settles
 * and the form's fetch already resolved — so the in-flight map is
 * empty by the time the second consumer asks.
 *
 * This hook adds a small client-side value cache (default 30s) on top
 * of the in-flight dedup. Intentionally NOT generic — keeping this
 * scoped means we don't pull in SWR / React Query for a single
 * endpoint.
 */

export interface OnboardingProfile {
  targetRole?: string
  experienceLevel?: string
  interviewGoal?: string
  weakAreas?: string[]
  industry?: string
  linkedinUrl?: string
  // Any other fields the API returns flow through verbatim.
  [key: string]: unknown
}

type CacheEntry = { value: OnboardingProfile | null; expires: number }

// Module-level cache shared across every component that calls the hook.
const CACHE_TTL_MS = 30_000
let cached: CacheEntry | null = null

export type OnboardingStatus = 'loading' | 'anonymous' | 'ready' | 'error'

export interface OnboardingHookValue {
  status: OnboardingStatus
  profile: OnboardingProfile | null
}

/** Test-only escape hatch — wipes the module-level cache. */
export function _resetOnboardingProfileCache() {
  cached = null
}

export function useOnboardingProfile(): OnboardingHookValue {
  const { status: authStatus } = useSession()
  const [value, setValue] = useState<OnboardingHookValue>(() => {
    // Hydrate immediately from the cache if it's still valid — avoids
    // even the brief loading flash for the second consumer.
    if (cached && cached.expires > Date.now()) {
      return { status: 'ready', profile: cached.value }
    }
    return { status: 'loading', profile: null }
  })

  useEffect(() => {
    if (authStatus === 'loading') return
    if (authStatus === 'unauthenticated') {
      setValue({ status: 'anonymous', profile: null })
      return
    }
    if (cached && cached.expires > Date.now()) {
      setValue({ status: 'ready', profile: cached.value })
      return
    }
    let cancelled = false
    deduplicatedFetchJSON<OnboardingProfile>('/api/onboarding')
      .then((data) => {
        if (cancelled) return
        cached = { value: data, expires: Date.now() + CACHE_TTL_MS }
        setValue({ status: 'ready', profile: data })
      })
      .catch(() => {
        if (cancelled) return
        setValue({ status: 'error', profile: null })
      })
    return () => {
      cancelled = true
    }
  }, [authStatus])

  return value
}
