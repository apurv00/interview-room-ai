import { describe, it, expect } from 'vitest'
import { getDomainLabel } from '@interview/config/interviewConfig'

describe('getDomainLabel', () => {
  it('resolves the canonical legacy uppercase key', () => {
    expect(getDomainLabel('PM')).toBe('Product Manager')
    expect(getDomainLabel('SWE')).toBe('Backend Engineer')
  })

  it('UAT-013: resolves lowercase CMS slug variants (case-insensitive)', () => {
    // Prior bug: lowercase `pm` slug from CMS missed the uppercase `PM`
    // key and degraded to title-casing → "Pm".
    expect(getDomainLabel('pm')).toBe('Product Manager')
    expect(getDomainLabel('swe')).toBe('Backend Engineer')
  })

  it('trims whitespace around the slug before lookup', () => {
    expect(getDomainLabel('  pm  ')).toBe('Product Manager')
  })

  it('prefers CMS catalog label when one is provided', () => {
    const catalog = [{ slug: 'pm', label: 'Senior Product Manager' }]
    expect(getDomainLabel('pm', catalog)).toBe('Senior Product Manager')
    // Catalog match is also case-insensitive on the slug.
    expect(getDomainLabel('PM', catalog)).toBe('Senior Product Manager')
  })

  it('falls back to title-cased slug when no mapping matches', () => {
    expect(getDomainLabel('staff-engineer')).toBe('Staff Engineer')
    expect(getDomainLabel('growth_marketer')).toBe('Growth Marketer')
  })

  it('returns empty string for empty / null-ish inputs (no "Undefined" leak)', () => {
    expect(getDomainLabel('')).toBe('')
    expect(getDomainLabel('   ')).toBe('')
    // null/undefined come in via `session.config.role` for very old rows.
    expect(getDomainLabel(null as unknown as string)).toBe('')
    expect(getDomainLabel(undefined as unknown as string)).toBe('')
  })
})
