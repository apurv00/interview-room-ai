import { describe, expect, it } from 'vitest'
import { HireApplication } from '../models/HireApplication'
import {
  HIRE_CANDIDATE_PROVENANCE_SOURCES,
  HireCandidate,
} from '../models/HireCandidate'
import { AddOrMergeJobCandidateSchema } from '../validators/hire'

const OPERATION_ID = '11111111-1111-4111-8111-111111111111'

describe('manual/pool candidate merge contract', () => {
  it('keeps original candidate source separate from bounded later provenance', () => {
    expect(HIRE_CANDIDATE_PROVENANCE_SOURCES).toEqual([
      'manual',
      'apply_page',
      'bulk_upload',
      'pool',
    ])
    expect(HireCandidate.schema.path('source').options.enum).not.toContain('pool')
    expect(HireCandidate.schema.path('sourceHistory')).toBeDefined()
  })

  it('allows only explicit merge/audit event types', () => {
    const eventType = HireApplication.schema.path('events.type')
    expect(eventType.options.enum).toEqual(expect.arrayContaining(['reapplied', 'source_merged']))
  })

  it('accepts exactly one recruiter identity mode plus an idempotency key', () => {
    expect(
      AddOrMergeJobCandidateSchema.parse({
        name: 'Jane Candidate',
        email: 'jane@example.com',
        operationId: OPERATION_ID,
      }),
    ).toMatchObject({ email: 'jane@example.com' })
    expect(
      AddOrMergeJobCandidateSchema.parse({
        candidateId: 'aaaaaaaaaaaaaaaaaaaaaaaa',
        operationId: OPERATION_ID,
      }),
    ).toMatchObject({ candidateId: 'aaaaaaaaaaaaaaaaaaaaaaaa' })
    expect(() =>
      AddOrMergeJobCandidateSchema.parse({
        candidateId: 'aaaaaaaaaaaaaaaaaaaaaaaa',
        email: 'jane@example.com',
        operationId: OPERATION_ID,
      }),
    ).toThrow(/talent-pool candidate/i)
  })
})
