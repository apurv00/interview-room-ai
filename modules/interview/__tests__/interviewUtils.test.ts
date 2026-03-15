import { describe, it, expect } from 'vitest'
import {
  computePerformanceSignal,
  shouldProbeOrAdvance,
  buildThreadSummary,
  toneToEmotion,
} from '../hooks/interviewUtils'
import type { AnswerEvaluation, ThreadEntry } from '@shared/types'

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
})

// ─── shouldProbeOrAdvance ───────────────────────────────────────────────────

describe('shouldProbeOrAdvance', () => {
  const probeEval = makeEval()
  probeEval.probeDecision = {
    shouldProbe: true,
    probeType: 'clarify',
    probeQuestion: 'Can you elaborate?',
  }

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
