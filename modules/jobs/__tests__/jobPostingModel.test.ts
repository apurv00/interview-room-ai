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

  it('stores URL generations and anonymous bounded governance on provenance', () => {
    const provenance = JobPosting.schema.path('provenance') as unknown as {
      schema: { path: (name: string) => { instance?: string; schema?: { path: (name: string) => { options?: Record<string, unknown> } | undefined } } | undefined }
    }
    expect(provenance.schema.path('applyUrlFirstSeenAt')?.instance).toBe('Date')
    const governance = provenance.schema.path('linkGovernance')?.schema
    expect(governance?.path('incidentVersion')?.options).toMatchObject({ required: true, min: 1 })
    expect(governance?.path('reportCount')?.options).toMatchObject({ required: true, min: 0, max: 3 })
    expect(governance?.path('machineOutcome')?.options?.enum).toEqual(['dead', 'alive', 'unverifiable'])
  })

  it('binds closed-posting recovery evidence to one opaque link generation', () => {
    const applyCheck = JobPosting.schema.path('applyCheck') as unknown as {
      schema: { path: (name: string) => { instance?: string; options?: Record<string, unknown> } | undefined }
    }

    expect(applyCheck.schema.path('recoverySubject')?.instance).toBe('String')
    expect(applyCheck.schema.path('recoveryGeneration')?.instance).toBe('String')
    expect(String(applyCheck.schema.path('recoverySubject')?.options?.match))
      .toContain('ls1_')
    expect(String(applyCheck.schema.path('recoveryGeneration')?.options?.match))
      .toContain('lg1_')
  })

  it('indexes only pending crowd verification markers for the bounded priority lane', () => {
    const requestedIndex = JobPosting.schema.indexes().find(
      ([keys]) => keys.linkCheckRequestedAt === 1,
    )
    expect(requestedIndex).toEqual([
      { linkCheckRequestedAt: 1 },
      { partialFilterExpression: { linkCheckRequestedAt: { $type: 'date' } } },
    ])
  })
})
