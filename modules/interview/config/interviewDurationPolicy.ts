import {
  CONSUMER_CATALOG_V1,
  SUPPORTED_INTERVIEW_DURATIONS_MINUTES,
} from '@shared/services/planConfig'
import type { Duration } from '@shared/types'

export const BASIC_MAX_INTERVIEW_DURATION_MINUTES =
  CONSUMER_CATALOG_V1.plans.free.interview.maxDurationMinutes

export const MAX_INTERVIEW_DURATION_MINUTES =
  SUPPORTED_INTERVIEW_DURATIONS_MINUTES[
    SUPPORTED_INTERVIEW_DURATIONS_MINUTES.length - 1
  ]

export interface InterviewDurationUserContext {
  plan?: string | null
  role?: string | null
  organizationId?: string | null
}

/** Personal candidates without a paid/Enterprise projection use Basic limits. */
export function isBasicPersonalInterviewUser(
  user?: InterviewDurationUserContext | null,
): boolean {
  if (!user) return true

  const isPrivilegedRole = [
    'recruiter',
    'org_admin',
    'platform_admin',
  ].includes(user.role ?? 'candidate')
  const hasPaidPlan = ['plus', 'pro', 'enterprise'].includes(
    user.plan ?? 'free',
  )

  return !user.organizationId && !isPrivilegedRole && !hasPaidPlan
}

export function interviewDurationOptionsForUser(
  user?: InterviewDurationUserContext | null,
): Duration[] {
  const options = isBasicPersonalInterviewUser(user)
    ? CONSUMER_CATALOG_V1.plans.free.interview.supportedDurationsMinutes
    : SUPPORTED_INTERVIEW_DURATIONS_MINUTES

  return [...options]
}

export function normalizeInterviewDurationForUser(
  user: InterviewDurationUserContext | null | undefined,
  requestedDuration: Duration | null,
): Duration {
  const options = interviewDurationOptionsForUser(user)
  return requestedDuration !== null &&
    options.some((option) => option === requestedDuration)
    ? requestedDuration
    : options[0]
}
