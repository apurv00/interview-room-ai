import { describe, it, expect } from 'vitest'
import {
  companyKey, titleKey, titleTokens, locationKey, fingerprintOf, sourceKeyOf,
  isConfidentialCompany, titleJaccard,
} from '../services/identityResolver'

// Ported from the probe's executable spec (scripts/jobs-liquidity-probe.test.mjs).
// Cases tagged [Cx-*] are accepted PR #503 review findings — never re-break.

describe('companyKey', () => {
  it('strips legal suffixes, iterated', () => {
    expect(companyKey('Acme Pvt Ltd.')).toBe('acme')
    expect(companyKey('Acme Private Limited')).toBe('acme')
    expect(companyKey('Wipro Technologies LLP')).toBe('wipro technologies')
  })
  it('[Cx] tail-anchored — "Corporation Bank" is not "bank"', () => {
    expect(companyKey('Corporation Bank')).toBe('corporation bank')
  })
  it('[Cx-507] compact dot/comma-chained suffixes canonicalize identically', () => {
    expect(companyKey('Acme Pvt.Ltd.')).toBe('acme')
    expect(companyKey('Acme Pvt., Ltd.')).toBe('acme')
    expect(companyKey('Acme.Ltd')).toBe('acme')
    // the same employer must mint ONE fingerprint across spellings
    expect(fingerprintOf('Acme Pvt.Ltd.', 'Developer', 'Pune', false))
      .toBe(fingerprintOf('Acme Pvt Ltd', 'Developer', 'Pune', false))
  })
  it('never strips solutions/technologies (half of India consultancy namespace)', () => {
    expect(companyKey('ABC Solutions')).toBe('abc solutions')
  })
})

describe('titleKey / titleTokens', () => {
  it('drops parenthesized junk and stopwords, sorts tokens', () => {
    expect(titleKey('Senior Developer (Remote) [Urgent Hiring]')).toBe('developer senior')
  })
  it('keeps seniority and +# tokens', () => {
    expect(titleTokens('C++ Developer for Backend')).toContain('c++')
    expect(titleTokens('Senior QA Engineer')).toContain('senior')
  })
})

describe('locationKey', () => {
  it('[Cx] collapses separator spelling before alias lookup', () => {
    expect(locationKey('Delhi-NCR')).toBe('delhi-ncr')
    expect(locationKey('delhi_ncr')).toBe('delhi-ncr')
    expect(locationKey('Delhi NCR')).toBe('delhi-ncr')
  })
  it('maps metro aliases', () => {
    expect(locationKey('Gurgaon')).toBe('delhi-ncr')
    expect(locationKey('Bangalore Urban')).toBe('bengaluru')
    expect(locationKey('Navi Mumbai')).toBe('mumbai')
    expect(locationKey('Secunderabad')).toBe('hyderabad')
  })
  it('remote wins; unknown cities slug; empty is visible', () => {
    expect(locationKey('Pune', true)).toBe('remote-in')
    expect(locationKey('Indore')).toBe('indore')
    expect(locationKey('')).toBe('unknown')
  })
})

describe('fingerprintOf', () => {
  it('is stable across alias spellings of the same job', () => {
    const a = fingerprintOf('Acme Pvt Ltd', 'Senior Developer', 'Gurgaon', false)
    const b = fingerprintOf('Acme', 'Developer Senior', 'Delhi NCR', false)
    expect(a).toMatch(/^[0-9a-f]{24}$/)
    expect(a).toBe(b)
  })
  it('[guard #2] confidential companies mint NO fingerprint', () => {
    expect(isConfidentialCompany('Confidential')).toBe(true)
    expect(fingerprintOf('Confidential Company', 'Developer', 'Pune', false)).toBeNull()
  })
  it('[guard #1] salt separates same-source different-externalId postings', () => {
    const plain = fingerprintOf('Acme', 'Developer', 'Pune', false)
    const salted = fingerprintOf('Acme', 'Developer', 'Pune', false, 'REF-2')
    expect(salted).not.toBe(plain)
  })
})

describe('titleJaccard (fuzzy tier, company-scoped)', () => {
  it('identical titles → 1, disjoint → 0', () => {
    expect(titleJaccard('Backend Developer', 'Developer Backend')).toBe(1)
    expect(titleJaccard('Backend Developer', 'HR Recruiter')).toBe(0)
  })
  it('partial overlap computes token-set ratio', () => {
    // {backend, developer, senior} vs {backend, developer} → 2/3
    expect(titleJaccard('Senior Backend Developer', 'Backend Developer')).toBeCloseTo(2 / 3, 5)
  })
})

describe('sourceKeyOf', () => {
  it('composes the source-tier identity', () => {
    expect(sourceKeyOf('jsearch', 'abc123')).toBe('jsearch:abc123')
  })
})
