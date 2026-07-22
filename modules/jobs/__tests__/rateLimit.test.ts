import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockCheckRateLimit } = vi.hoisted(() => ({
  mockCheckRateLimit: vi.fn(),
}))

vi.mock('@shared/middleware/checkRateLimit', () => ({
  checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
}))

import {
  checkJobsRateLimit,
  JOBS_RATE_LIMITS,
  type JobsRateLimitScope,
} from '../services/rateLimit'

beforeEach(() => {
  vi.clearAllMocks()
  mockCheckRateLimit.mockResolvedValue(null)
})

describe('Jobs mutation rate-limit policy', () => {
  it('uses one shared mutation bucket keyed by a verified user identity', async () => {
    await expect(checkJobsRateLimit('candidate-1')).resolves.toBeNull()

    expect(mockCheckRateLimit).toHaveBeenCalledOnce()
    expect(mockCheckRateLimit).toHaveBeenCalledWith(
      'user:candidate-1',
      JOBS_RATE_LIMITS.mutation,
    )
  })

  it.each<JobsRateLimitScope>([
    'ats-check',
    'broken-link',
    'practice-email',
    'admin-command',
    'email-action',
    'xray',
  ])('applies the shared bucket before the tighter %s bucket', async (scope) => {
    await expect(checkJobsRateLimit('candidate-1', scope)).resolves.toBeNull()

    expect(mockCheckRateLimit).toHaveBeenNthCalledWith(
      1,
      'user:candidate-1',
      JOBS_RATE_LIMITS.mutation,
    )
    expect(mockCheckRateLimit).toHaveBeenNthCalledWith(
      2,
      'user:candidate-1',
      JOBS_RATE_LIMITS[scope],
    )
  })

  it('short-circuits a scoped check when the shared mutation bucket blocks', async () => {
    const blocked = new Response(null, {
      status: 429,
      headers: { 'Retry-After': '60' },
    })
    mockCheckRateLimit.mockResolvedValueOnce(blocked)

    await expect(checkJobsRateLimit('candidate-1', 'ats-check')).resolves.toBe(blocked)
    expect(mockCheckRateLimit).toHaveBeenCalledOnce()
  })

  it('returns the endpoint-specific block with its Retry-After header intact', async () => {
    const blocked = new Response(null, {
      status: 429,
      headers: { 'Retry-After': '3600' },
    })
    mockCheckRateLimit.mockResolvedValueOnce(null).mockResolvedValueOnce(blocked)

    const response = await checkJobsRateLimit('candidate-1', 'practice-email')

    expect(response).toBe(blocked)
    expect(response?.headers.get('Retry-After')).toBe('3600')
  })

  it('keeps expensive and operational scopes tighter than the global mutation budget', () => {
    expect(JOBS_RATE_LIMITS['ats-check'].maxRequests).toBeLessThan(JOBS_RATE_LIMITS.mutation.maxRequests)
    expect(JOBS_RATE_LIMITS['broken-link']).toMatchObject({
      windowMs: 60 * 60_000,
      maxRequests: 6,
    })
    expect(JOBS_RATE_LIMITS['admin-command'].maxRequests).toBeLessThan(JOBS_RATE_LIMITS.mutation.maxRequests)
    expect(JOBS_RATE_LIMITS.xray.maxRequests).toBeLessThan(JOBS_RATE_LIMITS.mutation.maxRequests)
    expect(JOBS_RATE_LIMITS['practice-email'].windowMs).toBeGreaterThan(JOBS_RATE_LIMITS.mutation.windowMs)
    expect(JOBS_RATE_LIMITS['email-action'].windowMs).toBeGreaterThan(JOBS_RATE_LIMITS.mutation.windowMs)
  })
})
