import { describe, it, expect } from 'vitest'
import { RESUME_TEMPLATES } from '../templates'

/**
 * The wizard export picker renders RESUME_TEMPLATES.slice(0, 6)
 * (modules/resume/wizard/components/StageExport.tsx). New templates MUST be
 * appended after this window so existing wizard choices stay selectable —
 * inserting mid-array silently drops templates from the wizard (Codex
 * r3326001350 on PR #412).
 */
describe('wizard template window (RESUME_TEMPLATES.slice(0, 6))', () => {
  it('keeps the six primary templates in the wizard picker', () => {
    expect(RESUME_TEMPLATES.slice(0, 6).map(t => t.id)).toEqual([
      'professional',
      'classic-navy',
      'technical',
      'creative',
      'sidebar-slate',
      'executive',
    ])
  })
})
