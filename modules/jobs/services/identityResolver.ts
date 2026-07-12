import crypto from 'crypto'
import { METRO_ALIASES } from '../config/metros'

/**
 * Canonical identity — pure key/fingerprint layer (INGESTION §4.2).
 * Ported verbatim from the probe reference impl; identity stays 100%
 * deterministic and the LLM verdict NEVER informs it (ruling #10/#16).
 *
 * The DB resolution ladder (sourceKey → fingerprint → company-scoped fuzzy →
 * insert) lands with ingestPipeline; this file is everything pure under it,
 * including the §4.2 false-merge build-blocker guards:
 *   1. same-source/different-externalId salting → `fingerprintOf(..., salt)`
 *   2. confidentialCompany exemption → `fingerprintOf` returns null
 *   3-4. provenance eviction / merge ordering — pipeline concerns.
 */

// Anchored to the TAIL and iterated — an unanchored strip turned
// 'Corporation Bank' into 'bank', false-merging distinct employers.
// Separators between chained suffixes accept dots/commas as well as
// whitespace: 'Acme Pvt.Ltd.' must canonicalize identically to
// 'Acme Pvt Ltd' or the same employer mints two fingerprints and
// duplicate postings bypass the merge ladder (Codex on #507).
const LEGAL_SUFFIX_TAIL_RE = /([\s.,]+(pvt|private|ltd|limited|llp|inc|incorporated|corp|corporation))+[\s.,]*$/
const TITLE_STOPWORDS = new Set(['the', 'a', 'an', 'and', 'or', 'for', 'of', 'in', 'at', 'to', 'with'])
// Constructed (not literals): the tsconfig target predates the `u` flag's
// literal syntax; runtime semantics are identical on Node 18+.
const NON_ALNUM_RE = new RegExp('[^\\p{L}\\p{N} ]', 'gu')
const TOKEN_SPLIT_RE = new RegExp('[^\\p{L}\\p{N}+#]+', 'u')

export function companyKey(name = ''): string {
  return name.toLowerCase().replace(LEGAL_SUFFIX_TAIL_RE, '').replace(NON_ALNUM_RE, ' ').replace(/\s+/g, ' ').trim()
}

export function titleTokens(title = ''): string[] {
  const stripped = title.replace(/\(.*?\)|\[.*?\]/g, ' ').toLowerCase()
  return stripped.split(TOKEN_SPLIT_RE).filter((t) => t && !TITLE_STOPWORDS.has(t)).sort()
}

export function titleKey(title = ''): string {
  return titleTokens(title).join(' ')
}

export function locationKey(city = '', isRemote = false): string {
  if (isRemote) return 'remote-in'
  // Collapse separator spelling ("Delhi-NCR" / "Delhi NCR" / "delhi_ncr")
  // BEFORE alias lookup — source-dependent spelling must not mint distinct
  // fingerprints for the same metro.
  const c = city.toLowerCase().replace(/[-_/]+/g, ' ').replace(/\s+/g, ' ').trim()
  return METRO_ALIASES[c] || (c ? c.replace(/ /g, '-') : 'unknown')
}

export function isConfidentialCompany(name = ''): boolean {
  return /\bconfidential\b/i.test(name)
}

/**
 * Canonical fingerprint. Returns null for confidential companies (guard #2 —
 * they store NO fingerprint and never merge; the partial unique index exists
 * for exactly this). `salt` implements guard #1: two open postings from the
 * same source with different externalIds must not collapse — the caller
 * salts with refNumber/ordinal when the ladder detects that case.
 */
export function fingerprintOf(company: string, title: string, city: string, isRemote: boolean, salt = ''): string | null {
  if (isConfidentialCompany(company)) return null
  const base = `${companyKey(company)}|${titleKey(title)}|${locationKey(city, isRemote)}${salt ? `|${salt}` : ''}`
  return crypto.createHash('sha256').update(base).digest('hex').slice(0, 24)
}

/** Source-tier identity: `${sourceId}:${externalId}` — refresh matches only. */
export function sourceKeyOf(sourceId: string, externalId: string): string {
  return `${sourceId}:${externalId}`
}

/**
 * Token-set Jaccard over titleTokens — the fuzzy-merge tier's similarity.
 * The ladder applies it COMPANY-SCOPED only (same companyKey + location
 * overlap + jaccard ≥ 0.85); cross-company fuzzy merging is forbidden.
 */
export function titleJaccard(a: string, b: string): number {
  const sa = new Set(titleTokens(a))
  const sb = new Set(titleTokens(b))
  if (!sa.size && !sb.size) return 1
  if (!sa.size || !sb.size) return 0
  let inter = 0
  sa.forEach((t) => { if (sb.has(t)) inter++ })
  return inter / (sa.size + sb.size - inter)
}

export const FUZZY_MERGE_JACCARD = 0.85
