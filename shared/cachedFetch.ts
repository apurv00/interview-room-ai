/**
 * Lightweight in-flight request deduplication for client-side fetches.
 * Identical concurrent GET requests share a single network call.
 */
const inflight = new Map<string, Promise<Response>>()

export function deduplicatedFetch(url: string, options?: RequestInit): Promise<Response> {
  const method = options?.method?.toUpperCase() || 'GET'

  // Only deduplicate GET requests — mutations must always go through
  if (method !== 'GET') return fetch(url, options)

  if (inflight.has(url)) return inflight.get(url)!

  const promise = fetch(url, options).finally(() => inflight.delete(url))
  inflight.set(url, promise)
  return promise
}

/**
 * JSON-aware variant that caches the *parsed* JSON, not the Response.
 *
 * Why this exists: `deduplicatedFetch` returns the shared
 * `Promise<Response>`. Two concurrent consumers each then call
 * `.json()` on the same Response object — and the second `.json()`
 * throws because the body stream is one-shot. In unit tests with a
 * stubbed `fetch` this slip silently passes; in production it explodes.
 *
 * Use this when two or more components on the same page may need the
 * parsed JSON from the same URL simultaneously (e.g. PathwayStatusBanner
 * + MarketingHomepage CTA, or the feedback page's three concurrent
 * session GETs).
 *
 * Codex P1 (PR #402): the in-flight map is keyed by URL alone. For
 * auth-scoped endpoints (`/api/learn/pathway`, `/api/onboarding`) this
 * permits a cross-account read: if the call is in-flight for user A
 * and the tab switches accounts before it resolves, user B's mount
 * attaches to A's promise and renders A's payload. Callers that read
 * auth-sensitive endpoints MUST pass an explicit `cacheKey` that
 * includes the user discriminator (e.g. `${url}#${userId}`). For
 * endpoints whose URL is already user-resource-keyed
 * (e.g. /api/interviews/{sessionId}), the default URL key is safe.
 */
const inflightJSON = new Map<string, Promise<unknown>>()

export function deduplicatedFetchJSON<T = unknown>(
  url: string,
  options?: RequestInit,
  cacheKey?: string,
): Promise<T | null> {
  const method = options?.method?.toUpperCase() || 'GET'
  if (method !== 'GET') {
    return fetch(url, options).then((r) => (r.ok ? r.json() : null))
  }
  const key = cacheKey ?? url
  if (inflightJSON.has(key)) {
    return inflightJSON.get(key) as Promise<T | null>
  }
  const promise = fetch(url, options)
    .then((r) => (r.ok ? r.json() : null))
    .finally(() => inflightJSON.delete(key))
  inflightJSON.set(key, promise)
  return promise as Promise<T | null>
}

/** Test-only escape hatch — wipes every in-flight cache slot. */
export function _resetDeduplicatedFetchCache() {
  inflight.clear()
  inflightJSON.clear()
}
