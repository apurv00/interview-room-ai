import { describe, it, expect } from 'vitest'
import {
  classifyIntent,
  simplifyQuestion,
  pickRandom,
  CONVERSATION_RESPONSES,
} from '../config/conversationalResponses'

describe('classifyIntent', () => {
  it('detects answers (default)', () => {
    expect(classifyIntent('In my last role I led a team of 5 engineers')).toBe('answer')
    expect(classifyIntent('So we built a new microservice architecture that handled 10x traffic')).toBe('answer')
  })

  it('detects clarification requests', () => {
    expect(classifyIntent('Can you repeat that?')).toBe('clarification')
    expect(classifyIntent('What do you mean by that?')).toBe('clarification')
    expect(classifyIntent("I didn't catch that")).toBe('clarification')
    expect(classifyIntent("I'm not sure I understand the question")).toBe('clarification')
  })

  it('detects redirect requests', () => {
    expect(classifyIntent('Can I give a different example?')).toBe('redirect')
    expect(classifyIntent('Let me start over')).toBe('redirect')
    expect(classifyIntent('Actually, can I share another story?')).toBe('redirect')
  })

  it('detects proactive questions', () => {
    expect(classifyIntent("What's the team size?")).toBe('question')
    expect(classifyIntent('Is this a remote role?')).toBe('question')
  })

  it('detects thinking starters (short)', () => {
    expect(classifyIntent('Let me think about that')).toBe('thinking')
    expect(classifyIntent('Good question')).toBe('thinking')
    expect(classifyIntent("That's a great question")).toBe('thinking')
  })

  it('treats long thinking starters as answers', () => {
    expect(classifyIntent(
      'Good question, so in my previous role I actually managed a team of 12 engineers working on the payment infrastructure'
    )).toBe('answer')
  })
})

describe('simplifyQuestion', () => {
  it('strips formal STAR framing', () => {
    const result = simplifyQuestion('Tell me about a time when you led a team through a crisis')
    expect(result).not.toContain('Tell me about a time when')
    expect(result).toContain('led a team')
  })

  it('capitalizes first letter', () => {
    const result = simplifyQuestion('tell me about a time when you failed')
    expect(result[0]).toMatch(/[A-Z]/)
  })
})

describe('pickRandom', () => {
  it('returns an item from the array', () => {
    const arr = ['a', 'b', 'c']
    expect(arr).toContain(pickRandom(arr))
  })
})

describe('CONVERSATION_RESPONSES', () => {
  it('has responses for all intent types', () => {
    expect(CONVERSATION_RESPONSES.clarification.length).toBeGreaterThan(0)
    expect(CONVERSATION_RESPONSES.redirect.length).toBeGreaterThan(0)
    expect(CONVERSATION_RESPONSES.thinking.length).toBeGreaterThan(0)
  })
})
