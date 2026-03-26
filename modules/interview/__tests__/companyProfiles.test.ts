import { describe, it, expect } from 'vitest'
import { COMPANY_PROFILES, findCompanyProfile, buildCompanyPromptContext } from '../config/companyProfiles'

describe('COMPANY_PROFILES', () => {
  it('contains at least 10 company profiles', () => {
    expect(COMPANY_PROFILES.length).toBeGreaterThanOrEqual(10)
  })

  it('every profile has required fields', () => {
    for (const p of COMPANY_PROFILES) {
      expect(p.name).toBeTruthy()
      expect(p.industry).toBeTruthy()
      expect(p.interviewStyle.length).toBeGreaterThan(20)
      expect(p.culturalValues.length).toBeGreaterThanOrEqual(3)
      expect(p.commonThemes.length).toBeGreaterThanOrEqual(3)
      expect(['standard', 'high', 'very_high']).toContain(p.difficultyLevel)
      expect(p.tips.length).toBeGreaterThan(10)
    }
  })

  it('has no duplicate company names', () => {
    const names = COMPANY_PROFILES.map(p => p.name.toLowerCase())
    expect(new Set(names).size).toBe(names.length)
  })
})

describe('findCompanyProfile', () => {
  it('finds Google by exact name', () => {
    const profile = findCompanyProfile('Google')
    expect(profile).not.toBeNull()
    expect(profile!.name).toBe('Google')
  })

  it('finds by name case-insensitively', () => {
    const profile = findCompanyProfile('google')
    expect(profile).not.toBeNull()
    expect(profile!.name).toBe('Google')
  })

  it('finds Amazon by alias AWS', () => {
    const profile = findCompanyProfile('AWS')
    expect(profile).not.toBeNull()
    expect(profile!.name).toBe('Amazon')
  })

  it('finds Meta by alias Facebook', () => {
    const profile = findCompanyProfile('Facebook')
    expect(profile).not.toBeNull()
    expect(profile!.name).toBe('Meta')
  })

  it('finds McKinsey by full name', () => {
    const profile = findCompanyProfile('McKinsey & Company')
    expect(profile).not.toBeNull()
    expect(profile!.name).toBe('McKinsey')
  })

  it('returns null for unknown company', () => {
    const profile = findCompanyProfile('Random Startup XYZ')
    expect(profile).toBeNull()
  })

  it('returns null for empty string', () => {
    const profile = findCompanyProfile('')
    expect(profile).toBeNull()
  })

  it('handles whitespace in input', () => {
    const profile = findCompanyProfile('  Google  ')
    expect(profile).not.toBeNull()
    expect(profile!.name).toBe('Google')
  })
})

describe('buildCompanyPromptContext', () => {
  it('includes company name in output', () => {
    const profile = findCompanyProfile('Google')!
    const ctx = buildCompanyPromptContext(profile)
    expect(ctx).toContain('Google')
  })

  it('includes interview style', () => {
    const profile = findCompanyProfile('Amazon')!
    const ctx = buildCompanyPromptContext(profile)
    expect(ctx).toContain('Leadership Principles')
  })

  it('includes cultural values', () => {
    const profile = findCompanyProfile('Netflix')!
    const ctx = buildCompanyPromptContext(profile)
    expect(ctx).toContain('Freedom and Responsibility')
  })

  it('includes difficulty level', () => {
    const profile = findCompanyProfile('Stripe')!
    const ctx = buildCompanyPromptContext(profile)
    expect(ctx).toContain('very_high')
  })
})
