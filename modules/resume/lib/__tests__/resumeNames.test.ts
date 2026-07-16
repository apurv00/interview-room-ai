import { describe, it, expect } from 'vitest'
import { tailoredResumeName } from '../resumeNames'

/**
 * Founder catch 2026-07-16: re-tailoring stacked "(Tailored) (Tailored)"
 * onto the name (reproduced in their own saved resumes). The helper must
 * be idempotent over its own output AND heal legacy stacked names.
 */
describe('tailoredResumeName', () => {
  it('appends the suffix once', () => {
    expect(tailoredResumeName('Apurv Resume.pdf')).toBe('Apurv Resume.pdf (Tailored)')
  })

  it('is idempotent — tailoring a tailored resume never stacks', () => {
    expect(tailoredResumeName('Apurv Resume.pdf (Tailored)')).toBe('Apurv Resume.pdf (Tailored)')
  })

  it('heals legacy stacked names (the founder-account repro)', () => {
    expect(tailoredResumeName('Apurv Resume.pdf (Tailored) (Tailored)')).toBe('Apurv Resume.pdf (Tailored)')
  })

  it('company variant replaces any prior suffix instead of stacking', () => {
    expect(tailoredResumeName('Apurv Resume.pdf (Tailored)', 'PhonePe')).toBe('Apurv Resume.pdf (Tailored for PhonePe)')
    expect(tailoredResumeName('Apurv Resume.pdf (Tailored for Groww)', 'PhonePe')).toBe('Apurv Resume.pdf (Tailored for PhonePe)')
  })

  it('empty/undefined base falls back to Resume', () => {
    expect(tailoredResumeName('')).toBe('Resume (Tailored)')
    expect(tailoredResumeName(undefined)).toBe('Resume (Tailored)')
    expect(tailoredResumeName('(Tailored)')).toBe('Resume (Tailored)')
  })

  it('Codex #540 r3: company names WITH parentheses strip cleanly — no re-stacking', () => {
    expect(tailoredResumeName('X.pdf (Tailored for Acme (India))', 'Acme (India)')).toBe('X.pdf (Tailored for Acme (India))')
    expect(tailoredResumeName('X.pdf (Tailored for Acme (India))', 'PhonePe')).toBe('X.pdf (Tailored for PhonePe)')
    expect(tailoredResumeName('X.pdf (Tailored for Acme (India)) (Tailored)', 'Acme (India)')).toBe('X.pdf (Tailored for Acme (India))')
  })

  it('a user base name with its own parenthetical survives', () => {
    expect(tailoredResumeName('My (2026) Resume.pdf')).toBe('My (2026) Resume.pdf (Tailored)')
    expect(tailoredResumeName('My (2026) Resume.pdf (Tailored)')).toBe('My (2026) Resume.pdf (Tailored)')
  })
})
