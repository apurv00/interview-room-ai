import type { InterviewConfig } from '@shared/types'
import { isHireRuntimeInterview } from '@interview/config/hireRuntimeMode'

/**
 * The generic privacy-mode recording opt-out is a B2C control. Hire invite
 * recording is required by the candidate's explicit consent and must remain
 * available for the hiring-team review.
 */
export function isLobbyPrivacyModeAvailable(
  config: InterviewConfig | null | undefined,
  featureEnabled: boolean,
): boolean {
  return featureEnabled && !isHireRuntimeInterview(config)
}

/** A stale or tampered Hire lobby config may not suppress required recording. */
export function shouldClearStaleHirePrivacyMode(
  config: InterviewConfig | null | undefined,
): boolean {
  return Boolean(config?.privacyMode) && isHireRuntimeInterview(config)
}
