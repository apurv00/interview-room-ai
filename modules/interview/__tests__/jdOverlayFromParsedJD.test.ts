import { describe, it, expect } from 'vitest'
import { buildJDOverlayFromParsedJD } from '@interview/flow/jdOverlayBuilder'
import type { IParsedJobDescription, ParsedRequirement } from '@shared/db/models/SavedJobDescription'

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeParsedJD(requirements: ParsedRequirement[]): IParsedJobDescription {
  return {
    rawText: 'synthetic test JD',
    company: 'Acme',
    role: 'Senior Engineer',
    inferredDomain: 'backend',
    requirements,
    keyThemes: [],
  }
}

function req(
  text: string,
  importance: 'must-have' | 'nice-to-have' = 'must-have',
  category: ParsedRequirement['category'] = 'technical',
): ParsedRequirement {
  return {
    id: `r-${Math.random().toString(36).slice(2, 8)}`,
    category,
    requirement: text,
    importance,
    targetCompetencies: [],
  }
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('buildJDOverlayFromParsedJD', () => {
  it('returns null when parsed is null', () => {
    expect(buildJDOverlayFromParsedJD(null, ['slot-a', 'slot-b'])).toBeNull()
  })

  it('returns null when requirements array is empty', () => {
    const parsed = makeParsedJD([])
    expect(buildJDOverlayFromParsedJD(parsed, ['slot-a', 'slot-b'])).toBeNull()
  })

  it('returns null when requirements has zero must-haves', () => {
    const parsed = makeParsedJD([
      req('Nice to have experience with Kubernetes', 'nice-to-have'),
      req('Familiarity with GraphQL a plus', 'nice-to-have'),
    ])
    expect(buildJDOverlayFromParsedJD(parsed, ['slot-a', 'slot-b'])).toBeNull()
  })

  it('returns an overlay when there are must-have requirements', () => {
    // "incident" → incident-response, "mentoring" → mentorship-and-growth
    const parsed = makeParsedJD([
      req('Lead incident response rotations for production systems'),
      req('Mentoring junior engineers across the team'),
    ])
    const existingSlotIds = ['warm-up-intro', 'incident-response', 'mentorship-and-growth', 'closing']

    const overlay = buildJDOverlayFromParsedJD(parsed, existingSlotIds)

    expect(overlay).not.toBeNull()
    expect(overlay!.promotions).toContain('incident-response')
    expect(overlay!.promotions).toContain('mentorship-and-growth')
    expect(overlay!.annotations.length).toBeGreaterThanOrEqual(2)
    // Matched → should not have generated insertions for these two
    expect(overlay!.insertions.length).toBe(0)
  })

  it('produces insertions for unmatched must-haves (up to cap of 2)', () => {
    // 3 must-haves with no REQUIREMENT_TO_SLOT keyword matches
    const parsed = makeParsedJD([
      req('Fluency in Mandarin Chinese for partner calls'),
      req('Willingness to travel to São Paulo quarterly'),
      req('Prior experience with FedRAMP compliance audits'),
    ])
    const existingSlotIds = ['warm-up', 'generic-exploration', 'closing']

    const overlay = buildJDOverlayFromParsedJD(parsed, existingSlotIds)

    expect(overlay).not.toBeNull()
    // Cap of 2 insertions in buildJDOverlay
    expect(overlay!.insertions.length).toBe(2)
    // No existing slots to promote against these requirements
    expect(overlay!.promotions.length).toBe(0)
  })

  it('ignores nice-to-have requirements for insertion', () => {
    // 1 must-have (unmatched) + 3 nice-to-haves (unmatched)
    // Only the must-have should drive an insertion.
    const parsed = makeParsedJD([
      req('Fluency in Mandarin Chinese', 'must-have'),
      req('Experience at an early-stage startup', 'nice-to-have'),
      req('Open-source contributions', 'nice-to-have'),
      req('Public speaking background', 'nice-to-have'),
    ])
    const existingSlotIds = ['warm-up', 'generic-exploration', 'closing']

    const overlay = buildJDOverlayFromParsedJD(parsed, existingSlotIds)

    expect(overlay).not.toBeNull()
    expect(overlay!.insertions.length).toBe(1)
    expect(overlay!.insertions[0].jdRequirement).toBe('Fluency in Mandarin Chinese')
  })
})
