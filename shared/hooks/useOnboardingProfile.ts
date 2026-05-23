'use client'

import { useEffect, useState } from 'react'
import { useSession } from 'next-auth/react'
import { deduplicatedFetchJSON } from '@shared/cachedFetch'

/**
 * Cached /api/onboarding fetch with in-flight dedup + short TTL value
 * cache, scoped per authenticated user.
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
 *
 * Codex P1 (PR #402): the cache used to be module-scoped (one
 * `cached: CacheEntry | null`), so a sign-out + sign-in inside the
 * 30s TTL would hand the new user the previous user's profile —
 * personalized recommendations driven from the wrong account. The
 * cache is now keyed by `session.user.id`, so each user gets their
 * own slot and an auth transition cannot re-use stale data.
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

// Per-user cache. Keyed by `session.user.id` so a different user signing
// in inside the TTL window never observes the previous user's profile.
const CACHE_TTL_MS = 30_000
const cache = new Map<string, CacheEntry>()

function readCache(userId: string | null | undefined):
  | { hit: true; value: OnboardingProfile | null }
  | { hit: false } {
  if (!userId) return { hit: false }
  const entry = cache.get(userId)
  if (!entry || entry.expires <= Date.now()) {
    if (entry) cache.delete(userId) // evict expired entry
    return { hit: false }
  }
  return { hit: true, value: entry.value }
}

function writeCache(userId: string, value: OnboardingProfile | null) {
  cache.set(userId, { value, expires: Date.now() + CACHE_TTL_MS })
}

export type OnboardingStatus = 'loading' | 'anonymous' | 'ready' | 'error'

export interface OnboardingHookValue {
  status: OnboardingStatus
  profile: OnboardingProfile | null
}

/** Test-only escape hatch — wipes every per-user cache slot. */
export function _resetOnboardingProfileCache() {
  cache.clear()
}

// Augmented session shape: NextAuth's default session.user has no `id`
// field, but this app's authOptions.ts populates one (see
// shared/auth/next-auth.d.ts). Narrow the type locally to avoid a
// dependency on the shared callback's module-augmented `next-auth`
// types in test environments.
interface SessionWithUserId {
  user?: { id?: string }
}

export function useOnboardingProfile(): OnboardingHookValue {
  const { status: authStatus, data } = useSession()
  const session = data as SessionWithUserId | null
  const userId = session?.user?.id

  const [value, setValue] = useState<OnboardingHookValue>(() => {
    // Hydrate immediately from cache only when we already know who is
    // signed in. Without a stable `userId`, we cannot prove the cache
    // entry belongs to this caller — start in 'loading' instead.
    const initial = readCache(userId)
    if (initial.hit) {
      return { status: 'ready', profile: initial.value }
    }
    return { status: 'loading', profile: null }
  })

  useEffect(() => {
    if (authStatus === 'loading') return
    if (authStatus === 'unauthenticated') {
      setValue({ status: 'anonymous', profile: null })
      return
    }
    if (!userId) {
      // Authenticated but no user id surfaced (theoretical; the app's
      // authOptions always populates it). Fall through to 'loading'
      // rather than risk a cross-user cache read.
      return
    }
    const cached = readCache(userId)
    if (cached.hit) {
      setValue({ status: 'ready', profile: cached.value })
      return
    }

    // PR #402 follow-up: cache miss for a NEW userId. Reset to
    // loading + null profile before the fetch fires so the previous
    // user's profile is not briefly visible during the in-tab
    // account switch. We only do this on a miss (the hit branch
    // already overwrote the state above), and we skip the noop when
    // the state is already in the right shape — saves a render on
    // the first mount of an authenticated user.
    setValue((prev) => {
      if (prev.status === 'loading' && prev.profile === null) return prev
      return { status: 'loading', profile: null }
    })

    let cancelled = false
    // Codex P1 (PR #402): pass a userId-discriminated cache key so the
    // shared in-flight map cannot fan A's in-flight pathway/onboarding
    // call out to B's mount during a tab account-switch.
    deduplicatedFetchJSON<OnboardingProfile>(
      '/api/onboarding',
      undefined,
      `/api/onboarding#${userId}`,
    )
      .then((data) => {
        if (cancelled) return
        writeCache(userId, data)
        setValue({ status: 'ready', profile: data })
      })
      .catch(() => {
        if (cancelled) return
        setValue({ status: 'error', profile: null })
      })
    return () => {
      cancelled = true
    }
  }, [authStatus, userId])

  return value
}
