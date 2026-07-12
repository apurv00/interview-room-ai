/**
 * Job domain taxonomy (INGESTION §4.0). The 13 launch domains mirror the
 * liquidity-probe bucket matrix — under ruling #17 these are the G1 verdict
 * cells (domain × country). The LLM verdict (ruling #16) classifies each
 * posting into one of these at ingest; JOB_DOMAIN_IDS is the closed enum the
 * verdict schema validates against.
 */
export const JOB_DOMAINS = [
  { id: 'backend', q: 'backend developer' },
  { id: 'frontend', q: 'frontend developer' },
  { id: 'sdet', q: 'qa engineer' },
  { id: 'data', q: 'data analyst' },
  { id: 'devops', q: 'devops engineer' },
  { id: 'pm', q: 'product manager' },
  { id: 'marketing', q: 'digital marketing' },
  { id: 'sales', q: 'sales executive' },
  { id: 'business', q: 'business analyst' },
  { id: 'finance', q: 'financial analyst' },
  { id: 'hr', q: 'hr recruiter' },
  { id: 'design', q: 'ui ux designer' },
  { id: 'electrical', q: 'electrical engineer' },
] as const

export type JobDomainId = (typeof JOB_DOMAINS)[number]['id']
export const JOB_DOMAIN_IDS = JOB_DOMAINS.map((d) => d.id) as JobDomainId[]

/** Fresher-heavy domains measured separately (G1f/G6). */
export const FRESHER_DOMAINS: JobDomainId[] = ['marketing', 'sales', 'electrical', 'data', 'hr']

/**
 * Deterministic fresher-domain matcher — ingest-side fallback only; the LLM
 * verdict's seniority/fresherFriendly fields supersede this for serving
 * (ruling #16; these regexes are India-anchored and brittle by construction —
 * see the probe's #503 history: supermarket≠marketing, Telecaller, bare-analyst).
 */
export const FRESHER_DOMAIN_PATTERNS: Record<string, RegExp> = {
  marketing: /\b(marketing|digital marketing|social media|seo|brand(ing)?)\b/i,
  sales: /\b(sales|business development|telecall(er|ers|ing)?|telesales|field sales)\b/i,
  electrical: /electric/i,
  data: /\b(data entry|data analyst|data operator|mis analyst|mis executive|mis)\b/i,
  hr: /\b(hr|human resources?|recruiter|recruitment|talent acquisition)\b/i,
}

export function matchFresherDomain(text = ''): string | null {
  for (const [d, re] of Object.entries(FRESHER_DOMAIN_PATTERNS)) if (re.test(text)) return d
  return null
}
