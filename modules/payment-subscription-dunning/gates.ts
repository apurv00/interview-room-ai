/**
 * Subscription dunning has an isolated production-dark foundation. Each effect
 * class has an independent compile-time gate so no broad switch can
 * accidentally authorize persistence, scheduling, customer communication,
 * entitlement, or paid-to-Basic effects together.
 */
export const PAYMENT_SUBSCRIPTION_DUNNING_CASE_WRITES_READY =
  false as const
export const PAYMENT_SUBSCRIPTION_DUNNING_JOB_EXECUTION_READY =
  false as const
export const PAYMENT_SUBSCRIPTION_DUNNING_COMMUNICATION_READY =
  false as const
export const PAYMENT_SUBSCRIPTION_DUNNING_BASIC_FALLBACK_READY =
  false as const
export const PAYMENT_SUBSCRIPTION_DUNNING_GRACE_INTERVIEW_READY =
  false as const
