import { describe, it, expect } from 'vitest'
import { sanitizeLearnerCopy, sanitizeLearnerFields } from '@learn/copy/learnerCopySanitizer'

describe('sanitizeLearnerCopy', () => {
  it('accepts clean candidate-facing copy', () => {
    const r = sanitizeLearnerCopy('Practice 3 STAR answers focused on ownership.')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.text).toBe('Practice 3 STAR answers focused on ownership.')
  })

  it('rejects empty / null / whitespace input', () => {
    expect(sanitizeLearnerCopy('')).toEqual({ ok: false, reason: 'empty' })
    expect(sanitizeLearnerCopy('   ')).toEqual({ ok: false, reason: 'empty' })
    expect(sanitizeLearnerCopy(null)).toEqual({ ok: false, reason: 'empty' })
    expect(sanitizeLearnerCopy(undefined)).toEqual({ ok: false, reason: 'empty' })
  })

  it('rejects banned LLM jargon tokens case-insensitively', () => {
    const cases = [
      ['Repeat with five different prompts to vary it.', 'prompt'], // matches BANNED_TOKEN first via "prompts"
      ['Output as JSON for the next step.', 'json'],
      ['Use the STAR template to structure your answer.', 'template'],
      ['Have the LLM rewrite this for you.', 'llm'],
      ['Ask Claude to grade your answer.', 'claude'],
    ]
    for (const [input, expectedToken] of cases) {
      const r = sanitizeLearnerCopy(input)
      expect(r.ok, `expected rejection for "${input}"`).toBe(false)
      if (!r.ok) expect(r.reason).toContain(`banned-token:${expectedToken}`)
    }
  })

  it('rejects the explicit "five different prompts" phrase', () => {
    // Caught by BANNED_TOKEN_RE first since "prompts" is in the token list.
    const r = sanitizeLearnerCopy('Repeat this with five different prompts to vary it.')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/banned-token|banned-phrase/)
  })

  it('rejects "as an AI" coaching-leak phrase', () => {
    const r = sanitizeLearnerCopy('As an AI, I recommend you practice this.')
    expect(r.ok).toBe(false)
  })

  it('trims surrounding whitespace before testing', () => {
    const r = sanitizeLearnerCopy('  Practice answering with metrics.  ')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.text).toBe('Practice answering with metrics.')
  })

  it('does not reject normal English with similar-looking compound words', () => {
    // "promptly" should slip through because the regex uses \b — "prompt"
    // followed by "ly" is one token. False negatives are fine; false
    // positives on bare "prompt" are what we care about.
    const r = sanitizeLearnerCopy('Reply promptly to recruiter outreach.')
    expect(r.ok).toBe(true)
  })
})

describe('sanitizeLearnerFields', () => {
  it('passes when every requested field is clean', () => {
    const record = { title: 'Practice STAR', description: 'Pick 3 wins from last year.' }
    expect(sanitizeLearnerFields(record, ['title', 'description'])).toEqual({ ok: true, text: '' })
  })

  it('returns the first field rejection with a prefixed reason', () => {
    const record = { title: 'Use this template', description: 'Pick 3 wins from last year.' }
    const r = sanitizeLearnerFields(record, ['title', 'description'])
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('title:banned-token:template')
  })

  it('catches jargon in later fields when earlier ones are clean', () => {
    const record = { title: 'Practice STAR', description: 'Return your answer as JSON.' }
    const r = sanitizeLearnerFields(record, ['title', 'description'])
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('description:banned-token:json')
  })
})
