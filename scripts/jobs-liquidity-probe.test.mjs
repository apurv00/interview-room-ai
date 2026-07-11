// Executable spec for the probe's gate-critical pure logic.
// Run: node --test scripts/jobs-liquidity-probe.test.mjs
// Every case tagged [Cx-N] is a regression test for an accepted Codex/review
// finding on PR #503 — these must never re-break.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  companyKey, titleKey, locationKey, fingerprint,
  classifyJob, classifyApplyUrl, isBlockedApplyUrl, bestUsableTier,
  betterRepresentative, dedupKey, pickRotSample, median, isErroredBucket, parseArgs,
  normalizeJSearchJob,
} from './jobs-liquidity-probe.mjs'

// ── normalization ───────────────────────────────────────────────────────────

test('companyKey strips LEGAL suffixes only — never business nouns', () => {
  assert.equal(companyKey('Acme Pvt. Ltd.'), 'acme')
  assert.equal(companyKey('Acme Private Limited'), 'acme')
  assert.equal(companyKey('Acme Solutions LLP'), 'acme solutions') // 'solutions' must survive
  assert.equal(companyKey('Acme Technologies Inc'), 'acme technologies')
})

test('titleKey strips parens/stopwords, keeps seniority, sorts tokens', () => {
  assert.equal(titleKey('Senior Backend Developer (Remote)'), titleKey('Backend Senior Developer'))
  assert.notEqual(titleKey('Senior Backend Developer'), titleKey('Backend Developer')) // seniority kept
  assert.equal(titleKey('Manager, Marketing'), titleKey('Marketing Manager'))
})

test('[Cx-5th] locationKey: metro spelling variants mint ONE key', () => {
  for (const c of ['Delhi NCR', 'Delhi-NCR', 'delhi_ncr', 'NCR', 'Gurugram', 'Noida', 'New Delhi']) {
    assert.equal(locationKey(c, false), 'delhi-ncr', c)
  }
  assert.equal(locationKey('Navi Mumbai', false), 'mumbai')
  assert.equal(locationKey('Coimbatore', false), 'coimbatore')
  assert.equal(locationKey('Sri City', false), 'sri-city') // unknown cities: stable dashed form
  assert.equal(locationKey('', true), 'remote-in')
  assert.equal(locationKey('', false), 'unknown')
})

test('[Cx-5th] fingerprint parity across metro spellings; distinct across companies', () => {
  assert.equal(fingerprint('Acme', 'Dev', 'Delhi NCR', false), fingerprint('Acme', 'Dev', 'Gurugram', false))
  assert.notEqual(fingerprint('Acme', 'Dev', 'Delhi', false), fingerprint('Zeta', 'Dev', 'Delhi', false))
})

// ── apply-url tiers + blocklist ─────────────────────────────────────────────

test('classifyApplyUrl tier matrix', () => {
  assert.equal(classifyApplyUrl('https://boards.greenhouse.io/x/jobs/1'), 'direct-ats')
  assert.equal(classifyApplyUrl('https://jobs.lever.co/x/1'), 'direct-ats')
  assert.equal(classifyApplyUrl('https://in.linkedin.com/jobs/view/1'), 'aggregator-deep')
  assert.equal(classifyApplyUrl('https://apna.co/job/x'), 'platform-funnel')
  assert.equal(classifyApplyUrl('https://www.google.com/search?q=x'), 'aggregator-redirect')
  assert.equal(classifyApplyUrl('https://careers.acme.com/1'), 'employer')
  assert.equal(classifyApplyUrl('not-a-url'), 'aggregator-redirect')
})

test('[Rev-14] host blocklist is exact/suffix, never substring', () => {
  // 'recruit.meesho.com'.includes('t.me') === true — must NOT be dropped
  const ok = classifyJob({ title: 'Dev', company: 'Meesho', description: 'x '.repeat(300), applyUrls: ['https://recruit.meesho.com/j/1'] })
  assert.ok(!ok.drops.includes('blocklist-apply-domain'))
  const blocked = classifyJob({ title: 'Dev', company: 'X', description: 'x '.repeat(300), applyUrls: ['https://wa.me/919876543210'] })
  assert.ok(blocked.drops.includes('blocklist-apply-domain'))
})

test('[Bugbot-1] blocklisted hosts are excluded from tier ranking everywhere', () => {
  assert.equal(isBlockedApplyUrl('https://wa.me/919876543210'), true)
  assert.equal(isBlockedApplyUrl('https://t.me/hrjobs'), true)
  assert.equal(isBlockedApplyUrl('https://recruit.meesho.com/j/1'), false) // suffix, not substring
  // wa.me alone: NO usable tier (previously ranked tier-1 'employer')
  assert.equal(bestUsableTier(['https://wa.me/919876543210']), null)
  // wa.me + google redirect: the redirect is the only real tier left
  assert.equal(bestUsableTier(['https://wa.me/x', 'https://www.google.com/url?q=1']), 'aggregator-redirect')
  // wa.me + genuine employer link: employer wins, spam link never sampled
  assert.equal(bestUsableTier(['https://wa.me/x', 'https://careers.acme.com/1']), 'employer')
})

// ── quality gate ────────────────────────────────────────────────────────────

test('hard drops: walk-in, phone-in-title, multirole, openings, caps, fee-fraud, no-company, expired', () => {
  const d = (o) => classifyJob({ title: 'Dev', company: 'Acme', description: '', applyUrls: [], ...o }).drops
  assert.ok(d({ title: 'Walk-in interview for BPO' }).includes('title-walkin'))
  assert.ok(d({ title: 'Dev call 9876543210' }).includes('title-phone'))
  assert.ok(d({ title: 'Dev/QA/Support/Sales/HR' }).includes('title-multirole'))
  assert.ok(d({ title: 'Telecaller 50 openings' }).includes('title-openings'))
  assert.ok(d({ title: 'URGENT HIRING TELECALLERS NOW' }).includes('title-caps'))
  assert.ok(d({ description: 'Pay registration fee of Rs 500 to apply' }).includes('fee-fraud'))
  assert.ok(d({ company: '  ' }).includes('no-company'))
  assert.ok(d({ validThrough: '2020-01-01' }).includes('valid-through-expired'))
})

test('[Cx-7th] contact-spam: body solicitation drops ONLY without a real apply path', () => {
  const spamBody = 'Interested candidates Call HR 9876543210 or WhatsApp now'
  const drops = (urls) => classifyJob({ title: 'Telecaller', company: 'X Services', description: spamBody, applyUrls: urls }).drops
  assert.ok(drops(['https://www.google.com/redirect?x=1']).includes('contact-spam'))          // redirect-only
  assert.ok(drops([]).includes('contact-spam'))                                                // no links at all
  assert.ok(!drops(['https://careers.xservices.com/apply/1']).includes('contact-spam'))        // real employer link
  assert.ok(!drops(['https://jobs.lever.co/x/1']).includes('contact-spam'))                    // ATS link
})

test('[Cx-8th] blocklisted hosts never count as a real apply path for contact-spam', () => {
  const spamBody = 'Interested? WhatsApp HR on 9876543210 now'
  // wa.me would fall through classifyApplyUrl to 'employer' — the blocklist
  // check must run first, so wa.me + google-redirect still drops.
  const r = classifyJob({ title: 'Telecaller', company: 'X', description: spamBody, applyUrls: ['https://wa.me/919876543210', 'https://www.google.com/url?q=x'] })
  assert.ok(r.drops.includes('contact-spam'))
})

test('flags (not drops): staffing, confidential, short-jd; clean job has neither', () => {
  const staffing = classifyJob({ title: 'Dev', company: 'TalentFirst Staffing', description: 'x '.repeat(300), applyUrls: ['https://a.com/1'] })
  assert.ok(staffing.flags.includes('staffing') && staffing.drops.length === 0)
  const short = classifyJob({ title: 'Dev', company: 'Acme', description: 'short', applyUrls: ['https://a.com/1'] })
  assert.ok(short.flags.includes('short-jd'))
  const clean = classifyJob({ title: 'Backend Developer', company: 'Acme', description: 'Great role. '.repeat(60), applyUrls: ['https://careers.acme.com/1'] })
  assert.deepEqual(clean.drops, [])
  assert.deepEqual(clean.flags, [])
})

// ── duplicate representative selection ──────────────────────────────────────

test('[Cx-7th] betterRepresentative: not-dropped > full-JD > tier > length', () => {
  const mk = (o) => ({ drops: [], flags: [], jdLen: 500, tier: 'employer', ...o })
  assert.ok(betterRepresentative(mk({}), mk({ drops: ['title-walkin'] })))            // not-dropped wins
  assert.ok(betterRepresentative(mk({ jdLen: 500 }), mk({ jdLen: 100 })))             // full-JD wins
  assert.ok(betterRepresentative(mk({ tier: 'direct-ats' }), mk({ tier: 'platform-funnel' })))
  assert.ok(betterRepresentative(mk({ jdLen: 900 }), mk({ jdLen: 500 })))             // longer JD tiebreak
  assert.ok(!betterRepresentative(mk({ jdLen: 100 }), mk({ jdLen: 500 })))
})

test('[Cx-10th] JSearch expiration maps to validThrough and triggers the expired drop', () => {
  const r = normalizeJSearchJob({
    job_title: 'Dev', employer_name: 'Acme', job_city: 'Pune',
    job_description: 'x', job_offer_expiration_datetime_utc: '2020-01-01T00:00:00Z',
  })
  assert.equal(r.validThrough, '2020-01-01T00:00:00Z')
  const { drops } = classifyJob({ title: r.title, company: r.company, description: 'x '.repeat(300), applyUrls: ['https://careers.acme.com/1'], validThrough: r.validThrough })
  assert.ok(drops.includes('valid-through-expired'))
  // absent expiration -> null -> no drop
  assert.equal(normalizeJSearchJob({ job_title: 'Dev', employer_name: 'Acme' }).validThrough, null)
})

test('[Cx-9th] confidential rows never merge and mint no identity (spec §4.2)', () => {
  const conf = { flags: ['confidential'], fp: 'samefp' }
  assert.notEqual(dedupKey(conf, 0), dedupKey(conf, 1))       // two confidential rows: distinct keys
  assert.equal(dedupKey({ flags: [], fp: 'samefp' }, 5), 'samefp') // normal rows: fingerprint key
})

test('[Cx-9th] pickRotSample is breadth-first: every bucket first, then seconds', () => {
  const lists = [
    { bucket: 'a', urls: ['a1', 'a2'] },
    { bucket: 'b', urls: ['b1'] },
    { bucket: 'c', urls: ['c1', 'c2'] },
  ]
  const { picked, contributed } = pickRotSample(lists, 5)
  assert.deepEqual(picked, ['a1', 'b1', 'c1', 'a2', 'c2'])    // all firsts before any second
  assert.equal(contributed.size, 3)
  // cap >= bucket count guarantees every linked bucket contributes
  const many = Array.from({ length: 90 }, (_, i) => ({ bucket: `b${i}`, urls: [`u${i}`] }))
  const wide = pickRotSample(many, Math.max(40, many.length))
  assert.equal(wide.contributed.size, 90)
})

// ── gate arithmetic ─────────────────────────────────────────────────────────

test('[Rev-11] median: lower value for even-length arrays (bias toward FAIL)', () => {
  assert.equal(median([19, 20]), 19)
  assert.equal(median([1, 2, 3, 100]), 2)
  assert.equal(median([5]), 5)
  assert.equal(median([]), 0)
})

test('[Rev-1/Cx-4th] isErroredBucket: error field OR any non-200 status', () => {
  assert.ok(isErroredBucket({ error: 'http-429' }))
  assert.ok(isErroredBucket({ httpStatus: 429 }))                 // pre-fix artifacts: status without error field
  assert.ok(isErroredBucket({ httpStatus: 200, error: 'http-429-partial' })) // partial fetch
  assert.ok(!isErroredBucket({ httpStatus: 200 }))
  assert.ok(!isErroredBucket({}))                                 // non-bucket-shaped objects are not errored
})

// ── CLI parsing ─────────────────────────────────────────────────────────────

test('[Rev-17] parseArgs: valued flags, bare flags, positionals', () => {
  assert.deepEqual(parseArgs(['--sample', '60']), { flags: { sample: '60' }, positional: [] })
  assert.deepEqual(parseArgs(['--sample']), { flags: { sample: true }, positional: [] })
  assert.deepEqual(parseArgs(['A.json', 'B.json']), { flags: {}, positional: ['A.json', 'B.json'] })
  assert.deepEqual(parseArgs(['snap.json', '--no-fresher']), { flags: { 'no-fresher': true }, positional: ['snap.json'] })
})
