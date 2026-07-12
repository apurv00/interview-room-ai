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
        } catch (parseErr) {
          // An abort/timeout during the body read keeps its own semantics —
          // rethrow into the outer catch's discrimination.
          if (controller.signal.aborted) throw parseErr
          // Only an ACTUAL parse failure is permanent (HTML error page
          // served as 200 — retrying re-bills the same broken payload).
          // A body-stream drop after headers (ECONNRESET/'terminated')
          // rejects res.json() too but is a transient network error —
          // rethrow so it flows to the retry path (Codex on #507).
          if (parseErr instanceof SyntaxError) {
            return { ok: false, status: res.status, error: 'invalid JSON body' }
          }
          throw parseErr
        }
      } else if (res.status !== 429 && res.status < 500) {
        // Release the connection on the terminal path too — an unread body
        // pins an undici socket until GC.
        try { await res.body?.cancel() } catch { /* already closed */ }
        return { ok: false, status: res.status, error: `http-${res.status}` }
      } else {
        lastError = `http-${res.status}`
        // Release the connection BEFORE backing off — repeated retryable
        // 429/5xx responses with unread bodies tie up sockets across the
        // whole backoff sequence (Codex on #507; probe helper parity).
        try { await res.body?.cancel() } catch { /* already closed */ }
      }
    } catch (err) {
      // Discriminate on OUR controller's state, not the error name — the
      // rethrown body-read abort above and provider-specific abort error
      // shapes must all land on timeout/aborted.
      lastError = controller.signal.aborted
        ? callerSignal?.aborted ? 'aborted' : 'timeout'
        : String(err)
    } finally {
      clearTimeout(timer)
      callerSignal?.removeEventListener('abort', onCallerAbort)
    }
    // A caller abort ends the sequence — retrying cancelled work is waste.
    if (callerSignal?.aborted) return { ok: false, status: lastStatus, error: 'aborted' }
    if (attempt < maxRetries - 1) {
      // Abortable backoff (Codex on #507): a caller abort during the
      // exponential delay must settle the helper immediately, not after
      // the full sleep — the loop-top check returns 'aborted' right after.
      await new Promise<void>((resolve) => {
        const finish = () => {
          clearTimeout(timer)
          callerSignal?.removeEventListener('abort', finish)
          resolve()
        }
        const timer = setTimeout(finish, baseDelayMs * Math.pow(2, attempt))
        callerSignal?.addEventListener('abort', finish, { once: true })
      })
    }
  }

  aiLogger.warn({ url, status: lastStatus, error: lastError }, 'fetchJSONWithRetry exhausted')
  return { ok: false, status: lastStatus, error: lastError }
}
