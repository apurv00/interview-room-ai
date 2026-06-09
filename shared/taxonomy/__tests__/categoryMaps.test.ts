import { describe, it, expect } from 'vitest'
import {
  isKnownCategorySlug,
  legacyCategoryFor,
  toFormCategorySlug,
  KNOWN_CATEGORY_SLUGS,
} from '../categoryMaps'

describe('categoryMaps', () => {
  it('isKnownCategorySlug recognizes the 7 category slugs (and rejects legacy)', () => {
    expect(KNOWN_CATEGORY_SLUGS.length).toBe(7)
    expect(isKnownCategorySlug('core-engineering')).toBe(true)
    expect(isKnownCategorySlug('data-ai')).toBe(true)
    expect(isKnownCategorySlug('engineering')).toBe(false) // legacy label, not a new slug
    expect(isKnownCategorySlug('')).toBe(false)
    expect(isKnownCategorySlug(undefined)).toBe(false)
  })

  it('legacyCategoryFor maps new slugs to legacy DomainSelector tab values', () => {
    expect(legacyCategoryFor('programming')).toBe('engineering')
    expect(legacyCategoryFor('data-ai')).toBe('engineering')
    expect(legacyCategoryFor('core-engineering')).toBe('engineering')
    expect(legacyCategoryFor('design')).toBe('product')
    expect(legacyCategoryFor('business')).toBe('business')
    expect(legacyCategoryFor('made-up')).toBe('made-up') // passthrough
  })

  it('toFormCategorySlug normalizes any stored value to a valid slug', () => {
    expect(toFormCategorySlug('core-engineering', 'engineering')).toBe('core-engineering') // valid wins
    expect(toFormCategorySlug(undefined, 'engineering')).toBe('programming') // legacy mapped
    expect(toFormCategorySlug('not-real', 'business')).toBe('business') // invalid -> legacy
    expect(toFormCategorySlug(undefined, undefined)).toBe('programming') // safe default
  })
})
