import { aiLogger } from '@shared/logger'
import {
  pinnedHttpRequest,
  type BeforePinnedRequestResult,
  type PinnedHttpRequestImpl,
} from '@shared/pinnedHttpClient'

export type BeforePhysicalRequestResult = BeforePinnedRequestResult

export const PROVIDER_JSON_BODY_CAP_BYTES = 16 * 1024 * 1024

export interface RetryJSONOptions {
  maxRetries?: number
  baseDelayMs?: number
  timeoutMs?: number
  maxResponseBytes?: number
  /** Re-checked for every physical attempt, including retries. False or
   *  throw aborts as authority loss and never reaches fetch(). */
  beforePhysicalRequest?: () => BeforePhysicalRequestResult | Promise<BeforePhysicalRequestResult>
  /** Pinned transport seam for deterministic security tests. Production
   *  callers use the resolve-once default and cannot fall back to fetch(). */
  requestImpl?: PinnedHttpRequestImpl
}

export type FetchJSONResult<T> =
  | { ok: true; data: T; status: number; attempts?: number }
  | { ok: false; status: number; error: string; authorityChanged?: true; requestRejected?: string; attempts?: number }

function normalizedRequestBody(body: BodyInit | null | undefined): Uint8Array | null | undefined {
  if (body == null) return undefined
  if (typeof body === 'string') return Buffer.from(body)
  if (body instanceof URLSearchParams) return Buffer.from(body.toString())
  if (body instanceof ArrayBuffer) return new Uint8Array(body)
  if (ArrayBuffer.isView(body)) {
    return new Uint8Array(body.buffer, body.byteOffset, body.byteLength)
  }
  // Streams, Blob and FormData have implicit framing/length semantics that
  // this bounded provider primitive intentionally does not guess.
  return null
}

function transportError(code: string): string {
  if (code === 'BODY_TOO_LARGE') return 'response-too-large'
  if (code === 'DNS_NON_GLOBAL') return 'dns-non-global'
  return code.toLowerCase()
}

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
  const {
    maxRetries = 3,
    baseDelayMs = 1000,
    timeoutMs = 15000,
    maxResponseBytes = PROVIDER_JSON_BODY_CAP_BYTES,
    beforePhysicalRequest,
    requestImpl = pinnedHttpRequest,
  } = options
  const method = (init.method ?? 'GET').toUpperCase()
  const body = normalizedRequestBody(init.body)
  if ((method !== 'GET' && method !== 'POST') || body === null) {
    return { ok: false, status: 0, error: 'unsupported provider request', attempts: 0 }
  }
  // Compose the caller's signal with the per-attempt timeout instead of
  // clobbering it (Codex on #507): upstream cancellation (Inngest step
  // deadline, route abort) must kill the in-flight request AND the retry
  // sequence, not run each attempt to timeoutMs.
  const callerSignal = init.signal ?? undefined
  let lastStatus = 0
  let lastError = 'no attempts made'
  let physicalAttempts = 0

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    if (callerSignal?.aborted) {
      return { ok: false, status: lastStatus, error: 'aborted', attempts: physicalAttempts }
    }
    const controller = new AbortController()
    const onCallerAbort = () => controller.abort()
    callerSignal?.addEventListener('abort', onCallerAbort, { once: true })
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const result = await requestImpl({
        url,
        method,
        headers: init.headers,
        body: body ?? undefined,
        signal: controller.signal,
        maxResponseBytes,
        beforePhysicalRequest,
      })
      physicalAttempts += result.socketAttempts

      if (result.kind === 'authority-changed') {
        return {
          ok: false,
          status: 0,
          error: 'source-authority-changed',
          authorityChanged: true,
          attempts: physicalAttempts,
        }
      }
      if (result.kind === 'request-rejected') {
        return {
          ok: false,
          status: 0,
          error: result.reason,
          requestRejected: result.reason,
          attempts: physicalAttempts,
        }
      }
      if (result.kind === 'network-error') {
        lastError = result.code === 'ABORT_ERR'
          ? callerSignal?.aborted ? 'aborted' : 'timeout'
          : transportError(result.code)
        if (callerSignal?.aborted) {
          return { ok: false, status: lastStatus, error: 'aborted', attempts: physicalAttempts }
        }
        if (!result.retryable && result.code !== 'ABORT_ERR') {
          return { ok: false, status: lastStatus, error: lastError, attempts: physicalAttempts }
        }
      } else {
        lastStatus = result.status
      }

      if (result.kind === 'response' && result.status >= 200 && result.status < 300) {
        try {
          return {
            ok: true,
            data: JSON.parse(result.body.toString('utf8')) as T,
            status: result.status,
            attempts: physicalAttempts,
          }
        } catch (parseErr) {
          if (parseErr instanceof SyntaxError) {
            return {
              ok: false,
              status: result.status,
              error: 'invalid JSON body',
              attempts: physicalAttempts,
            }
          }
          throw parseErr
        }
      } else if (result.kind === 'response') {
        if (result.status !== 429 && result.status < 500) {
          return {
            ok: false,
            status: result.status,
            error: `http-${result.status}`,
            attempts: physicalAttempts,
          }
        }
        lastError = `http-${result.status}`
      }
    } catch (err) {
      lastError = controller.signal.aborted
        ? callerSignal?.aborted ? 'aborted' : 'timeout'
        : String(err)
    } finally {
      clearTimeout(timer)
      callerSignal?.removeEventListener('abort', onCallerAbort)
    }
    // A caller abort ends the sequence — retrying cancelled work is waste.
    if (callerSignal?.aborted) {
      return { ok: false, status: lastStatus, error: 'aborted', attempts: physicalAttempts }
    }
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
  return { ok: false, status: lastStatus, error: lastError, attempts: physicalAttempts }
}
