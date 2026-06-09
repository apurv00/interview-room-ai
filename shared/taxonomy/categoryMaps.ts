// Client-safe category mapping helpers — NO database imports, so both the seed
// (server: shared/db/seed.ts) and the CMS domain forms (client: app/(cms)) can
// import them. Single source of truth for the legacy <-> new category
// translation so the two layers cannot drift.

/** The browseable + escape category slugs (mirrors BUILT_IN_CATEGORIES). */
export const KNOWN_CATEGORY_SLUGS = [
  'programming',
  'data-ai',
  'core-engineering',
  'business',
  'product',
  'design',
  'general',
] as const

/** True iff `s` is one of the known taxonomy category slugs. */
export const isKnownCategorySlug = (s?: string | null): boolean =>
  !!s && (KNOWN_CATEGORY_SLUGS as readonly string[]).includes(s)

/**
 * Best-effort map from a legacy free-form `category` label to a new category
 * slug. Coarse by nature — legacy 'engineering' covered both software and
 * data — so a stored `categorySlug` always wins over this.
 */
export const CATEGORY_SLUG_FOR_LEGACY: Record<string, string> = {
  programming: 'programming',
  'data-ai': 'data-ai',
  'core-engineering': 'core-engineering',
  product: 'product',
  design: 'design',
  business: 'business',
  general: 'general',
  engineering: 'programming', // legacy 'engineering' meant software
  operations: 'business', // legacy phantom enum value
}

/**
 * Map a new category slug back to a legacy `category` value the *current*
 * DomainSelector tabs (engineering/product/business/general) understand, so a
 * newly created role stays visible under a tab until that reader migrates to
 * `categorySlug` (Phase 2).
 */
export const LEGACY_FOR_CATEGORY_SLUG: Record<string, string> = {
  programming: 'engineering',
  'data-ai': 'engineering',
  'core-engineering': 'engineering',
  product: 'product',
  design: 'product',
  business: 'business',
  general: 'general',
}

/** New slug -> legacy label, defaulting to the input when unknown. */
export const legacyCategoryFor = (categorySlug: string): string =>
  LEGACY_FOR_CATEGORY_SLUG[categorySlug] ?? categorySlug

/** Normalize any stored category value to a valid category slug for a form. */
export const toFormCategorySlug = (categorySlug?: string | null, legacyCategory?: string | null): string =>
  (isKnownCategorySlug(categorySlug) ? categorySlug! : undefined) ??
  (legacyCategory ? CATEGORY_SLUG_FOR_LEGACY[legacyCategory] : undefined) ??
  'programming'
