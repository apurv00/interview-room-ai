import { describe, expect, it } from 'vitest'
import {
  CandidateStatusCapabilitySchema,
  CandidateStatusLinkIdSchema,
  IssueCandidateStatusLinkSchema,
} from '../validators/hireStatus'

const IDS = {
  workspace: '1'.repeat(24),
  application: '2'.repeat(24),
  job: '3'.repeat(24),
  candidate: '4'.repeat(24),
  link: '5'.repeat(24),
}
const SECRET = 'ab'.repeat(32)

describe('candidate status-link validators', () => {
  it('requires every persistent coordinate plus an exact 32-byte secret', () => {
    const capability = `${IDS.workspace}.${IDS.application}.${IDS.job}.${IDS.candidate}.${IDS.link}.${SECRET}`
    expect(CandidateStatusCapabilitySchema.parse(capability)).toBe(capability)
    expect(
      CandidateStatusCapabilitySchema.safeParse(
        `${IDS.workspace}.${IDS.application}.${IDS.job}.${IDS.candidate}.${SECRET}`,
      ).success,
    ).toBe(false)
    expect(
      CandidateStatusCapabilitySchema.safeParse(
        `${IDS.workspace}.${IDS.application}.${IDS.job}.${IDS.candidate}.${IDS.link}.short`,
      ).success,
    ).toBe(false)
  })

  it('keeps issuance strict and the expiry bounded', () => {
    expect(
      IssueCandidateStatusLinkSchema.parse({
        applicationId: IDS.application,
        operationId: '11111111-1111-4111-8111-111111111111',
        expiresInDays: 90,
      }),
    ).toMatchObject({ applicationId: IDS.application, expiresInDays: 90 })
    expect(
      IssueCandidateStatusLinkSchema.safeParse({
        applicationId: IDS.application,
        operationId: 'not-a-uuid',
      }).success,
    ).toBe(false)
    expect(
      IssueCandidateStatusLinkSchema.safeParse({
        applicationId: IDS.application,
        operationId: '11111111-1111-4111-8111-111111111111',
        expiresInDays: 91,
      }).success,
    ).toBe(false)
    expect(
      IssueCandidateStatusLinkSchema.safeParse({
        applicationId: IDS.application,
        operationId: '11111111-1111-4111-8111-111111111111',
        unrelated: true,
      }).success,
    ).toBe(false)
  })

  it('treats a route link id as a coordinate, never a substitute for a capability', () => {
    expect(CandidateStatusLinkIdSchema.safeParse(IDS.link).success).toBe(true)
    expect(CandidateStatusLinkIdSchema.safeParse('short').success).toBe(false)
  })
})
