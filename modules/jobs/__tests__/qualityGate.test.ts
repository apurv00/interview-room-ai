import { describe, it, expect } from 'vitest'
// Deliberately imported via the @jobs BARREL (not a relative path): this is
// the regression proof that the vitest resolver carries the @jobs alias in
// lockstep with tsconfig (Codex on #507 — tests resolving what the build
// resolves).
import {
  classifyJob, classifyApplyUrl, isBlockedApplyUrl, bestUsableTier,
  isStaffingOrg, normalizeJdBody, bodyHashOf, validThroughDate,
} from '@jobs'

// Ported from the probe's executable spec (scripts/jobs-liquidity-probe.test.mjs).
// Cases tagged [Cx-*] are accepted PR #503 review findings — never re-break.
// The probe stays the deterministic baseline of record: behavior here must
// match it byte-for-byte (ruling #16 dual-report reconciliation).

const base = { title: 'Backend Developer', company: 'Acme', applyUrls: ['https://careers.acme.com/1'] }
const longBody = 'A genuine role with real responsibilities and requirements. '.repeat(10)

describe('fee-fraud', () => {
  it('drops registration-fee and pay-before-joining shapes', () => {
    expect(classifyJob({ ...base, description: `${longBody} registration fee of Rs 500 applies` }).drops).toContain('fee-fraud')
    expect(classifyJob({ ...base, description: `${longBody} Pay Rs 500 before joining` }).drops).toContain('fee-fraud')
    expect(classifyJob({ ...base, description: `${longBody} refundable deposit required` }).drops).toContain('fee-fraud')
  })
  it('[Cx-27th] HTML markup must not split the phrase', () => {
    expect(classifyJob({ ...base, description: 'Pay registration <b>fee</b> of Rs 500 to apply' }).drops).toContain('fee-fraud')
  })
  it('[Cx-36th] entity-encoded whitespace must not split it either', () => {
    expect(classifyJob({ ...base, description: 'registration&nbsp;fee of Rs 500' }).drops).toContain('fee-fraud')
    expect(classifyJob({ ...base, description: 'Pay&nbsp;500&nbsp;before&nbsp;joining' }).drops).toContain('fee-fraud')
  })
  it('benign training mentions survive', () => {
    expect(classifyJob({ ...base, description: `${longBody} Salary paid after training completion` }).drops).not.toContain('fee-fraud')
  })
})

describe('title shapes', () => {
  it('walk-in variants drop', () => {
    expect(classifyJob({ ...base, title: 'Walk-in Drive: Sales Executive', description: longBody }).drops).toContain('title-walkin')
    expect(classifyJob({ ...base, title: 'walk in interview HR', description: longBody }).drops).toContain('title-walkin')
  })
  it('[Cx] contiguous phone in title drops; salary ranges survive', () => {
    expect(classifyJob({ ...base, title: 'Telecaller 9876543210', description: longBody }).drops).toContain('title-phone')
    expect(classifyJob({ ...base, title: 'Telecaller +919876543210', description: longBody }).drops).toContain('title-phone')
    expect(classifyJob({ ...base, title: 'Sales Executive 60000-70000 monthly', description: longBody }).drops).not.toContain('title-phone')
  })
  it('multirole, openings-count and CAPS shapes drop', () => {
    expect(classifyJob({ ...base, title: 'Sales/HR/Marketing/Operations Executive', description: longBody }).drops).toContain('title-multirole')
    expect(classifyJob({ ...base, title: 'Data Entry — 50 openings', description: longBody }).drops).toContain('title-openings')
    expect(classifyJob({ ...base, title: 'URGENT HIRING SALES EXECUTIVE', description: longBody }).drops).toContain('title-caps')
  })
})

describe('contact-spam', () => {
  const spamBody = `${longBody} For details call 98765 43210 immediately`
  it('drops phone-solicitation bodies with no usable apply path', () => {
    expect(classifyJob({ ...base, applyUrls: [], description: spamBody }).drops).toContain('contact-spam')
  })
  it('a non-redirect apply link exempts (platform detail page IS the apply path)', () => {
    expect(classifyJob({ ...base, applyUrls: ['https://apna.co/job/1'], description: spamBody }).drops).not.toContain('contact-spam')
  })
  it('[Bugbot-1] a blocklisted link does NOT exempt', () => {
    expect(classifyJob({ ...base, applyUrls: ['https://wa.me/919876543210'], description: spamBody }).drops).toContain('contact-spam')
  })
})

describe('apply-url blocklist and tier ladder', () => {
  it('[Cx] exact-host or suffix only — no substring matches', () => {
    expect(isBlockedApplyUrl('https://t.me/scamjobs')).toBe(true)
    expect(isBlockedApplyUrl('https://recruit.meesho.com/apply/1')).toBe(false)
    expect(isBlockedApplyUrl('https://chat.whatsapp.com/xyz')).toBe(true)
  })

  it("free-app-host suffix blocks the WHOLE subdomain space — the 'vacancy target jobs' flood (2026-07-16) hard-drops at ingest", () => {
    expect(isBlockedApplyUrl('https://vacancyglobal.up.railway.app/jobs/123')).toBe(true)
    // A freshly-minted subdomain gets nothing — the suffix is the lever.
    expect(isBlockedApplyUrl('https://totally-new-name.up.railway.app/apply')).toBe(true)
    // A posting whose ONLY apply path is the spam host drops entirely.
    const r = classifyJob({
      title: 'Senior Product Manager',
      company: 'vacancy target jobs',
      description: 'A genuine-looking role with responsibilities and requirements. '.repeat(10),
      applyUrls: ['https://vacancyglobal.up.railway.app/jobs/123'],
      validThrough: null,
    })
    expect(r.drops).toContain('blocklist-apply-domain')
  })

  it('[Cx-507] trailing DNS root dots cannot bypass the blocklist or tier ladder', () => {
    expect(isBlockedApplyUrl('https://wa.me./919876543210')).toBe(true)
    expect(isBlockedApplyUrl('https://chat.whatsapp.com./xyz')).toBe(true)
    expect(classifyApplyUrl('https://www.google.com./url?q=x')).toBe('aggregator-redirect')
    // and a legit host with a trailing dot still classifies normally
    expect(classifyApplyUrl('https://boards.greenhouse.io./acme/jobs/1')).toBe('direct-ats')
  })
  it('all-blocked apply set drops the row', () => {
    expect(classifyJob({ ...base, applyUrls: ['https://bit.ly/x', 'https://forms.gle/y'], description: longBody }).drops).toContain('blocklist-apply-domain')
  })
  it('[Cx] careers.google.com is an employer, google.com is a redirect', () => {
    expect(classifyApplyUrl('https://careers.google.com/jobs/1')).toBe('employer')
    expect(classifyApplyUrl('https://www.google.com/url?q=x')).toBe('aggregator-redirect')
  })
  it('ladder: ats > employer > deep > funnel', () => {
    expect(classifyApplyUrl('https://boards.greenhouse.io/acme/jobs/1')).toBe('direct-ats')
    expect(classifyApplyUrl('https://www.naukri.com/job-1')).toBe('aggregator-deep')
    expect(classifyApplyUrl('https://apna.co/job/1')).toBe('platform-funnel')
  })
  it('bestUsableTier ignores blocklisted urls', () => {
    expect(bestUsableTier(['https://wa.me/91987', 'https://www.naukri.com/j1'])).toBe('aggregator-deep')
    expect(bestUsableTier(['https://wa.me/91987'])).toBeNull()
  })
})

describe('validThrough', () => {
  it('expired drops; malformed flags visibly; future passes', () => {
    expect(classifyJob({ ...base, description: longBody, validThrough: '2020-01-01T00:00:00Z' }).drops).toContain('valid-through-expired')
    expect(classifyJob({ ...base, description: longBody, validThrough: 'not-a-date' }).flags).toContain('bad-valid-through')
    const future = classifyJob({ ...base, description: longBody, validThrough: '2999-01-01T00:00:00Z' })
    expect(future.drops).toHaveLength(0)
    expect(future.flags).not.toContain('bad-valid-through')
  })

  it('[Cx-507] a date-only validThrough stays valid through END of that day', () => {
    // JSON-LD sources commonly send 'YYYY-MM-DD'; midnight-UTC parsing
    // expired postings at the START of their closing day.
    const todayUtc = new Date().toISOString().slice(0, 10)
    expect(classifyJob({ ...base, description: longBody, validThrough: todayUtc }).drops).not.toContain('valid-through-expired')
    expect(classifyJob({ ...base, description: longBody, validThrough: '2020-01-01' }).drops).toContain('valid-through-expired')
    expect(validThroughDate(todayUtc)?.toISOString()).toBe(`${todayUtc}T23:59:59.999Z`)
  })
})

describe('flags', () => {
  it('staffing: named firms and word-shapes, one shared predicate', () => {
    expect(isStaffingOrg('TeamLease Services')).toBe(true)
    expect(isStaffingOrg('XYZ Manpower Consultancy')).toBe(true)
    expect(isStaffingOrg('Acme Software')).toBe(false)
    expect(classifyJob({ ...base, company: 'Randstad India', description: longBody }).flags).toContain('staffing')
  })
  it('no-company drops; confidential flags', () => {
    expect(classifyJob({ ...base, company: '', description: longBody }).drops).toContain('no-company')
    expect(classifyJob({ ...base, company: 'Confidential', description: longBody }).flags).toContain('confidential')
  })
  it('[Cx-37th] jdLen is normalized — entity-padded stubs stay under the 400 floor', () => {
    const stub = classifyJob({ ...base, description: 'hi&nbsp;'.repeat(80) })
    expect(stub.jdLen).toBeLessThan(400)
    expect(stub.flags).toContain('short-jd')
  })
})

describe('normalizeJdBody / bodyHashOf', () => {
  it('decodes whitespace entities and strips tags', () => {
    expect(normalizeJdBody('a&nbsp;b <b>c</b> d &amp; e')).toBe('a b c d & e')
  })
  it('bodyHashOf: tiny bodies mint no repost key; tag variants collapse', () => {
    expect(bodyHashOf('short')).toBeNull()
    const a = bodyHashOf(longBody)
    const b = bodyHashOf(`<p>${longBody}</p>`)
    expect(a).toMatch(/^[0-9a-f]{20}$/)
    expect(a).toBe(b)
  })

  it('[Cx-507] entity variants hash identically; entity padding cannot cross the 100-char floor', () => {
    // '&nbsp;' spelling of the same body must group with its plain twin in
    // the mass-repost counter, and a 240-raw-byte stub that normalizes to
    // ~90 chars must mint NO repost key.
    expect(bodyHashOf(longBody.replace(/ /g, '&nbsp;'))).toBe(bodyHashOf(longBody))
    expect(bodyHashOf('hi&nbsp;'.repeat(30))).toBeNull()
  })
})

describe('displayJdBody vs normalizeJdBody (PR-C, founder item 7)', () => {
  const HTML = '<div><p>Company&nbsp;Description</p><p>We build things &amp; ship.</p><ul><li>Own the roadmap</li><li>Talk to users</li></ul><br><br><br><p>Apply   now</p></div>'

  it('normalizeJdBody output is BYTE-IDENTICAL to its pre-PR-C behavior — it feeds bodyHashOf, the verdict inputHash, and every xray hash', async () => {
    const { normalizeJdBody } = await import('../services/qualityGate')
    // Pinned literal = the exact output of the pre-PR-C implementation.
    expect(normalizeJdBody(HTML)).toBe('Company Description We build things & ship. Own the roadmap Talk to users Apply now')
  })

  it('displayJdBody preserves paragraphs and line-per-item lists; collapses spaces only; caps blank runs', async () => {
    const { displayJdBody } = await import('../services/qualityGate')
    // NO bullet glyphs: the display shape must collapse back to the exact
    // canonical text (next vector) so version hashing sees one JD.
    expect(displayJdBody(HTML)).toBe(
      'Company Description\nWe build things & ship.\n\nOwn the roadmap\nTalk to users\n\nApply now'
    )
  })

  it('displayJdBody equals normalizeJdBody after whitespace collapse — same CONTENT, different shape', async () => {
    const { displayJdBody, normalizeJdBody } = await import('../services/qualityGate')
    expect(displayJdBody(HTML).replace(/\s+/g, ' ').trim()).toBe(normalizeJdBody(HTML))
  })
})

describe('xrayHashOf whitespace-insensitivity (PR-C — version binding survives the display twin)', () => {
  it('display-shaped and collapsed forms of the same JD hash IDENTICALLY; different content differs', async () => {
    const { xrayHashOf } = await import('../services/xrayService')
    const { displayJdBody, normalizeJdBody } = await import('../services/qualityGate')
    const HTML = '<p>Node.js engineer.</p><ul><li>MongoDB</li><li>Payments</li></ul>'
    expect(xrayHashOf(displayJdBody(HTML))).toBe(xrayHashOf(normalizeJdBody(HTML)))
    expect(xrayHashOf('completely different jd')).not.toBe(xrayHashOf(normalizeJdBody(HTML)))
    // No-op on already-collapsed inputs = every stored hash stays valid.
    expect(xrayHashOf('a b c')).toBe(xrayHashOf('  a  b\n c '))
  })
})

describe('legacyXrayHashOf (Codex #541 — resume hashes predate the collapse)', () => {
  it('legacy and current forms agree on collapsed text but differ on newline-bearing text', async () => {
    const { xrayHashOf, legacyXrayHashOf } = await import('../services/xrayService')
    expect(legacyXrayHashOf('a b c')).toBe(xrayHashOf('a b c')) // stored JD bodies: identical
    const resume = 'NAME\nRole\n\nThings I did'
    expect(legacyXrayHashOf(resume)).not.toBe(xrayHashOf(resume)) // raw resumes: the migration case
  })
})
