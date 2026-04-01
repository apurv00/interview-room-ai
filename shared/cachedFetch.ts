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
