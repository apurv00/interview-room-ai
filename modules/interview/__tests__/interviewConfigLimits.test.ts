import { describe, expect, it } from 'vitest'
import {
  INTERVIEW_JOB_DESCRIPTION_MAX_CHARS,
  INTERVIEW_ROLE_SLUG_MAX_CHARS,
  INTERVIEW_TARGET_COMPANY_MAX_CHARS,
} from '@shared/interviewContract'
import { InterviewConfigSchema } from '../validators/interview'
import { CreateJobSchema } from '@hire'

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

    // Downstream consumer of the exact role persisted on an InterviewSession:
    // IPG Hire job titles become AI-round roles (v1's InviteSchema was
    // deleted 2026-08-09; CreateJobSchema is its successor pin). A title the
    // hire UI accepts must never fail the engine contract mid-flow.
    const jdText = 'x'.repeat(60)
    expect(CreateJobSchema.safeParse({ title: atLimit, jdText }).success).toBe(true)
    expect(CreateJobSchema.safeParse({ title: overLimit, jdText }).success).toBe(false)
  })
})
