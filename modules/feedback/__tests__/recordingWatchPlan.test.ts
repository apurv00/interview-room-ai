import { describe, it, expect } from 'vitest'
import {
  resolveRecordingWatch,
  EXTENDED_WATCH_ATTEMPTS,
  SHORT_WATCH_ATTEMPTS,
  RECENT_COMPLETION_WINDOW_MS,
} from '../lib/recordingWatchPlan'

// The founder's history-revisit matrix: the optimistic "still uploading…"
// message must NEVER show for sessions whose upload is not plausibly in
// flight (privacy-mode, months-old, retention-deleted), while the 30-min
// slow-multipart case gets the extended budget that motivated the change.

const NOW = 1_800_000_000_000

describe('resolveRecordingWatch', () => {
  it('privacy-mode sessions: no watcher, privacy-specific message', () => {
    const plan = resolveRecordingWatch({
      privacyMode: true,
      completedAtMs: NOW - 60_000, // even a fresh privacy session
      nowMs: NOW,
      hasQueuedUpload: false,
    })
    expect(plan).toEqual({ maxAttempts: 0, fallback: 'privacy' })
  })

  it('queued IndexedDB upload: extended budget + honest uploading message', () => {
    const plan = resolveRecordingWatch({
      privacyMode: false,
      completedAtMs: NOW - 3 * 24 * 60 * 60 * 1000, // even for an old session
      nowMs: NOW,
      hasQueuedUpload: true,
    })
    expect(plan).toEqual({ maxAttempts: EXTENDED_WATCH_ATTEMPTS, fallback: 'uploading' })
  })

  it('recently completed session: extended budget (upload plausibly in flight)', () => {
    const plan = resolveRecordingWatch({
      privacyMode: false,
      completedAtMs: NOW - (RECENT_COMPLETION_WINDOW_MS - 1000),
      nowMs: NOW,
      hasQueuedUpload: false,
    })
    expect(plan).toEqual({ maxAttempts: EXTENDED_WATCH_ATTEMPTS, fallback: 'uploading' })
  })

  it('old history session with nothing queued: short budget + definitive message immediately', () => {
    const plan = resolveRecordingWatch({
      privacyMode: false,
      completedAtMs: NOW - 40 * 24 * 60 * 60 * 1000, // beyond retention
      nowMs: NOW,
      hasQueuedUpload: false,
    })
    expect(plan).toEqual({ maxAttempts: SHORT_WATCH_ATTEMPTS, fallback: 'none' })
  })

  it('unknown completion time (facts not yet landed): treated as not-recent, no lie', () => {
    const plan = resolveRecordingWatch({
      privacyMode: false,
      completedAtMs: null,
      nowMs: NOW,
      hasQueuedUpload: false,
    })
    expect(plan).toEqual({ maxAttempts: SHORT_WATCH_ATTEMPTS, fallback: 'none' })
  })

  it('exactly at the recency boundary: not recent', () => {
    const plan = resolveRecordingWatch({
      privacyMode: false,
      completedAtMs: NOW - RECENT_COMPLETION_WINDOW_MS,
      nowMs: NOW,
      hasQueuedUpload: false,
    })
    expect(plan.fallback).toBe('none')
  })
})
