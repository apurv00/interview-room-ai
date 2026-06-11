import { describe, it, expect } from 'vitest'
import { getStarterCode, type CodingProblem } from '@interview/config/codingProblems'
import type { CodeLanguage } from '@shared/types'

const ALL_LANGS: CodeLanguage[] = ['python', 'javascript', 'typescript', 'java', 'cpp']

function makeProblem(starterCode: CodingProblem['starterCode']): CodingProblem {
  return {
    id: 'test-problem',
    title: 'Test',
    description: '',
    examples: [],
    constraints: [],
    difficulty: 'easy',
    applicableDomains: [],
    hints: [],
    starterCode,
    expectedTimeMinutes: 10,
    tags: [],
  }
}

describe('getStarterCode', () => {
  it('returns the problem-specific starter when present', () => {
    const p = makeProblem({ python: 'def two_sum(): pass', java: 'class Sol {}' })
    expect(getStarterCode(p, 'python')).toBe('def two_sum(): pass')
    expect(getStarterCode(p, 'java')).toBe('class Sol {}')
  })

  it('falls back to a non-empty skeleton for languages the problem omits', () => {
    // The candidate-reported bug: problems with only python/javascript left
    // Java/C++/TypeScript editors empty.
    const p = makeProblem({ python: 'def x(): pass', javascript: 'function x(){}' })
    for (const lang of ['typescript', 'java', 'cpp'] as const) {
      expect(getStarterCode(p, lang).trim().length).toBeGreaterThan(0)
    }
  })

  it('never returns empty — null problem, empty starter, or whitespace-only', () => {
    for (const lang of ALL_LANGS) {
      expect(getStarterCode(null, lang).trim().length).toBeGreaterThan(0)
      expect(getStarterCode(undefined, lang).trim().length).toBeGreaterThan(0)
      expect(getStarterCode(makeProblem({}), lang).trim().length).toBeGreaterThan(0)
      expect(getStarterCode(makeProblem({ java: '   \n  ' }), 'java').trim().length).toBeGreaterThan(0)
    }
  })

  it('produces language-appropriate skeletons', () => {
    expect(getStarterCode(null, 'java')).toContain('class')
    expect(getStarterCode(null, 'cpp')).toContain('#include')
    expect(getStarterCode(null, 'python')).toContain('def')
  })

  it('java/cpp skeletons are runnable as-is (have a main entry point — Codex P2)', () => {
    // The Run button posts these raw to the Piston sandbox, so they must execute
    // without a "Main method not found" / missing-entry-point error.
    expect(getStarterCode(null, 'java')).toMatch(/public\s+static\s+void\s+main/)
    expect(getStarterCode(null, 'cpp')).toMatch(/int\s+main\s*\(/)
  })
})
