import { describe, it, expect } from 'vitest'
import {
  computeTranscriptOrigin,
  entrySeconds,
  computeTranscriptSeconds,
} from '../transcriptOffsets'

/**
 * Regression test for Codex P2 on PR #370:
 *
 *   When `timestamp` values are epoch milliseconds but `sessionStartedAt`
 *   is null, this branch forces every line to `0` seconds. In that state,
 *   the transcript tab shows all rows at `0:00`, every timestamp click
 *   seeks to the beginning, and active-line tracking no longer reflects
 *   playback. Because `sessionStartedAt` is optional in this component
 *   and can be absent on older/session-recovered data, this is a real
 *   regression path; add a fallback (for example, derive offsets from
 *   the first transcript timestamp) instead of collapsing all entries
 *   to zero.
 */

const EPOCH_BASE = 1747370800000

describe('computeTranscriptOrigin', () => {
  it('prefers sessionStartedAt when provided and positive', () => {
    const transcript = [{ timestamp: EPOCH_BASE + 30_000 }]
    expect(computeTranscriptOrigin(transcript, EPOCH_BASE)).toBe(EPOCH_BASE)
  })

  it('falls back to the first epoch-ms entry when sessionStartedAt is null', () => {
    const transcript = [
      { timestamp: EPOCH_BASE + 60_000 },
      { timestamp: EPOCH_BASE + 120_000 },
    ]
    expect(computeTranscriptOrigin(transcript, null)).toBe(EPOCH_BASE + 60_000)
  })

  it('falls back to first epoch-ms entry when sessionStartedAt is undefined', () => {
    const transcript = [{ timestamp: EPOCH_BASE + 5_000 }]
    expect(computeTranscriptOrigin(transcript, undefined)).toBe(EPOCH_BASE + 5_000)
  })

  it('skips non-epoch entries when scanning for fallback origin', () => {
    const transcript = [
      { timestamp: 0 },          // already seconds (small)
      { timestamp: 15 },         // already seconds (small)
      { timestamp: EPOCH_BASE }, // epoch ms — first one wins
    ]
    expect(computeTranscriptOrigin(transcript, null)).toBe(EPOCH_BASE)
  })

  it('returns 0 when no epoch-ms entries exist and no sessionStartedAt (already-seconds regime)', () => {
    const transcript = [{ timestamp: 5 }, { timestamp: 30 }]
    expect(computeTranscriptOrigin(transcript, null)).toBe(0)
  })

  it('returns 0 when transcript is empty and no sessionStartedAt', () => {
    expect(computeTranscriptOrigin([], null)).toBe(0)
  })

  it('treats sessionStartedAt of 0 as "missing" and falls back', () => {
    // 0 is a falsy timestamp — almost certainly never a real session start.
    const transcript = [{ timestamp: EPOCH_BASE }]
    expect(computeTranscriptOrigin(transcript, 0)).toBe(EPOCH_BASE)
  })
})

describe('entrySeconds', () => {
  it('converts epoch ms relative to origin', () => {
    expect(entrySeconds(EPOCH_BASE + 30_000, EPOCH_BASE)).toBe(30)
    expect(entrySeconds(EPOCH_BASE + 90_500, EPOCH_BASE)).toBe(90.5)
  })

  it('passes through already-seconds entries (small numbers) unchanged', () => {
    expect(entrySeconds(15, EPOCH_BASE)).toBe(15)
    expect(entrySeconds(0, 0)).toBe(0)
  })

  it('clamps negative results to 0 (e.g. if origin > timestamp)', () => {
    expect(entrySeconds(EPOCH_BASE, EPOCH_BASE + 5_000)).toBe(0)
  })

  it('returns 0 for non-finite timestamps', () => {
    expect(entrySeconds(NaN, EPOCH_BASE)).toBe(0)
    expect(entrySeconds(Infinity, EPOCH_BASE)).toBe(0)
  })
})

describe('computeTranscriptSeconds (Codex P2 regression)', () => {
  it('preserves relative spacing when sessionStartedAt is null but timestamps are epoch ms', () => {
    // The regression case: previously every entry returned 0; now first
    // entry is 0 (its own timestamp is the origin) and subsequent entries
    // show their real offsets from that first one.
    const transcript = [
      { timestamp: EPOCH_BASE + 5_000 },   // first epoch entry → 0
      { timestamp: EPOCH_BASE + 65_000 },  // → +60s
      { timestamp: EPOCH_BASE + 125_000 }, // → +120s
    ]
    expect(computeTranscriptSeconds(transcript, null)).toEqual([0, 60, 120])
  })

  it('uses sessionStartedAt as origin when present (preserves absolute offset)', () => {
    const transcript = [
      { timestamp: EPOCH_BASE + 30_000 },
      { timestamp: EPOCH_BASE + 90_000 },
    ]
    // Origin = EPOCH_BASE → first entry at 30s (not 0s as in the fallback path).
    expect(computeTranscriptSeconds(transcript, EPOCH_BASE)).toEqual([30, 90])
  })

  it('handles mixed shapes (seconds-from-start entries pass through)', () => {
    const transcript = [
      { timestamp: 0 },
      { timestamp: 30 },
      { timestamp: 75 },
    ]
    expect(computeTranscriptSeconds(transcript, null)).toEqual([0, 30, 75])
  })

  it('empty transcript returns empty array', () => {
    expect(computeTranscriptSeconds([], null)).toEqual([])
  })
})
