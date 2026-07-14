import { describe, it, expect } from 'vitest'
import { JOB_DOMAINS, JOB_DOMAIN_IDS, FRESHER_DOMAINS, FRESHER_DOMAIN_PATTERNS, matchFresherDomain } from '../config/domains'
import { FALLBACK_DOMAINS } from '@shared/db/seed'

// The unified-namespace drift guard (founder ruling 2026-07-12): the jobs
// taxonomy is keyed on the interview catalog's slugs — a rename or removal
// on either side must fail HERE, never become a silent disjoint.

describe('unified taxonomy', () => {
  const interviewSlugs = new Set(FALLBACK_DOMAINS.map((d: { slug: string }) => d.slug))

  it('every mapped jobs domain exists in the interview catalog', () => {
    for (const d of JOB_DOMAINS) {
      if (d.interviewSlug !== null) {
        expect(interviewSlugs.has(d.interviewSlug), `jobs domain '${d.id}' maps to missing interview slug '${d.interviewSlug}'`).toBe(true)
      }
    }
  })

  it('mapped ids ARE the interview slugs — one namespace, no translation', () => {
    for (const d of JOB_DOMAINS) {
      if (d.interviewSlug !== null) expect(d.id).toBe(d.interviewSlug)
    }
  })

  it('core-engineering domains are covered (the original gap)', () => {
    for (const slug of ['mechanical', 'civil', 'electrical', 'electronics']) {
      expect(JOB_DOMAIN_IDS).toContain(slug)
    }
  })

  it('jobs-only domains are explicit nulls, tracked deliberately', () => {
    const jobsOnly = JOB_DOMAINS.filter((d) => d.interviewSlug === null).map((d) => d.id)
    expect(jobsOnly).toEqual(['hr'])
  })

  it('ids are unique and every entry has a harvest query', () => {
    expect(new Set(JOB_DOMAIN_IDS).size).toBe(JOB_DOMAINS.length)
    for (const d of JOB_DOMAINS) expect(d.q.length).toBeGreaterThan(3)
  })
})

describe('fresher measurement cells', () => {
  it('FRESHER_DOMAINS are valid taxonomy ids with matchers', () => {
    for (const d of FRESHER_DOMAINS) {
      expect(JOB_DOMAIN_IDS).toContain(d)
      expect(FRESHER_DOMAIN_PATTERNS[d]).toBeInstanceOf(RegExp)
    }
  })

  it('[Cx-38th] telecaller titles reach the sales tally; Telecom does not', () => {
    expect(matchFresherDomain('Telecaller')).toBe('sales')
    expect(matchFresherDomain('Telecalling Executive')).toBe('sales')
    expect(matchFresherDomain('Telecom Engineer')).toBeNull()
  })

  it("probe 'data' cell rides the unified 'data-analyst' slug", () => {
    expect(matchFresherDomain('Data Entry Operator')).toBe('data-analyst')
  })
})

describe('interviewSlugForDomain (the hand-off role resolver, Codex #524)', async () => {
  const { interviewSlugForDomain } = await import('../config/domains')
  it('maps catalog domains 1:1, jobs-only domains to general, unknown to undefined', () => {
    expect(interviewSlugForDomain('backend')).toBe('backend')
    expect(interviewSlugForDomain('hr')).toBe('general') // interviewSlug: null → general, never the raw jobs slug
    expect(interviewSlugForDomain('astrology')).toBeUndefined()
    expect(interviewSlugForDomain(undefined)).toBeUndefined()
  })
})
