/**
 * Roster taxonomy for QA matrix — mirrors modules/interview/config/staticData.ts
 * and shared/db/seed.ts depth applicability (category-aware).
 * Update when STATIC_DOMAINS / STATIC_DEPTHS change.
 */

/** @type {{ slug: string, categorySlug: string }[]} */
export const ROSTER_DOMAINS = [
  { slug: 'frontend', categorySlug: 'programming' },
  { slug: 'backend', categorySlug: 'programming' },
  { slug: 'sdet', categorySlug: 'programming' },
  { slug: 'data-science', categorySlug: 'data-ai' },
  { slug: 'pm', categorySlug: 'product' },
  { slug: 'design', categorySlug: 'design' },
  { slug: 'business', categorySlug: 'business' },
  { slug: 'mechanical', categorySlug: 'core-engineering' },
  { slug: 'civil', categorySlug: 'core-engineering' },
  { slug: 'electrical', categorySlug: 'core-engineering' },
  { slug: 'electronics', categorySlug: 'core-engineering' },
  { slug: 'fullstack', categorySlug: 'programming' },
  { slug: 'devops', categorySlug: 'programming' },
  { slug: 'mobile', categorySlug: 'programming' },
  { slug: 'ml-engineer', categorySlug: 'data-ai' },
  { slug: 'data-analyst', categorySlug: 'data-ai' },
  { slug: 'strategy', categorySlug: 'business' },
  { slug: 'finance', categorySlug: 'business' },
  { slug: 'operations', categorySlug: 'business' },
  { slug: 'marketing', categorySlug: 'business' },
  { slug: 'sales', categorySlug: 'business' },
  { slug: 'product-analyst', categorySlug: 'product' },
  { slug: 'ui-designer', categorySlug: 'design' },
  { slug: 'product-designer', categorySlug: 'design' },
  { slug: 'general', categorySlug: 'general' },
]

/** @type {{ slug: string, domains?: string[], categories?: string[] }[]} */
export const ROSTER_DEPTHS = [
  { slug: 'behavioral' },
  { slug: 'technical' },
  {
    slug: 'case-study',
    domains: ['pm', 'business', 'data-science', 'design', 'general'],
    categories: ['product', 'business', 'data-ai', 'design'],
  },
  {
    slug: 'system-design',
    domains: ['backend', 'frontend', 'data-science', 'sdet', 'general'],
    categories: ['programming', 'data-ai'],
  },
  {
    slug: 'coding',
    domains: ['backend', 'frontend', 'data-science', 'sdet'],
    categories: ['programming', 'data-ai'],
  },
  {
    // Subject viva for 0-2 campus freshers. Mirrors staticData.ts applicableCategories.
    // NOTE: academics draws questions from the per-domain {domain}-academics.md skill file,
    // NOT the QuestionBank — so it is intentionally EXCLUDED from the QuestionBank-backfill
    // invariant in rosterMatrix.test.ts. The matrix runs at experience 0-2 (full/smoke
    // default), which matches academics' visibility gate.
    slug: 'academics',
    categories: ['programming', 'data-ai', 'core-engineering', 'business'],
  },
]

/** Curated smoke cells — one combo per category bucket for GA gate speed. */
export const SMOKE_CELLS = [
  ['backend', 'technical'],
  ['frontend', 'coding'],
  ['pm', 'case-study'],
  ['ml-engineer', 'technical'],
  ['finance', 'case-study'],
  ['mechanical', 'technical'],
  // Academics subject-viva smoke coverage across three categories (programming /
  // business / core-engineering) — guards the Q1 favourite-subject duplication fix.
  ['backend', 'academics'],
  ['marketing', 'academics'],
  ['mechanical', 'academics'],
]

export const PERSONAS = ['strong', 'weak']
