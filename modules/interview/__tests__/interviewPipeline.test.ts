import {
  shouldProbeOrAdvance,
  computePerformanceSignal,
} from '../hooks/interviewUtils'
import { classifyIntent } from '../config/conversationalResponses'
import type { AnswerEvaluation } from '@shared/types'

// ─── Helpers ───────────────────────────────────────────────────────────────

function makeEval(overrides: Partial<AnswerEvaluation> = {}): AnswerEvaluation {
  return {
    questionIndex: 0,
    question: 'Test question',
    answer: 'Test answer',
    relevance: 70,
    structure: 70,
    specificity: 70,
    ownership: 70,
    needsFollowUp: false,
    flags: [],
    ...overrides,
  }
}

function makeEvalWithAvg(avg: number): AnswerEvaluation {
  return makeEval({ relevance: avg, structure: avg, specificity: avg, ownership: avg })
}

// ─── shouldProbeOrAdvance ──────────────────────────────────────────────────

describe('shouldProbeOrAdvance', () => {
  it('returns probe when evaluation has shouldProbe=true and conditions met', () => {
    const evalWithProbe = makeEval({
      probeDecision: {
        shouldProbe: true,
        probeType: 'clarify',
        probeQuestion: 'Can you elaborate on that?',
      },
    })
    // Plenty of time, enough completed threads for 10-min interview
    const result = shouldProbeOrAdvance(evalWithProbe, 300, 4, 10)
    expect(result).toBe('probe')
  })

  it('returns advance when time is low (< 60s)', () => {
    const evalWithProbe = makeEval({
      probeDecision: {
        shouldProbe: true,
        probeType: 'clarify',
        probeQuestion: 'Tell me more.',
      },
    })
    expect(shouldProbeOrAdvance(evalWithProbe, 30, 4, 10)).toBe('advance')
  })

  it('returns advance when enough threads completed but topics still needed', () => {
    const evalWithProbe = makeEval({
      probeDecision: {
        shouldProbe: true,
        probeType: 'expand',
        probeQuestion: 'What happened next?',
      },
    })
    // 0 completed, 20-min → needs ~7 topics, 200s is not enough for 7*90=630
    expect(shouldProbeOrAdvance(evalWithProbe, 200, 0, 20)).toBe('advance')
  })

  it('returns advance when shouldProbe is false', () => {
    const evalNoProbe = makeEval({
      probeDecision: { shouldProbe: false },
    })
    expect(shouldProbeOrAdvance(evalNoProbe, 500, 0, 10)).toBe('advance')
  })

  it('returns advance when probeDecision is missing', () => {
    const evalPlain = makeEval()
    expect(shouldProbeOrAdvance(evalPlain, 500, 0, 10)).toBe('advance')
  })
})

// ─── computePerformanceSignal ──────────────────────────────────────────────

describe('computePerformanceSignal', () => {
  it('returns calibrating for fewer than 2 evaluations', () => {
    expect(computePerformanceSignal([])).toBe('calibrating')
    expect(computePerformanceSignal([makeEvalWithAvg(90)])).toBe('calibrating')
  })

  it('returns strong for high-scoring candidate', () => {
    const evals = [makeEvalWithAvg(85), makeEvalWithAvg(80)]
    expect(computePerformanceSignal(evals)).toBe('strong')
  })

  it('returns on_track for moderate scores', () => {
    const evals = [makeEvalWithAvg(55), makeEvalWithAvg(50)]
    expect(computePerformanceSignal(evals)).toBe('on_track')
  })

  it('returns struggling for low scores', () => {
    const evals = [makeEvalWithAvg(30), makeEvalWithAvg(25)]
    expect(computePerformanceSignal(evals)).toBe('struggling')
  })
})

// ─── classifyIntent integration ────────────────────────────────────────────

describe('classifyIntent integration with pipeline', () => {
  it('identifies answer intent for substantive responses', () => {
    expect(classifyIntent('I led a team of five engineers to deliver the project on time')).toBe('answer')
  })

  it('identifies clarification so interviewer can rephrase', () => {
    expect(classifyIntent("I didn't catch that, could you explain the question?")).toBe('clarification')
  })

  it('identifies thinking to give candidate space', () => {
    expect(classifyIntent("That's a great question")).toBe('thinking')
  })

  it('identifies question to handle candidate queries', () => {
    expect(classifyIntent('How large is the engineering team?')).toBe('question')
  })

  it('identifies redirect for re-attempt', () => {
    expect(classifyIntent('Can I use a different example?')).toBe('redirect')
  })
})

// ─── Probe depth limits ────────────────────────────────────────────────────

describe('probe depth limits', () => {
  const PROBE_DEPTH_LIMITS: Record<string, number> = {
    'case-study': 5,
    technical: 3,
    behavioral: 2,
    screening: 2,
  }

  it('case-study allows 5 probes', () => {
    expect(PROBE_DEPTH_LIMITS['case-study']).toBe(5)
  })

  it('technical allows 3 probes', () => {
    expect(PROBE_DEPTH_LIMITS['technical']).toBe(3)
  })

  it('behavioral allows 2 probes', () => {
    expect(PROBE_DEPTH_LIMITS['behavioral']).toBe(2)
  })

  it('screening allows 2 probes', () => {
    expect(PROBE_DEPTH_LIMITS['screening']).toBe(2)
  })

  it('case-study has the highest probe depth', () => {
    const max = Math.max(...Object.values(PROBE_DEPTH_LIMITS))
    expect(PROBE_DEPTH_LIMITS['case-study']).toBe(max)
  })
})
