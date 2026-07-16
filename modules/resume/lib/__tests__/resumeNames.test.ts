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
})
