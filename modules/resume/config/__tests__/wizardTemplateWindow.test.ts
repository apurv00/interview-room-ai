import { describe, it, expect } from 'vitest'
import { RESUME_TEMPLATES } from '../templates'
import { TEMPLATE_FAMILIES, TEMPLATE_VARIANTS } from '../templateFamilies'

/**
 * The wizard export picker and the /resume/templates grid render templates
 * grouped by family (StageExport.tsx, templates/page.tsx). Every template must
 * therefore map to a family that exists in TEMPLATE_FAMILIES — otherwise it is
 * silently dropped from those grouped pickers.
 *
 * (Supersedes the old "first-six window" guard: the wizard no longer truncates
 * to RESUME_TEMPLATES.slice(0, 6); it shows all templates grouped — which is the
 * proper fix for Codex r3326001350 on #412.)
 */
describe('grouped template pickers render every template', () => {
  const familyIds = new Set(TEMPLATE_FAMILIES.map(f => f.id))

  it('maps every RESUME_TEMPLATES id to a known family', () => {
    for (const t of RESUME_TEMPLATES) {
      const variant = TEMPLATE_VARIANTS[t.id]
      expect(variant, `missing TEMPLATE_VARIANTS entry for "${t.id}"`).toBeTruthy()
      expect(
        familyIds.has(variant.familyId),
        `template "${t.id}" maps to unknown family "${variant.familyId}"`,
      ).toBe(true)
    }
  })

  it('every family that owns templates is represented', () => {
    const ownedFamilies = new Set(
      RESUME_TEMPLATES.map(t => TEMPLATE_VARIANTS[t.id]?.familyId).filter(Boolean),
    )
    for (const fid of ownedFamilies) {
      expect(familyIds.has(fid as string)).toBe(true)
    }
  })
})
