import { describe, it, expect } from 'vitest'
import {
  isMetaDrillQuestion,
  pickDrillQuestion,
  rewriteMetaDrillQuestion,
  _allDrillQuestions,
} from '@learn/copy/metaQuestionRewriter'
import { sanitizeLearnerCopy } from '@learn/copy/learnerCopySanitizer'

describe('isMetaDrillQuestion', () => {
  it('flags every probe pattern emitted by interviewUtils.buildProbeText', () => {
    const metaSamples = [
      'Can you tell me more about that initiative?',
      'What exactly do you mean by "stakeholder buy-in"?',
      'How did you specifically approach the migration?',
      'Can you put a number on the impact — what was the measurable outcome?',
      'Can you elaborate on the rollout?',
      // Variants that have shown up in past sessions
      'Could you walk me through that decision?',
      'Could you elaborate on that for me?',
    ]
    for (const q of metaSamples) {
      expect(isMetaDrillQuestion(q), `expected meta-match for "${q}"`).toBe(true)
    }
  })

  it('does NOT flag substantive behavioral questions that mention similar words later', () => {
    const realQuestions = [
      'Tell me about a project you led and the impact you had.',
      'Describe a time you had to elaborate a plan under pressure.',
      'Walk me through your decision-making on a difficult tradeoff.',
      "What's a result you're most proud of from the last year?",
    ]
    for (const q of realQuestions) {
      expect(isMetaDrillQuestion(q), `expected non-meta for "${q}"`).toBe(false)
    }
  })

  it('handles null / empty / whitespace input safely', () => {
    expect(isMetaDrillQuestion('')).toBe(false)
    expect(isMetaDrillQuestion('   ')).toBe(false)
    expect(isMetaDrillQuestion(null)).toBe(false)
    expect(isMetaDrillQuestion(undefined)).toBe(false)
  })
})

describe('pickDrillQuestion', () => {
  it('returns a competency-specific question for known competencies', () => {
    const q = pickDrillQuestion('relevance', 'k1')
    expect(q).toBeTruthy()
    expect(q.length).toBeGreaterThan(20)
  })

  it('is deterministic across calls', () => {
    const a = pickDrillQuestion('structure', 'session-1-q-2')
    const b = pickDrillQuestion('structure', 'session-1-q-2')
    expect(a).toBe(b)
  })

  it('rotates across different rotation keys', () => {
    const picks = new Set<string>()
    for (let i = 0; i < 10; i++) picks.add(pickDrillQuestion('ownership', `k-${i}`))
    expect(picks.size).toBeGreaterThan(1)
  })

  it('falls back to a generic pool for unknown competencies', () => {
    const q = pickDrillQuestion('made_up_competency', 'k')
    expect(q).toBeTruthy()
  })
})

describe('rewriteMetaDrillQuestion', () => {
  it('rewrites a meta probe into a curated competency question', () => {
    const r = rewriteMetaDrillQuestion(
      'Can you elaborate on that for me?',
      'ownership',
      'sess-abc-q-3',
    )
    expect(r.rewritten).toBe(true)
    expect(isMetaDrillQuestion(r.question)).toBe(false)
  })

  it('passes a substantive question through unchanged', () => {
    const original = 'Tell me about a time you had to make a tough tradeoff.'
    const r = rewriteMetaDrillQuestion(original, 'ownership', 'k')
    expect(r.rewritten).toBe(false)
    expect(r.question).toBe(original)
  })

  it('rewrites identical meta probes to identical fallbacks for the same rotationKey', () => {
    const a = rewriteMetaDrillQuestion('Can you elaborate on it?', 'relevance', 'same-key')
    const b = rewriteMetaDrillQuestion('Can you elaborate on it?', 'relevance', 'same-key')
    expect(a.question).toBe(b.question)
  })
})

describe('shipped drill questions are sanitizer-clean', () => {
  it('every fallback question passes sanitizeLearnerCopy', () => {
    for (const q of _allDrillQuestions()) {
      const r = sanitizeLearnerCopy(q)
      expect(r.ok, `rejected: ${q} (${!r.ok && r.reason})`).toBe(true)
    }
  })
})
