import { deduplicatedFetchJSON } from '@shared/cachedFetch'

/**
 * Shared fetcher for the feedback page's `/api/interviews/{id}?excludeTranscript=true`
 * GET. Wave 3 / UAT-015: the feedback page used to fire this GET from
 * three independent useEffects — recording-probe, initial-load, and
 * pre-generation poll — racing each other on mount and producing 3–4
 * duplicate GETs visible in the Network panel.
 *
 * `deduplicatedFetchJSON` shares the parsed JSON between any
 * concurrent consumers (correct for the body-stream issue that bare
 * `deduplicatedFetch` has). The in-flight cache clears the moment
 * the call resolves, so the poll loop's next iteration fires fresh
 * data — no staleness.
 *
 * Returns `null` on a non-OK response (matches the original call sites'
 * `if (res.ok)` guards), or on non-abort network error.
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

export async function fetchFeedbackSessionSummary(
  sessionId: string,
  options: { signal?: AbortSignal } = {},
): Promise<FeedbackSessionSummary | null> {
  try {
    return await deduplicatedFetchJSON<FeedbackSessionSummary>(
      `/api/interviews/${sessionId}?excludeTranscript=true`,
      options.signal ? { signal: options.signal } : undefined,
    )
  } catch (err) {
    // Codex P1: AbortError MUST propagate so the feedback page can
    // honor route/unmount cancellation. Treating an abort as "no data"
    // would cause the local-data fallback to fire on a defunct
    // component.
    if ((err as { name?: string })?.name === 'AbortError') throw err
    return null
  }
}
