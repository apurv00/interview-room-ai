import { describe, it, expect } from 'vitest'
import {
  classifyIntent,
  simplifyQuestion,
  pickRandom,
  CONVERSATION_RESPONSES,
  THINKING_ACKS,
  PRE_QUESTION_FILLERS,
} from '../config/conversationalResponses'

describe('classifyIntent', () => {
  // ── Existing intent types ──

  it('detects answers (default)', () => {
    expect(classifyIntent('In my last role I led a team of 5 engineers')).toBe('answer')
    expect(classifyIntent('So we built a new microservice architecture that handled 10x traffic')).toBe('answer')
  })

  it('detects clarification requests', () => {
    // Note: "Can you repeat that?" now matches 'repetition' (higher priority)
    expect(classifyIntent('What do you mean by that?')).toBe('clarification')
    expect(classifyIntent("I didn't catch that")).toBe('clarification')
    expect(classifyIntent("I'm not sure I understand the question")).toBe('clarification')
    expect(classifyIntent('Can you explain that?')).toBe('clarification')
  })

  it('detects redirect requests', () => {
    expect(classifyIntent('Can I give a different example?')).toBe('redirect')
    // Note: "Let me start over" now matches 'correction' (higher priority)
    expect(classifyIntent('Actually, can I share another story?')).toBe('redirect')
    expect(classifyIntent('Can I try a different answer?')).toBe('redirect')
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

  // ── New intent types ──

  describe('distress detection', () => {
    it('detects blanking / nervousness', () => {
      expect(classifyIntent("I'm blanking")).toBe('distress')
      expect(classifyIntent("I'm drawing a blank")).toBe('distress')
      expect(classifyIntent("I'm really nervous")).toBe('distress')
      expect(classifyIntent("I'm anxious")).toBe('distress')
      expect(classifyIntent("I forgot everything")).toBe('distress')
      expect(classifyIntent("My mind went blank")).toBe('distress')
    })

    it('detects needing a moment', () => {
      expect(classifyIntent("I need a second")).toBe('distress')
      expect(classifyIntent("I need a moment")).toBe('distress')
      expect(classifyIntent("I can't think")).toBe('distress')
    })

    it('does NOT match long answers that mention nervousness', () => {
      expect(classifyIntent(
        "I was nervous at first but then I settled in and delivered the presentation to 200 people which was a big achievement"
      )).toBe('answer')
    })
  })

  describe('correction detection', () => {
    it('detects restart / rephrase requests', () => {
      expect(classifyIntent("Let me restart that")).toBe('correction')
      expect(classifyIntent("Wait, I made an error")).toBe('correction')
      expect(classifyIntent("Scratch that")).toBe('correction')
      expect(classifyIntent("Let me rephrase")).toBe('correction')
      expect(classifyIntent("Ignore what I just said")).toBe('correction')
      expect(classifyIntent("Sorry, let me redo that")).toBe('correction')
    })

    it('does NOT match long answers with correction words', () => {
      // Correction regex has 80-char length guard to prevent false positives
      expect(classifyIntent(
        "Actually let me think about this differently because the project I worked on involved restructuring the entire team and we delivered on time"
      )).toBe('answer')
    })
  })

  describe('repetition detection', () => {
    it('detects repeat question requests', () => {
      expect(classifyIntent("Can you repeat that?")).toBe('repetition')
      expect(classifyIntent("What was the question?")).toBe('repetition')
      expect(classifyIntent("Could you re-ask that?")).toBe('repetition')
      expect(classifyIntent("Say that again")).toBe('repetition')
      expect(classifyIntent("I missed the question")).toBe('repetition')
    })
  })

  describe('timecheck detection', () => {
    it('detects time-related queries', () => {
      expect(classifyIntent("How much time do I have left?")).toBe('timecheck')
      expect(classifyIntent("How long do I have?")).toBe('timecheck')
      expect(classifyIntent("Am I going too slow?")).toBe('timecheck')
    })
  })

  describe('hint detection', () => {
    it('detects hint requests', () => {
      expect(classifyIntent("Give me a hint")).toBe('hint')
      expect(classifyIntent("Can you give me a hint?")).toBe('hint')
      expect(classifyIntent("Point me in the right direction")).toBe('hint')
      expect(classifyIntent("Where should I start?")).toBe('hint')
      expect(classifyIntent("Any hints?")).toBe('hint')
    })
  })

  // ── Priority ordering tests ──

  describe('priority ordering', () => {
    it('distress takes priority over clarification', () => {
      // "sorry, I..." could match clarification but distress should win
      expect(classifyIntent("I'm blanking, sorry")).toBe('distress')
    })

    it('repetition takes priority over clarification for "repeat"', () => {
      // "Can you repeat that?" matches both repetition and clarification
      // Repetition is checked first (priority 2 vs 7)
      expect(classifyIntent("Can you repeat that?")).toBe('repetition')
    })

    it('long utterances default to answer even with trigger words', () => {
      // Distress, correction, etc. have length guards
      expect(classifyIntent(
        "I need a second opinion on this but I think the best approach would be to restructure the team around product lines"
      )).toBe('answer')
    })

    it('empty input returns answer', () => {
      expect(classifyIntent('')).toBe('answer')
    })
  })

  // ── False positive prevention ──

  describe('false positive prevention', () => {
    it('real answers containing "I don\'t know" as part of a longer answer stay as answer', () => {
      expect(classifyIntent(
        "I don't know exactly when it happened but the team eventually grew to 15 people and we shipped the product"
      )).toBe('answer')
    })

    it('hint-like phrases in answers stay as answer', () => {
      expect(classifyIntent(
        "The hint I'd give to my team was to focus on the customer journey first before building features"
      )).toBe('answer')
    })

    it('time-related content in answers stays as answer', () => {
      expect(classifyIntent(
        "We had very little time left and the deadline was approaching fast so I prioritized the critical path"
      )).toBe('answer')
    })
  })

  // ── E4: Challenge question ──

  describe('challenge_question detection', () => {
    it('detects question fairness challenges', () => {
      expect(classifyIntent("That's not a fair question")).toBe('challenge_question')
      expect(classifyIntent("This question is flawed")).toBe('challenge_question')
      expect(classifyIntent("I don't think that's relevant")).toBe('challenge_question')
      expect(classifyIntent("That doesn't apply to my role")).toBe('challenge_question')
      expect(classifyIntent("Why are you asking that?")).toBe('challenge_question')
    })

    it('does NOT match long answers discussing fairness', () => {
      expect(classifyIntent(
        "I think that's not a fair comparison between the two approaches because the first one had significantly more resources"
      )).toBe('answer')
    })
  })

  // ── E8: Gaming detection ──

  describe('gaming detection', () => {
    it('detects attempts to extract the answer', () => {
      expect(classifyIntent("Just tell me the right answer")).toBe('gaming')
      expect(classifyIntent("What should I say?")).toBe('gaming')
      expect(classifyIntent("What are you looking for?")).toBe('gaming')
      expect(classifyIntent("Tell me what you want to hear")).toBe('gaming')
    })

    it('does NOT match genuine clarification questions about interview scope', () => {
      expect(classifyIntent(
        "What should I focus on in terms of the technical architecture for this distributed system design?"
      )).toBe('question')
    })
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
    expect(CONVERSATION_RESPONSES.distress.length).toBeGreaterThan(0)
    expect(CONVERSATION_RESPONSES.correction.length).toBeGreaterThan(0)
    expect(CONVERSATION_RESPONSES.repetition.length).toBeGreaterThan(0)
    expect(CONVERSATION_RESPONSES.dontKnow.probe.length).toBeGreaterThan(0)
    expect(CONVERSATION_RESPONSES.dontKnow.advance.length).toBeGreaterThan(0)
    expect(CONVERSATION_RESPONSES.challenge_question.length).toBeGreaterThan(0)
    expect(CONVERSATION_RESPONSES.gaming.length).toBeGreaterThan(0)
  })

  it('has hint responses for all interview types', () => {
    expect(CONVERSATION_RESPONSES.hint.behavioral).toBeTruthy()
    expect(CONVERSATION_RESPONSES.hint.technical).toBeTruthy()
    expect(CONVERSATION_RESPONSES.hint['case-study']).toBeTruthy()
    expect(CONVERSATION_RESPONSES.hint.screening).toBeTruthy()
  })

  it('timecheck function returns meaningful messages', () => {
    const msg5 = CONVERSATION_RESPONSES.timecheck(5, true)
    expect(msg5).toContain('5 minutes')
    expect(msg5).toContain('great')

    const msg1 = CONVERSATION_RESPONSES.timecheck(1, false)
    expect(msg1).toContain('1 minute')
    expect(msg1).not.toContain('minutes')

    const msg0 = CONVERSATION_RESPONSES.timecheck(0, false)
    expect(msg0).toContain('almost at time')
  })
})

describe('THINKING_ACKS', () => {
  it('has at least 10 variants for variety', () => {
    expect(THINKING_ACKS.length).toBeGreaterThanOrEqual(10)
  })
})

describe('PRE_QUESTION_FILLERS', () => {
  it('has transition fillers', () => {
    expect(PRE_QUESTION_FILLERS.length).toBeGreaterThan(0)
  })
})
