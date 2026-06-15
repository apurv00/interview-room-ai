import { describe, it, expect } from 'vitest'
import { ClarifyCodingRequestSchema } from '@interview/validators/clarifyCoding'

/**
 * Review P2 (PR #453): the client sends the problem the candidate is already
 * viewing, and AI-generated problems carry no length cap. The schema must
 * TRUNCATE oversize fields, never reject the request (which would 400 every
 * clarification on a verbose problem).
 */
describe('ClarifyCodingRequestSchema — problem context truncates, never rejects', () => {
  const base = {
    problemId: 'ai-some-generated-id',
    candidateQuestion: 'Can I assume the input is sorted?',
    language: 'python' as const,
  }

  it('truncates an oversize description instead of rejecting', () => {
    const r = ClarifyCodingRequestSchema.safeParse({
      ...base,
      problem: {
        title: 'T',
        difficulty: 'medium',
        description: 'x'.repeat(20000),
        examples: [],
        constraints: [],
      },
    })
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.problem?.description.length).toBe(8000)
  })

  it('truncates oversize example fields and caps the array length', () => {
    const r = ClarifyCodingRequestSchema.safeParse({
      ...base,
      problem: {
        title: 't'.repeat(1000),
        difficulty: 'hard',
        description: 'desc',
        examples: Array.from({ length: 30 }, () => ({
          input: 'i'.repeat(5000),
          output: 'o'.repeat(5000),
        })),
        constraints: Array.from({ length: 50 }, () => 'c'.repeat(2000)),
      },
    })
    expect(r.success).toBe(true)
    if (r.success && r.data.problem) {
      expect(r.data.problem.title.length).toBe(300)
      expect(r.data.problem.examples.length).toBe(12)
      expect(r.data.problem.examples[0].input.length).toBe(2000)
      expect(r.data.problem.constraints.length).toBe(30)
      expect(r.data.problem.constraints[0].length).toBe(500)
    }
  })

  it('accepts a request with no problem context (optional)', () => {
    const r = ClarifyCodingRequestSchema.safeParse(base)
    expect(r.success).toBe(true)
  })
})
