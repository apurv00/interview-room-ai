/**
 * Lightweight, zero-dependency analytics helper.
 *
 * Sends events to PostHog's capture endpoint via fetch. Uses the public
 * project key (`NEXT_PUBLIC_POSTHOG_KEY`) and host (`NEXT_PUBLIC_POSTHOG_HOST`,
 * defaulting to PostHog Cloud US). If the key is not configured, all calls
 * are no-ops — safe to deploy before PostHog is wired up in the dashboard.
 *
 * A stable anonymous distinct_id is persisted in localStorage so funnels
 * correctly attribute anonymous → signed-in journeys when we later call
 * `identify()`.
 *
 * Why not the posthog-js SDK? It adds ~50KB gzip and we only need the
 * capture endpoint for pre-GTM funnel baselining. We can swap in the SDK
 * later without changing call sites.
 */

const DISTINCT_ID_KEY = 'ipg_distinct_id'

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

export function track(
  event: string,
  properties: Record<string, unknown> = {}
): void {
  if (typeof window === 'undefined') return

  const apiKey = process.env.NEXT_PUBLIC_POSTHOG_KEY
  if (!apiKey) return

  const host =
    process.env.NEXT_PUBLIC_POSTHOG_HOST || 'https://us.i.posthog.com'

  const payload = {
    api_key: apiKey,
    event,
    distinct_id: getDistinctId(),
    properties: {
      ...properties,
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

/**
 * Associate the current distinct_id with a known user id after sign-in.
 * PostHog's capture endpoint supports this via a `$identify` event.
 */
export function identify(userId: string, traits: Record<string, unknown> = {}): void {
  if (typeof window === 'undefined') return
  const apiKey = process.env.NEXT_PUBLIC_POSTHOG_KEY
  if (!apiKey) return

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
          ...traits,
        },
      }),
      keepalive: true,
    }).catch(() => {})
    window.localStorage.setItem(DISTINCT_ID_KEY, userId)
  } catch {
    // Swallow.
  }
}
