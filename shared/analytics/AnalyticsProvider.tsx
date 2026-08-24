'use client'

/**
 * AnalyticsProvider — owns the three "always-on" client-side analytics
 * concerns:
 *
 *   1. **Pageview** — fires `track('page_view')` on every client-side
 *      route change (including the initial render). The GA loader is
 *      configured with `send_page_view: false`, so this is the *only*
 *      pageview signal reaching GA. PostHog (capture-endpoint flavour)
 *      doesn't auto-generate pageviews either, so this also feeds it.
 *      Admin-route filtering for GA happens inside `track()` →
 *      `dispatchToGa()`.
 *
 *   2. **Identify** — when an authenticated `useSession()` lands, calls
 *      `identify(userId, traits)` once per session.user.id. Idempotent
 *      across re-renders. Sends only the non-PII subset of `session.user`
 *      (see `UserTraits` in `./events.ts`). Email / name / image NEVER
 *      reach analytics.
 *
 *   3. **signin_succeeded** — fires exactly once on the
 *      unauthenticated → authenticated transition. NOT fired on a page
 *      reload of an already-authenticated session (no transition). The
 *      `had_prior_session` flag distinguishes a returning user signing
 *      in again (their previous user_id is still in localStorage from
 *      a prior identify) from a clean first-time signup signin.
 *
 * Mount inside `<SessionProvider>` so `useSession()` works. The provider
 * renders only `{children}` — it has no UI of its own.
 */

import { useEffect, useRef } from 'react'
import { usePathname } from 'next/navigation'
import { useSession } from 'next-auth/react'
import { track, identify, redactSecretPathSegments } from './track'

const DISTINCT_ID_KEY = 'ipg_distinct_id'

function readPriorDistinctId(): string | null {
  if (typeof window === 'undefined') return null
  try {
    return window.localStorage.getItem(DISTINCT_ID_KEY)
  } catch {
    return null
  }
}

export function AnalyticsProvider({ children }: { children: React.ReactNode }) {
  const { data: session, status } = useSession()
  const pathname = usePathname()
  const lastIdentifiedUserIdRef = useRef<string | null>(null)
  const previousStatusRef = useRef<typeof status>('loading')

  // ── 1. Pageview on every route change (incl. initial render) ────────
  useEffect(() => {
    if (!pathname) return
    track('page_view', { pathname: redactSecretPathSegments(pathname) })
  }, [pathname])

  // ── 2. Identify once per user.id; ──────────────────────────────────
  // ── 3. Fire signin_succeeded on unauth → auth transition. ──────────
  useEffect(() => {
    if (status !== 'authenticated' || !session?.user?.id) {
      if (status === 'unauthenticated') {
        lastIdentifiedUserIdRef.current = null
      }
      previousStatusRef.current = status
      return
    }

    const userId = session.user.id

    // Determine "transition" vs "page reload of authed session".
    // The first useEffect run after the session loads will see
    // previousStatus === 'loading' (initial ref value); anything else
    // came from a status change.
    const wasUnauthenticated = previousStatusRef.current === 'unauthenticated'

    if (lastIdentifiedUserIdRef.current !== userId) {
      const priorDistinctId = readPriorDistinctId()
      const had_prior_session =
        priorDistinctId !== null && !priorDistinctId.startsWith('anon_')
      const persistentRole =
        session.user.role === 'candidate' ||
        session.user.role === 'platform_admin'
          ? session.user.role
          : undefined

      identify(userId, {
        plan: session.user.plan as 'free' | 'pro' | 'enterprise' | undefined,
        ...(persistentRole === undefined ? {} : { role: persistentRole }),
        organizationId: session.user.organizationId,
      })
      lastIdentifiedUserIdRef.current = userId

      if (wasUnauthenticated) {
        track('signin_succeeded', { had_prior_session })
      }
    }

    previousStatusRef.current = status
  }, [status, session])

  return <>{children}</>
}
