import { describe, it, expect } from 'vitest'
import {
  contentScoreFromEvaluation,
  deliveryScoreForQuestion,
  quadrantOf,
  buildMatrixData,
  buildExclusionFootnote,
  REASON_LABEL,
  QUADRANT_LABEL,
  type ExcludedQuestion,
} from '../deliveryMatrix'
import type { AnswerEvaluation } from '@shared/types'
import type { ProsodySegment, FacialSegment } from '@shared/types/multimodal'

function evaln(qIdx: number, scores: { rel: number; str: number; spec: number; own: number }): AnswerEvaluation {
  return {
    questionIndex: qIdx,
    question: `Q${qIdx + 1}?`,
    answer: '...',
    relevance: scores.rel,
    structure: scores.str,
    specificity: scores.spec,
    ownership: scores.own,
  } as AnswerEvaluation
}

function prosody(qIdx: number | undefined, marker: ProsodySegment['confidenceMarker']): ProsodySegment {
  return {
    startSec: 0,
    endSec: 30,
    wpm: 140,
    fillerWords: [],
    pauseDurationSec: 0,
    confidenceMarker: marker,
    questionIndex: qIdx,
  } as ProsodySegment
}

function facial(qIdx: number | undefined, eye: number, stab: number): FacialSegment {
  return {
    startSec: 0,
    endSec: 30,
    avgEyeContact: eye,
    dominantExpression: 'neutral',
    headStability: stab,
    gestureLevel: 'moderate',
    questionIndex: qIdx,
  } as FacialSegment
}

const QS = [
  { label: 'Q1', offsetSeconds: 0 },
  { label: 'Q2', offsetSeconds: 60 },
  { label: 'Q3', offsetSeconds: 120 },
]

describe('contentScoreFromEvaluation', () => {
  it('returns null for missing evaluation', () => {
    expect(contentScoreFromEvaluation(undefined)).toBeNull()
  })

  it('returns mean of the four dimensions', () => {
    expect(contentScoreFromEvaluation(evaln(0, { rel: 80, str: 60, spec: 70, own: 90 }))).toBe(75)
  })

  it('returns null when any dimension is non-finite', () => {
    expect(contentScoreFromEvaluation(evaln(0, { rel: NaN, str: 60, spec: 70, own: 90 }))).toBeNull()
    expect(contentScoreFromEvaluation(evaln(0, { rel: 80, str: 60, spec: Infinity, own: 90 }))).toBeNull()
  })
})

describe('deliveryScoreForQuestion', () => {
  it('returns null when prosody is missing (no audio confidence to anchor)', () => {
    expect(deliveryScoreForQuestion(undefined, facial(0, 0.8, 0.9))).toBeNull()
  })

  it('returns null when facial is missing entirely', () => {
    expect(deliveryScoreForQuestion(prosody(0, 'high'), undefined)).toBeNull()
  })

  it('returns null when both facial signals are sentinel/missing', () => {
    expect(deliveryScoreForQuestion(prosody(0, 'high'), facial(0, -1, -1))).toBeNull()
  })

  it('mixes audio (100) with strong facial (0.9 eye, 0.9 stab) to ~95', () => {
    // audio=100, facial=(90+90)/2=90, mean=(100+90)/2=95
    expect(deliveryScoreForQuestion(prosody(0, 'high'), facial(0, 0.9, 0.9))).toBeCloseTo(95)
  })

  it('mixes low audio (0) with weak facial (0.1 eye, 0.1 stab) to ~5', () => {
    expect(deliveryScoreForQuestion(prosody(0, 'low'), facial(0, 0.1, 0.1))).toBeCloseTo(5)
  })

  it('uses only the valid facial signal when the other is a sentinel', () => {
    // eye=0.8 valid, stab=-1 sentinel → facial=80. audio=50. mean=65.
    expect(deliveryScoreForQuestion(prosody(0, 'medium'), facial(0, 0.8, -1))).toBeCloseTo(65)
  })

  it('clamps out-of-range facial values to [0,1] before scaling', () => {
    // eye=2 → clamped 1 → 100, stab=-0.5 (not sentinel, just out of range) → clamped 0 → 0
    // wait — sentinel is exactly -1. -0.5 is treated as out-of-range and not sentinel...
    // Actually our validFacialComponent returns null for negatives via sentinel match.
    // Let me test the actual contract: only -1 is sentinel; other negatives go through clamp.
    // BUT validFacialComponent currently only excludes === -1. So -0.5 passes Number.isFinite,
    // !== -1, and gets clamped to 0. eye=2 → 100. facial mean (0+100)/2=50. audio=100. mean=75.
    expect(deliveryScoreForQuestion(prosody(0, 'high'), facial(0, 2, -0.5))).toBeCloseTo(75)
  })
})

describe('quadrantOf', () => {
  it('threshold is 50 — exactly 50 counts as "high"', () => {
    expect(quadrantOf(50, 50)).toBe('nailed-it')
  })

  it('high content + high delivery → nailed-it', () => {
    expect(quadrantOf(80, 80)).toBe('nailed-it')
  })

  it('low content + high delivery → bluffed-confidently', () => {
    expect(quadrantOf(20, 80)).toBe('bluffed-confidently')
  })

  it('high content + low delivery → knew-but-mumbled', () => {
    expect(quadrantOf(80, 20)).toBe('knew-but-mumbled')
  })

  it('low content + low delivery → off-on-both', () => {
    expect(quadrantOf(20, 20)).toBe('off-on-both')
  })
})

describe('QUADRANT_LABEL', () => {
  it('uses the user-confirmed sharp copy from Round 5d sign-off', () => {
    expect(QUADRANT_LABEL['nailed-it']).toBe('Nailed it')
    expect(QUADRANT_LABEL['bluffed-confidently']).toBe('Bluffed confidently')
    expect(QUADRANT_LABEL['knew-but-mumbled']).toBe('Knew but mumbled')
    expect(QUADRANT_LABEL['off-on-both']).toBe('Off on both')
  })
})

describe('buildMatrixData', () => {
  it('returns empty points/excluded when no questions', () => {
    const data = buildMatrixData({
      evaluations: [],
      prosodySegments: [],
      facialSegments: [],
      questions: [],
    })
    expect(data.points).toEqual([])
    expect(data.excluded).toEqual([])
  })

  it('builds one point per Q when all data is present', () => {
    const data = buildMatrixData({
      evaluations: [
        evaln(0, { rel: 90, str: 90, spec: 90, own: 90 }),
        evaln(1, { rel: 20, str: 20, spec: 20, own: 20 }),
      ],
      prosodySegments: [prosody(0, 'high'), prosody(1, 'low')],
      facialSegments: [facial(0, 0.9, 0.9), facial(1, 0.1, 0.1)],
      questions: QS.slice(0, 2),
    })
    expect(data.points).toHaveLength(2)
    expect(data.excluded).toHaveLength(0)
    expect(data.points[0].quadrant).toBe('nailed-it')
    expect(data.points[1].quadrant).toBe('off-on-both')
  })

  it('excludes Qs with missing facial data (reason: no-facial-data)', () => {
    const data = buildMatrixData({
      evaluations: [evaln(0, { rel: 90, str: 90, spec: 90, own: 90 })],
      prosodySegments: [prosody(0, 'high')],
      facialSegments: [], // empty
      questions: [QS[0]],
    })
    expect(data.points).toHaveLength(0)
    expect(data.excluded).toEqual([
      { questionIndex: 0, questionLabel: 'Q1', reason: 'no-facial-data' },
    ])
  })

  it('excludes Qs with missing content score (reason: no-content-score)', () => {
    const data = buildMatrixData({
      evaluations: [], // no eval
      prosodySegments: [prosody(0, 'high')],
      facialSegments: [facial(0, 0.9, 0.9)],
      questions: [QS[0]],
    })
    expect(data.points).toHaveLength(0)
    expect(data.excluded).toEqual([
      { questionIndex: 0, questionLabel: 'Q1', reason: 'no-content-score' },
    ])
  })

  it('prefers questionIndex-matched entries over positional fallback', () => {
    const data = buildMatrixData({
      // evaluations come in REVERSE order — questionIndex is the source of truth.
      evaluations: [
        evaln(1, { rel: 100, str: 100, spec: 100, own: 100 }),
        evaln(0, { rel: 0, str: 0, spec: 0, own: 0 }),
      ],
      prosodySegments: [prosody(0, 'low'), prosody(1, 'high')],
      facialSegments: [facial(0, 0.1, 0.1), facial(1, 0.9, 0.9)],
      questions: [QS[0], QS[1]],
    })
    expect(data.points).toHaveLength(2)
    // Q1 (index 0) should still get score 0; Q2 (index 1) should get 100.
    expect(data.points[0].contentScore).toBe(0)
    expect(data.points[1].contentScore).toBe(100)
  })

  it('falls back to positional index when questionIndex is missing on inputs', () => {
    const data = buildMatrixData({
      evaluations: [
        evaln(0, { rel: 80, str: 80, spec: 80, own: 80 }),
        evaln(1, { rel: 30, str: 30, spec: 30, own: 30 }),
      ],
      // No questionIndex on prosody/facial — must align by position.
      prosodySegments: [prosody(undefined, 'high'), prosody(undefined, 'low')],
      facialSegments: [facial(undefined, 0.8, 0.8), facial(undefined, 0.2, 0.2)],
      questions: [QS[0], QS[1]],
    })
    expect(data.points).toHaveLength(2)
    expect(data.points[0].quadrant).toBe('nailed-it')
    expect(data.points[1].quadrant).toBe('off-on-both')
  })

  it('mixes plotted and excluded — partial data does not poison the matrix', () => {
    const data = buildMatrixData({
      evaluations: [
        evaln(0, { rel: 90, str: 90, spec: 90, own: 90 }),
        evaln(1, { rel: 50, str: 50, spec: 50, own: 50 }),
        evaln(2, { rel: 70, str: 70, spec: 70, own: 70 }),
      ],
      prosodySegments: [prosody(0, 'high'), prosody(1, 'medium'), prosody(2, 'high')],
      // Q2 (index 1) has no facial data
      facialSegments: [facial(0, 0.9, 0.9), facial(2, 0.9, 0.9)],
      questions: QS,
    })
    expect(data.points).toHaveLength(2)
    expect(data.excluded).toEqual([
      { questionIndex: 1, questionLabel: 'Q2', reason: 'no-facial-data' },
    ])
  })

  // Codex P2 review on Round 5d — previously hardcoded reason 'no-facial-data'
  // even when the cause was missing audio. The diagnosis must match the actual
  // cause so the footnote doesn't lie to the user.
  describe('precise exclusion reasons (P2 fix)', () => {
    it('reports reason no-audio-data when prosody is missing but facial is present', () => {
      const data = buildMatrixData({
        evaluations: [evaln(0, { rel: 80, str: 80, spec: 80, own: 80 })],
        prosodySegments: [], // no audio
        facialSegments: [facial(0, 0.9, 0.9)],
        questions: [QS[0]],
      })
      expect(data.points).toHaveLength(0)
      expect(data.excluded).toEqual([
        { questionIndex: 0, questionLabel: 'Q1', reason: 'no-audio-data' },
      ])
    })

    it('reports reason no-audio-data when prosody exists but confidenceMarker is unrecognized', () => {
      const data = buildMatrixData({
        evaluations: [evaln(0, { rel: 80, str: 80, spec: 80, own: 80 })],
        prosodySegments: [{
          ...prosody(0, 'high'),
          confidenceMarker: 'unknown' as unknown as ProsodySegment['confidenceMarker'],
        }],
        facialSegments: [facial(0, 0.9, 0.9)],
        questions: [QS[0]],
      })
      expect(data.excluded[0]?.reason).toBe('no-audio-data')
    })

    it('reports reason no-facial-data when audio is fine but facial is missing', () => {
      const data = buildMatrixData({
        evaluations: [evaln(0, { rel: 80, str: 80, spec: 80, own: 80 })],
        prosodySegments: [prosody(0, 'high')],
        facialSegments: [],
        questions: [QS[0]],
      })
      expect(data.excluded[0]?.reason).toBe('no-facial-data')
    })

    it('reports reason no-content-score first, before checking delivery signals', () => {
      const data = buildMatrixData({
        evaluations: [],
        prosodySegments: [], // also missing — but content takes precedence
        facialSegments: [],
        questions: [QS[0]],
      })
      expect(data.excluded[0]?.reason).toBe('no-content-score')
    })

    it('handles mixed-reason batches correctly (one of each)', () => {
      const data = buildMatrixData({
        evaluations: [
          evaln(0, { rel: 80, str: 80, spec: 80, own: 80 }), // Q1 has eval
          // Q2 missing eval
          evaln(2, { rel: 80, str: 80, spec: 80, own: 80 }), // Q3 has eval
        ],
        prosodySegments: [
          prosody(0, 'high'),
          // Q2 missing prosody (doesn't matter — content takes precedence)
          // Q3 missing prosody — should report no-audio-data
          { ...prosody(2, 'high'), confidenceMarker: undefined as unknown as 'high' },
        ],
        facialSegments: [
          facial(0, 0.9, 0.9), // Q1 has facial
          facial(2, 0.9, 0.9), // Q3 has facial
          // Q2 missing — but it'll be caught by no-content-score first
        ],
        questions: QS,
      })
      // Q1 plots; Q2 excluded for no-content-score; Q3 excluded for no-audio-data
      expect(data.points).toHaveLength(1)
      expect(data.points[0].questionIndex).toBe(0)
      expect(data.excluded).toEqual([
        { questionIndex: 1, questionLabel: 'Q2', reason: 'no-content-score' },
        { questionIndex: 2, questionLabel: 'Q3', reason: 'no-audio-data' },
      ])
    })
  })
})

// Codex P3 #1 review on Round 5d — footnote must group reasons honestly
// rather than picking 'no-facial-data' if any excluded Q has it.
describe('buildExclusionFootnote', () => {
  function ex(q: string, reason: ExcludedQuestion['reason']): ExcludedQuestion {
    return { questionIndex: 0, questionLabel: q, reason }
  }

  it('returns empty string for empty input', () => {
    expect(buildExclusionFootnote([])).toBe('')
  })

  it('single Q, single reason — uses "was"', () => {
    expect(buildExclusionFootnote([ex('Q2', 'no-facial-data')]))
      .toBe('Q2 was excluded — no facial signal.')
  })

  it('multiple Qs same reason — uses "were"', () => {
    expect(buildExclusionFootnote([ex('Q1', 'no-audio-data'), ex('Q3', 'no-audio-data')]))
      .toBe('Q1, Q3 were excluded — no audio signal.')
  })

  it('multiple Qs mixed reasons — annotates each Q with its own reason', () => {
    const out = buildExclusionFootnote([
      ex('Q1', 'no-facial-data'),
      ex('Q3', 'no-audio-data'),
    ])
    expect(out).toBe('Q1 (no facial signal), Q3 (no audio signal) were excluded.')
  })

  it('all three reasons mixed — annotates per Q in input order', () => {
    const out = buildExclusionFootnote([
      ex('Q1', 'no-content-score'),
      ex('Q2', 'no-facial-data'),
      ex('Q3', 'no-audio-data'),
    ])
    expect(out).toContain('Q1 (no content score)')
    expect(out).toContain('Q2 (no facial signal)')
    expect(out).toContain('Q3 (no audio signal)')
    expect(out).toMatch(/were excluded\.?$/)
  })
})

describe('REASON_LABEL', () => {
  it('exposes friendly copy for every exclusion reason', () => {
    expect(REASON_LABEL['no-facial-data']).toBe('no facial signal')
    expect(REASON_LABEL['no-audio-data']).toBe('no audio signal')
    expect(REASON_LABEL['no-content-score']).toBe('no content score')
  })
})
