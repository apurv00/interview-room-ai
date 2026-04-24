/**
 * Guards the time-normalisation contract for the multimodal analysis pipeline.
 *
 * Prior to this fix, `stepFetchSession` returned `questionBoundaries` as raw
 * Date.now() ms timestamps while downstream aggregators expected seconds-
 * since-recording-start. That unit mismatch produced: ms-epoch startSec on
 * every segment, sentinel -1 eye contact for every facial window, zero-
 * prosody for every prosody window, a mixed-unit last entry, and phantom
 * questionIndex values past the actual evaluation count.
 *
 * See the full RCA in the PR description. These tests pin the contract so
 * the fix can't silently regress.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ─── Mocks (must come before the SUT import) ───────────────────────────────

vi.mock('@shared/db/connection', () => ({
  connectDB: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@shared/db/models/MultimodalAnalysis', () => ({
  MultimodalAnalysis: { findOneAndUpdate: vi.fn().mockResolvedValue(null) },
}))

const mockFindById = vi.fn()
vi.mock('@shared/db/models/InterviewSession', () => ({
  InterviewSession: { findById: (...args: unknown[]) => mockFindById(...args) },
}))

vi.mock('@shared/db/models/User', () => ({ User: { findById: vi.fn() } }))
vi.mock('@shared/storage/r2', () => ({ getDownloadPresignedUrl: vi.fn() }))
vi.mock('@shared/services/usageTracking', () => ({
  trackUsage: vi.fn().mockResolvedValue(undefined),
  __PRICING: {},
}))
vi.mock('@shared/logger', () => ({
  aiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
vi.mock('@shared/featureFlags', () => ({ isFeatureEnabled: vi.fn().mockReturnValue(false) }))
vi.mock('../services/analysis/prosodyService', () => ({ extractProsody: vi.fn() }))
vi.mock('../services/analysis/facialAggregator', () => ({ aggregateFacialData: vi.fn() }))
vi.mock('../services/analysis/fusionService', () => ({ runFusionAnalysis: vi.fn() }))

import {
  computeSessionT0,
  secondsSinceT0,
  stepFetchSession,
} from '@interview/services/analysis/multimodalPipeline'

// ─── Helpers ───────────────────────────────────────────────────────────────

function makeSessionDoc(opts: {
  interviewerCount: number
  evaluationsCount: number
  t0Ms: number
  includeStartedAt?: boolean
}) {
  const transcript: Array<{ speaker: string; text: string; timestamp: number }> = []
  for (let i = 0; i < opts.interviewerCount; i++) {
    transcript.push({ speaker: 'interviewer', text: `Q${i}`, timestamp: opts.t0Ms + i * 60_000 })
  }
  for (let i = 0; i < Math.min(opts.evaluationsCount, opts.interviewerCount); i++) {
    transcript.push({
      speaker: 'candidate',
      text: `A${i}`,
      timestamp: opts.t0Ms + i * 60_000 + 10_000,
    })
  }
  const doc: Record<string, unknown> = {
    _id: 'sess-test',
    recordingR2Key: 'r/sess-test.webm',
    facialLandmarksR2Key: 'f/sess-test.json',
    transcript,
    evaluations: Array.from({ length: opts.evaluationsCount }, (_, i) => ({ questionIndex: i })),
    config: { role: 'pm', interviewType: 'technical' },
  }
  if (opts.includeStartedAt !== false) doc.startedAt = new Date(opts.t0Ms)
  return doc
}

// ─── Unit tests: computeSessionT0 ──────────────────────────────────────────

describe('computeSessionT0', () => {
  it('prefers session.startedAt when present', () => {
    const startedAt = new Date('2026-04-23T15:13:00Z')
    const t0 = computeSessionT0(startedAt, [
      { speaker: 'candidate', timestamp: 1776957200000 },
    ])
    expect(t0).toBe(startedAt.getTime())
  })

  it('falls back to first candidate timestamp when startedAt is absent', () => {
    const t0 = computeSessionT0(undefined, [
      { speaker: 'interviewer', timestamp: 1776957100000 },
      { speaker: 'candidate', timestamp: 1776957120000 },
    ])
    expect(t0).toBe(1776957120000)
  })

  it('falls back to first transcript entry when no candidate turn exists', () => {
    const t0 = computeSessionT0(undefined, [
      { speaker: 'interviewer', timestamp: 1776957100000 },
    ])
    expect(t0).toBe(1776957100000)
  })

  it('returns 0 when transcript is empty and startedAt missing', () => {
    expect(computeSessionT0(undefined, [])).toBe(0)
  })
})

// ─── Unit tests: secondsSinceT0 ────────────────────────────────────────────

describe('secondsSinceT0', () => {
  it('converts ms delta to seconds', () => {
    expect(secondsSinceT0(1776957130000, 1776957100000)).toBe(30)
  })

  it('clamps negative deltas to 0', () => {
    expect(secondsSinceT0(1776957100000, 1776957130000)).toBe(0)
  })

  it('handles t0 === 0 (degenerate fallback, no normalisation applied)', () => {
    expect(secondsSinceT0(120_000, 0)).toBe(120)
  })
})

// ─── Integration tests: stepFetchSession ───────────────────────────────────

describe('stepFetchSession — time normalisation contract', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns sessionT0 equal to session.startedAt.getTime()', async () => {
    mockFindById.mockResolvedValue(
      makeSessionDoc({ interviewerCount: 3, evaluationsCount: 3, t0Ms: 1776957100000 }),
    )
    const result = await stepFetchSession('sess-test')
    expect(result.sessionT0).toBe(1776957100000)
  })

  it('normalises questionBoundaries to seconds-since-t0', async () => {
    mockFindById.mockResolvedValue(
      makeSessionDoc({ interviewerCount: 3, evaluationsCount: 3, t0Ms: 1776957100000 }),
    )
    const result = await stepFetchSession('sess-test')
    expect(result.questionBoundaries).toEqual([0, 60, 120])
  })

  it('caps boundaries to evaluations.length + 1 (strips phantom greeting/closing turns)', async () => {
    // 8 interviewer turns (greeting + 6 Qs + closing), 6 evaluations → capped at 7.
    mockFindById.mockResolvedValue(
      makeSessionDoc({ interviewerCount: 8, evaluationsCount: 6, t0Ms: 1776957100000 }),
    )
    const result = await stepFetchSession('sess-test')
    expect(result.questionBoundaries).toHaveLength(7)
  })

  it('clamps boundaries that predate sessionT0 to 0', async () => {
    const doc = makeSessionDoc({ interviewerCount: 1, evaluationsCount: 1, t0Ms: 1776957100000 })
    ;(doc.transcript as Array<{ timestamp: number }>)[0].timestamp = 1776957000000 // 100s before startedAt
    mockFindById.mockResolvedValue(doc)
    const result = await stepFetchSession('sess-test')
    expect(result.questionBoundaries).toEqual([0])
  })

  it('uses first candidate timestamp when startedAt is missing', async () => {
    const doc = makeSessionDoc({
      interviewerCount: 2,
      evaluationsCount: 2,
      t0Ms: 1776957100000,
      includeStartedAt: false,
    })
    mockFindById.mockResolvedValue(doc)
    const result = await stepFetchSession('sess-test')
    // First candidate is at t0+10_000 ms (makeSessionDoc helper)
    expect(result.sessionT0).toBe(1776957110000)
    // The first interviewer turn (t0) is now 10s BEFORE the candidate t0 — clamped to 0
    expect(result.questionBoundaries[0]).toBe(0)
  })

  it('never returns ms-epoch values in questionBoundaries', async () => {
    // Regression pin: any boundary >= 1e10 would be a raw ms-epoch leak.
    mockFindById.mockResolvedValue(
      makeSessionDoc({ interviewerCount: 8, evaluationsCount: 6, t0Ms: 1776957100000 }),
    )
    const result = await stepFetchSession('sess-test')
    for (const b of result.questionBoundaries) {
      expect(b).toBeLessThan(1e10)
    }
  })
})
