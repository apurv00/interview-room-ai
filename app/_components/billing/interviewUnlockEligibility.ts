import type { InterviewConfig } from '@shared/types'
import { isHireRuntimeInterview } from '@interview/config/hireRuntimeMode'

export interface InterviewUsageSummary {
  plan?: unknown
  entitlementSource?: unknown
  monthlyInterviewsUsed?: unknown
  monthlyInterviewLimit?: unknown
}

type InterviewUnlockConfig = Pick<InterviewConfig, 'duration'> & {
  _hireRoundId?: unknown
}

export function shouldCheckPaidInterviewCheckout(
  config: InterviewUnlockConfig,
): boolean {
  return !isHireRuntimeInterview(config as InterviewConfig)
}

export function shouldOfferPaidInterviewCheckout(
  config: InterviewUnlockConfig,
  usage: InterviewUsageSummary,
): boolean {
  if (!shouldCheckPaidInterviewCheckout(config)) return false
  if (usage.plan !== 'free') return false
  // Mirrors the server admission authority (interviewService admin_grant
  // branch): an admin-granted account — comped users, and IPG Hire's
  // employer-funded synthetic guests — must never be offered a personal
  // checkout. Without this, the pre-flight modal contradicted the server,
  // which would have admitted them (Codex/founder on #605: a hire candidate
  // was shown the ₹69 paywall).
  if (usage.entitlementSource === 'admin_grant') return false
  if (config.duration > 10) return true
  return (
    typeof usage.monthlyInterviewsUsed === 'number' &&
    Number.isSafeInteger(usage.monthlyInterviewsUsed) &&
    typeof usage.monthlyInterviewLimit === 'number' &&
    Number.isSafeInteger(usage.monthlyInterviewLimit) &&
    usage.monthlyInterviewLimit >= 0 &&
    usage.monthlyInterviewsUsed >= usage.monthlyInterviewLimit
  )
}
