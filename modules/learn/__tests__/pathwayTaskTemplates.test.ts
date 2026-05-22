import { describe, it, expect } from 'vitest'
import { pickTaskTemplate, _allTemplates } from '@learn/copy/pathwayTaskTemplates'
import { sanitizeLearnerCopy } from '@learn/copy/learnerCopySanitizer'

describe('pickTaskTemplate', () => {
  it('returns a competency-specific template when the competency is known', () => {
    const t = pickTaskTemplate('relevance', 'blocker-0')
    expect(t.title).toBeTruthy()
    expect(t.description).toBeTruthy()
    expect(t.title.toLowerCase()).not.toContain('focus drill')
  })

  it('is deterministic — same competency + rotationKey gives the same template every call', () => {
    const a = pickTaskTemplate('structure', 'blocker-1')
    const b = pickTaskTemplate('structure', 'blocker-1')
    expect(a).toEqual(b)
  })

  it('rotates the template across different rotation keys for the same competency', () => {
    // The pool has at most 3 variants per competency, so we may see
    // duplicates across a small key set — but we should see >1 distinct
    // template across a reasonable spread.
    const picks = new Set<string>()
    for (let i = 0; i < 20; i++) {
      picks.add(pickTaskTemplate('ownership', `blocker-${i}`).title)
    }
    expect(picks.size).toBeGreaterThan(1)
  })

  it('normalizes competency slugs (case + separator) before lookup', () => {
    const a = pickTaskTemplate('Self Awareness', 'k')
    const b = pickTaskTemplate('SELF-AWARENESS', 'k')
    const c = pickTaskTemplate('self_awareness', 'k')
    expect(a).toEqual(c)
    expect(b).toEqual(c)
  })

  it('falls back to a generic pool for unknown competency keys', () => {
    const t = pickTaskTemplate('some_brand_new_competency', 'k')
    expect(t.title).toBeTruthy()
    // Generic pool templates exist and are not domain-specific.
    expect(t.description.length).toBeGreaterThan(20)
  })

  it('handles null/undefined competency gracefully', () => {
    const t1 = pickTaskTemplate(null, 'k')
    const t2 = pickTaskTemplate(undefined, 'k')
    expect(t1.title).toBeTruthy()
    expect(t2.title).toBeTruthy()
  })
})

describe('shipped templates are sanitizer-clean', () => {
  it('every title + description passes sanitizeLearnerCopy', () => {
    for (const t of _allTemplates()) {
      const titleResult = sanitizeLearnerCopy(t.title)
      const descResult = sanitizeLearnerCopy(t.description)
      expect(titleResult.ok, `title rejected: ${t.title} (${!titleResult.ok && titleResult.reason})`).toBe(true)
      expect(descResult.ok, `description rejected: ${t.description} (${!descResult.ok && descResult.reason})`).toBe(true)
    }
  })
})
