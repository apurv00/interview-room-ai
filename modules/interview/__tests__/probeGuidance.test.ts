/**
 * PR "grounded follow-ups" — buildFollowUpCalibration.
 *
 * The scripted coding/system-design rounds never run the flow engine, so the
 * templates' per-band probeGuidance and neverAsk were dead on that path. This
 * helper renders them into the evaluate-code/evaluate-design prompts.
 * Contract: pure, '' on any missing input or unmatched template (calibration
 * must never block evaluation), general-domain fallback mirrors resolveFlow.
 */
import { describe, it, expect } from 'vitest'
import { buildFollowUpCalibration } from '@interview/flow/probeGuidance'

describe('buildFollowUpCalibration', () => {
  it('renders probe lines and neverAsk for a registered domain/depth/band', () => {
    const block = buildFollowUpCalibration('backend', 'coding', '3-6')
    expect(block).toContain('<followup_calibration>')
    expect(block).toContain('3-6-years backend candidate')
    // backend-coding 3-6 exploration probes include trade-off/complexity angles
    expect(block).toMatch(/- .+/)
    expect(block).toContain('Never ask about')
  })

  it('keeps entry-band guardrails: backend system-design 0-2 forbids distributed-systems content', () => {
    const block = buildFollowUpCalibration('backend', 'system-design', '0-2')
    expect(block).toContain('Never ask about')
    expect(block.toLowerCase()).toContain('cap theorem')
  })

  it('falls back to the general template for domains without their own', () => {
    // pm has no coding template; general:coding exists for all three bands.
    const block = buildFollowUpCalibration('pm', 'coding', '3-6')
    expect(block).toContain('<followup_calibration>')
  })

  it('returns empty string when domain or experience is missing', () => {
    expect(buildFollowUpCalibration(undefined, 'coding', '3-6')).toBe('')
    expect(buildFollowUpCalibration('backend', 'coding', undefined)).toBe('')
  })

  it('returns empty string for an unknown experience band', () => {
    expect(buildFollowUpCalibration('backend', 'coding', '99-100')).toBe('')
  })

  it('caps the probe lines injected', () => {
    const block = buildFollowUpCalibration('backend', 'system-design', '3-6')
    const probeLines = block.split('\n').filter((l) => l.startsWith('- '))
    expect(probeLines.length).toBeLessThanOrEqual(4)
  })
})
