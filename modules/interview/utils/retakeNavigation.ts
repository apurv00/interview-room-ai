import type { InterviewConfig } from '@shared/types'

const OBJECT_ID = /^[a-f\d]{24}$/i

export interface RetakeRouteResponse {
  parentSessionId?: unknown
  jobsPractice?: { jobId?: unknown }
  jobsOrigin?: unknown
  config?: InterviewConfig
}

export type RetakeNavigationPlan =
  | {
      kind: 'jobs-practice'
      parentSessionId: string
      href: string
      jobId: string
    }
  | {
      kind: 'retake'
      parentSessionId: string
      href: string
    }
  | {
      kind: 'general-practice'
      jobsFallback: true
      href: string
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

  if (jobId) {
    return {
      kind: 'jobs-practice',
      parentSessionId,
      jobId,
      href: `/jobs/${jobId}?practice=1&retake=${encodeURIComponent(parentSessionId)}`,
    }
  }

  // A Jobs-origin session without a currently verified exact-JD handoff is
  // not comparable with its parent. The URL remains the fail-closed authority
  // even when browser storage is blocked: every setup hydrator sees
  // jobsFallback=1, while omission of `retake` prevents false lineage.
  if (payload.jobsOrigin === true) {
    return {
      kind: 'general-practice',
      jobsFallback: true,
      href: '/interview/setup?jobsFallback=1',
    }
  }

  return {
    kind: 'retake',
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

type RetakeStoredConfig = InterviewConfig & {
  /** Transport-only proof from a Jobs detail handoff; never reusable. */
  jobsHandoffToken?: unknown
}

type RetakeStoredSession = {
  config?: RetakeStoredConfig | null
  jobDescription?: unknown
  resumeText?: unknown
  jdFileName?: unknown
  resumeFileName?: unknown
}

/**
 * InterviewSession persists document context beside its compact `config`
 * subdocument. Reconstruct the browser setup shape from that real API
 * representation before applying any Jobs-origin scrub.
 */
export function retakeConfigFromStoredSession(
  value: unknown,
): RetakeStoredConfig | undefined {
  if (!value || typeof value !== 'object') return undefined
  const session = value as RetakeStoredSession
  const config = session?.config
  if (
    !config ||
    typeof config.role !== 'string' ||
    typeof config.experience !== 'string' ||
    typeof config.duration !== 'number'
  ) return undefined

  return {
    ...config,
    ...(typeof session.jobDescription === 'string'
      ? { jobDescription: session.jobDescription }
      : {}),
    ...(typeof session.resumeText === 'string'
      ? { resumeText: session.resumeText }
      : {}),
    ...(typeof session.jdFileName === 'string'
      ? { jdFileName: session.jdFileName }
      : {}),
    ...(typeof session.resumeFileName === 'string'
      ? { resumeFileName: session.resumeFileName }
      : {}),
  }
}

/**
 * A Jobs-origin session may fall back to generic setup only when its posting
 * is unavailable or no longer safe to reuse. Preserve the candidate's resume
 * and interview choices, but remove every field whose truth came from that
 * posting. Ordinary retakes keep their complete user-supplied JD context.
 */
export function genericRetakeConfig(
  config: RetakeStoredConfig,
  jobsOrigin: boolean,
): InterviewConfig {
  if (!jobsOrigin) return config

  const genericConfig: RetakeStoredConfig = { ...config }
  delete genericConfig.jobDescription
  delete genericConfig.jdFileName
  delete genericConfig.targetCompany
  delete genericConfig.targetIndustry
  delete genericConfig.attribution
  delete genericConfig.jobsHandoffToken
  return genericConfig
}

/** Replace browser setup state without letting an older Jobs handoff survive. */
export function persistGenericRetakeConfig(
  storage: Pick<Storage, 'removeItem' | 'setItem'>,
  storageKey: string,
  config: RetakeStoredConfig | null | undefined,
  jobsOrigin: boolean,
): void {
  if (jobsOrigin) storage.removeItem(storageKey)
  if (!config) return
  storage.setItem(storageKey, JSON.stringify(genericRetakeConfig(config, jobsOrigin)))
}
