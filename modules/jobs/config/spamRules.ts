/**
 * Deterministic quality-gate rules (INGESTION §4.5 layer 1 — the permanent
 * BLOCKING floor per rulings #15/#16; the LLM verdict only ADDS severity).
 *
 * Every pattern here is ported VERBATIM from the probe reference impl
 * (scripts/jobs-liquidity-probe.mjs) — 38 review rounds hardened them; the
 * probe stays the deterministic baseline of record, so any change here must
 * also land there or the ruling-#16 dual-report reconciliation drifts.
 * A CMS overlay (blocklist-company + extra apply-domains) composes at the
 * qualityGate call site; these are the code-side floors.
 */

// whatsapp.com covers api./chat./www. via suffix matching; telegram.me/.org
// beside t.me; docs.google.com is the Google-Forms vector (same as forms.gle).
export const APPLY_DOMAIN_BLOCKLIST = [
  'bit.ly', 'forms.gle', 'docs.google.com', 'wa.me', 'whatsapp.com',
  't.me', 'telegram.me', 'telegram.org', 'tinyurl.com',
]

export const CONSULTANCY_RE = /\b(consultanc\w*|consultants?|staffing|manpower|placements?|recruitment\s+(services|agency|firm)|hr\s+(services|solutions)|talent\s+(acquisition|solutions)\s+(llp|pvt|private))\b/i

// §4.5 names TeamLease/Randstad/Quess explicitly — India's largest staffing
// firms match no generic word-shape.
export const STAFFING_NAMES_RE = /\b(teamlease|randstad|quess|adecco|kelly\s?services|gi\s?group|persolkelly|ciel\s?hr|innovsource|firstmeridian)\b/i

// The pay branch allows an optional currency/amount between the verb and the
// training/joining phrase — 'Pay Rs 500 before joining' is the common Indian
// scam shape.
export const FEE_FRAUD_RE = /\b(registration|security)\s+(fees?|deposits?|amounts?)\b|\bpay(ment)?\s+(((rs\.?|inr|₹)\s*)?[\d,]+\s+)?(for|before)\s+(training|joining)\b|\brefundable\s+deposits?\b/i

// Body-side phone matching allows one internal separator ('98765 43210');
// (+91-prefix OR word boundary) — '+919876543210' has no \b between the
// country code and the local digits, so \b-only patterns missed it.
export const SPACED_PHONE = '(\\+91[\\s-]?|\\b)[6-9]\\d{4}[\\s-]?\\d{5}\\b'
export const CONTACT_SPAM_RE = new RegExp(
  `(\\bcall\\b|\\bwhats\\s?app\\b)[\\s\\S]{0,60}?${SPACED_PHONE}|${SPACED_PHONE}[\\s\\S]{0,60}?(\\bcall\\b|\\bwhats\\s?app\\b)`,
  'i'
)

// ── Apply-tier ladder hosts (INGESTION §4.2) ──
// EXACT hosts only for the redirect set — substring 'google.' demoted
// careers.google.com to tier-4. docs.google.com is handled by the blocklist,
// not the tier ladder.
export const GOOGLE_REDIRECT_HOSTS = new Set([
  'google.com', 'www.google.com', 'google.co.in', 'www.google.co.in', 'g.co', 'www.g.co',
])
export const ATS_HOSTS = [
  'greenhouse.io', 'lever.co', 'smartrecruiters.com', 'ashbyhq.com',
  'workable.com', 'bamboohr.com', 'jobvite.com', 'icims.com', 'myworkdayjobs.com',
]
export const AGG_DEEP_HOSTS = [
  'naukri.com', 'linkedin.com', 'indeed.com', 'shine.com', 'foundit.in',
  'monsterindia.com', 'timesjobs.com', 'glassdoor.com', 'glassdoor.co.in',
]
export const FUNNEL_HOSTS = ['apna.co', 'unstop.com', 'internshala.com', 'cutshort.io', 'instahyre.com']

export const APPLY_TIERS = ['direct-ats', 'employer', 'aggregator-deep', 'platform-funnel', 'aggregator-redirect'] as const
export type ApplyTier = (typeof APPLY_TIERS)[number]
export const TIER_RANK: Record<ApplyTier, number> = {
  'direct-ats': 0, employer: 1, 'aggregator-deep': 2, 'platform-funnel': 3, 'aggregator-redirect': 4,
}
