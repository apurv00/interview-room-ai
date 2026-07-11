// Executable spec for the probe's gate-critical pure logic.
// Run: node --test scripts/jobs-liquidity-probe.test.mjs
// Every case tagged [Cx-N] is a regression test for an accepted Codex/review
// finding on PR #503 — these must never re-break.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  companyKey, titleKey, locationKey, fingerprint,
  classifyJob, classifyApplyUrl, isBlockedApplyUrl, bestUsableTier, isStaffingOrg,
  betterRepresentative, dedupKey, foldCandidates, pickRotSample, median, lenStats,
  isErroredBucket, gateBuckets, gateFingerprints, parseArgs,
  normalizeJSearchJob, accountBucket, detectMassReposts, computeVerdict,
  extractJsonLdJobPosting, matchFresherDomain,
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
  // [Cx-34th] plural scam wording must not escape
  assert.ok(d({ description: 'Registration fees of Rs 500 apply' }).includes('fee-fraud'))
  assert.ok(d({ description: 'Refundable deposits required before joining' }).includes('fee-fraud'))
  // [Cx-35th] amount-bearing pay-for-training shapes must not escape
  assert.ok(d({ description: 'Pay Rs 500 before joining' }).includes('fee-fraud'))
  assert.ok(d({ description: 'Pay ₹500 for training kit' }).includes('fee-fraud'))
  assert.ok(d({ description: 'Pay 1,000 before joining' }).includes('fee-fraud'))
  // benign: 'paid after training' — no pay(ment)-for/before shape at all.
  // NOTE: bare 'pay for training' DOES drop by design (classic scam copy).
  assert.ok(!d({ description: 'Salary paid after training completion' }).includes('fee-fraud'))
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

// ── audit-round regressions (the proper solve) ──────────────────────────────

test('[Audit-12] companyKey strips legal suffixes at the TAIL only', () => {
  assert.equal(companyKey('Corporation Bank'), 'corporation bank') // NOT 'bank'
  assert.equal(companyKey('Acme Pvt. Ltd.'), 'acme')
  assert.equal(companyKey('Quess Corp'), 'quess')
})

test('[Audit-3/8] messenger blocklist variants + exact Google hosts', () => {
  for (const u of ['https://chat.whatsapp.com/xyz', 'https://telegram.me/jobs', 'https://telegram.org/x', 'https://docs.google.com/forms/d/1']) {
    assert.equal(isBlockedApplyUrl(u), true, u)
    assert.equal(bestUsableTier([u]), null, u)
  }
  assert.equal(classifyApplyUrl('https://careers.google.com/jobs/1'), 'employer') // exact-host redirect set
  assert.equal(classifyApplyUrl('https://www.google.com/search?q=x'), 'aggregator-redirect')
  assert.equal(classifyApplyUrl('https://www.google.co.in/url?q=x'), 'aggregator-redirect')
})

test('[Audit-13] spaced phones hit contact-spam; salary-range titles stay undropped', () => {
  const spaced = classifyJob({ title: 'Telecaller', company: 'X', description: 'WhatsApp HR on 98765 43210 now', applyUrls: [] })
  assert.ok(spaced.drops.includes('contact-spam'))
  const salary = classifyJob({ title: 'Telecaller 60000-70000 salary', company: 'X', description: 'x '.repeat(300), applyUrls: ['https://a.com/1'] })
  assert.ok(!salary.drops.includes('title-phone'))
  // [Cx-26th] separator-less +91 numbers must not escape either pattern
  const plus91 = classifyJob({ title: 'Telecaller', company: 'X', description: 'Interested? WhatsApp +919876543210 now', applyUrls: [] })
  assert.ok(plus91.drops.includes('contact-spam'))
  const plus91Title = classifyJob({ title: 'Telecaller call +919876543210', company: 'X', description: '', applyUrls: [] })
  assert.ok(plus91Title.drops.includes('title-phone'))
  // [Cx-27th] HTML markup must not split hard-drop phrases
  const htmlFee = classifyJob({ title: 'Dev', company: 'X', description: 'Pay registration <b>fee</b> of Rs 500 to apply', applyUrls: [] })
  assert.ok(htmlFee.drops.includes('fee-fraud'))
  // [Cx-36th] entity-encoded whitespace must not split them either
  const nbspFee = classifyJob({ title: 'Dev', company: 'X', description: 'registration&nbsp;fee of Rs 500', applyUrls: [] })
  assert.ok(nbspFee.drops.includes('fee-fraud'))
  const nbspPay = classifyJob({ title: 'Dev', company: 'X', description: 'Pay&nbsp;500&nbsp;before&nbsp;joining', applyUrls: [] })
  assert.ok(nbspPay.drops.includes('fee-fraud'))
  const htmlSpam = classifyJob({ title: 'Telecaller', company: 'X', description: 'Call <strong>HR</strong> on <b>9876543210</b> now', applyUrls: [] })
  assert.ok(htmlSpam.drops.includes('contact-spam'))
})

test('[Audit-23] malformed validThrough is flagged, real expiry drops', () => {
  const bad = classifyJob({ title: 'Dev', company: 'Acme', description: 'x '.repeat(300), applyUrls: ['https://a.com/1'], validThrough: 'not-a-date' })
  assert.ok(bad.flags.includes('bad-valid-through') && !bad.drops.includes('valid-through-expired'))
  const expired = classifyJob({ title: 'Dev', company: 'Acme', description: 'x', applyUrls: [], validThrough: '2020-01-01' })
  assert.ok(expired.drops.includes('valid-through-expired'))
})

test('[Audit-5] named staffing firms flagged (spec seed list)', () => {
  for (const org of ['Quess Corp', 'TeamLease Services', 'Randstad India', 'Adecco Group']) {
    assert.ok(isStaffingOrg(org), org)
    assert.ok(classifyJob({ title: 'Dev', company: org, description: 'x '.repeat(300), applyUrls: ['https://a.com/1'] }).flags.includes('staffing'), org)
  }
  assert.ok(!isStaffingOrg('Acme Software'))
})

test('[Audit-4] foldCandidates: union urls -> best tier, earliest postedAt, max jdLen', () => {
  const a = { r: { postedAt: '2026-07-10T00:00:00Z', viaSite: 'x' }, urls: ['https://www.google.com/url?q=1'], drops: [], flags: [], jdLen: 900, tier: 'aggregator-redirect', fp: 'f1' }
  const b = { r: { postedAt: '2026-07-01T00:00:00Z', viaSite: 'y' }, urls: ['https://boards.greenhouse.io/x/jobs/1'], drops: [], flags: [], jdLen: 100, tier: 'direct-ats', fp: 'f1' }
  const m = foldCandidates(a, b)
  assert.equal(m.tier, 'direct-ats')          // union tier, not the representative's
  assert.equal(m.jdLen, 900)                  // max
  assert.equal(m.r.postedAt, '2026-07-01T00:00:00Z') // earliest non-null (repost re-stamps must not inflate G2)
  assert.equal(m.urls.length, 2)
  // [Cx-21st] a hard-dropped copy donates NOTHING: clean stub + fee-fraud
  // full-JD copy folds to the clean stub exactly as it was
  const cleanStub = { r: { postedAt: null, viaSite: '' }, urls: ['https://careers.acme.com/1'], drops: [], flags: [], jdLen: 100, tier: 'employer', fp: 'f2' }
  const droppedFull = { r: { postedAt: '2026-07-01T00:00:00Z', viaSite: '' }, urls: ['https://boards.greenhouse.io/x/jobs/2'], drops: ['fee-fraud'], flags: [], jdLen: 900, tier: 'direct-ats', fp: 'f2' }
  const folded = foldCandidates(cleanStub, droppedFull)
  assert.equal(folded.jdLen, 100)
  assert.deepEqual(folded.urls, ['https://careers.acme.com/1'])
  assert.equal(folded.drops.length, 0)
})

test('[Audit-2] mass-repost: >3 companyKeys drops, 2-3 flags', () => {
  const reps = ['a', 'b', 'c', 'd'].map(k => ({ bodyHash: 'H1', companyKey: k, drops: [], flags: [], jdLen: 500, tier: 'employer', urls: ['https://x.com/1'], fp: `f-${k}`, r: { postedAt: null, viaSite: '' } }))
  const two = ['p', 'q'].map(k => ({ bodyHash: 'H2', companyKey: k, drops: [], flags: [], jdLen: 500, tier: 'employer', urls: ['https://x.com/1'], fp: `g-${k}`, r: { postedAt: null, viaSite: '' } }))
  const { drop, flag } = detectMassReposts([...reps, ...two])
  assert.ok(drop.has('H1') && !drop.has('H2'))
  assert.ok(flag.has('H2') && !flag.has('H1'))
  const shell = { dropped: {}, flagged: {}, byTierAll: {}, byTierUsable: {}, viaSites: {}, fingerprints: [], uniqueNonDropped: 0, usable: 0, fullJd: 0, sampleApplyUrls: [] }
  const s = accountBucket(shell, [...reps, ...two], drop, flag)
  assert.equal(s.dropped['mass-repost'], 4)
  assert.equal(s.usable, 2)                   // only the H2 pair survives
  assert.equal(s.flagged['repost'], 2)
})

test('[Audit-18] JSON-LD @type arrays are recognized', () => {
  const html = '<script type="application/ld+json">{"@type":["JobPosting","Thing"],"title":"Dev"}</script>'
  assert.equal(extractJsonLdJobPosting(html)?.title, 'Dev')
})

test('[Audit-1] fresher-domain matcher', () => {
  assert.equal(matchFresherDomain('Digital Marketing Executive'), 'marketing')
  assert.equal(matchFresherDomain('Telecaller for field sales'), 'sales')
  assert.equal(matchFresherDomain('HR Recruiter (Fresher)'), 'hr')
  assert.equal(matchFresherDomain('Backend Developer'), null)
  // [Cx-17th] generic analysts must NOT land in the data fresher tally
  assert.equal(matchFresherDomain('Data Analyst'), 'data')
  assert.equal(matchFresherDomain('MIS Executive'), 'data')
  assert.equal(matchFresherDomain('Business Analyst'), null)
  assert.equal(matchFresherDomain('Financial Analyst'), null)
  // [Cx-35th] 'market' substring must not hijack marketing; HR spelled out counts
  assert.equal(matchFresherDomain('Stock Market Analyst'), null)
  assert.equal(matchFresherDomain('Supermarket Cashier'), null)
  assert.equal(matchFresherDomain('Marketing Executive'), 'marketing')
  assert.equal(matchFresherDomain('Human Resources Executive'), 'hr')
})

test('[Audit-9] gateBuckets: single population accessor filters errored + splits fresher', () => {
  const snap = { buckets: [
    { bucket: 'a', fresher: false, httpStatus: 200, usable: 5, fingerprints: [{ fp: 'x' }] },
    { bucket: 'b', fresher: false, httpStatus: 429, usable: 9, fingerprints: [{ fp: 'y' }] },
    { bucket: 'c', fresher: true, httpStatus: 200, usable: 3, fingerprints: [{ fp: 'z' }] },
  ] }
  assert.deepEqual(gateBuckets(snap).map(b => b.bucket), ['a'])
  assert.deepEqual(gateBuckets(snap, { fresher: true }).map(b => b.bucket), ['c'])
  assert.deepEqual(gateFingerprints(snap), ['x']) // errored bucket's fp never leaks
})

test('[Audit-7] computeVerdict: PASS / PARTIAL(scoped) / FAIL(<50% rule)', () => {
  const mkBucket = (domain, i, usable, fullJd, unique, fresher = false) => ({ bucket: `${domain}:${fresher ? 'fresher:' : ''}${i}`, domain, fresher, httpStatus: 200, usable, fullJd, uniqueNonDropped: unique, byTierUsable: { employer: usable }, fingerprints: [] })
  // PASS requires the fresher gate too ([Cx-28th])
  const pass = { buckets: [...['x', 'y'].flatMap(d => [0, 1].map(i => mkBucket(d, i, 25, 24, 25))), mkBucket('x', 0, 12, 11, 12, true)] }
  assert.equal(computeVerdict(pass).verdict, 'PASS')
  // Same strong core WITHOUT fresher coverage must NOT read PASS
  const noFresher = { buckets: ['x', 'y'].flatMap(d => [0, 1].map(i => mkBucket(d, i, 25, 24, 25))) }
  assert.equal(computeVerdict(noFresher).verdict, 'PARTIAL')
  // Strong core with a FAILING fresher domain caps at PARTIAL
  const weakFresher = { buckets: [...['x', 'y'].flatMap(d => [0, 1].map(i => mkBucket(d, i, 25, 24, 25))), mkBucket('x', 0, 3, 3, 3, true)] }
  assert.equal(computeVerdict(weakFresher).verdict, 'PARTIAL')
  // [Cx-29th] G1f is PER BUCKET: 5+5 across metros must NOT read as 10
  const summedFresher = { buckets: [...['x', 'y'].flatMap(d => [0, 1].map(i => mkBucket(d, i, 25, 24, 25))), mkBucket('x', 0, 5, 5, 5, true), mkBucket('x', 1, 5, 5, 5, true)] }
  assert.equal(computeVerdict(summedFresher).verdict, 'PARTIAL')
  const partial = { buckets: [...[0, 1].map(i => mkBucket('good', i, 25, 24, 25)), ...[0, 1].map(i => mkBucket('thin', i, 20, 19, 20))] }
  const pv = computeVerdict({ buckets: [...partial.buckets.slice(0, 2), mkBucket('thin', 0, 12, 11, 12), mkBucket('thin', 1, 12, 11, 12)] })
  assert.equal(pv.verdict, 'PARTIAL')
  assert.deepEqual(pv.passingDomains, ['good'])
  const fail = { buckets: [0, 1, 2, 3].map(i => mkBucket('dead', i, 2, 1, 2)) }
  assert.equal(computeVerdict(fail).verdict, 'FAIL')
})

test('[Cx-13th] computeVerdict counts errored core buckets as zero — never inflated by collection failures', () => {
  const ok = (domain, i) => ({ bucket: `${domain}:${i}`, domain, fresher: false, httpStatus: 200, usable: 25, fullJd: 24, uniqueNonDropped: 25, byTierUsable: { employer: 25 }, fingerprints: [] })
  const err = (domain, i) => ({ bucket: `${domain}:e${i}`, domain, fresher: false, httpStatus: 429, usable: 9, fullJd: 8, uniqueNonDropped: 9, byTierUsable: {}, fingerprints: [] })
  // 3 healthy + 3 errored: survivors alone would read PASS (median 25,
  // 100% pass-share); with errored-as-zero the pass share is 50% and the
  // median collapses — the verdict must NOT be PASS.
  const snap = { buckets: [ok('x', 0), ok('x', 1), ok('y', 0), err('y', 1), err('z', 0), err('z', 1)] }
  const v = computeVerdict(snap)
  assert.notEqual(v.verdict, 'PASS')
  assert.equal(v.gates.passSharePct, 50)
  assert.equal(v.gates.domainMedians.z, 0) // fully-errored domain reads zero, not absent
})

test('[Cx-15th] PARTIAL launch scope requires domain-level QUALITY, not just volume', () => {
  const mk = (domain, i, usable, fullJd, unique, tier = 'employer') => ({ bucket: `${domain}:${i}`, domain, fresher: false, httpStatus: 200, usable, fullJd, uniqueNonDropped: unique, byTierUsable: { [tier]: usable }, fingerprints: [] })
  // 'good' passes volume+quality; 'shiny' has volume (median 25) but 40%
  // full-JD; 'redirecty' has volume but zero employer-or-better share.
  const snap = { buckets: [
    mk('good', 0, 25, 24, 25), mk('good', 1, 25, 24, 25),
    mk('shiny', 0, 25, 10, 25), mk('shiny', 1, 25, 10, 25),
    mk('redirecty', 0, 25, 24, 25, 'aggregator-redirect'), mk('redirecty', 1, 25, 24, 25, 'aggregator-redirect'),
  ] }
  const v = computeVerdict(snap)
  assert.deepEqual(v.passingDomains, ['good']) // shiny + redirecty excluded despite median 25
})

test('[Audit-21] lenStats p50 uses the lower median', () => {
  assert.ok(lenStats([100, 500]).includes('p50=100'))
})

// ── CLI parsing ─────────────────────────────────────────────────────────────

test('[Rev-17] parseArgs: valued flags, bare flags, positionals', () => {
  assert.deepEqual(parseArgs(['--sample', '60']), { flags: { sample: '60' }, positional: [] })
  assert.deepEqual(parseArgs(['--sample']), { flags: { sample: true }, positional: [] })
  assert.deepEqual(parseArgs(['A.json', 'B.json']), { flags: {}, positional: ['A.json', 'B.json'] })
  assert.deepEqual(parseArgs(['snap.json', '--no-fresher']), { flags: { 'no-fresher': true }, positional: ['snap.json'] })
})
