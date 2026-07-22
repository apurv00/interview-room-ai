import { checkRateLimit } from '@shared/middleware/checkRateLimit'

/**
 * Jobs mutation limits are deliberately keyed only by identities established
 * by NextAuth or a verified signed-action token. Callers must never pass an
 * untrusted user-id header here.
 */
export const JOBS_RATE_LIMITS = {
  mutation: {
    keyPrefix: 'rl:jobs:mutation',
    windowMs: 60_000,
    maxRequests: 30,
  },
  'ats-check': {
    keyPrefix: 'rl:jobs:ats-check',
    windowMs: 60_000,
    maxRequests: 5,
  },
  'broken-link': {
    keyPrefix: 'rl:jobs:broken-link',
    windowMs: 60 * 60_000,
    maxRequests: 6,
  },
  'practice-email': {
    keyPrefix: 'rl:jobs:practice-email',
    windowMs: 60 * 60_000,
    maxRequests: 3,
  },
  'admin-command': {
    keyPrefix: 'rl:jobs:admin-command',
    windowMs: 60_000,
    maxRequests: 10,
  },
  'email-action': {
    keyPrefix: 'rl:jobs:email-action',
    windowMs: 60 * 60_000,
    maxRequests: 10,
  },
  xray: {
    keyPrefix: 'rl:jobs:xray',
    windowMs: 60_000,
    maxRequests: 10,
  },
} as const

export type JobsRateLimitScope = Exclude<keyof typeof JOBS_RATE_LIMITS, 'mutation'>

/**
 * Applies the shared Jobs mutation budget, followed by a tighter budget for
 * costly or operationally sensitive actions. A blocked global check does not
 * consume the endpoint-specific budget.
 */
export async function checkJobsRateLimit(
  verifiedIdentity: string,
  scope?: JobsRateLimitScope,
) {
  const identifier = `user:${verifiedIdentity}`
  const mutationBlock = await checkRateLimit(identifier, JOBS_RATE_LIMITS.mutation)
  if (mutationBlock || !scope) return mutationBlock

  return checkRateLimit(identifier, JOBS_RATE_LIMITS[scope])
}
