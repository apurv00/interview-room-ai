/**
 * Jobs domain taxonomy — KEYED ON THE INTERVIEW PRODUCT'S DOMAIN SLUGS
 * (shared/db/seed.ts BUILT_IN_DOMAINS / FALLBACK_DOMAINS). One vocabulary,
 * two views: the interview catalog is the namespace of record; each entry
 * here adds the jobs-side metadata (JSearch query, fresher weighting).
 *
 * Founder ruling 2026-07-12: the jobs feed and interview prep must never
 * run disjoint taxonomies — a job's domain IS an interview domain slug, so
 * the practice hand-off, readiness-per-domain, and the LLM verdict enum all
 * share one namespace with zero mapping tables. `interviewSlug: null` marks
 * the (rare, telemetry-tracked) jobs domains with no interview-side catalog
 * entry yet — the hand-off falls back to 'general' for those, and promoting
 * them into the interview catalog is a founder content decision (rubrics +
 * question banks), not a config flip.
 *
 * The drift guard: __tests__/domains.test.ts asserts every non-null
 * interviewSlug exists in FALLBACK_DOMAINS — a rename on either side is a
 * failing test, never a silent disjoint.
 */
export interface JobDomain {
  /** Interview-catalog slug when one exists — THE shared namespace. */
  id: string
  /** JSearch harvest query (country-parameterized at the adapter). */
  q: string
  interviewSlug: string | null
}

export const JOB_DOMAINS: readonly JobDomain[] = [
  // Programming / data
  { id: 'backend', q: 'backend developer', interviewSlug: 'backend' },
  { id: 'frontend', q: 'frontend developer', interviewSlug: 'frontend' },
  { id: 'fullstack', q: 'full stack developer', interviewSlug: 'fullstack' },
  { id: 'mobile', q: 'mobile app developer', interviewSlug: 'mobile' },
  { id: 'sdet', q: 'qa engineer', interviewSlug: 'sdet' },
  { id: 'devops', q: 'devops engineer', interviewSlug: 'devops' },
  { id: 'data-science', q: 'data scientist', interviewSlug: 'data-science' },
  { id: 'ml-engineer', q: 'machine learning engineer', interviewSlug: 'ml-engineer' },
  { id: 'data-analyst', q: 'data analyst', interviewSlug: 'data-analyst' },
  // Core engineering — the interview catalog always had these; the first
  // jobs taxonomy draft missed them (probe sampling frame ≠ product scope).
  { id: 'mechanical', q: 'mechanical engineer', interviewSlug: 'mechanical' },
  { id: 'civil', q: 'civil engineer', interviewSlug: 'civil' },
  { id: 'electrical', q: 'electrical engineer', interviewSlug: 'electrical' },
  { id: 'electronics', q: 'electronics engineer', interviewSlug: 'electronics' },
  // Product / design
  { id: 'pm', q: 'product manager', interviewSlug: 'pm' },
  { id: 'product-analyst', q: 'product analyst', interviewSlug: 'product-analyst' },
  { id: 'design', q: 'ui ux designer', interviewSlug: 'design' },
  // Business
  { id: 'business', q: 'business analyst', interviewSlug: 'business' },
  { id: 'strategy', q: 'strategy consultant', interviewSlug: 'strategy' },
  { id: 'operations', q: 'operations executive', interviewSlug: 'operations' },
  { id: 'finance', q: 'financial analyst', interviewSlug: 'finance' },
  { id: 'marketing', q: 'digital marketing', interviewSlug: 'marketing' },
  { id: 'sales', q: 'sales executive', interviewSlug: 'sales' },
  // Jobs-only (no interview-catalog entry yet — hand-off falls back to
  // 'general'; promotion into the catalog is an open founder decision).
  { id: 'hr', q: 'hr recruiter', interviewSlug: null },
] as const

export type JobDomainId = (typeof JOB_DOMAINS)[number]['id']
export const JOB_DOMAIN_IDS = JOB_DOMAINS.map((d) => d.id) as JobDomainId[]

/**
 * Fresher-heavy domains measured by the probe's G1f/G6 cells. Kept aligned
 * with the probe matrix for measurement continuity ('data-analyst' is the
 * probe's 'data' cell under the unified namespace).
 */
export const FRESHER_DOMAINS: JobDomainId[] = ['marketing', 'sales', 'electrical', 'data-analyst', 'hr']

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
  'data-analyst': /\b(data entry|data analyst|data operator|mis analyst|mis executive|mis)\b/i,
  hr: /\b(hr|human resources?|recruiter|recruitment|talent acquisition)\b/i,
}

export function matchFresherDomain(text = ''): string | null {
  for (const [d, re] of Object.entries(FRESHER_DOMAIN_PATTERNS)) if (re.test(text)) return d
  return null
}

/** The hand-off's role resolver: jobs-only domains (interviewSlug: null)
 *  fall back to 'general' — never write a jobs-only slug into
 *  InterviewConfig.role (Codex on #524). Unknown ids return undefined so
 *  callers can try the X-ray's inferredDomain next. */
export function interviewSlugForDomain(id: string | undefined | null): string | undefined {
  if (!id) return undefined
  const d = JOB_DOMAINS.find((x) => x.id === id)
  if (!d) return undefined
  return d.interviewSlug ?? 'general'
}
