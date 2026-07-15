import { describe, it, expect } from 'vitest'
import { computeReadiness, ANSWER_SCORE_FLOOR, type EvidenceRowLike } from '../config/readiness'

/**
 * Band math (READINESS.md §2) — the panel's blocker cases pinned as
 * vectors so they can never regress: quality laundering (R0), the
 * weighted-mean no-op (R1), stale-hash exclusion (R2), epoch exclusion
 * (R8), repeat-coverage multi-counting (R28), the small-N cap (R4), and
 * the must-have counting universe (Codex #537).
 */

const HASH = 'hash-a'
const EPOCH = 'gpt-5.6-luna'
const parse = (n: number) => ({ xrayHash: HASH, mustHaveIds: Array.from({ length: n }, (_, i) => `req-${i}`) })
const row = (over: Partial<EvidenceRowLike> = {}): EvidenceRowLike => ({
  requirementId: 'req-0', xrayHash: HASH, strength: 'partial', answerScore: 72,
  scoringEpoch: EPOCH, sessionId: 's1', ...over,
})

describe('computeReadiness', () => {
  it('zero counted evidence = band none, zero claims', () => {
    const s = computeReadiness([], parse(8), EPOCH, 0)
    expect(s.band).toBe('none')
    expect(s.practicedCount).toBe(0)
  })

  it('R1 blocker vector: all-partial 72s score quality 36, NOT 72 — strength multiplies', () => {
    const rows = Array.from({ length: 6 }, (_, i) => row({ requirementId: `req-${i}` }))
    const s = computeReadiness(rows, parse(8), EPOCH, 3)
    expect(s.quality).toBe(36)
    expect(s.band).toBe('building') // quality 36 < 50 blocks Practiced
  })

  it('R0 blocker vector: rows below the answer-score floor never count at all', () => {
    const rows = [row({ answerScore: ANSWER_SCORE_FLOOR - 1 }), row({ requirementId: 'req-1', answerScore: 25 })]
    const s = computeReadiness(rows, parse(8), EPOCH, 3)
    expect(s.band).toBe('none')
    expect(s.practicedCount).toBe(0)
  })

  it('Practiced needs sessions ≥3 AND coverage ≥40% AND quality ≥50', () => {
    const strongRows = Array.from({ length: 4 }, (_, i) => row({ requirementId: `req-${i}`, strength: 'strong', answerScore: 60 }))
    expect(computeReadiness(strongRows, parse(8), EPOCH, 3).band).toBe('practiced') // 50% cov, q=60
    expect(computeReadiness(strongRows, parse(8), EPOCH, 2).band).toBe('building') // sessions gate
    expect(computeReadiness(strongRows.slice(0, 2), parse(8), EPOCH, 3).band).toBe('building') // 25% cov
  })

  it('strong-evidence needs coverage ≥70% + quality ≥70 + strong coverage ≥40%', () => {
    const rows = [
      ...Array.from({ length: 4 }, (_, i) => row({ requirementId: `req-${i}`, strength: 'strong', answerScore: 85 })),
      ...Array.from({ length: 2 }, (_, i) => row({ requirementId: `req-${4 + i}`, strength: 'partial', answerScore: 90 })),
    ]
    // 6/8 covered (75%), strong 4/8 (50%), quality = (4×85 + 2×45)/6 = 71.67 → 72
    const s = computeReadiness(rows, parse(8), EPOCH, 3)
    expect(s.band).toBe('strong-evidence')
    expect(s.strongCoverage).toBe(0.5)
    // All-partial evidence can never even clear Practiced's quality bar:
    // partial × 95 = 47.5 < 50 — under the multiplicative rule (R1),
    // advancing past 'building' requires SOME strong evidence. Deliberate.
    const allPartial = Array.from({ length: 8 }, (_, i) => row({ requirementId: `req-${i}`, answerScore: 95 }))
    const ap = computeReadiness(allPartial, parse(8), EPOCH, 5)
    expect(ap.band).toBe('building')
    expect(ap.quality).toBe(48)
  })

  it('R4: small-N postings cap at Practiced even with perfect evidence', () => {
    const rows = [row({ strength: 'strong', answerScore: 95 }), row({ requirementId: 'req-1', strength: 'strong', answerScore: 95 })]
    const s = computeReadiness(rows, parse(2), EPOCH, 5)
    expect(s.band).toBe('practiced')
    expect(s.mustHaveTotal).toBe(2)
  })

  it('R2/R8: stale-hash and stale-epoch rows are excluded from counting', () => {
    const rows = [
      row({ strength: 'strong', answerScore: 90 }),
      row({ requirementId: 'req-1', xrayHash: 'hash-OLD', strength: 'strong', answerScore: 90 }),
      row({ requirementId: 'req-2', scoringEpoch: 'old-model', strength: 'strong', answerScore: 90 }),
    ]
    const s = computeReadiness(rows, parse(8), EPOCH, 3)
    expect(s.practicedCount).toBe(1)
  })

  it('R28: repeat coverage never multi-counts — best row per requirement wins', () => {
    const rows = [
      row({ strength: 'partial', answerScore: 60, sessionId: 's1' }),
      row({ strength: 'strong', answerScore: 80, sessionId: 's2' }), // same req-0: best = strong 80
    ]
    const s = computeReadiness(rows, parse(4), EPOCH, 3)
    expect(s.practicedCount).toBe(1)
    expect(s.quality).toBe(80)
  })

  it('Codex #537: ids outside the must-have universe never count', () => {
    const rows = [row({ requirementId: 'nice-to-have-1', strength: 'strong', answerScore: 95 })]
    expect(computeReadiness(rows, parse(4), EPOCH, 3).practicedCount).toBe(0)
  })
})
