'use client'

import { useEffect, useState } from 'react'
import { useSession } from 'next-auth/react'
import { deduplicatedFetchJSON } from '@shared/cachedFetch'

// Augmented session shape — NextAuth's default doesn't include user.id
// but authOptions.ts populates it (see shared/auth/next-auth.d.ts).
// Narrowing locally avoids a hard dep on the module-augmented type in
// test environments.
interface SessionWithUserId {
  user?: { id?: string }
}

/**
 * Shared pathway-status hook.
 *
 * Wave 3 / UAT-021: PathwayStatusBanner (above the marketing hero) and
 * the signed-in MarketingHomepage CTA both want the same pathway
 * `nextAction`. Previously the banner fetched `/api/learn/pathway`
 * inline and the hero CTA hardcoded "Take Your First Interview" →
 * `/interview/setup`, so the banner could say "Continue Lesson 2"
 * while the CTA shipped you to setup.
 *
 * This hook returns the response once, sharing the in-flight network
 * request between both consumers (deduplicatedFetch). Anonymous
 * visitors get `status: 'anonymous'` and no fetch fires — the
 * marketing hero falls back to its auth-gated default behavior.
 */

export interface PathwayBannerAction {
  title: string
  ctaLabel: string
  href?: string
}

interface PathwayBannerPayload {
  readinessScore: number
  readinessLevel: string
  nextSessionRecommendation?: {
    reason?: string
    focusCompetencies?: string[]
  } | null
  practiceTasks?: Array<{ title: string; completed: boolean }>
}

export type PathwayApiState =
  | 'empty'
  | 'active'
  | 'completed'
  | 'pending'
  | 'abandoned'
  | 'returning'

interface PathwayApiResponse {
  state?: PathwayApiState
  nextAction?: PathwayBannerAction
  pathway?: PathwayBannerPayload | null
}

export type PathwayHookStatus = 'loading' | 'anonymous' | 'ready' | 'error'

export interface PathwayHookValue {
  status: PathwayHookStatus
  state?: PathwayApiState
  nextAction: PathwayBannerAction | null
  pathway: PathwayBannerPayload | null
}

export function usePathwayNextAction(): PathwayHookValue {
  const { status: authStatus, data } = useSession()
  const session = data as SessionWithUserId | null
  const userId = session?.user?.id
  const [value, setValue] = useState<PathwayHookValue>({
    status: 'loading',
    nextAction: null,
    pathway: null,
  })

  useEffect(() => {
    if (authStatus === 'loading') return
    if (authStatus === 'unauthenticated') {
      setValue({ status: 'anonymous', nextAction: null, pathway: null })
      return
    }
    if (!userId) {
      // Authenticated but no userId surfaced yet — wait. Without a
      // stable discriminator we can't safely share the in-flight
      // promise with other concurrent mounts (Codex P1 on PR #402).
      return
    }
    let cancelled = false
    // Codex P1 (PR #402): cache key includes the userId so a tab
    // account-switch mid-flight cannot fan A's pending pathway promise
    // out to B's mount.
    deduplicatedFetchJSON<PathwayApiResponse>(
      '/api/learn/pathway',
      undefined,
      `/api/learn/pathway#${userId}`,
    )
      .then((data) => {
        if (cancelled) return
        setValue({
          status: 'ready',
          state: data?.state,
          nextAction: data?.nextAction ?? null,
          pathway: data?.pathway ?? null,
        })
      })
      .catch(() => {
        if (cancelled) return
        setValue({ status: 'error', nextAction: null, pathway: null })
      })
    return () => {
      cancelled = true
    }
  }, [authStatus, userId])

  return value
}
