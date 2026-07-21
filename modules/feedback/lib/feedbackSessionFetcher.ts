/**
 * Shared fetcher for the feedback page's `/api/interviews/{id}?excludeTranscript=true`
 * GET. Wave 3 / UAT-015: the feedback page used to fire this GET from
 * three independent useEffects — recording-probe, initial-load, and
 * pre-generation poll — racing each other on mount and producing 3–4
 * duplicate GETs visible in the Network panel.
 *
 * The fetcher shares parsed JSON between concurrent signal-less consumers
 * (avoiding one-shot Response body races). The in-flight cache clears the
 * moment the call settles, so the poll loop's next iteration fires fresh
 * data — no staleness. Signal-bearing callers retain independent abort
 * lifecycles and therefore bypass that cache.
 *
 * Returns `null` on a non-OK response (matches the original call sites'
 * `if (res.ok)` guards), or on non-abort network error. The sole exception
 * is an exact `401 ACCOUNT_UNAVAILABLE`, which throws the typed terminal
 * error below so a late poll cannot hide account deletion as a cache miss.
 *
 * Codex P1 (PR #402): callers in app/feedback/[sessionId]/page.tsx use
 * `if ((e as Error).name === 'AbortError') return` to short-circuit
 * route changes / unmount cleanup. Catching AbortError here would
 * silently collapse it to a `null` "no data" miss and let downstream
 * branches (local-data fallback, generateFeedback POST) fire on a
 * component that's already unmounting. Preserve abort semantics by
 * rethrowing AbortError; only convert real network errors to null.
 */

export interface FeedbackSessionSummary {
  _id?: string
  status?: string
  hasRecording?: boolean
  feedback?: unknown
  config?: { role?: string; experience?: string; duration?: number; interviewType?: string }
  evaluations?: unknown[]
  completedAt?: string
  createdAt?: string
  // Other fields surface verbatim — feedback page consumers cast at use site.
  [key: string]: unknown
}

/**
 * An exact inactive-account response must survive the shared fetch layer so
 * long-lived feedback polls can engage the page's terminal privacy fence.
 * Ordinary 401 responses deliberately remain generic misses.
 */
export class FeedbackAccountUnavailableError extends Error {
  readonly code = 'ACCOUNT_UNAVAILABLE'
  readonly status = 401

  constructor() {
    super('The account is unavailable')
    this.name = 'FeedbackAccountUnavailableError'
  }
}

export function isFeedbackAccountUnavailableError(
  error: unknown,
): error is FeedbackAccountUnavailableError {
  return (
    error instanceof FeedbackAccountUnavailableError ||
    (
      typeof error === 'object' &&
      error !== null &&
      (error as { name?: unknown }).name === 'FeedbackAccountUnavailableError' &&
      (error as { status?: unknown }).status === 401 &&
      (error as { code?: unknown }).code === 'ACCOUNT_UNAVAILABLE'
    )
  )
}

const inflightSummaries = new Map<string, Promise<FeedbackSessionSummary | null>>()

async function requestFeedbackSessionSummary(
  url: string,
  signal?: AbortSignal,
): Promise<FeedbackSessionSummary | null> {
  try {
    const response = await fetch(url, signal ? { signal } : undefined)
    if (response.ok) return await response.json() as FeedbackSessionSummary

    if (response.status === 401) {
      const body = await response.json().catch(() => null) as { code?: unknown } | null
      if (body?.code === 'ACCOUNT_UNAVAILABLE') {
        throw new FeedbackAccountUnavailableError()
      }
    }
    return null
  } catch (error) {
    if ((error as { name?: string })?.name === 'AbortError') throw error
    if (isFeedbackAccountUnavailableError(error)) throw error
    return null
  }
}

export async function fetchFeedbackSessionSummary(
  sessionId: string,
  options: { signal?: AbortSignal } = {},
): Promise<FeedbackSessionSummary | null> {
  const url = `/api/interviews/${sessionId}?excludeTranscript=true`

  // A signal-bearing caller owns an independent abort lifecycle, matching
  // deduplicatedFetchJSON's existing contract. Signal-less callers share the
  // parsed result (or typed terminal error), so concurrent consumers still
  // issue exactly one network request without sharing a one-shot body stream.
  if (options.signal) {
    return requestFeedbackSessionSummary(url, options.signal)
  }

  const existing = inflightSummaries.get(url)
  if (existing) return existing

  let shared: Promise<FeedbackSessionSummary | null>
  shared = requestFeedbackSessionSummary(url).finally(() => {
    if (inflightSummaries.get(url) === shared) inflightSummaries.delete(url)
  })
  inflightSummaries.set(url, shared)
  return shared
}
