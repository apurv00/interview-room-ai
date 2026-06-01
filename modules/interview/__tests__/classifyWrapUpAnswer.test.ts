import { describe, expect, it } from 'vitest'
import { classifyWrapUpAnswer } from '@interview/utils/classifyWrapUpAnswer'

describe('classifyWrapUpAnswer', () => {
  it('treats silence and very short text as empty', () => {
    expect(classifyWrapUpAnswer('')).toBe('empty')
    expect(classifyWrapUpAnswer('   ')).toBe('empty')
    expect(classifyWrapUpAnswer('ok')).toBe('empty')
  })

  it('detects explicit no-question answers', () => {
    expect(classifyWrapUpAnswer("I don't have any questions at the moment")).toBe('no_questions')
    expect(classifyWrapUpAnswer('No questions from my side')).toBe('no_questions')
    expect(classifyWrapUpAnswer("Thank you. I don't have questions but wish you a good day")).toBe('no_questions')
  })

  it('detects thank-you-only answers', () => {
    expect(classifyWrapUpAnswer('Thank you so much, I really appreciate your time')).toBe('thank_you_only')
    expect(classifyWrapUpAnswer('Sounds good, appreciate it')).toBe('thank_you_only')
  })

  it('detects real candidate questions', () => {
    expect(classifyWrapUpAnswer("What's the team culture like?")).toBe('has_question')
    expect(classifyWrapUpAnswer('What does the onboarding process look like?')).toBe('has_question')
    expect(classifyWrapUpAnswer('When?')).toBe('has_question')
    expect(classifyWrapUpAnswer('How?')).toBe('has_question')
    expect(classifyWrapUpAnswer('Why?')).toBe('has_question')
    expect(classifyWrapUpAnswer('should I expect another round')).toBe('has_question')
    expect(classifyWrapUpAnswer('do I need to prepare anything')).toBe('has_question')
    expect(classifyWrapUpAnswer('is this role remote')).toBe('has_question')
  })

  it('lets a real question win over a thank-you or no-question prefix', () => {
    expect(classifyWrapUpAnswer('Thank you - no questions, but when will I hear back?')).toBe('has_question')
    expect(classifyWrapUpAnswer("Thank you. I don't have questions, but what are the next steps?")).toBe('has_question')
  })

  it('does not treat an incomplete polite close as a question', () => {
    expect(classifyWrapUpAnswer("Thank you. I don't have any questions at the moment, but if")).toBe('no_questions')
  })
})
