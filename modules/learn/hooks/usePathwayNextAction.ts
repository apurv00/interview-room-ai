'use client'

import { useEffect, useState } from 'react'
import { useSession } from 'next-auth/react'
import { deduplicatedFetchJSON } from '@shared/cachedFetch'

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
  const { status: authStatus } = useSession()
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
    let cancelled = false
    deduplicatedFetchJSON<PathwayApiResponse>('/api/learn/pathway')
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
  }, [authStatus])

  return value
}
