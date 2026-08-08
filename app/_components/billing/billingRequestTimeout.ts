export const BILLING_REQUEST_TIMEOUT_MS = 15_000

export class BillingRequestTimeoutError extends Error {
  constructor() {
    super('Billing request timed out')
    this.name = 'BillingRequestTimeoutError'
  }
}

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The operation was aborted', 'AbortError')
}

export async function billingFetch(
  input: RequestInfo | URL,
  init: RequestInit = {},
  timeoutMs = BILLING_REQUEST_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController()
  const upstreamSignal = init.signal ?? undefined
  let timeoutId: ReturnType<typeof setTimeout> | undefined
  let removeUpstreamAbort = () => {}

  const abortPromise = new Promise<never>((_, reject) => {
    if (!upstreamSignal) return
    const handleAbort = () => {
      controller.abort(upstreamSignal.reason)
      reject(abortError(upstreamSignal))
    }
    if (upstreamSignal.aborted) {
      handleAbort()
      return
    }
    upstreamSignal.addEventListener('abort', handleAbort, { once: true })
    removeUpstreamAbort = () => {
      upstreamSignal.removeEventListener('abort', handleAbort)
    }
  })

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      const timeoutError = new BillingRequestTimeoutError()
      controller.abort(timeoutError)
      reject(timeoutError)
    }, timeoutMs)
  })

  try {
    return await Promise.race([
      fetch(input, { ...init, signal: controller.signal }),
      abortPromise,
      timeoutPromise,
    ])
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId)
    removeUpstreamAbort()
  }
}
