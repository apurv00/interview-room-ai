/**
 * Server-side depth/experience gate (PR #468 review). The authoritative integrity
 * check: createSession refuses an experience-restricted depth on the wrong band even if
 * the client UI gate is bypassed (tampered localStorage / direct API call). This unit
 * covers the pure predicate that backs it.
 */
import { describe, it, expect } from 'vitest'
import { isDepthAllowedForExperience } from '@interview/services/core/interviewService'

describe('isDepthAllowedForExperience', () => {
  it('allows the academics subject viva ONLY for the 0-2 fresher band', () => {
    expect(isDepthAllowedForExperience('academics', '0-2')).toBe(true)
    expect(isDepthAllowedForExperience('academics', '3-6')).toBe(false)
    expect(isDepthAllowedForExperience('academics', '7+')).toBe(false)
  })

  it('allows unrestricted depths at every experience band', () => {
    for (const exp of ['0-2', '3-6', '7+']) {
      expect(isDepthAllowedForExperience('behavioral', exp)).toBe(true)
      expect(isDepthAllowedForExperience('technical', exp)).toBe(true)
      expect(isDepthAllowedForExperience('coding', exp)).toBe(true)
      expect(isDepthAllowedForExperience('case-study', exp)).toBe(true)
    }
  })

  it('defaults unknown (CMS-added) depths to allowed — built-in gating only', () => {
    expect(isDepthAllowedForExperience('some-cms-depth', '3-6')).toBe(true)
  })
})
