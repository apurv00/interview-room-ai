import { describe, it, expect } from 'vitest'
import { selectProblem } from '@interview/config/codingProblems'

// Phase 4 gave `coding` to programming/data-ai roles that have no problem pool
// of their own; selectProblem must still return a problem (the coding UI would
// otherwise be empty if /api/code/generate-problem is unavailable).
describe('selectProblem — Phase 4 coding-eligible roles get a fallback problem', () => {
  for (const role of ['fullstack', 'devops', 'mobile', 'ml-engineer', 'data-analyst']) {
    it(`${role} returns a problem (not null) despite having no own pool`, () => {
      const p = selectProblem(role, '0-2', [])
      expect(p).not.toBeNull()
      expect(p?.id).toBeTruthy()
    })
  }

  it('an existing role with its own pool (backend) still works', () => {
    expect(selectProblem('backend', '0-2', [])).not.toBeNull()
  })

  it('a role with no pool and no fallback returns null (triggers AI generation)', () => {
    expect(selectProblem('mechanical', '0-2', [])).toBeNull()
  })
})
