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
  it('maps only active CMS roles, including custom roles and jobs-only fallback', () => {
    const active = new Set(['backend', 'general', 'product-designer', 'custom-quant-role'])
    expect(interviewSlugForDomain('backend', active)).toBe('backend')
    expect(interviewSlugForDomain('hr', active)).toBe('general') // interviewSlug: null → general, never the raw jobs slug
    expect(interviewSlugForDomain('product-designer', active)).toBe('product-designer')
    expect(interviewSlugForDomain('custom-quant-role', active)).toBe('custom-quant-role')
    expect(interviewSlugForDomain('frontend', active)).toBeUndefined() // built-in, but CMS-inactive
    expect(interviewSlugForDomain('astrology', active)).toBeUndefined()
    expect(interviewSlugForDomain(undefined, active)).toBeUndefined()
  })
})

describe('roleToJobsDomain (founder RCA 2026-07-16 — the feed never mapped the target role to a domain)', async () => {
  const { roleToJobsDomain } = await import('../config/domains')

  it("the founder's exact repro: 'Product Management' reaches pm (titleJaccard scored it 0.33 and never fired)", () => {
    expect(roleToJobsDomain('Product Management')).toBe('pm')
    expect(roleToJobsDomain('product manager')).toBe('pm')
    expect(roleToJobsDomain('Senior Product Manager')).toBe('pm')
    expect(roleToJobsDomain('Product Owner')).toBe('pm') // alias — token math can't reach it
  })

  it('specificity: product ANALYST beats pm when both partially match', () => {
    expect(roleToJobsDomain('Product Analyst')).toBe('product-analyst')
  })

  it('stems reach the -ing/-ment forms; unknown roles return undefined (no filter beats a wrong filter)', () => {
    expect(roleToJobsDomain('Backend Development')).toBe('backend')
    expect(roleToJobsDomain('QA Engineer')).toBe('sdet')
    expect(roleToJobsDomain('Data Scientist')).toBe('data-science')
    expect(roleToJobsDomain('UX Designer')).toBe('design') // 2 of 3 q tokens
    expect(roleToJobsDomain('Astronaut')).toBeUndefined()
    expect(roleToJobsDomain('Software Engineer')).toBeUndefined() // deliberately unmapped — backend vs fullstack is a founder call
    expect(roleToJobsDomain('')).toBeUndefined()
    expect(roleToJobsDomain(undefined)).toBeUndefined()
  })

  it("a lone shared token never matches: 'Engineering Manager' maps to NO domain, not pm", () => {
    expect(roleToJobsDomain('Engineering Manager')).toBeUndefined()
  })

  it("Codex #539: engineer ≡ developer — 'Backend Engineer' (the placeholder itself) reaches backend", () => {
    expect(roleToJobsDomain('Backend Engineer')).toBe('backend')
    expect(roleToJobsDomain('Frontend Engineer')).toBe('frontend')
    expect(roleToJobsDomain('DevOps Engineer')).toBe('devops')
    expect(roleToJobsDomain('Mechanical Engineer')).toBe('mechanical')
    // Not in the taxonomy — class-unification must not force a wrong bucket.
    expect(roleToJobsDomain('Data Engineer')).toBeUndefined()
  })

  it("Codex #539 r2: fullstack ≡ full stack — one-word forms reach the fullstack bucket", () => {
    expect(roleToJobsDomain('Fullstack Engineer')).toBe('fullstack')
    expect(roleToJobsDomain('Full-Stack Engineer')).toBe('fullstack')
    expect(roleToJobsDomain('Fullstack Software Engineer')).toBe('fullstack')
    expect(roleToJobsDomain('Full Stack Developer')).toBe('fullstack')
  })

  it('every alias target is a real taxonomy id', async () => {
    const { JOB_DOMAIN_IDS } = await import('../config/domains')
    for (const role of ['pm', 'product owner', 'ml engineer', 'fullstack developer', 'qa', 'human resources']) {
      const id = roleToJobsDomain(role)
      expect(id && (JOB_DOMAIN_IDS as readonly string[]).includes(id)).toBe(true)
    }
  })
})
