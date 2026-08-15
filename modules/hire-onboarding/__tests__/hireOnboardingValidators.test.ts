import { describe, expect, it } from 'vitest'
import { StartHireOnboardingTestDriveSchema } from '../validators/hireOnboarding'

describe('Hire onboarding test-drive validators', () => {
  it('requires a strict operation idempotency key', () => {
    expect(
      StartHireOnboardingTestDriveSchema.parse({
        operationId: '11111111-1111-4111-8111-111111111111',
      }),
    ).toEqual({ operationId: '11111111-1111-4111-8111-111111111111' })
    expect(StartHireOnboardingTestDriveSchema.safeParse({ operationId: 'not-a-uuid' }).success).toBe(false)
    expect(
      StartHireOnboardingTestDriveSchema.safeParse({
        operationId: '11111111-1111-4111-8111-111111111111',
        candidateEmail: 'must-not-be-accepted@example.com',
      }).success,
    ).toBe(false)
  })
})
