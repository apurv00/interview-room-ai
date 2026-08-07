import { describe, expect, it } from 'vitest'
import {
  INTERVIEW_JOB_DESCRIPTION_MAX_CHARS,
  INTERVIEW_ROLE_SLUG_MAX_CHARS,
  INTERVIEW_TARGET_COMPANY_MAX_CHARS,
} from '@shared/interviewContract'
import { InterviewConfigSchema } from '../validators/interview'
import { InviteSchema } from '@b2b/validators/hire'

const BASE_CONFIG = {
  role: 'backend',
  experience: '3-6' as const,
  duration: 20,
}

describe('InterviewConfigSchema shared producer limits', () => {
  it('accepts 30 minutes and rejects requests above the product maximum', () => {
    expect(InterviewConfigSchema.safeParse({
      ...BASE_CONFIG,
      duration: 30,
    }).success).toBe(true)
    expect(InterviewConfigSchema.safeParse({
      ...BASE_CONFIG,
      duration: 31,
    }).success).toBe(false)
    expect(InterviewConfigSchema.safeParse({
      ...BASE_CONFIG,
      duration: 60,
    }).success).toBe(false)
  })

  it('accepts the exact JD/company boundaries', () => {
    expect(InterviewConfigSchema.safeParse({
      ...BASE_CONFIG,
      jobDescription: 'j'.repeat(INTERVIEW_JOB_DESCRIPTION_MAX_CHARS),
      targetCompany: 'c'.repeat(INTERVIEW_TARGET_COMPANY_MAX_CHARS),
    }).success).toBe(true)
  })

  it('rejects one character beyond either boundary', () => {
    expect(InterviewConfigSchema.safeParse({
      ...BASE_CONFIG,
      jobDescription: 'j'.repeat(INTERVIEW_JOB_DESCRIPTION_MAX_CHARS + 1),
    }).success).toBe(false)
    expect(InterviewConfigSchema.safeParse({
      ...BASE_CONFIG,
      targetCompany: 'c'.repeat(INTERVIEW_TARGET_COMPANY_MAX_CHARS + 1),
    }).success).toBe(false)
  })

  it('accepts the CMS role-slug boundary and rejects one character beyond it', () => {
    const atLimit = 'r'.repeat(INTERVIEW_ROLE_SLUG_MAX_CHARS)
    const overLimit = `${atLimit}r`
    expect(InterviewConfigSchema.safeParse({
      ...BASE_CONFIG,
      role: atLimit,
    }).success).toBe(true)
    expect(InterviewConfigSchema.safeParse({
      ...BASE_CONFIG,
      role: overLimit,
    }).success).toBe(false)

    // These are downstream consumers of the exact role persisted on an
    // InterviewSession. A CMS-valid role must not fail after session start.
    expect(InviteSchema.safeParse({ candidateEmail: 'candidate@example.com', role: atLimit }).success).toBe(true)

    expect(InviteSchema.safeParse({ candidateEmail: 'candidate@example.com', role: overLimit }).success).toBe(false)
  })
})
