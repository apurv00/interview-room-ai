import type { InterviewConfig } from '@shared/types'

export interface InterviewUsageSummary {
  plan?: unknown
  monthlyInterviewsUsed?: unknown
  monthlyInterviewLimit?: unknown
}

export function shouldOfferPaidInterviewCheckout(
  config: Pick<InterviewConfig, 'duration'>,
  usage: InterviewUsageSummary,
): boolean {
  if (usage.plan !== 'free') return false
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
