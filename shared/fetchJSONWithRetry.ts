import { aiLogger } from '@shared/logger'

interface RetryJSONOptions {
  maxRetries?: number
  baseDelayMs?: number
  timeoutMs?: number
}

export type FetchJSONResult<T> =
  | { ok: true; data: T; status: number }
  | { ok: false; status: number; error: string }

/**
 * JSON fetch with per-attempt timeout and exponential backoff. Returns a
 * discriminated result and never throws — the existing `fetchWithRetry`
 * resolves boolean and discards the body, which ingestion adapters can't use.
 *
 * Retries only network errors, 429 and 5xx. Other 4xx return immediately:
 * a 404/410 is an answer (board liveness reads it), not a flake — and
 * RapidAPI bills error responses, so JSearch callers pass maxRetries: 1.
 */
export async function fetchJSONWithRetry<T>(
  url: string,
  init: RequestInit = {},
  options: RetryJSONOptions = {}
): Promise<FetchJSONResult<T>> {
  const { maxRetries = 3, baseDelayMs = 1000, timeoutMs = 15000 } = options
  // Compose the caller's signal with the per-attempt timeout instead of
  // clobbering it (Codex on #507): upstream cancellation (Inngest step
  // deadline, route abort) must kill the in-flight request AND the retry
  // sequence, not run each attempt to timeoutMs.
  const callerSignal = init.signal ?? undefined
  let lastStatus = 0
  let lastError = 'no attempts made'

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    if (callerSignal?.aborted) return { ok: false, status: lastStatus, error: 'aborted' }
    const controller = new AbortController()
    const onCallerAbort = () => controller.abort()
    callerSignal?.addEventListener('abort', onCallerAbort, { once: true })
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await fetch(url, { ...init, signal: controller.signal })
      lastStatus = res.status
      if (res.ok) {
        try {
          // Body is consumed inside the abort window — a stalled body must
          // hit the same timeout as a stalled connect (probe precedent).
          return { ok: true, data: (await res.json()) as T, status: res.status }
        } catch {
          lastError = 'invalid JSON body'
        }
      } else if (res.status !== 429 && res.status < 500) {
        return { ok: false, status: res.status, error: `http-${res.status}` }
      } else {
        lastError = `http-${res.status}`
      }
    } catch (err) {
      lastError =
        err instanceof Error && err.name === 'AbortError'
          ? callerSignal?.aborted ? 'aborted' : 'timeout'
          : String(err)
    } finally {
      clearTimeout(timer)
      callerSignal?.removeEventListener('abort', onCallerAbort)
    }
    // A caller abort ends the sequence — retrying cancelled work is waste.
    if (callerSignal?.aborted) return { ok: false, status: lastStatus, error: 'aborted' }
    if (attempt < maxRetries - 1) {
      await new Promise((r) => setTimeout(r, baseDelayMs * Math.pow(2, attempt)))
    }
  }

  aiLogger.warn({ url, status: lastStatus, error: lastError }, 'fetchJSONWithRetry exhausted')
  return { ok: false, status: lastStatus, error: lastError }
}
