import { describe, it, expect } from 'vitest'
import { categorySlugFor } from '@shared/db/seed'
import { isKnownCategorySlug } from '@shared/taxonomy/categoryMaps'
import { STATIC_DOMAINS } from '@interview/config/staticData'

// The §8.3 freshers' roster and its intended categories.
const ROSTER: Record<string, string> = {
  mechanical: 'core-engineering', civil: 'core-engineering', electrical: 'core-engineering', electronics: 'core-engineering',
  fullstack: 'programming', devops: 'programming', mobile: 'programming',
  'ml-engineer': 'data-ai', 'data-analyst': 'data-ai',
  strategy: 'business', finance: 'business', operations: 'business', marketing: 'business', sales: 'business',
  'product-analyst': 'product',
  'ui-designer': 'design', 'product-designer': 'design',
}

describe('Phase 4 freshers roster', () => {
  it('every role maps to its intended, known-active category', () => {
    for (const [slug, cat] of Object.entries(ROSTER)) {
      expect(categorySlugFor(slug)).toBe(cat)
      expect(isKnownCategorySlug(cat)).toBe(true)
    }
  })

  it('Core Engineering is no longer empty (the motivating gap)', () => {
    const coreEng = STATIC_DOMAINS.filter(d => d.categorySlug === 'core-engineering')
    expect(coreEng.length).toBeGreaterThanOrEqual(4)
  })

  it('every roster role has an instant-render STATIC_DOMAINS entry with a matching categorySlug', () => {
    for (const [slug, cat] of Object.entries(ROSTER)) {
      const d = STATIC_DOMAINS.find(x => x.slug === slug)
      expect(d, `STATIC_DOMAINS missing ${slug}`).toBeTruthy()
      expect(d?.categorySlug).toBe(cat)
    }
  })
})
