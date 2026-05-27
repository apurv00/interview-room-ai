import { describe, it, expect } from 'vitest'
import {
  isQuotaExceeded,
  shouldRetryCell,
  mergeMatrixReports,
  computeResumeOffset,
} from '../retryPolicy.mjs'

describe('retryPolicy', () => {
  it('detects quota HTTP statuses', () => {
    expect(isQuotaExceeded(402)).toBe(true)
    expect(isQuotaExceeded(403)).toBe(true)
    expect(isQuotaExceeded(429)).toBe(false)
  })

  it('allows one retry by default', () => {
    expect(shouldRetryCell(0)).toBe(true)
    expect(shouldRetryCell(1)).toBe(false)
  })

  it('merges prior and continuation reports by runId', () => {
    const prior = {
      reportId: 'qa-browser-full-1',
      runs: [{ runId: 'a', pass: true }, { runId: 'b', pass: false }],
      telemetry: [{ activityId: 'a/1' }],
      evaluationRows: [{ run: 'a' }],
    }
    const next = {
      reportId: 'qa-browser-full-1',
      runs: [{ runId: 'b', pass: true }, { runId: 'c', pass: true }],
      telemetry: [{ activityId: 'b/1' }],
      evaluationRows: [{ run: 'b' }],
    }
    const merged = mergeMatrixReports(prior, next)
    expect(merged.totalRuns).toBe(3)
    expect(merged.passedRuns).toBe(3)
    expect(merged.runs.find((r) => r.runId === 'b')?.pass).toBe(true)
    expect(merged.telemetry).toHaveLength(2)
  })

  it('computes resume offset from prior report runs', () => {
    expect(computeResumeOffset({ runs: [{ runId: 'x' }, { runId: 'y' }] }, null)).toBe(2)
    expect(computeResumeOffset(null, { resume: { offset: 5 } })).toBe(5)
  })
})
