import type { InterviewConfig } from '@shared/types'
import { fetchWithRetry } from '@shared/fetchWithRetry'

export interface CreateDbSessionResult {
  sessionId: string | null
  limitReached?: boolean
  /** Server rejected the depth for this experience band (403, e.g. academics at 3-6/7+). */
  forbidden?: boolean
  handoffInvalid?: boolean
  error?: string
}

export async function createDbSession(
  config: InterviewConfig,
  parentSessionId?: string,
  jobsHandoffToken?: string
): Promise<CreateDbSessionResult> {
  try {
    let effectiveJobsHandoffToken = jobsHandoffToken
    const jobsId = config.attribution?.source === 'jobs'
      ? config.attribution.jobId
      : undefined
    if (jobsId && jobsHandoffToken) {
      try {
        // A candidate can remain in the lobby longer than the signed handoff
        // TTL. Refresh immediately before session creation; the POST route
        // still re-resolves and validates job, JD, role, and user server-side.
        const handoffResponse = await fetch(
          `/api/jobs/${encodeURIComponent(jobsId)}`,
          { cache: 'no-store' },
        )
        if (handoffResponse.ok) {
          const detail = await handoffResponse.json() as { practiceHandoffToken?: unknown }
          if (
            typeof detail.practiceHandoffToken === 'string' &&
            detail.practiceHandoffToken.length > 0
          ) {
            effectiveJobsHandoffToken = detail.practiceHandoffToken
          }
        }
      } catch {
        // Use the click-time token when refresh is unavailable. If it has
        // expired, the server returns the existing recoverable 409 handoff
        // error and sends the candidate back to the job.
      }
    }

    const res = await fetch('/api/interviews', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        config,
        ...(parentSessionId ? { parentSessionId } : {}),
        ...(effectiveJobsHandoffToken ? { jobsHandoffToken: effectiveJobsHandoffToken } : {}),
      }),
    })
    if (res.status === 402) return { sessionId: null, limitReached: true }
    if (res.status === 403) {
      const body = await res.json().catch(() => null) as { error?: string } | null
      return { sessionId: null, forbidden: true, error: body?.error }
    }
    if (res.status === 409) {
      const body = await res.json().catch(() => null) as { error?: string; code?: string } | null
      if (body?.code === 'JOBS_HANDOFF_INVALID') {
        return { sessionId: null, handoffInvalid: true, error: body.error }
      }
    }
    if (!res.ok) return { sessionId: null }
    const data = await res.json()
    return { sessionId: data.sessionId }
  } catch {
    return { sessionId: null }
  }
}

export async function persistSession(sessionId: string, payload: Record<string, unknown>) {
  await fetchWithRetry(`/api/interviews/${sessionId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
}
