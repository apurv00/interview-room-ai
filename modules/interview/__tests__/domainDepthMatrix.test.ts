import { describe, it, expect } from 'vitest'
import { DOMAIN_DEPTH_OVERRIDES } from '../config/domainDepthMatrix'
import type { DomainDepthOverride } from '../config/domainDepthMatrix'

const DOMAINS = [
  'frontend', 'backend', 'sdet', 'devops', 'data-science',
  'pm', 'design',
  'business', 'marketing', 'finance', 'sales',
]

const DEPTHS = ['screening', 'behavioral', 'technical', 'case-study']

describe('DOMAIN_DEPTH_OVERRIDES', () => {
  it('contains exactly 44 entries (11 domains x 4 depths)', () => {
    expect(Object.keys(DOMAIN_DEPTH_OVERRIDES)).toHaveLength(44)
  })

  it('has an entry for every domain x depth combination', () => {
    for (const domain of DOMAINS) {
      for (const depth of DEPTHS) {
        const key = `${domain}:${depth}`
        expect(DOMAIN_DEPTH_OVERRIDES[key], `Missing key: ${key}`).toBeDefined()
      }
    }
  })

  it('every override has required fields (questionStrategy, interviewerTone)', () => {
    for (const [key, override] of Object.entries(DOMAIN_DEPTH_OVERRIDES)) {
      expect(override.questionStrategy, `${key} missing questionStrategy`).toBeTruthy()
      expect(typeof override.questionStrategy).toBe('string')
      expect(override.questionStrategy.length).toBeGreaterThan(20)

      expect(override.interviewerTone, `${key} missing interviewerTone`).toBeTruthy()
      expect(typeof override.interviewerTone).toBe('string')
      expect(override.interviewerTone.length).toBeGreaterThan(10)
    }
  })

  it('technical overrides have technicalTranslation field', () => {
    for (const domain of DOMAINS) {
      const key = `${domain}:technical`
      const override = DOMAIN_DEPTH_OVERRIDES[key]
      expect(override.technicalTranslation, `${key} missing technicalTranslation`).toBeTruthy()
    }
  })

  it('case-study overrides have technicalTranslation field', () => {
    for (const domain of DOMAINS) {
      const key = `${domain}:case-study`
      const override = DOMAIN_DEPTH_OVERRIDES[key]
      expect(override.technicalTranslation, `${key} missing technicalTranslation`).toBeTruthy()
    }
  })

  it('every override has antiPatterns', () => {
    for (const [key, override] of Object.entries(DOMAIN_DEPTH_OVERRIDES)) {
      expect(override.antiPatterns, `${key} missing antiPatterns`).toBeTruthy()
      expect(override.antiPatterns!.length).toBeGreaterThan(10)
    }
  })

  it('every override has experienceCalibration with all 3 levels', () => {
    for (const [key, override] of Object.entries(DOMAIN_DEPTH_OVERRIDES)) {
      expect(override.experienceCalibration, `${key} missing experienceCalibration`).toBeDefined()
      expect(override.experienceCalibration!['0-2'], `${key} missing 0-2 calibration`).toBeTruthy()
      expect(override.experienceCalibration!['3-6'], `${key} missing 3-6 calibration`).toBeTruthy()
      expect(override.experienceCalibration!['7+'], `${key} missing 7+ calibration`).toBeTruthy()
    }
  })

  it('every override has domainRedFlags with at least 2 entries', () => {
    for (const [key, override] of Object.entries(DOMAIN_DEPTH_OVERRIDES)) {
      expect(override.domainRedFlags, `${key} missing domainRedFlags`).toBeDefined()
      expect(override.domainRedFlags!.length, `${key} needs at least 2 red flags`).toBeGreaterThanOrEqual(2)
    }
  })

  it('no duplicate keys exist', () => {
    const keys = Object.keys(DOMAIN_DEPTH_OVERRIDES)
    const uniqueKeys = new Set(keys)
    expect(keys.length).toBe(uniqueKeys.size)
  })

  // ── Domain-specific content checks ──
  it('sales:technical mentions sales methodology', () => {
    const override = DOMAIN_DEPTH_OVERRIDES['sales:technical']
    const combined = `${override.questionStrategy} ${override.technicalTranslation || ''}`
    expect(combined.toLowerCase()).toMatch(/meddic|spin|challenger|sales method/i)
  })

  it('finance:technical mentions financial modeling', () => {
    const override = DOMAIN_DEPTH_OVERRIDES['finance:technical']
    const combined = `${override.questionStrategy} ${override.technicalTranslation || ''}`
    expect(combined.toLowerCase()).toMatch(/dcf|valuation|financial model/i)
  })

  it('frontend:case-study mentions component or architecture', () => {
    const override = DOMAIN_DEPTH_OVERRIDES['frontend:case-study']
    const combined = `${override.questionStrategy} ${override.technicalTranslation || ''}`
    expect(combined.toLowerCase()).toMatch(/component|architecture|micro-frontend/i)
  })

  it('backend:case-study mentions system design', () => {
    const override = DOMAIN_DEPTH_OVERRIDES['backend:case-study']
    const combined = `${override.questionStrategy} ${override.technicalTranslation || ''}`
    expect(combined.toLowerCase()).toMatch(/system design|microservice|migration/i)
  })
})
