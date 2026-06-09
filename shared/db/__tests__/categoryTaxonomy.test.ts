import { describe, it, expect } from 'vitest'
import { Category } from '../models/Category'
import { FALLBACK_DOMAINS, FALLBACK_CATEGORIES, resolveCategorySlug } from '../seed'

describe('Category model', () => {
  it('validates a minimal category and applies defaults', () => {
    const c = new Category({ slug: 'programming', label: 'Programming' })
    expect(c.validateSync()).toBeUndefined()
    expect(c.isActive).toBe(true)
    expect(c.isBuiltIn).toBe(false)
    expect(c.sortOrder).toBe(0)
    expect(c.icon).toBeTruthy() // has a default
  })

  it('requires slug and label', () => {
    const err = new Category({}).validateSync()
    expect(err?.errors.slug).toBeDefined()
    expect(err?.errors.label).toBeDefined()
  })
})

describe('taxonomy seed data integrity', () => {
  const categorySlugs = new Set(FALLBACK_CATEGORIES.map((c) => c.slug))

  it('seeds the six browseable categories plus the general escape', () => {
    expect(categorySlugs).toEqual(
      new Set(['programming', 'data-ai', 'core-engineering', 'business', 'product', 'design', 'general']),
    )
  })

  it('every domain references an existing category (no orphans)', () => {
    for (const d of FALLBACK_DOMAINS) {
      expect(d.categorySlug, `domain ${d.slug} has a categorySlug`).toBeTruthy()
      expect(categorySlugs.has(d.categorySlug!), `domain ${d.slug} → ${d.categorySlug} exists`).toBe(true)
    }
  })

  it('re-cuts the existing 8 domains onto the new categories', () => {
    const bySlug = Object.fromEntries(FALLBACK_DOMAINS.map((d) => [d.slug, d.categorySlug]))
    expect(bySlug).toMatchObject({
      frontend: 'programming',
      backend: 'programming',
      sdet: 'programming',
      'data-science': 'data-ai',
      pm: 'product',
      design: 'design',
      business: 'business',
      general: 'general',
    })
  })

  it('keeps the legacy `category` field intact (no UI break in Phase 0)', () => {
    // Legacy values are unchanged so the current DomainSelector still works.
    const frontend = FALLBACK_DOMAINS.find((d) => d.slug === 'frontend')
    expect(frontend?.category).toBe('engineering')
  })

  it('core-engineering is seeded but starts empty (roles land in Phase 4)', () => {
    expect(categorySlugs.has('core-engineering')).toBe(true)
    expect(FALLBACK_DOMAINS.some((d) => d.categorySlug === 'core-engineering')).toBe(false)
  })
})

describe('resolveCategorySlug — read-path bucket resolution', () => {
  it('prefers a stored categorySlug over everything (authoritative)', () => {
    // A CMS mechanical role tagged with the legacy 'engineering' category but
    // given an explicit categorySlug must keep the explicit bucket.
    expect(resolveCategorySlug({ slug: 'mechanical', category: 'engineering', categorySlug: 'core-engineering' }))
      .toBe('core-engineering')
  })

  it('uses the exact built-in slug mapping before the legacy category', () => {
    // data-science is legacy-categorized 'engineering' but must bucket as data-ai.
    expect(resolveCategorySlug({ slug: 'data-science', category: 'engineering' })).toBe('data-ai')
  })

  it('falls back to the legacy category for non-seed CMS domains', () => {
    expect(resolveCategorySlug({ slug: 'consulting', category: 'business' })).toBe('business')
    expect(resolveCategorySlug({ slug: 'qa-lead', category: 'engineering' })).toBe('programming')
    expect(resolveCategorySlug({ slug: 'ops-mgr', category: 'operations' })).toBe('business')
  })

  it('falls back to general when nothing resolves', () => {
    expect(resolveCategorySlug({ slug: 'totally-unknown' })).toBe('general')
    expect(resolveCategorySlug({ slug: 'x', category: 'made-up-label' })).toBe('general')
  })
})
