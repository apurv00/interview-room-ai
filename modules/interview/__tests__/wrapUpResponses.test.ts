import { describe, expect, it } from 'vitest'
import {
  buildWrapUpClosingLine,
  shouldAnswerWrapUpWithLLM,
} from '@interview/utils/classifyWrapUpAnswer'

describe('wrap-up responses', () => {
  it('does not call for LLM handling on no-questions or thank-you-only intents', () => {
    expect(shouldAnswerWrapUpWithLLM('empty')).toBe(false)
    expect(shouldAnswerWrapUpWithLLM('no_questions')).toBe(false)
    expect(shouldAnswerWrapUpWithLLM('thank_you_only')).toBe(false)
    expect(shouldAnswerWrapUpWithLLM('has_question')).toBe(true)
  })

  it('does not use the old great-question close for no-questions intent', () => {
    const close = buildWrapUpClosingLine('no_questions')

    expect(close).toContain('No worries at all')
    expect(close).not.toContain("That's a great question")
  })

  it('does not use the old great-question close for thank-you-only intent', () => {
    const close = buildWrapUpClosingLine('thank_you_only')

    expect(close).toContain('Thank you as well')
    expect(close).not.toContain("That's a great question")
  })

  it('appends the client-owned sign-off after a safe answer', () => {
    const close = buildWrapUpClosingLine(
      'has_question',
      "I don't have the exact company-specific details here, but generally the recruiter will confirm next steps.",
    )

    expect(close).toContain("I don't have the exact company-specific details here")
    expect(close).toContain("we'll be in touch")
    expect(close).not.toContain("That's a great question")
  })
})
