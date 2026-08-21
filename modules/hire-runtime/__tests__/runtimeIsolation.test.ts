import { afterEach, describe, expect, it } from 'vitest'
import { HireRuntimeBinding } from '../models/HireRuntimeBinding'
import { assertHireRuntimeSurface } from '../services/runtimeBoundary'
import { runtimePrincipalEmail } from '../services/runtimePrincipalService'

const originalSurface = process.env.IPG_SURFACE

afterEach(() => {
  if (originalSurface === undefined) delete process.env.IPG_SURFACE
  else process.env.IPG_SURFACE = originalSurface
})

describe('Hire runtime identity isolation', () => {
  it('fails closed outside the dedicated runtime deployment', () => {
    process.env.IPG_SURFACE = 'hire-control'
    expect(() => assertHireRuntimeSurface()).toThrow(/outside the isolated runtime/)
  })

  it('binding schema has no candidate or B2C identity fields', () => {
    expect(HireRuntimeBinding.schema.path('candidateEmail')).toBeUndefined()
    expect(HireRuntimeBinding.schema.path('candidateName')).toBeUndefined()
    expect(HireRuntimeBinding.schema.path('b2cUserId')).toBeUndefined()
    expect(HireRuntimeBinding.schema.path('workspaceId')).toBeDefined()
    expect(HireRuntimeBinding.schema.path('applicationId')).toBeDefined()
    expect(HireRuntimeBinding.schema.path('roundId')).toBeDefined()
    expect(HireRuntimeBinding.schema.path('authTicketGeneration')).toBeDefined()
    expect(HireRuntimeBinding.schema.path('authTicketHandoffNonce')).toBeDefined()
    expect(HireRuntimeBinding.schema.path('authTicketState')).toBeDefined()
    expect(HireRuntimeBinding.schema.path('authTicketDigest')).toBeDefined()
    expect(HireRuntimeBinding.schema.path('authTicketExpiresAt')).toBeDefined()
  })

  it('uses only a non-routable, round-scoped pseudonym', () => {
    const email = runtimePrincipalEmail('A'.repeat(24))
    expect(email).toBe(`round-${'a'.repeat(24)}@guests.interviewprep.internal`)
    expect(email).not.toContain('example.com')
  })
})
