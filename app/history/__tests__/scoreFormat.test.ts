import { describe, it, expect } from 'vitest'
import { getScoreDisplay } from '../scoreFormat'

describe('getScoreDisplay', () => {
  it('renders the numeric score when feedback.overall_score is present', () => {
    expect(getScoreDisplay({ status: 'completed', feedback: { overall_score: 85 } }))
      .toEqual({ value: '85' })
  })

  it('renders a literal 0 (does not collapse to --)', () => {
    // UAT-011 regression guard: `|| '--'` swallowed zero scores. `??` semantics
    // are exercised here via `!= null`.
    expect(getScoreDisplay({ status: 'completed', feedback: { overall_score: 0 } }))
      .toEqual({ value: '0' })
  })

  it('shows the scoring placeholder when session is completed but feedback is missing', () => {
    expect(getScoreDisplay({ status: 'completed' }))
      .toEqual({ value: '…', title: 'Scoring in progress' })
  })

  it('shows the scoring placeholder when feedback exists but overall_score is null', () => {
    expect(getScoreDisplay({ status: 'completed', feedback: { overall_score: null } }))
      .toEqual({ value: '…', title: 'Scoring in progress' })
  })

  it('shows -- for in_progress sessions (score not expected yet)', () => {
    expect(getScoreDisplay({ status: 'in_progress' })).toEqual({ value: '--' })
  })

  it('shows -- for abandoned sessions', () => {
    expect(getScoreDisplay({ status: 'abandoned' })).toEqual({ value: '--' })
  })

  it('shows -- for created sessions that never started', () => {
    expect(getScoreDisplay({ status: 'created' })).toEqual({ value: '--' })
  })
})
