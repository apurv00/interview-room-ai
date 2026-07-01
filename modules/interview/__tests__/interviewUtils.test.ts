import { describe, it, expect } from 'vitest'
import {
  buildProbeQuestion,
  sanitizeProbeQuestion,
  computePerformanceSignal,
  shouldProbeOrAdvance,
  buildThreadSummary,
  toneToEmotion,
  createDesignSubmissionGate,
  buildPreviousQA,
  isNonAnswer,
  countTrailingNonAnswers,
} from '../hooks/interviewUtils'
import type { AnswerEvaluation, DesignSubmission, ThreadEntry, TranscriptEntry } from '@shared/types'

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeEval(scores: {
  relevance?: number
  structure?: number
  specificity?: number
  ownership?: number
} = {}): AnswerEvaluation {
  return {
    questionIndex: 0,
    question: 'Test question',
    answer: 'Test answer',
    relevance: scores.relevance ?? 70,
    structure: scores.structure ?? 70,
    specificity: scores.specificity ?? 70,
    ownership: scores.ownership ?? 70,
    needsFollowUp: false,
    flags: [],
  }
}

function makeEvalWithAvg(avg: number): AnswerEvaluation {
  return makeEval({ relevance: avg, structure: avg, specificity: avg, ownership: avg })
}

function makeThreadEntry(overrides: Partial<ThreadEntry> = {}): ThreadEntry {
  return {
    role: 'interviewer',
    text: 'Test question',
    isProbe: false,
    probeDepth: 0,
    ...overrides,
  }
}

// ─── computePerformanceSignal ───────────────────────────────────────────────

describe('computePerformanceSignal', () => {
  it('returns calibrating for empty evals', () => {
    expect(computePerformanceSignal([])).toBe('calibrating')
  })

  it('returns calibrating for single eval', () => {
    expect(computePerformanceSignal([makeEvalWithAvg(90)])).toBe('calibrating')
  })

  it('returns strong when avg >= 70', () => {
    const evals = [makeEvalWithAvg(80), makeEvalWithAvg(75)]
    expect(computePerformanceSignal(evals)).toBe('strong')
  })

  it('returns on_track when avg >= 45 and < 70', () => {
    const evals = [makeEvalWithAvg(55), makeEvalWithAvg(60)]
    expect(computePerformanceSignal(evals)).toBe('on_track')
  })

  it('returns struggling when avg < 45', () => {
    const evals = [makeEvalWithAvg(30), makeEvalWithAvg(35)]
    expect(computePerformanceSignal(evals)).toBe('struggling')
  })

  // Boundary tests
  it('boundary: avg exactly 70 → strong', () => {
    const evals = [makeEvalWithAvg(70), makeEvalWithAvg(70)]
    expect(computePerformanceSignal(evals)).toBe('strong')
  })

  it('boundary: avg exactly 45 → on_track', () => {
    const evals = [makeEvalWithAvg(45), makeEvalWithAvg(45)]
    expect(computePerformanceSignal(evals)).toBe('on_track')
  })

  it('boundary: avg exactly 44 → struggling', () => {
    const evals = [makeEvalWithAvg(44), makeEvalWithAvg(44)]
    expect(computePerformanceSignal(evals)).toBe('struggling')
  })

  it('handles large array correctly', () => {
    const evals = Array.from({ length: 20 }, () => makeEvalWithAvg(72))
    expect(computePerformanceSignal(evals)).toBe('strong')
  })

  it('handles mixed scores correctly', () => {
    // avg of (80+60)/2 = 70 → strong
    const evals = [makeEvalWithAvg(80), makeEvalWithAvg(60)]
    expect(computePerformanceSignal(evals)).toBe('strong')
  })

  it('averages across all four dimensions', () => {
    // (90 + 50 + 70 + 70) / 4 = 70 per eval → strong
    const evals = [
      makeEval({ relevance: 90, structure: 50, specificity: 70, ownership: 70 }),
      makeEval({ relevance: 90, structure: 50, specificity: 70, ownership: 70 }),
    ]
    expect(computePerformanceSignal(evals)).toBe('strong')
  })

  it('excludes failed fallback rows from live performance signal', () => {
    const evals = [
      makeEvalWithAvg(90),
      { ...makeEvalWithAvg(20), status: 'failed' as const },
      makeEvalWithAvg(80),
    ]

    expect(computePerformanceSignal(evals)).toBe('strong')
  })

  it('returns calibrating when fewer than two non-failed rows remain', () => {
    const evals = [
      makeEvalWithAvg(90),
      { ...makeEvalWithAvg(20), status: 'failed' as const },
    ]

    expect(computePerformanceSignal(evals)).toBe('calibrating')
  })
})

// ─── isNonAnswer ─────────────────────────────────────────────────────────────

describe('isNonAnswer', () => {
  it('flags a near-zero answer as a non-answer (e.g. "It\'s mash law" → 5/0/0/0)', () => {
    expect(isNonAnswer(makeEval({ relevance: 5, structure: 0, specificity: 0, ownership: 0 }))).toBe(true)
    // "the master law of hierarchical theory" → 10/5/0/0
    expect(isNonAnswer(makeEval({ relevance: 10, structure: 5, specificity: 0, ownership: 0 }))).toBe(true)
  })

  it('does NOT flag a weak-but-real answer (the candidate listed sub-topics → avg ~18)', () => {
    // "perception, leadership, motivation... strongest in motivation" → 34/8/12/18 (avg 18, spec 12)
    expect(isNonAnswer(makeEval({ relevance: 34, structure: 8, specificity: 12, ownership: 18 }))).toBe(false)
  })

  it('does NOT flag a solid answer', () => {
    expect(isNonAnswer(makeEval())).toBe(false) // defaults are 70 across the board
  })

  it('treats a failed eval (server error) as NOT a non-answer (not the candidate\'s fault)', () => {
    const failed = { ...makeEval({ relevance: 0, structure: 0, specificity: 0, ownership: 0 }), status: 'failed' as const }
    expect(isNonAnswer(failed)).toBe(false)
  })
})

// ─── countTrailingNonAnswers ─────────────────────────────────────────────────

describe('countTrailingNonAnswers', () => {
  const nonAns = (qi: number) => ({ ...makeEval({ relevance: 5, structure: 0, specificity: 0, ownership: 0 }), questionIndex: qi })
  const good = (qi: number) => ({ ...makeEval(), questionIndex: qi })

  it('counts consecutive non-answers from the most recent', () => {
    expect(countTrailingNonAnswers([good(0), nonAns(1), nonAns(2), nonAns(3)])).toBe(3)
  })

  it('resets when a more recent real answer interrupts the streak', () => {
    expect(countTrailingNonAnswers([nonAns(0), nonAns(1), good(2), nonAns(3)])).toBe(1)
  })

  it('is 0 when the most recent answer is real', () => {
    expect(countTrailingNonAnswers([nonAns(0), nonAns(1), good(2)])).toBe(0)
  })

  it('sorts by questionIndex so completion-order scramble cannot mislead the streak', () => {
    // The most recent answer (qi=3) is GOOD but was appended BEFORE the earlier probe
    // non-answers (qi=1,2) — exactly the bg-eval-lands-late race. Sorted, trailing is 0;
    // a naive end-of-array count would wrongly report 2.
    expect(countTrailingNonAnswers([good(3), nonAns(1), nonAns(2)])).toBe(0)
  })
})

// ─── shouldProbeOrAdvance ───────────────────────────────────────────────────

describe('shouldProbeOrAdvance', () => {
  const probeEval = makeEval()
  probeEval.probeDecision = {
    shouldProbe: true,
    probeType: 'clarify',
    probeQuestion: 'Can you elaborate?',
  }

  it('advances on a non-answer even when the evaluator said shouldProbe (the new bound)', () => {
    const nonAnswer = makeEval({ relevance: 5, structure: 0, specificity: 0, ownership: 0 })
    nonAnswer.probeDecision = { shouldProbe: true, probeType: 'clarify', probeQuestion: 'Clarify?' }
    // Plenty of time + topics so only the non-answer rule can force advance here.
    expect(shouldProbeOrAdvance(nonAnswer, 300, 3, 10)).toBe('advance')
  })

  it('returns advance when shouldProbe is false', () => {
    const eval_ = { ...probeEval, probeDecision: { shouldProbe: false } }
    expect(shouldProbeOrAdvance(eval_, 300, 0, 10)).toBe('advance')
  })

  it('returns advance when no probeDecision', () => {
    const eval_ = { ...makeEval() }
    expect(shouldProbeOrAdvance(eval_, 300, 0, 10)).toBe('advance')
  })

  it('returns advance when probeQuestion is missing', () => {
    const eval_ = { ...makeEval(), probeDecision: { shouldProbe: true } }
    expect(shouldProbeOrAdvance(eval_, 300, 0, 10)).toBe('advance')
  })

  it('returns advance when timeRemaining < 60', () => {
    expect(shouldProbeOrAdvance(probeEval, 59, 3, 10)).toBe('advance')
  })

  it('returns probe when all conditions met', () => {
    // 10-min duration, MINIMUM_TOPICS[10] = 4, 3 completed, 1 needed, 300s remaining
    expect(shouldProbeOrAdvance(probeEval, 300, 3, 10)).toBe('probe')
  })

  it('boundary: exactly 60s remaining → probe', () => {
    // 3 of 4 topics done, 1 needed, 90s needed, 60s < 90 → advance actually
    // Need more topics completed so time isn't the issue
    expect(shouldProbeOrAdvance(probeEval, 60, 4, 10)).toBe('probe')
  })

  it('returns advance when not enough time for remaining topics', () => {
    // 10-min duration, MINIMUM_TOPICS[10] = 4, 0 completed, 4 needed, 4*90=360 > 300
    expect(shouldProbeOrAdvance(probeEval, 300, 0, 10)).toBe('advance')
  })

  it('returns probe when topics are met even with low time', () => {
    // All minimum topics covered
    expect(shouldProbeOrAdvance(probeEval, 120, 7, 20)).toBe('probe')
  })

  it('returns advance when minimum topics not met for 20-min', () => {
    // 20-min: MINIMUM_TOPICS = 7, 2 completed, 5 needed, 5*90=450 > 200
    expect(shouldProbeOrAdvance(probeEval, 200, 2, 20)).toBe('advance')
  })

  it('returns advance when minimum topics not met for 30-min', () => {
    // 30-min: MINIMUM_TOPICS = 10, 3 completed, 7 needed, 7*90=630 > 300
    expect(shouldProbeOrAdvance(probeEval, 300, 3, 30)).toBe('advance')
  })
})

// ─── buildProbeQuestion ─────────────────────────────────────────────────────

describe('buildProbeQuestion', () => {
  it('does not emit self-clarifying wording for weak clarify targets', () => {
    const badTargets = [
      'the tradeoff rationale',
      'which integrations were shipped first',
      'exact partner and KPI',
    ]

    for (const target of badTargets) {
      const question = buildProbeQuestion('clarify', target)
      expect(question).not.toContain('What exactly do you mean by')
      expect(question).not.toContain(target)
      expect(question).toContain('specific example')
    }
  })

  it('keeps valid answer-derived clarify probes concrete', () => {
    expect(buildProbeQuestion('clarify', 'the 20% churn reduction')).toBe(
      'Can you clarify the 20% churn reduction with a specific example?'
    )
  })

  it('rejects targets copied from the original question but missing from the answer', () => {
    const question = buildProbeQuestion('clarify', 'partner onboarding KPI', {
      question: 'How would you define the partner onboarding KPI for this marketplace?',
      answer: 'I would start by interviewing sellers and mapping the workflow.',
    })

    expect(question).toBe('Can you make that more concrete with a specific example?')
  })

  // Regression (#481): buildProbeQuestion TEMPLATES the target ("Can you tell me more about <t>?"),
  // so a full interrogative probeTarget (a non-compliant evaluate-answer output, e.g. on technical /
  // case-study depths) would render ungrammatically ("...about how does X avoid leakage?"). The
  // templated path must reject ALL interrogative targets and fall back cleanly. (The verbatim
  // sanitizeProbeQuestion path keeps full interrogatives — see the asymmetry test below.)
  it('rejects a full interrogative target so the fixed template never renders ungrammatically', () => {
    const ctx = {
      question: 'Walk me through your modeling pipeline.',
      answer: 'I used cross-validation and a holdout set.',
    }
    const q = buildProbeQuestion('expand', 'how does your feature selection avoid leakage', ctx)
    expect(q).not.toContain('how does')
    expect(q).toBe('Can you walk me through the specific example?')
  })
})

describe('sanitizeProbeQuestion', () => {
  it('blocks first-router probes that self-clarify the original question', () => {
    const sanitized = sanitizeProbeQuestion(
      'What exactly do you mean by partner onboarding KPI?',
      {
        question: 'How would you define the partner onboarding KPI for this marketplace?',
        answer: 'I would interview sellers and map the onboarding workflow.',
      },
      'expand',
    )

    expect(sanitized).toBe('Can you walk me through the specific example?')
  })

  it('keeps concrete answer-derived first probes', () => {
    const sanitized = sanitizeProbeQuestion(
      'Can you quantify the 20% churn reduction?',
      {
        question: 'Tell me about a retention initiative.',
        answer: 'We reduced churn by 20% after improving onboarding.',
      },
      'quantify',
    )

    expect(sanitized).toBe('Can you quantify the 20% churn reduction?')
  })

  // Regression: a full, well-formed interrogative probe (how/why/what...) must NOT be stripped to
  // the generic fallback. The old isWeakProbeTarget rejected EVERY how/why/what-prefixed string;
  // because sanitizeProbeQuestion passes it the whole turn-router question, that nulled grounded
  // probes → "Can you walk me through the specific example?" appeared all over live academics
  // transcripts. These are real grounded probes and must survive verbatim.
  const academicCtx = {
    question: "what is motivation in consumer behaviour, and how does it influence a buyer's decision?",
    answer: 'motivation is the internal driving force that prompts a person to act to satisfy a need',
  }
  it('keeps a full "How does X differ from Y?" grounded probe', () => {
    const q = 'How does motivation differ from a need in consumer behaviour?'
    expect(sanitizeProbeQuestion(q, academicCtx, 'expand')).toBe(q)
  })
  it('keeps a "Walk me through how X explains Y" grounded probe', () => {
    const q = "Walk me through how Maslow's hierarchy explains a buyer's motivation?"
    expect(sanitizeProbeQuestion(q, academicCtx, 'expand')).toBe(q)
  })
  it('still falls back on a BARE interrogative fragment', () => {
    expect(sanitizeProbeQuestion('Why?', academicCtx, 'expand')).toBe('Can you walk me through the specific example?')
  })

  // Asymmetry (#481): the SAME full interrogative that buildProbeQuestion rejects (it would template
  // it ungrammatically) is KEPT here, because sanitizeProbeQuestion speaks the probe verbatim.
  it('keeps a full interrogative probe verbatim (verbatim path, unlike the templated buildProbeQuestion)', () => {
    const q = 'How does your feature selection avoid leakage?'
    const ctx = {
      question: 'Walk me through your modeling pipeline.',
      answer: 'I used cross-validation and a holdout set.',
    }
    expect(sanitizeProbeQuestion(q, ctx, 'expand')).toBe(q)
  })

  // Regression (#481 clarify-echo): when the candidate ASKS to clarify a term, the turn-router is
  // prompted to rephrase the question — parroting the question's words back. The clarify request
  // re-quotes the question (answerOverlap >= 0.5) so the plain re-ask guard misses it; the
  // clarify-echo guard must catch it and fall back.
  it('falls back when the candidate asked to clarify and the probe just echoes the question', () => {
    const sanitized = sanitizeProbeQuestion(
      'How would you make the marketplace expansion unit economics profitable?',
      {
        question: 'How would you make the marketplace expansion unit economics profitable?',
        answer: 'Sorry, what do you mean by unit economics?',
      },
      'expand',
    )
    expect(sanitized).toBe('Can you walk me through the specific example?')
  })

  // The clarify-echo guard is NARROW: a clarify request must NOT strip a probe that introduces a new
  // angle (low question overlap). Otherwise it would re-create the over-rejection #481 set out to fix.
  it('does NOT strip a genuinely new probe even when the candidate asked to clarify', () => {
    const q = 'Can you give a concrete example of unit economics from a business you admire?'
    const sanitized = sanitizeProbeQuestion(q, {
      question: 'How would you make the marketplace expansion profitable?',
      answer: 'What do you mean by unit economics?',
    }, 'expand')
    expect(sanitized).toBe(q)
  })

  // Regression (Codex #481 P2): a CONCISE but complete grounded interrogative ("why does motivation
  // matter?" = 3 significant tokens) must survive on the verbatim path. The earlier token-count
  // threshold (<= 3 tokens → weak) wrongly re-created the generic-fallback bug for short valid probes.
  const conceptCtx = {
    question: 'Tell me about consumer behaviour fundamentals.',
    answer: 'Consumer behaviour studies how people choose products.',
  }
  it('keeps a CONCISE grounded interrogative probe (3 significant tokens), not just long ones', () => {
    expect(sanitizeProbeQuestion('Why does motivation matter?', conceptCtx, 'expand')).toBe('Why does motivation matter?')
    expect(sanitizeProbeQuestion('How does CLV change?', conceptCtx, 'quantify')).toBe('How does CLV change?')
  })

  // Regression (Codex #481 P2): the clarify-echo guard must NOT fire on NARRATIVE uncertainty inside a
  // real answer ("if I don't understand user needs, I'd run interviews"). The candidate ANSWERED — a
  // question-overlapping follow-up must survive, not be stripped to the generic fallback.
  it('does NOT treat narrative uncertainty in a substantive answer as a clarify request', () => {
    const ctx = {
      question: 'How would you understand user needs?',
      answer: "If I don't understand user needs, I'd run interviews and synthesize the themes.",
    }
    const probe = 'How would you understand user needs through customer interviews?'
    expect(sanitizeProbeQuestion(probe, ctx, 'expand')).toBe(probe)
  })

  // Regression (Codex #481 P2 follow-up): a TERM-specific clarification ("what does <term> mean?") must
  // be caught — the earlier regex only allowed you/that/this before "mean", so a term ask slipped
  // through and the router's rephrase parroted the term back instead of falling back.
  it('falls back on a term-specific clarification ask ("What does X mean?") that echoes the question', () => {
    const sanitized = sanitizeProbeQuestion(
      'What is unit economics for the marketplace?',
      {
        question: 'What is unit economics for the marketplace?',
        answer: 'What does unit economics mean?',
      },
      'expand',
    )
    expect(sanitized).toBe('Can you walk me through the specific example?')
  })
})

// ─── buildThreadSummary ─────────────────────────────────────────────────────

describe('buildThreadSummary', () => {
  it('creates summary with no probes', () => {
    const thread: ThreadEntry[] = [
      makeThreadEntry({ role: 'interviewer', text: 'Main question', isProbe: false }),
      makeThreadEntry({ role: 'candidate', text: 'My answer', isProbe: false }),
    ]
    const evals = [makeEval({ relevance: 80, structure: 60, specificity: 70, ownership: 90 })]
    evals[0].answer = 'My answer'

    const result = buildThreadSummary(0, 'Main question', thread, evals)
    expect(result.topicIndex).toBe(0)
    expect(result.topicQuestion).toBe('Main question')
    expect(result.probeCount).toBe(0)
    expect(result.probeTypes).toEqual([])
    expect(result.summary).toContain('No probing needed.')
  })

  it('creates summary with multiple probes', () => {
    const thread: ThreadEntry[] = [
      makeThreadEntry({ role: 'interviewer', text: 'Q', isProbe: false }),
      makeThreadEntry({ role: 'candidate', text: 'A', isProbe: false }),
      makeThreadEntry({ role: 'interviewer', text: 'Probe1', isProbe: true, probeType: 'clarify' }),
      makeThreadEntry({ role: 'candidate', text: 'A2', isProbe: true }),
      makeThreadEntry({ role: 'interviewer', text: 'Probe2', isProbe: true, probeType: 'expand' }),
      makeThreadEntry({ role: 'candidate', text: 'A3', isProbe: true }),
    ]
    const evals = [makeEvalWithAvg(60), makeEvalWithAvg(70)]

    const result = buildThreadSummary(1, 'Q', thread, evals)
    expect(result.probeCount).toBe(2)
    expect(result.probeTypes).toContain('clarify')
    expect(result.probeTypes).toContain('expand')
    expect(result.summary).toContain('Probed 2 time(s)')
  })

  it('calculates avg score correctly', () => {
    const thread: ThreadEntry[] = [
      makeThreadEntry({ role: 'interviewer' }),
      makeThreadEntry({ role: 'candidate', text: 'A' }),
    ]
    // (80+80+80+80)/4 = 80
    const evals = [makeEvalWithAvg(80)]

    const result = buildThreadSummary(0, 'Q', thread, evals)
    expect(result.avgScore).toBe(80)
  })

  it('deduplicates probe types', () => {
    const thread: ThreadEntry[] = [
      makeThreadEntry({ role: 'interviewer', isProbe: true, probeType: 'clarify' }),
      makeThreadEntry({ role: 'interviewer', isProbe: true, probeType: 'clarify' }),
      makeThreadEntry({ role: 'interviewer', isProbe: true, probeType: 'expand' }),
    ]

    const result = buildThreadSummary(0, 'Q', thread, [])
    expect(result.probeTypes).toEqual(['clarify', 'expand'])
    expect(result.probeTypes.length).toBe(2)
  })

  it('returns avgScore 0 for empty evals', () => {
    const result = buildThreadSummary(0, 'Q', [], [])
    expect(result.avgScore).toBe(0)
  })

  it('rounds avgScore', () => {
    // (73+67+71+69)/4 = 70, (60+60+60+60)/4 = 60, avg = 65
    const evals = [
      makeEval({ relevance: 73, structure: 67, specificity: 71, ownership: 69 }),
      makeEvalWithAvg(60),
    ]
    const result = buildThreadSummary(0, 'Q', [], evals)
    expect(result.avgScore).toBe(65)
  })

  it('summary string contains topic question', () => {
    const result = buildThreadSummary(0, 'Tell me about leadership', [], [])
    expect(result.summary).toContain('Tell me about leadership')
  })
})

// ─── toneToEmotion ──────────────────────────────────────────────────────────

describe('toneToEmotion', () => {
  it('maps curious to curious', () => {
    expect(toneToEmotion('curious')).toBe('curious')
  })

  it('maps probing to skeptical', () => {
    expect(toneToEmotion('probing')).toBe('skeptical')
  })

  it('maps encouraging to friendly', () => {
    expect(toneToEmotion('encouraging')).toBe('friendly')
  })
})

// ─── createDesignSubmissionGate ──────────────────────────────────────────────

describe('createDesignSubmissionGate', () => {
  const makeSubmission = (submittedAt: number): DesignSubmission => ({
    components: [],
    connections: [],
    questionIndex: 1,
    submittedAt,
  })

  it('resolves the installed waiter when submit happens after wait', () => {
    const gate = createDesignSubmissionGate()
    let received: DesignSubmission | undefined
    expect(gate.takePending()).toBeNull()
    gate.setResolver((d) => { received = d })
    gate.submit(makeSubmission(1))
    expect(received).toEqual(makeSubmission(1))
  })

  it('buffers an early submit so a later wait resolves with it (no hang)', () => {
    const gate = createDesignSubmissionGate()
    // Candidate clicks Submit during the pre-canvas scoping window, before any
    // resolver is installed.
    gate.submit(makeSubmission(42))
    // waitForDesignSubmission() checks the buffer first and resolves with it.
    expect(gate.takePending()).toEqual(makeSubmission(42))
    // Buffer is consumed once.
    expect(gate.takePending()).toBeNull()
  })

  it('keeps only the most recent early submit', () => {
    const gate = createDesignSubmissionGate()
    gate.submit(makeSubmission(1))
    gate.submit(makeSubmission(2))
    expect(gate.takePending()).toEqual(makeSubmission(2))
  })

  it('does not double-fire: a buffered submit is not also delivered to a later resolver', () => {
    const gate = createDesignSubmissionGate()
    gate.submit(makeSubmission(1))
    expect(gate.takePending()).toEqual(makeSubmission(1)) // consumed by the wait
    let received: DesignSubmission | undefined
    gate.setResolver((d) => { received = d })
    expect(received).toBeUndefined() // resolver not invoked by the already-taken buffer
    gate.submit(makeSubmission(2))
    expect(received).toEqual(makeSubmission(2))
  })

  it('clear() drops a buffered submit so it cannot auto-resolve the next run', () => {
    const gate = createDesignSubmissionGate()
    gate.submit(makeSubmission(99))
    gate.clear()
    expect(gate.takePending()).toBeNull()
  })
})

describe('buildPreviousQA', () => {
  const mkTranscript = (n: number): TranscriptEntry[] =>
    Array.from({ length: n }, (_, i) => ({
      speaker: i % 2 === 0 ? 'interviewer' : 'candidate',
      text: `t${i}`,
    })) as TranscriptEntry[]

  it('returns the last 10 entries for non-academics depths', () => {
    const r = buildPreviousQA(mkTranscript(20), 'behavioral')
    expect(r).toHaveLength(10)
    expect(r[0].text).toBe('t10') // window starts at the 11th-from-last
  })

  it('pins the intro Q&A to the front for academics so the named subject stays in context', () => {
    const r = buildPreviousQA(mkTranscript(20), 'academics')
    expect(r).toHaveLength(12)        // pinned intro [t0,t1] + last 10
    expect(r[0].text).toBe('t0')      // intro question
    expect(r[1].text).toBe('t1')      // intro answer = the named subject
    expect(r[r.length - 1].text).toBe('t19')
  })

  it('does NOT pin for academics while the intro is still inside the last-10 window', () => {
    const r = buildPreviousQA(mkTranscript(8), 'academics')
    expect(r).toHaveLength(8)          // slice(-10) = all 8; intro already present, no pin
    expect(r[0].text).toBe('t0')
  })
})
