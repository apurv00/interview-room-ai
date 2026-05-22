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
 */
const inflightJSON = new Map<string, Promise<unknown>>()

export function deduplicatedFetchJSON<T = unknown>(
  url: string,
  options?: RequestInit,
): Promise<T | null> {
  const method = options?.method?.toUpperCase() || 'GET'
  if (method !== 'GET') {
    return fetch(url, options).then((r) => (r.ok ? r.json() : null))
  }
  if (inflightJSON.has(url)) {
    return inflightJSON.get(url) as Promise<T | null>
  }
  const promise = fetch(url, options)
    .then((r) => (r.ok ? r.json() : null))
    .finally(() => inflightJSON.delete(url))
  inflightJSON.set(url, promise)
  return promise as Promise<T | null>
}
