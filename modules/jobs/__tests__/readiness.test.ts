import { describe, it, expect } from 'vitest'
import {
  computeReadiness,
  ANSWER_SCORE_FLOOR,
  type CurrentReadinessProvenance,
  type EvidenceRowLike,
} from '../config/readiness'
import type { ModelExecutionProvenance } from '@shared/services/scoringProvenance'

/**
 * Band math (READINESS.md §2) — the panel's blocker cases pinned as
 * vectors so they can never regress: quality laundering (R0), the
 * weighted-mean no-op (R1), stale-hash exclusion (R2), epoch exclusion
 * (R8), repeat-coverage multi-counting (R28), the small-N cap (R4), and
 * the must-have counting universe (Codex #537).
 *
 * Codex #538 r2: `sessions` counts DISTINCT sessions among COUNTED rows,
 * not the application's total practice count — stale-JD/stale-epoch
 * sessions can never unlock the sessions ≥ 3 gate.
 */

const HASH = 'hash-a'
const execution = (
  fingerprint: string,
  over: Partial<ModelExecutionProvenance> = {},
): ModelExecutionProvenance => ({
  schemaVersion: 1,
  taskSlot: 'interview.evaluate-answer',
  contractVersion: 'answer-evaluation.v1',
  model: 'gpt-5.6-luna',
  provider: 'openai',
  usedFallback: false,
  attemptKind: 'primary',
  configDigest: 'c'.repeat(64),
  fingerprint,
  ...over,
})
const SCORING = execution('s'.repeat(64))
const ATTRIBUTION = execution('a'.repeat(64), {
  taskSlot: 'jobs.evidence-attribution',
  contractVersion: 'evidence-attribution.v1',
  configDigest: 'd'.repeat(64),
})
const CURRENT: CurrentReadinessProvenance = {
  epoch: 'current-provenance-epoch',
  scoring: [SCORING],
  attribution: [ATTRIBUTION],
}
const parse = (n: number) => ({ xrayHash: HASH, mustHaveIds: Array.from({ length: n }, (_, i) => `req-${i}`) })
const row = (over: Partial<EvidenceRowLike> = {}): EvidenceRowLike => ({
  requirementId: 'req-0', xrayHash: HASH, strength: 'partial', answerScore: 72,
  scoringEpoch: SCORING.fingerprint,
  sessionId: 's1',
  provenance: {
    schemaVersion: 1,
    status: 'attested',
    scoring: SCORING,
    attribution: ATTRIBUTION,
  },
  ...over,
})

describe('computeReadiness', () => {
  it('zero counted evidence = band none, zero claims', () => {
    const s = computeReadiness([], parse(8), CURRENT)
    expect(s.band).toBe('none')
    expect(s.practicedCount).toBe(0)
    expect(s.sessions).toBe(0)
  })

  it('R1 blocker vector: all-partial 72s score quality 36, NOT 72 — strength multiplies', () => {
    const rows = Array.from({ length: 6 }, (_, i) => row({ requirementId: `req-${i}`, sessionId: `s${1 + (i % 3)}` }))
    const s = computeReadiness(rows, parse(8), CURRENT)
    expect(s.quality).toBe(36)
    expect(s.band).toBe('building') // quality 36 < 50 blocks Practiced (sessions=3 met)
    expect(s.sessions).toBe(3)
  })

  it('R0 blocker vector: rows below the answer-score floor never count at all', () => {
    const rows = [row({ answerScore: ANSWER_SCORE_FLOOR - 1 }), row({ requirementId: 'req-1', answerScore: 25, sessionId: 's2' })]
    const s = computeReadiness(rows, parse(8), CURRENT)
    expect(s.band).toBe('none')
    expect(s.practicedCount).toBe(0)
    expect(s.sessions).toBe(0) // below-floor rows do not count as sessions either
  })

  it('Practiced needs counted-sessions ≥3 AND coverage ≥40% AND quality ≥50', () => {
    const strongRows = ['s1', 's2', 's3', 's3'].map((sid, i) =>
      row({ requirementId: `req-${i}`, strength: 'strong', answerScore: 60, sessionId: sid }))
    expect(computeReadiness(strongRows, parse(8), CURRENT).band).toBe('practiced') // 50% cov, q=60, 3 sessions
    // Same evidence squeezed into 2 sessions → the sessions gate blocks.
    const twoSessions = strongRows.map((r, i) => ({ ...r, sessionId: `s${1 + (i % 2)}` }))
    expect(computeReadiness(twoSessions, parse(8), CURRENT).band).toBe('building')
    // 3 sessions but only 3/8 covered (37.5%) → the coverage gate blocks.
    const lowCoverage = ['s1', 's2', 's3'].map((sid, i) =>
      row({ requirementId: `req-${i}`, strength: 'strong', answerScore: 60, sessionId: sid }))
    expect(computeReadiness(lowCoverage, parse(8), CURRENT).band).toBe('building')
  })

  it('Codex #538 r2: stale sessions never unlock the sessions gate', () => {
    // Two earlier sessions practiced an OLD JD version; one current
    // session has great coverage. sessions must be 1, band building —
    // NOT practiced off the back of stale practice.
    const rows = [
      row({ xrayHash: 'hash-OLD', strength: 'strong', answerScore: 90, sessionId: 's1' }),
      row({ requirementId: 'req-1', xrayHash: 'hash-OLD', strength: 'strong', answerScore: 90, sessionId: 's2' }),
      ...Array.from({ length: 4 }, (_, i) =>
        row({ requirementId: `req-${i}`, strength: 'strong', answerScore: 90, sessionId: 's3' })),
    ]
    const s = computeReadiness(rows, parse(8), CURRENT)
    expect(s.sessions).toBe(1)
    expect(s.band).toBe('building')
  })

  it('strong-evidence needs coverage ≥70% + quality ≥70 + strong coverage ≥40%', () => {
    const rows = [
      ...Array.from({ length: 4 }, (_, i) =>
        row({ requirementId: `req-${i}`, strength: 'strong', answerScore: 85, sessionId: `s${1 + (i % 3)}` })),
      ...Array.from({ length: 2 }, (_, i) =>
        row({ requirementId: `req-${4 + i}`, strength: 'partial', answerScore: 90, sessionId: `s${1 + i}` })),
    ]
    // 6/8 covered (75%), strong 4/8 (50%), quality = (4×85 + 2×45)/6 = 71.67 → 72
    const s = computeReadiness(rows, parse(8), CURRENT)
    expect(s.band).toBe('strong-evidence')
    expect(s.strongCoverage).toBe(0.5)
    // All-partial evidence can never even clear Practiced's quality bar:
    // partial × 95 = 47.5 < 50 — under the multiplicative rule (R1),
    // advancing past 'building' requires SOME strong evidence. Deliberate.
    const allPartial = Array.from({ length: 8 }, (_, i) =>
      row({ requirementId: `req-${i}`, answerScore: 95, sessionId: `s${1 + (i % 4)}` }))
    const ap = computeReadiness(allPartial, parse(8), CURRENT)
    expect(ap.band).toBe('building')
    expect(ap.quality).toBe(48)
  })

  it('R4: small-N postings cap at Practiced even with perfect evidence', () => {
    // 3 sessions of current evidence over a 2-must-have posting: every
    // strong-evidence prong passes except the small-N guard.
    const rows = [
      row({ strength: 'strong', answerScore: 95, sessionId: 's1' }),
      row({ strength: 'strong', answerScore: 95, sessionId: 's2' }),
      row({ requirementId: 'req-1', strength: 'strong', answerScore: 95, sessionId: 's3' }),
    ]
    const s = computeReadiness(rows, parse(2), CURRENT)
    expect(s.sessions).toBe(3)
    expect(s.band).toBe('practiced')
    expect(s.mustHaveTotal).toBe(2)
  })

  it('R2/R8: stale-hash and stale-epoch rows are excluded from counting', () => {
    const rows = [
      row({ strength: 'strong', answerScore: 90 }),
      row({ requirementId: 'req-1', xrayHash: 'hash-OLD', strength: 'strong', answerScore: 90, sessionId: 's2' }),
      row({ requirementId: 'req-2', scoringEpoch: 'old-fingerprint', strength: 'strong', answerScore: 90, sessionId: 's3' }),
    ]
    const s = computeReadiness(rows, parse(8), CURRENT)
    expect(s.practicedCount).toBe(1)
    expect(s.sessions).toBe(1) // the stale rows' sessions do not count
  })

  it('R28: repeat coverage never multi-counts — best row per requirement wins', () => {
    const rows = [
      row({ strength: 'partial', answerScore: 60, sessionId: 's1' }),
      row({ strength: 'strong', answerScore: 80, sessionId: 's2' }), // same req-0: best = strong 80
    ]
    const s = computeReadiness(rows, parse(4), CURRENT)
    expect(s.practicedCount).toBe(1)
    expect(s.quality).toBe(80)
    expect(s.sessions).toBe(2) // both sessions contributed counted rows
  })

  it('Codex #537: ids outside the must-have universe never count', () => {
    const rows = [row({ requirementId: 'nice-to-have-1', strength: 'strong', answerScore: 95 })]
    expect(computeReadiness(rows, parse(4), CURRENT).practicedCount).toBe(0)
  })

  it.each([
    ['missing provenance', undefined],
    ['legacy quarantine', { schemaVersion: 1 as const, status: 'legacy-unverifiable' as const }],
    ['missing scorer', {
      schemaVersion: 1 as const,
      status: 'attested' as const,
      attribution: ATTRIBUTION,
    }],
    ['missing attribution', {
      schemaVersion: 1 as const,
      status: 'attested' as const,
      scoring: SCORING,
    }],
  ])('%s rows never count', (_label, provenance) => {
    const snapshot = computeReadiness([row({ provenance })], parse(4), CURRENT)
    expect(snapshot).toMatchObject({ band: 'none', practicedCount: 0, sessions: 0 })
  })

  it.each([
    ['provider', { ...SCORING, provider: 'anthropic' }],
    ['scoring contract', { ...SCORING, contractVersion: 'answer-evaluation.v2' }],
    ['fallback use', { ...SCORING, usedFallback: true, attemptKind: 'configured-fallback' as const }],
    ['attempt kind', { ...SCORING, attemptKind: 'task-default' as const }],
    ['config digest', { ...SCORING, configDigest: 'e'.repeat(64) }],
  ])('rejects scoring %s drift even when a fingerprint is copied', (_label, scoring) => {
    const snapshot = computeReadiness([row({
      provenance: {
        schemaVersion: 1,
        status: 'attested',
        scoring,
        attribution: ATTRIBUTION,
      },
    })], parse(4), CURRENT)
    expect(snapshot.practicedCount).toBe(0)
  })

  it('rejects attribution contract drift and exports only represented canonical tuples', () => {
    const drifted = row({
      requirementId: 'req-1',
      provenance: {
        schemaVersion: 1,
        status: 'attested',
        scoring: SCORING,
        attribution: { ...ATTRIBUTION, contractVersion: 'evidence-attribution.v2' },
      },
    })
    const snapshot = computeReadiness([row(), drifted], parse(4), CURRENT)

    expect(snapshot.practicedCount).toBe(1)
    expect(snapshot.provenance).toEqual({
      schemaVersion: 1,
      scoring: [SCORING],
      attribution: [ATTRIBUTION],
    })
  })
})
