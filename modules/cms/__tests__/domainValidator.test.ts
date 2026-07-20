import { describe, expect, it } from 'vitest'
import { INTERVIEW_ROLE_SLUG_MAX_CHARS } from '@shared/interviewContract'
import { CreateDomainSchema } from '../validators/cms'

const DOMAIN = {
  label: 'Custom role',
  shortLabel: 'CR',
  icon: '🎯',
  description: 'A custom interview role.',
}

describe('CMS/interview role slug contract', () => {
  it('uses the same exact maximum as InterviewConfig', () => {
    expect(CreateDomainSchema.safeParse({
      ...DOMAIN,
      slug: 'r'.repeat(INTERVIEW_ROLE_SLUG_MAX_CHARS),
    }).success).toBe(true)
    expect(CreateDomainSchema.safeParse({
      ...DOMAIN,
      slug: 'r'.repeat(INTERVIEW_ROLE_SLUG_MAX_CHARS + 1),
    }).success).toBe(false)
  })
})
