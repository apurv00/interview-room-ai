import crypto from 'crypto'
import {
  APPLY_DOMAIN_BLOCKLIST, CONSULTANCY_RE, STAFFING_NAMES_RE, FEE_FRAUD_RE, CONTACT_SPAM_RE,
  GOOGLE_REDIRECT_HOSTS, ATS_HOSTS, AGG_DEEP_HOSTS, FUNNEL_HOSTS, TIER_RANK, type ApplyTier,
} from '../config/spamRules'

/**
 * Deterministic quality gate (INGESTION §4.5 layer 1 — permanent BLOCKING
 * floor per rulings #15/#16). Pure port of the probe's classifyJob & apply-tier
 * ladder; the probe stays the baseline of record and behavior should match it
 * (the ruling-#16 dual-report compares the two). Two DOCUMENTED divergences
 * pending the probe's SCHEMA_VERSION amendment, which ports both back
 * (Codex on #507): (1) date-only validThrough = end-of-day, not midnight;
 * (2) bodyHashOf runs the shared entity-decoding normalization;
 * (3) hostOf strips trailing DNS root dots before blocklist/tier matching.
 *
 * Run-level rules (mass-repost Redis counter, CMS blocklist overlay) compose
 * at the ingestPipeline call site — they need I/O this pure layer must not.
 */

export type DropRule =
  | 'no-company' | 'title-walkin' | 'title-phone' | 'title-multirole' | 'title-openings'
  | 'title-caps' | 'fee-fraud' | 'contact-spam' | 'blocklist-apply-domain' | 'valid-through-expired'
export type FlagRule = 'bad-valid-through' | 'staffing' | 'confidential' | 'short-jd'

export interface ClassifyInput {
  title?: string
  company?: string
  description?: string
  applyUrls?: string[]
  validThrough?: string | null
}
export interface ClassifyResult {
  drops: DropRule[]
  flags: FlagRule[]
  /** Normalized (tag-stripped, entity-decoded) body length — the 400 floor's input. */
  jdLen: number
}

export function hostOf(u: string): string {
  // Strip trailing DNS root dots — 'https://wa.me./x' yields hostname
  // 'wa.me.', which matches neither the exact entry nor the '.suffix'
  // rule and would fall through as an 'employer' apply path
  // (Codex on #507).
  try { return new URL(u).hostname.toLowerCase().replace(/\.+$/, '') } catch { return '' }
}
// Exact host or registrable-suffix match ONLY — substring includes() matched
// 'recruit.meesho.com'.includes('t.me') and hard-dropped legitimate employers.
function hostMatches(host: string, entry: string): boolean {
  return host === entry || host.endsWith('.' + entry)
}

/**
 * A blocklisted host is never an apply path, ANYWHERE — not for contact-spam
 * exemption, not for tier ranking, not for usable math. classifyApplyUrl
 * falls unknown hosts through to 'employer', so every tier consumer must
 * filter through this first.
 */
export function isBlockedApplyUrl(u: string): boolean {
  return APPLY_DOMAIN_BLOCKLIST.some((b) => hostMatches(hostOf(u), b))
}

export function classifyApplyUrl(url: string): ApplyTier {
  const h = hostOf(url)
  if (!h) return 'aggregator-redirect'
  if (ATS_HOSTS.some((a) => hostMatches(h, a))) return 'direct-ats'
  if (AGG_DEEP_HOSTS.some((a) => hostMatches(h, a))) return 'aggregator-deep'
  if (FUNNEL_HOSTS.some((a) => hostMatches(h, a))) return 'platform-funnel'
  if (GOOGLE_REDIRECT_HOSTS.has(h)) return 'aggregator-redirect'
  return 'employer'
}

/** Tier of the best NON-BLOCKLISTED apply URL — the only tier gate math may use. */
export function bestUsableTier(urls: string[]): ApplyTier | null {
  const usable = urls.filter((u) => !isBlockedApplyUrl(u))
  return usable.map(classifyApplyUrl).sort((a, b) => TIER_RANK[a] - TIER_RANK[b])[0] || null
}

export function isStaffingOrg(name = ''): boolean {
  return CONSULTANCY_RE.test(name) || STAFFING_NAMES_RE.test(name)
}

/**
 * Body normalization shared by the drop regexes, jdLen and (later) the LLM
 * verdict prompt: tag-strip + entity-decode — 'registration <b>fee</b>' and
 * 'registration&nbsp;fee' must both reach FEE_FRAUD_RE as plain words.
 */
export function normalizeJdBody(description = ''): string {
  return description
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(nbsp|#160|#xa0);/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ').trim()
}

/**
 * Display-facing JD normalization (founder item 7, 2026-07-16): the stored
 * body had ALL whitespace collapsed by normalizeJdBody, so the detail
 * page's pre-wrap renderer had nothing to preserve — a prod pm sample ran
 * 7,757 chars with ZERO newlines. This variant keeps block structure.
 *
 * It exists ALONGSIDE normalizeJdBody, whose output must stay
 * byte-identical forever: it feeds bodyHashOf (repost fingerprints), the
 * verdict inputHash, and — via jdCompressed — every xrayHashOf consumer
 * (parse cache, ATS identity, readiness JD-version binding). The display
 * body is a SEPARATE stored artifact (jdDisplayCompressed) precisely so
 * no hash input ever changes.
 */
export function displayJdBody(description = ''): string {
  return description
    .replace(/<\s*br\s*\/?\s*>/gi, '\n')
    // <li> gets its own LINE, deliberately no bullet glyph: the display
    // body must collapse back to the EXACT canonical text so
    // whitespace-insensitive hashing (xrayHashOf) sees one JD version —
    // an inserted '• ' is content the canonical form lacks and would
    // split the version hash (pinned by test).
    // Openers only for <li> — a </li><li> pair must not double-emit.
    .replace(/<\s*li[^>]*>/gi, '\n')
    .replace(/<\s*\/\s*(p|div|section|ul|ol|h[1-6]|tr|table|blockquote)\s*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(nbsp|#160|#xa0);/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/[^\S\n]+/g, ' ') // collapse spaces/tabs — newlines survive
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n') // cap blank runs at one empty line
    .trim()
}

export function classifyJob({ title = '', company = '', description = '', applyUrls = [], validThrough = null }: ClassifyInput): ClassifyResult {
  const drops: DropRule[] = []
  const flags: FlagRule[] = []
  const t = title.trim()
  if (!company.trim()) drops.push('no-company')
  if (/\bwalk[\s-]?in\b/i.test(t)) drops.push('title-walkin')
  // Contiguous-only — '60000-70000' in a salary-bearing title must not drop.
  if (/(\+91[\s-]?|\b)[6-9]\d{9}\b/.test(t)) drops.push('title-phone')
  if (t.split('/').length > 3) drops.push('title-multirole')
  if (/\b\d+\s*openings?\b/i.test(t)) drops.push('title-openings')
  const letters = t.replace(/[^a-zA-Z]/g, '')
  if (letters.length > 10 && letters.replace(/[^A-Z]/g, '').length / letters.length > 0.7) drops.push('title-caps')

  const body = normalizeJdBody(description)
  if (FEE_FRAUD_RE.test(body)) drops.push('fee-fraud')
  const hasNonRedirectApply = applyUrls.some((u) => !isBlockedApplyUrl(u) && classifyApplyUrl(u) !== 'aggregator-redirect')
  if (CONTACT_SPAM_RE.test(body) && !hasNonRedirectApply) drops.push('contact-spam')
  if (applyUrls.length && applyUrls.every(isBlockedApplyUrl)) drops.push('blocklist-apply-domain')
  // Malformed dates must be VISIBLE, not silently alive: NaN passes neither
  // branch, so bad dates get a flag and real expiries get the drop.
  if (validThrough) {
    // Date-only values (JSON-LD sources commonly send 'YYYY-MM-DD') parse
    // to midnight UTC, which would expire a posting at the START of its
    // closing day — treat them as valid through END of that day
    // (Codex on #507).
    const isDateOnly = /^\d{4}-\d{2}-\d{2}$/.test(validThrough.trim())
    const vt = new Date(isDateOnly ? `${validThrough.trim()}T23:59:59.999Z` : validThrough).getTime()
    if (Number.isNaN(vt)) flags.push('bad-valid-through')
    else if (vt < Date.now()) drops.push('valid-through-expired')
  }

  if (isStaffingOrg(company)) flags.push('staffing')
  if (/\bconfidential\b/i.test(company)) flags.push('confidential')
  const jdLen = body.length
  if (jdLen < 400) flags.push('short-jd')
  return { drops, flags, jdLen }
}

/**
 * sha1 of the normalized JD body — the mass-repost key (Redis 7d counter at
 * the pipeline layer). Tiny bodies (<100 chars) hash to noise → null.
 */
export function bodyHashOf(description = ''): string | null {
  // Same normalization the drop regexes and jdLen use (Codex on #507):
  // entity-encoded variants of one body must hash identically, and
  // entity-padded stubs must not cross the 100-char floor on raw bytes.
  const norm = normalizeJdBody(description).toLowerCase().slice(0, 2000)
  return norm.length >= 100 ? crypto.createHash('sha1').update(norm).digest('hex').slice(0, 20) : null
}
