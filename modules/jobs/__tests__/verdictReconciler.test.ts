import { describe, it, expect } from 'vitest'
import { reconcileVerdict, SOFT_CLOSE_GENUINENESS_MAX } from '../services/verdictReconciler'
import type { JobVerdict } from '../config/verdictSchema'
import { JOB_DOMAINS } from '../config/domains'

function verdict(over: Partial<JobVerdict>): JobVerdict {
  return {
    verdict: 'genuine',
    reasonCodes: ['ok'],
    genuineness: 0.9,
    quality: 0.7,
    completeness: 0.8,
    domain: JOB_DOMAINS[0].id,
    domainConfidence: 0.8,
    seniority: 'mid',
    fresherFriendly: false,
    geo: { locations: [], workMode: 'unspecified' },
    ...over,
  }
}

describe('reconcileVerdict (§4.5 enforcement policy — pure)', () => {
  it('soft-close requires BOTH fraud AND genuineness ≤ 0.2 (boundary inclusive)', () => {
    expect(reconcileVerdict(verdict({ verdict: 'fraud', genuineness: 0.2, reasonCodes: ['fee_fraud'] }), { anyDemotionFlag: false }).wouldSoftClose).toBe(true)
    expect(reconcileVerdict(verdict({ verdict: 'fraud', genuineness: 0.21, reasonCodes: ['fee_fraud'] }), { anyDemotionFlag: false }).wouldSoftClose).toBe(false)
    expect(reconcileVerdict(verdict({ verdict: 'suspicious', genuineness: 0, reasonCodes: ['vague_jd'] }), { anyDemotionFlag: false }).wouldSoftClose).toBe(false)
    expect(SOFT_CLOSE_GENUINENESS_MAX).toBe(0.2)
  })

  it('llm-flagged-clean-row: severity the rules missed, counted on rules-clean rows only', () => {
    const onClean = reconcileVerdict(verdict({ verdict: 'suspicious', reasonCodes: ['title_body_mismatch'] }), { anyDemotionFlag: false })
    expect(onClean.llmFlaggedCleanRow).toBe(true)
    expect(onClean.disagreesWithRules).toBe(true)
    const onFlagged = reconcileVerdict(verdict({ verdict: 'suspicious', reasonCodes: ['title_body_mismatch'] }), { anyDemotionFlag: true })
    expect(onFlagged.llmFlaggedCleanRow).toBe(false)
    expect(onFlagged.disagreesWithRules).toBe(false)
  })

  it('llm-cleared-flagged-row is ADVISORY ONLY — monotonicity means the flag stands', () => {
    const r = reconcileVerdict(verdict({ verdict: 'genuine', reasonCodes: ['legit_staffing'] }), { anyDemotionFlag: true })
    expect(r.llmClearedFlaggedRow).toBe(true)
    expect(r.disagreesWithRules).toBe(true)
    expect(r.wouldSoftClose).toBe(false)
    // the result carries NO mechanism to clear a flag — nothing to assert away, by construction
  })

  it('agreement cases produce no disagreement signal', () => {
    expect(reconcileVerdict(verdict({}), { anyDemotionFlag: false }).disagreesWithRules).toBe(false)
    // genuine WITHOUT a clean reason code on a flagged row = not a "clear"
    expect(reconcileVerdict(verdict({ verdict: 'genuine', reasonCodes: ['vague_jd'] }), { anyDemotionFlag: true }).llmClearedFlaggedRow).toBe(false)
  })
})
