const OBJECT_ID = /^[a-f\d]{24}$/i

export interface RetakeRouteResponse {
  parentSessionId?: unknown
  jobsPractice?: { jobId?: unknown }
}

export interface RetakeNavigationPlan {
  parentSessionId: string
  href: string
  jobId?: string
}

export function isObjectId(value: unknown): value is string {
  return typeof value === 'string' && OBJECT_ID.test(value)
}

/**
 * One navigation contract for every retake entry point. Verified Jobs
 * retakes return through the job page so it can mint a fresh user/JD-bound
 * handoff; ordinary retakes keep the setup flow.
 */
export function planRetakeNavigation(
  payload: RetakeRouteResponse,
  fallbackSessionId: string
): RetakeNavigationPlan {
  const parentSessionId = isObjectId(payload.parentSessionId)
    ? payload.parentSessionId
    : fallbackSessionId
  const jobId = isObjectId(payload.jobsPractice?.jobId)
    ? payload.jobsPractice.jobId
    : undefined

  return jobId
    ? {
        parentSessionId,
        jobId,
        href: `/jobs/${jobId}?practice=1&retake=${encodeURIComponent(parentSessionId)}`,
      }
    : {
        parentSessionId,
        href: `/interview/setup?retake=${encodeURIComponent(parentSessionId)}`,
      }
}

/** Accept only a real persisted session id from a Jobs practice URL. */
export function retakeParentFromSearch(search: string): string | undefined {
  try {
    const value = new URLSearchParams(search).get('retake')
    return isObjectId(value) ? value : undefined
  } catch {
    return undefined
  }
}
