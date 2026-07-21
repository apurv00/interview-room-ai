import { describe, expect, it } from 'vitest'
import { JobPosting } from '@shared/db/models/JobPosting'

describe('JobPosting internal derived-authority fence', () => {
  it('keeps the revision token private and initializes it deterministically', () => {
    const path = JobPosting.schema.path('derivedAuthorityRevision')

    expect(path).toBeDefined()
    expect((path?.options as { select?: boolean; default?: number }).select).toBe(false)
    expect((path?.options as { select?: boolean; default?: number }).default).toBe(0)
  })

  it('stores canonical freshness independently of capped provenance', () => {
    expect(JobPosting.schema.path('lastSeenAt')?.instance).toBe('Date')
  })

  it('leaves purgeAt TTL creation to the ordered deployment gate', () => {
    const purgeIndexes = JobPosting.schema.indexes().filter(([keys]) => keys.purgeAt === 1)
    expect(purgeIndexes).toEqual([])
  })
})
