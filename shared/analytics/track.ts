/**
 * Lightweight, zero-dependency analytics helper.
 *
 * Fans every event out to BOTH sinks from a single call site:
 *   1. PostHog — fire-and-forget POST to the capture endpoint, gated on
 *      `NEXT_PUBLIC_POSTHOG_KEY`. Uses the public project key so the
 *      browser bundle can authenticate without a backend round-trip.
 *   2. Google Analytics 4 — `window.gtag('event', ...)`, gated on the
 *      `<GoogleAnalytics />` loader having installed gtag. The loader
 *      is mounted in `app/layout.tsx` and itself no-ops when
 *      `NEXT_PUBLIC_GA_MEASUREMENT_ID` is unset, so this branch is also
 *      a safe no-op pre-config.
 *
 * Either sink can be unconfigured without affecting the other — this
 * is what lets us deploy GA infrastructure ahead of having a property
 * ID, and keep PostHog when GA isn't loaded yet.
 *
 * A stable anonymous distinct_id is persisted in localStorage so funnels
 * correctly attribute anonymous → signed-in journeys when we later call
 * `identify()`.
 *
 * Event names and property shapes are typed against the registry in
 * `./events.ts`. Adding a new event requires registering it there
 * first; the call site then gets full IDE completion + typo rejection.
 *
 * Why not the posthog-js SDK? It adds ~50KB gzip and we only need the
 * capture endpoint for pre-GTM funnel baselining. We can swap in the SDK
 * later without changing call sites.
 */

import type { EventName, EventProps, UserTraits } from './events'

declare global {
  interface Window {
    gtag?: (...args: unknown[]) => void
  }
}

const DISTINCT_ID_KEY = 'ipg_distinct_id'

// Admin surfaces shouldn't pollute product analytics. PostHog still
// receives these (we use it for ops debugging too), but GA only sees
// candidate-facing traffic. Prefixes match the Next.js App Router URLs
// produced by the `(cms)` and `(workspace)` route groups (the v1 `(hire)`
// group was deleted 2026-08-09).
const ADMIN_ROUTE_PREFIXES = ['/cms', '/workspace'] as const

const GA_STRING_PROP_LIMIT = 500

function getDistinctId(): string {
  if (typeof window === 'undefined') return 'server'
  try {
    const existing = window.localStorage.getItem(DISTINCT_ID_KEY)
    if (existing) return existing
    const fresh =
      'anon_' +
      (crypto.randomUUID?.() ??
        Math.random().toString(36).slice(2) + Date.now().toString(36))
    window.localStorage.setItem(DISTINCT_ID_KEY, fresh)
    return fresh
  } catch {
    return 'anon_nostorage'
  }
}

function isAdminRoute(pathname: string): boolean {
  for (const prefix of ADMIN_ROUTE_PREFIXES) {
    if (pathname === prefix || pathname.startsWith(prefix + '/')) return true
  }
  return false
}

function sanitizeForGa(
  properties: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(properties)) {
    if (value === undefined) continue
    if (typeof value === 'string' && value.length > GA_STRING_PROP_LIMIT) {
      out[key] = value.slice(0, GA_STRING_PROP_LIMIT)
      continue
    }
    out[key] = value
  }
  return out
}

function dispatchToGa(
  event: string,
  properties: Record<string, unknown>
): void {
  if (typeof window === 'undefined') return
  if (typeof window.gtag !== 'function') return
  if (isAdminRoute(window.location.pathname)) return

  try {
    window.gtag('event', event, sanitizeForGa(properties))
  } catch {
    // Swallow — analytics should never break the app.
  }
}

export function track<E extends EventName>(
  event: E,
  properties: EventProps<E>
): void {
  if (typeof window === 'undefined') return

  const apiKey = process.env.NEXT_PUBLIC_POSTHOG_KEY
  if (apiKey) {
    const host =
      process.env.NEXT_PUBLIC_POSTHOG_HOST || 'https://us.i.posthog.com'

    const payload = {
      api_key: apiKey,
      event,
      distinct_id: getDistinctId(),
      properties: {
        ...(properties as Record<string, unknown>),
        $current_url: window.location.href,
        $pathname: window.location.pathname,
        $referrer: document.referrer || undefined,
      },
      timestamp: new Date().toISOString(),
    }

    try {
      // Fire-and-forget; don't block UI on analytics.
      void fetch(`${host}/capture/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        keepalive: true,
      }).catch(() => {})
    } catch {
      // Swallow — analytics should never break the app.
    }
  }

  dispatchToGa(event, properties as Record<string, unknown>)
}

/**
 * Associate the current distinct_id with a known user id after sign-in.
 * PostHog's capture endpoint supports this via a `$identify` event.
 * GA receives the `user_id` via `gtag('set', { user_id })`, which is
 * the GA4-documented non-pageview update path. Using `gtag('config', ...)`
 * here would re-trigger automatic pageview tracking even when the loader
 * was initialized with `send_page_view: false`, because each `config`
 * call re-evaluates that flag against its own options object.
 */
export function identify(userId: string, traits: UserTraits = {}): void {
  if (typeof window === 'undefined') return

  const apiKey = process.env.NEXT_PUBLIC_POSTHOG_KEY
  if (apiKey) {
    const host =
      process.env.NEXT_PUBLIC_POSTHOG_HOST || 'https://us.i.posthog.com'

    const anonId = getDistinctId()
    try {
      void fetch(`${host}/capture/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_key: apiKey,
          event: '$identify',
          distinct_id: userId,
          properties: {
            $anon_distinct_id: anonId,
            ...(traits as Record<string, unknown>),
          },
        }),
        keepalive: true,
      }).catch(() => {})
      window.localStorage.setItem(DISTINCT_ID_KEY, userId)
    } catch {
      // Swallow.
    }
  }

  if (typeof window.gtag === 'function') {
    try {
      window.gtag('set', { user_id: userId })
      const sanitizedTraits = sanitizeForGa(traits as Record<string, unknown>)
      if (Object.keys(sanitizedTraits).length > 0) {
        window.gtag('set', 'user_properties', sanitizedTraits)
      }
    } catch {
      // Swallow.
    }
  }
}

/**
 * Drop browser-side identity when an account is signed out, switched, or
 * deleted. PostHog has no SDK state in this integration: removing the stored
 * distinct id makes the next capture anonymous. GA keeps identity in its
 * global config, so clear both the user id and the closed set of user traits.
 */
export function resetAnalyticsIdentity(): void {
  if (typeof window === 'undefined') return

  try {
    window.localStorage.removeItem(DISTINCT_ID_KEY)
  } catch {
    // Storage can be unavailable; still attempt to reset GA below.
  }

  if (typeof window.gtag !== 'function') return
  try {
    window.gtag('set', { user_id: null })
    window.gtag('set', 'user_properties', {
      plan: null,
      role: null,
      organizationId: null,
    })
  } catch {
    // Analytics cleanup must never interrupt the identity transition.
  }
}
